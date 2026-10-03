/**
 * plugin 包 - DSH 标准插件兼容宿主（deepseek-harness bundle 插件接口）
 *
 * DSH 插件契约（以 dsh-whale-widget 为基准实测）：
 *   package.json: { name, version, main, dsh?: { bundle: {...} } }   ← 无 manifest.json
 *   main 入口为 ESM，export { name, inject, apply }
 *     - name:   插件 id
 *     - inject: 依赖声明，如 ['webServer', 'credentials']
 *     - apply(ctx): 挂载入口；ctx 面向能力注入
 *   ctx 能力面：
 *     - webServer.register({kind:'exact', path, handler(req,res)}) → 返回 disposer
 *     - webServer.tapIndex((html) => html)                         → HTML 注入钩子（SPA 下降级为登记）
 *     - credentials.resolve(NAME) → Promise<{ value } | null>      ← 凭据读取
 *     - providers.register(adapter) → async disposer               ← 受宿主所有的 Provider
 *     - on(event, cb) → disposer；事件：'session/event' (session,event)、'session/disposed'(session)
 *     - effect(fn)  → fn() 返回清理函数；卸载时执行
 *
 * 与 ST 风格沙箱插件（runtime.ts）的关键差异：
 *   DSH 插件是「可信宿主直跑」模型（真 fs/网络/fetch），不做 node:vm 隔离；
 *   manifest permissions 只用于风险披露，绝不是安全沙箱；只应安装已审查的可信代码。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginRecord } from './registry.ts';

/** 本宿主公开给 DSH 插件的能力契约版本。 */
export const DSH_HOST_API_VERSION = 1 as const;
/** DSH HTTP 路由唯一公开命名空间。 */
export const DSH_ROUTE_NAMESPACE = '/ext' as const;

export type DshDisposer = () => void | Promise<void>;

/**
 * DSH 只需知道 Provider 的注册形状；真实请求/结果由电脑端 ProviderRegistry
 * 在发布时做严格校验。这里保持结构类型，避免 plugin 包构建依赖未提交的 proxy/dist。
 */
export interface DshProviderAdapter {
  readonly descriptor: {
    id: string;
    displayName: string;
    adapterVersion: string;
    protocolVersion: 1;
    configured: boolean;
    capabilities: {
      listModels: boolean;
      stream: boolean;
      tools: boolean;
      vision: boolean;
      chatCompletions: boolean;
      responses?: boolean;
      messages?: boolean;
    };
  };
  listModels?(ctx: {
    requestId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<any[]>;
  complete(request: any, ctx: {
    requestId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<any>;
  stream?(
    request: any,
    sink: {
      onTextDelta(delta: string): void;
      onToolCallDelta(delta: {
        index: number;
        id?: string;
        nameDelta?: string;
        argumentsDelta?: string;
      }): void;
    },
    ctx: { requestId: string; runId?: string; signal?: AbortSignal },
  ): Promise<any>;
  health?(ctx: {
    requestId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<any>;
  dispose?(): void | Promise<void>;
}

/**
 * DSH 宿主注入的最小 Provider 发布口。插件只能注册，不能读取或调用其他 Provider。
 * registrar 返回的 disposer 必须在调用时同步停止新调用准入，并在 Promise 完成前排空在途调用。
 */
export interface DshProviderRegistrar {
  register(ownerId: string, adapter: DshProviderAdapter): DshDisposer;
}

/** DSH webServer 路由注册项。公开路径必须位于 /ext/<pluginId>/...。 */
export interface DshRouteDef {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** DSH 凭据解析结果（对齐官方 ResolvedCredential：value + source 层名） */
export interface DshCredential {
  value: string;
  /** 来源层描述（'env' / 'provider.json' / 自定义） */
  source?: string;
}

/** DSH 插件 apply(ctx) 收到的宿主上下文 */
export interface DshPluginCtx {
  readonly hostApiVersion: typeof DSH_HOST_API_VERSION;
  /** 插件卸载或强制结束 drain 时触发；后台任务应监听它。 */
  readonly signal: AbortSignal;
  /** 插件唯一持久目录；不要把状态写到 import.meta.url 指向的临时运行副本。 */
  readonly dataDir: string;
  webServer: {
    /** 当前插件受控路由根，例如 /ext/commandcode。 */
    readonly basePath: string;
    register(def: DshRouteDef): () => void;
    tapIndex(fn: (html: string) => string): () => void;
  };
  credentials: {
    resolve(name: string): Promise<DshCredential | null>;
  };
  providers: {
    /** ownerId 由宿主固定为当前插件 id；注册只在 apply 成功后发布。 */
    register(adapter: DshProviderAdapter): DshDisposer;
  };
  on(event: string, cb: (...args: unknown[]) => unknown | Promise<unknown>): () => void;
  /** effect 是 timer/socket/AbortController 等插件资源的统一清理登记点。 */
  effect(fn: () => void | DshDisposer): void;
}

/** DSH 插件 ESM 导出契约 */
export interface DshPluginExports {
  name: string;
  inject: string[];
  apply(ctx: DshPluginCtx): void | DshDisposer | Promise<void | DshDisposer>;
}

interface MountedDshRoute extends DshRouteDef {
  sourcePath: string;
}

interface DshIndexTapEntry {
  owner: string;
  instance: LoadedDshPlugin;
  fn: (html: string) => string;
  active: boolean;
  disposed: boolean;
}

interface DshListenerEntry {
  owner: string;
  instance: LoadedDshPlugin;
  event: string;
  cb: (...args: unknown[]) => unknown | Promise<unknown>;
  active: boolean;
  disposed: boolean;
  sessionCleanupAttempts: Map<string, DshSessionCleanupAttempt>;
}

interface DshProviderRegistration {
  owner: string;
  adapter: DshProviderAdapter;
  disposed: boolean;
  registrarDisposer?: DshDisposer;
  disposal?: Promise<void>;
}

const DSH_OPERATION_FORCED = Symbol('dsh-operation-forced');

/** 单次 handler/listener 的宿主侧租约；force 只截断宿主等待，无法取消插件自己的 Promise。 */
interface DshActiveOperation {
  readonly forced: Promise<typeof DSH_OPERATION_FORCED>;
  readonly isForced: () => boolean;
  readonly force: () => void;
  readonly release: () => void;
}

interface DshSessionCleanupAttempt {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  readonly operation: DshActiveOperation;
}

type DshLifecyclePhase = 'loading' | 'active' | 'draining' | 'disposed';

/** DSH 插件实例（申请期先暂存资源；apply 成功后才原子发布）。 */
interface LoadedDshPlugin {
  record: PluginRecord;
  exports: DshPluginExports;
  runtimeDir: string;
  phase: DshLifecyclePhase;
  controller: AbortController;
  routes: MountedDshRoute[];
  indexTaps: DshIndexTapEntry[];
  listeners: DshListenerEntry[];
  providers: DshProviderRegistration[];
  providerDrain?: Promise<void>;
  disposers: DshDisposer[];
  activeRequests: number;
  activeOperations: Set<DshActiveOperation>;
  activeResponses: Set<ServerResponse>;
  idleWaiters: Set<() => void>;
  legacyRoots: Set<string>;
}

export interface DshHostOptions {
  /** 可选的 Provider 注册出口；未配置时使用 ctx.providers.register 的插件会加载失败。 */
  providerRegistrar?: DshProviderRegistrar;
  /** import 与 apply 各阶段的有界等待时间。 */
  loadTimeoutMs?: number;
  /** 在途响应自然完成的最长等待；超时后 signal abort 并关闭仍活动的响应。 */
  drainTimeoutMs?: number;
  /** 发出 abort 后给协作式 handler 收尾的宽限。 */
  abortGraceMs?: number;
  /** 单个插件 disposer 的最长等待；超时记录后继续清理其他资源。 */
  disposeTimeoutMs?: number;
  /** 单个 session/disposed 隐私清理 hook 的最长等待。 */
  sessionCleanupTimeoutMs?: number;
}

export interface DshHostDiagnostics {
  loaded: number;
  loading: number;
  unloading: number;
  instances: number;
  routes: number;
  listeners: number;
  indexTaps: number;
  inflight: number;
}

export interface DshLoadResult {
  id: string;
  status: 'active' | 'failed';
  error?: string;
}

export interface DshSessionCleanupContext {
  /** Stable across retries and contains no raw session id. */
  readonly operationId: string;
  readonly signal: AbortSignal;
}

export type DshSessionCleanupFailureCode =
  | 'hook-failed'
  | 'hook-rejected'
  | 'hook-timeout';

export interface DshSessionCleanupFailure {
  readonly pluginId: string;
  readonly code: DshSessionCleanupFailureCode;
}

export interface DshSessionCleanupResult {
  readonly scanned: number;
  readonly completed: number;
  readonly replayed: number;
}

export interface DshSessionCleanupFailureSummary extends DshSessionCleanupResult {
  readonly failed: number;
  readonly timedOut: number;
}

export class DshSessionCleanupError extends Error {
  readonly name = 'DshSessionCleanupError';

  constructor(
    readonly code: 'dsh-session-cleanup-invalid-session' | 'dsh-session-cleanup-failed',
    readonly summary: DshSessionCleanupFailureSummary,
    readonly failures: readonly DshSessionCleanupFailure[],
  ) {
    super(code);
  }
}

/** DSH 会话事件载荷（对齐官方 core/session Events：session/event(session, event) / session/disposed(session) / session/created(session)） */
export interface DshSessionEventPayload {
  session: { id: string; card?: string; round?: number };
  event: { type: string; data: Record<string, unknown> };
}

/** DSH assistant/message 事件 data 形状（whale-widget 消费的字段；对齐官方 SessionEventMap） */
export interface DshAssistantMessageData {
  turn: number;
  message: { source?: { model?: string } };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

const CREDENTIAL_NAMES = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_PLATFORM_TOKEN',
  'JG_API_KEY',
  'COMMANDCODE_API_KEY',
];
const DSH_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DSH_RESERVED_ROUTE_PREFIXES = ['/api', '/health', '/v1'];
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_ABORT_GRACE_MS = 250;
const DEFAULT_LOAD_TIMEOUT_MS = 15_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;
const DEFAULT_SESSION_CLEANUP_TIMEOUT_MS = 2_000;
const DSH_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}

class DshOperationTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} 超时（${timeoutMs}ms）`);
    this.name = 'DshOperationTimeoutError';
  }
}

class DshSessionCleanupRejectedError extends Error {
  constructor() {
    super('dsh-session-cleanup-hook-rejected');
    this.name = 'DshSessionCleanupRejectedError';
  }
}

function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error(`${label} 已取消`));
  return new Promise<T>((resolveWork, rejectWork) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => rejectWork(signal?.reason ?? new Error(`${label} 已取消`)));
    const timer = setTimeout(
      () => finish(() => rejectWork(new DshOperationTimeoutError(label, timeoutMs))),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolveWork(value)),
      (error) => finish(() => rejectWork(error)),
    );
  });
}

export function dshRouteBase(pluginId: string): string {
  if (!DSH_PLUGIN_ID_RE.test(pluginId)) {
    throw new Error(`DSH 插件 id 非法: ${pluginId}`);
  }
  return `${DSH_ROUTE_NAMESPACE}/${pluginId}`;
}

interface NormalizedDshRoute {
  path: string;
  legacyRoot?: string;
}

function normalizeRoutePath(pluginId: string, def: DshRouteDef, allowLegacy: boolean): NormalizedDshRoute {
  if (def.kind !== 'exact' && def.kind !== 'prefix') {
    throw new Error(`DSH 路由 kind 非法: ${String(def.kind)}`);
  }
  if (typeof def.handler !== 'function') throw new Error('DSH 路由 handler 必须是函数');
  if (typeof def.path !== 'string' || def.path.length === 0 || def.path !== def.path.trim()) {
    throw new Error('DSH 路由 path 必须是非空且无首尾空格的字符串');
  }
  if (def.path.length > 512) throw new Error('DSH 路由 path 过长');
  if (!def.path.startsWith('/') || def.path === '/') throw new Error('DSH 路由 path 必须是非根绝对路径');
  if (/[?#\\%\x00-\x1f\x7f]/.test(def.path) || def.path.includes('//')) {
    throw new Error(`DSH 路由 path 含 query/hash/转义或非法分隔符: ${def.path}`);
  }
  if (def.path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`DSH 路由 path 不允许 dot segment: ${def.path}`);
  }
  if (DSH_RESERVED_ROUTE_PREFIXES.some((prefix) => def.path === prefix || def.path.startsWith(`${prefix}/`))) {
    throw new Error(`DSH 路由不能注册宿主保留前缀: ${def.path}`);
  }

  const basePath = dshRouteBase(pluginId);
  if (def.path === basePath || def.path.startsWith(`${basePath}/`)) {
    const path = def.kind === 'prefix' && def.path.length > basePath.length
      ? def.path.replace(/\/+$/, '')
      : def.path;
    return { path };
  }
  if (def.path === DSH_ROUTE_NAMESPACE || def.path.startsWith(`${DSH_ROUTE_NAMESPACE}/`)) {
    throw new Error(`DSH 路由不能占用其他插件命名空间: ${def.path}`);
  }
  if (!allowLegacy) throw new Error(`DSH 路由必须位于 ${basePath}/...: ${def.path}`);

  // 未声明 Host API 的旧 DSH 插件只做受控迁移：剥掉其旧首段并挂到自身 /ext/<id> 下。
  // 旧根本身从不公开，因此仍无法遮蔽 /api 或其他插件。
  const segments = def.path.split('/').filter(Boolean);
  const legacySegment = segments[0] ?? '';
  if (!/^[A-Za-z0-9._~-]+$/.test(legacySegment)) {
    throw new Error(`DSH legacy 路由首段非法: ${def.path}`);
  }
  const suffix = segments.slice(1).join('/');
  let path = suffix ? `${basePath}/${suffix}` : basePath;
  if (def.kind === 'prefix' && path.length > basePath.length) path = path.replace(/\/+$/, '');
  return { path, legacyRoot: `/${legacySegment}` };
}

function routeMatches(route: MountedDshRoute, pathname: string): boolean {
  if (route.kind === 'exact') return route.path === pathname;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

function copyRuntimeTree(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.runtime') continue;
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`DSH 运行副本不接受符号链接: ${source}`);
    }
    if (entry.isDirectory()) copyRuntimeTree(source, target);
    else if (entry.isFile()) copyFileSync(source, target);
  }
}

function cleanupEmptyRuntimeParents(runtimeDir: string): void {
  const processDir = dirname(runtimeDir);
  const runtimeRoot = dirname(processDir);
  for (const directory of [processDir, runtimeRoot]) {
    try {
      if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
    } catch {
      // 并发 load 可能刚创建新副本；非空/锁定目录留待下一次卸载重试即可。
    }
  }
}

function removeRuntimeCopy(runtimeDir: string): unknown {
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch (error) {
    return error;
  } finally {
    cleanupEmptyRuntimeParents(runtimeDir);
  }
  return undefined;
}

function createRuntimeCopy(pluginId: string, sourceDir: string): string {
  const runtimeRoot = join(dirname(sourceDir), '.runtime', String(process.pid));
  mkdirSync(runtimeRoot, { recursive: true });
  const runtimeDir = mkdtempSync(join(runtimeRoot, `${pluginId}-`));
  try {
    copyRuntimeTree(sourceDir, runtimeDir);
    return runtimeDir;
  } catch (error) {
    removeRuntimeCopy(runtimeDir);
    throw error;
  }
}

function waitForResponseCompletion(res: ServerResponse): Promise<void> {
  if (res.writableFinished || res.destroyed) return Promise.resolve();
  return new Promise((resolveWait) => {
    const done = () => {
      res.off('finish', done);
      res.off('close', done);
      resolveWait();
    };
    res.once('finish', done);
    res.once('close', done);
    if (res.writableFinished || res.destroyed) done();
  });
}

function rewriteLegacyUrls(text: string, roots: Set<string>, basePath: string): string {
  let out = text;
  for (const root of roots) out = out.split(`${root}/`).join(`${basePath}/`);
  return out;
}

/** 仅为 legacy 文本资产缓冲响应，以把其硬编码旧 URL 改写到受控 /ext 根。 */
function legacyTextResponse(
  res: ServerResponse,
  roots: Set<string>,
  basePath: string,
): ServerResponse {
  const chunks: Buffer[] = [];
  let proxy: ServerResponse;
  proxy = new Proxy(res, {
    get(target, property) {
      if (property === 'writeHead') {
        return (statusCode: number, statusMessageOrHeaders?: string | Record<string, unknown>, maybeHeaders?: Record<string, unknown>) => {
          target.statusCode = statusCode;
          if (typeof statusMessageOrHeaders === 'string') target.statusMessage = statusMessageOrHeaders;
          const headers = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders;
          for (const [name, value] of Object.entries(headers ?? {})) {
            if (value !== undefined) target.setHeader(name, value as string | number | readonly string[]);
          }
          return proxy;
        };
      }
      if (property === 'write') {
        return (chunk: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
          const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), encoding));
          const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
          done?.();
          return true;
        };
      }
      if (property === 'end') {
        return (chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
          const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
          if (chunk !== undefined && typeof chunk !== 'function') {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
          }
          const rewritten = rewriteLegacyUrls(Buffer.concat(chunks).toString('utf8'), roots, basePath);
          target.removeHeader('Content-Length');
          const done = typeof chunk === 'function'
            ? chunk as () => void
            : typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
          return target.end(rewritten, 'utf8', done);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
  return proxy;
}

/**
 * DSH 插件宿主：加载/卸载/路由分发/会话事件广播。
 * DSH 仍是可信同进程扩展，不是权限沙箱；这里只收紧公开 HTTP/lifecycle 能力边界。
 */
export class DshPluginHost {
  private loaded = new Map<string, LoadedDshPlugin>();
  private loading = new Map<string, Promise<void>>();
  private unloading = new Map<string, Promise<void>>();
  private loadControllers = new Map<string, AbortController>();
  private cancelledLoads = new Set<string>();
  private pending = new Map<string, LoadedDshPlugin>();
  private instances = new Set<LoadedDshPlugin>();
  /** 会话事件监听器（插件注册的 on('session/event')） */
  private sessionListeners = new Map<string, Set<DshListenerEntry>>();
  private indexTapFns: DshIndexTapEntry[] = [];
  private closing = false;
  private readonly loadTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly sessionCleanupTimeoutMs: number;
  private readonly providerRegistrar?: DshProviderRegistrar;

  constructor(
    private credentialResolver: (name: string) => Promise<DshCredential | null>,
    options: DshHostOptions = {},
  ) {
    this.providerRegistrar = options.providerRegistrar;
    this.loadTimeoutMs = Math.max(1, options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
    this.drainTimeoutMs = Math.max(0, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    this.abortGraceMs = Math.max(0, options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
    this.disposeTimeoutMs = Math.max(1, options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS);
    this.sessionCleanupTimeoutMs = Math.max(
      1,
      options.sessionCleanupTimeoutMs ?? DEFAULT_SESSION_CLEANUP_TIMEOUT_MS,
    );
  }

  /** 是否为 DSH 标准包：package.json 存在且含 main + name（无 manifest.json） */
  static isDshPackage(dir: string): boolean {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; main?: string };
      return typeof pkg.name === 'string' && typeof pkg.main === 'string';
    } catch {
      return false;
    }
  }

  /** 加载一个 DSH 插件目录；同一 id 的并发 load 合并为一个原子激活操作。 */
  load(record: PluginRecord, dir: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('DSH 宿主正在关闭，拒绝加载新插件'));
    const draining = this.unloading.get(record.id);
    if (draining) return draining.then(() => this.load(record, dir));
    if (this.loaded.has(record.id)) return Promise.resolve();
    const current = this.loading.get(record.id);
    if (current) return current;

    let task!: Promise<void>;
    task = (async () => {
      const draining = this.unloading.get(record.id);
      if (draining) await draining;
      if (this.loaded.has(record.id)) return;
      await this.loadOne(record, dir);
    })().finally(() => {
      this.loadControllers.delete(record.id);
      if (this.loading.get(record.id) === task) this.loading.delete(record.id);
    });
    this.loading.set(record.id, task);
    return task;
  }

  private async loadOne(record: PluginRecord, sourceDir: string): Promise<void> {
    const basePath = dshRouteBase(record.id);
    // 隐藏保留目录避免与合法插件 id/name（例如 storage）发生路径碰撞；卸载插件源码不删持久数据。
    const dataDir = join(dirname(sourceDir), '.data', record.id);
    mkdirSync(dataDir, { recursive: true });
    const loadController = new AbortController();
    this.loadControllers.set(record.id, loadController);
    const pkgPath = join(sourceDir, 'package.json');
    if (!existsSync(pkgPath)) {
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件缺少 package.json: ${sourceDir}`);
    }
    const parsedPackage = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown;
    if (!parsedPackage || typeof parsedPackage !== 'object' || Array.isArray(parsedPackage)) {
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件 package.json 必须是对象: ${record.id}`);
    }
    const pkg = parsedPackage as {
      name?: string;
      main?: string;
      jiuguan?: { hostApi?: number };
      dsh?: { jiuguanHostApi?: number };
    };
    if (typeof pkg.name !== 'string' || pkg.name.trim().length === 0) {
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件 package.json 缺少 name: ${record.id}`);
    }
    if (!pkg.main) {
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件 package.json 缺少 main: ${record.id}`);
    }
    const declaredHostApi = pkg.jiuguan?.hostApi ?? pkg.dsh?.jiuguanHostApi;
    if (declaredHostApi !== undefined && declaredHostApi !== DSH_HOST_API_VERSION) {
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件要求 Host API ${declaredHostApi}，当前仅支持 ${DSH_HOST_API_VERSION}`);
    }
    const allowLegacyRoutes = declaredHostApi === undefined;

    // 每个激活实例使用独立运行副本：入口及其相对依赖 URL 一并变化，避免 Node ESM
    // cache 让热更新继续执行旧代码。副本贯穿 active/drain，最后随实例清理。
    const runtimeDir = createRuntimeCopy(record.id, sourceDir);
    const entryPath = resolvePath(runtimeDir, pkg.main);
    const entryRelative = relative(runtimeDir, entryPath);
    if (!entryRelative || entryRelative.startsWith('..') || isAbsolute(entryRelative)) {
      removeRuntimeCopy(runtimeDir);
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件 main 必须位于插件目录内: ${pkg.main}`);
    }
    if (!existsSync(entryPath)) {
      removeRuntimeCopy(runtimeDir);
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件入口不存在: ${join(sourceDir, pkg.main)}`);
    }

    let mod: Partial<DshPluginExports>;
    try {
      const importWork = import(pathToFileURL(entryPath).href) as Promise<Partial<DshPluginExports>>;
      mod = await withDeadline(importWork, this.loadTimeoutMs, `DSH 插件 ${record.id} import`, loadController.signal);
    } catch (error) {
      removeRuntimeCopy(runtimeDir);
      this.loadControllers.delete(record.id);
      const msg = (error as Error).message ?? '';
      if (/Cannot find package|ERR_MODULE_NOT_FOUND/.test(msg)) {
        throw new Error(`插件依赖未安装（Cannot find package）：${msg.slice(0, 160)}。jiuguan 不执行依赖安装；该插件需要自带构建产物或零第三方依赖才能加载`);
      }
      throw error;
    }
    if (typeof mod.apply !== 'function') {
      removeRuntimeCopy(runtimeDir);
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件缺少 export apply(): ${record.id}`);
    }

    const inst: LoadedDshPlugin = {
      record,
      exports: {
        name: mod.name ?? record.id,
        inject: Array.isArray(mod.inject) ? mod.inject : [],
        apply: mod.apply,
      },
      runtimeDir,
      phase: 'loading',
      controller: loadController,
      routes: [],
      indexTaps: [],
      listeners: [],
      providers: [],
      disposers: [],
      activeRequests: 0,
      activeOperations: new Set(),
      activeResponses: new Set(),
      idleWaiters: new Set(),
      legacyRoots: new Set(),
    };
    this.instances.add(inst);
    this.pending.set(record.id, inst);
    if (this.cancelledLoads.has(record.id)) {
      inst.controller.abort(new Error(`DSH 插件加载被卸载取消: ${record.id}`));
      this.pending.delete(record.id);
      await this.disposeInstance(inst);
      this.loadControllers.delete(record.id);
      throw new Error(`DSH 插件加载已取消: ${record.id}`);
    }

    const ctx: DshPluginCtx = {
      hostApiVersion: DSH_HOST_API_VERSION,
      signal: inst.controller.signal,
      dataDir,
      webServer: {
        basePath,
        register: (def) => {
          this.assertRegistrationOpen(inst, 'webServer.register');
          const normalized = normalizeRoutePath(record.id, def, allowLegacyRoutes);
          const path = normalized.path;
          for (const other of this.instances) {
            if (other.phase === 'disposed') continue;
            if (other.routes.some((route) => route.path === path)) {
              throw new Error(`DSH 路由重复注册: ${path}`);
            }
          }
          if (normalized.legacyRoot) inst.legacyRoots.add(normalized.legacyRoot);
          const route: MountedDshRoute = { kind: def.kind, path, sourcePath: def.path, handler: def.handler };
          inst.routes.push(route);
          return once(() => {
            const index = inst.routes.indexOf(route);
            if (index >= 0) inst.routes.splice(index, 1);
          });
        },
        tapIndex: (fn) => {
          this.assertRegistrationOpen(inst, 'webServer.tapIndex');
          if (typeof fn !== 'function') throw new Error('DSH tapIndex 必须是函数');
          const entry: DshIndexTapEntry = {
            owner: record.id,
            instance: inst,
            fn,
            active: false,
            disposed: false,
          };
          inst.indexTaps.push(entry);
          return once(() => {
            entry.disposed = true;
            const ownIndex = inst.indexTaps.indexOf(entry);
            if (ownIndex >= 0) inst.indexTaps.splice(ownIndex, 1);
            const globalIndex = this.indexTapFns.indexOf(entry);
            if (globalIndex >= 0) this.indexTapFns.splice(globalIndex, 1);
            entry.active = false;
          });
        },
      },
      credentials: {
        resolve: async (name) => this.credentialResolver(name),
      },
      providers: {
        register: (adapter) => {
          this.assertRegistrationOpen(inst, 'providers.register');
          if (!this.providerRegistrar) {
            throw new Error('DSH 宿主未配置 Provider registrar');
          }
          if (!adapter || typeof adapter !== 'object') {
            throw new Error('DSH Provider adapter 必须是对象');
          }
          const entry: DshProviderRegistration = {
            owner: record.id,
            adapter,
            disposed: false,
          };
          inst.providers.push(entry);
          return () => this.disposeProviderRegistration(entry);
        },
      },
      on: (event, cb) => {
        this.assertRegistrationOpen(inst, 'on');
        if (!event || typeof cb !== 'function') throw new Error('DSH on(event, cb) 参数非法');
        const entry: DshListenerEntry = {
          owner: record.id,
          instance: inst,
          event,
          cb,
          active: false,
          disposed: false,
          sessionCleanupAttempts: new Map(),
        };
        inst.listeners.push(entry);
        return once(() => {
          entry.disposed = true;
          const ownIndex = inst.listeners.indexOf(entry);
          if (ownIndex >= 0) inst.listeners.splice(ownIndex, 1);
          const set = this.sessionListeners.get(event);
          set?.delete(entry);
          if (set?.size === 0) this.sessionListeners.delete(event);
          entry.active = false;
        });
      },
      effect: (fn) => {
        this.assertRegistrationOpen(inst, 'effect');
        if (typeof fn !== 'function') throw new Error('DSH effect 必须是函数');
        const cleanup = fn();
        if (typeof cleanup === 'function') inst.disposers.push(cleanup);
      },
    };

    try {
      const applyWork = Promise.resolve().then(() => inst.exports.apply(ctx));
      let applyAccepted = false;
      void applyWork.then(async (lateCleanup) => {
        if (!applyAccepted && inst.phase === 'disposed' && typeof lateCleanup === 'function') {
          try {
            await withDeadline(Promise.resolve().then(lateCleanup), this.disposeTimeoutMs, `DSH 插件 ${record.id} 迟到 cleanup`);
          } catch (error) {
            console.warn(`[dsh-插件] ${record.id} 迟到清理异常: ${errorMessage(error)}`);
          }
        }
      }, () => { /* withDeadline 已观察并向加载调用方报告 */ });
      const applyCleanup = await withDeadline(
        applyWork,
        this.loadTimeoutMs,
        `DSH 插件 ${record.id} apply`,
        inst.controller.signal,
      );
      applyAccepted = true;
      if (typeof applyCleanup === 'function') inst.disposers.push(applyCleanup);
      if (inst.controller.signal.aborted) throw new Error(`DSH 插件加载已取消: ${record.id}`);

      // apply 期间只暂存 Provider。这里在同一个同步提交段内完成发布；若任一注册
      // 冲突，已发布项会先同步停止准入并完整等待回滚，然后 load 才拒绝。
      const providerRollback = this.publishProviderRegistrations(inst);
      if (providerRollback) await providerRollback;
      if (inst.controller.signal.aborted) throw new Error(`DSH 插件加载已取消: ${record.id}`);

      // UI 约定入口仍固定为命名空间根；嵌套 widget 路由只在 /ext 内补别名。
      const widgetPath = `${basePath}/widget.js`;
      if (!inst.routes.some((route) => route.path === widgetPath)) {
        const widget = inst.routes.find((route) => route.kind === 'exact' && route.path.endsWith('/widget.js'));
        if (widget && !inst.routes.some((route) => route.path === widgetPath)) {
          inst.routes.push({ ...widget, path: widgetPath, sourcePath: widget.sourcePath });
        }
      }

      for (const tap of inst.indexTaps) {
        if (tap.disposed) continue;
        tap.active = true;
        this.indexTapFns.push(tap);
      }
      for (const listener of inst.listeners) {
        if (listener.disposed) continue;
        let set = this.sessionListeners.get(listener.event);
        if (!set) {
          set = new Set();
          this.sessionListeners.set(listener.event, set);
        }
        set.add(listener);
        listener.active = true;
      }
      inst.phase = 'active';
      this.loaded.set(record.id, inst);
      if (inst.legacyRoots.size > 0) {
        console.warn(
          `[dsh-插件] ${record.id} 使用旧路由 ${[...inst.legacyRoots].join(', ')}；已仅映射到 ${basePath}，请升级插件声明 jiuguan.hostApi=1`,
        );
      }
    } catch (error) {
      await this.disposeInstance(inst);
      throw error;
    } finally {
      if (this.pending.get(record.id) === inst) this.pending.delete(record.id);
      if (this.loadControllers.get(record.id) === loadController) this.loadControllers.delete(record.id);
    }
  }

  private assertRegistrationOpen(inst: LoadedDshPlugin, capability: string): void {
    if (inst.phase !== 'loading' || inst.controller.signal.aborted) {
      throw new Error(`DSH ${capability} 只能在 apply 激活阶段调用（当前 ${inst.phase}）`);
    }
  }

  /** 卸载：先停止接新流量，再自然 drain；超时后发出 signal 并关闭残留响应。 */
  unload(id: string): Promise<void> {
    const current = this.unloading.get(id);
    if (current) return current;

    // 已激活实例在 unload() 返回前同步停止接流量/事件；异步任务只负责 drain 与清理。
    const activeAtCall = this.loaded.get(id);
    if (activeAtCall) {
      this.loaded.delete(id);
      activeAtCall.phase = 'draining';
      this.detachPublishedCapabilities(activeAtCall);
      // registrar disposer 的同步前半段负责先从 ProviderRegistry 摘除，保证
      // unload() 一返回 Promise 就已经停止接收新的 Provider 调用。
      void this.beginProviderDrain(activeAtCall);
    }

    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    const work = new Promise<void>((resolveWork, rejectWork) => {
      resolveTask = resolveWork;
      rejectTask = rejectWork;
    });
    let task!: Promise<void>;
    task = work.finally(() => {
      this.cancelledLoads.delete(id);
      if (this.unloading.get(id) === task) this.unloading.delete(id);
    });
    // 先发布占位任务，再同步执行到首个 await；signal abort 的同步回调即使重入 unload 也会复用同一任务。
    this.unloading.set(id, task);
    void (async () => {
      this.cancelledLoads.add(id);
      const loadController = this.loadControllers.get(id);
      if (loadController && !loadController.signal.aborted) {
        loadController.abort(new Error(`DSH 插件加载被卸载取消: ${id}`));
      }
      const pending = this.pending.get(id);
      if (pending && !pending.controller.signal.aborted) {
        pending.controller.abort(new Error(`DSH 插件加载被卸载取消: ${id}`));
      }
      const loading = this.loading.get(id);
      if (loading) {
        try { await loading; } catch { /* 加载失败/取消已由 load 调用方处理 */ }
      }

      const inst = activeAtCall ?? this.loaded.get(id);
      if (!inst) return;
      if (!activeAtCall) {
        this.loaded.delete(id);
        inst.phase = 'draining';
        this.detachPublishedCapabilities(inst);
        void this.beginProviderDrain(inst);
      }

      const drained = await this.waitForIdle(inst, this.drainTimeoutMs);
      if (!drained) {
        if (!inst.controller.signal.aborted) {
          inst.controller.abort(new Error(`DSH 插件 drain 超时: ${id}`));
        }
        for (const response of inst.activeResponses) {
          if (!response.destroyed) response.destroy();
        }
        const aborted = await this.waitForIdle(inst, this.abortGraceMs);
        if (!aborted) this.forceActiveOperations(inst);
      }
      await this.beginProviderDrain(inst);
      await this.disposeInstance(inst);
    })().then(resolveTask, rejectTask);
    return task;
  }

  private waitForIdle(inst: LoadedDshPlugin, timeoutMs: number): Promise<boolean> {
    if (inst.activeRequests === 0) return Promise.resolve(true);
    if (timeoutMs === 0) return Promise.resolve(false);
    return new Promise((resolveWait) => {
      let settled = false;
      const onIdle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inst.idleWaiters.delete(onIdle);
        resolveWait(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        inst.idleWaiters.delete(onIdle);
        resolveWait(false);
      }, timeoutMs);
      inst.idleWaiters.add(onIdle);
      if (inst.activeRequests === 0) onIdle();
    });
  }

  private async disposeInstance(inst: LoadedDshPlugin): Promise<void> {
    if (inst.phase === 'disposed') return;
    inst.phase = 'disposed';
    if (!inst.controller.signal.aborted) inst.controller.abort(new Error(`DSH 插件已卸载: ${inst.record.id}`));

    this.detachPublishedCapabilities(inst);
    for (const tap of inst.indexTaps) {
      const index = this.indexTapFns.indexOf(tap);
      if (index >= 0) this.indexTapFns.splice(index, 1);
      tap.active = false;
      tap.disposed = true;
    }
    for (const listener of inst.listeners) {
      const set = this.sessionListeners.get(listener.event);
      set?.delete(listener);
      if (set?.size === 0) this.sessionListeners.delete(listener.event);
      listener.active = false;
      listener.disposed = true;
    }
    // Provider 在插件 effect/apply cleanup 之前完成 drain/dispose，避免插件资源
    // 已拆除后仍有适配器调用继续运行。
    await this.beginProviderDrain(inst);
    for (let index = inst.disposers.length - 1; index >= 0; index--) {
      try {
        await withDeadline(
          Promise.resolve().then(inst.disposers[index]),
          this.disposeTimeoutMs,
          `DSH 插件 ${inst.record.id} disposer`,
        );
      } catch (error) {
        console.warn(`[dsh-插件] ${inst.record.id} 清理异常: ${errorMessage(error)}`);
      }
    }
    inst.routes.length = 0;
    inst.indexTaps.length = 0;
    inst.listeners.length = 0;
    inst.providers.length = 0;
    inst.disposers.length = 0;
    this.forceActiveOperations(inst);
    inst.activeOperations.clear();
    inst.idleWaiters.clear();
    this.instances.delete(inst);
    const runtimeCleanupError = removeRuntimeCopy(inst.runtimeDir);
    if (runtimeCleanupError !== undefined) {
      console.warn(`[dsh-插件] ${inst.record.id} 运行副本清理失败: ${errorMessage(runtimeCleanupError)}`);
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    while (
      this.loaded.size > 0
      || this.loading.size > 0
      || this.pending.size > 0
      || this.unloading.size > 0
      || this.loadControllers.size > 0
    ) {
      const ids = new Set([
        ...this.loaded.keys(),
        ...this.loading.keys(),
        ...this.pending.keys(),
        ...this.loadControllers.keys(),
      ]);
      const operations: Promise<unknown>[] = [...this.unloading.values()];
      for (const id of ids) {
        if (!this.unloading.has(id)) operations.push(this.unload(id));
      }
      if (operations.length === 0) break;
      await Promise.allSettled(operations);
    }
  }

  private detachPublishedCapabilities(inst: LoadedDshPlugin): void {
    for (const tap of inst.indexTaps) {
      const index = this.indexTapFns.indexOf(tap);
      if (index >= 0) this.indexTapFns.splice(index, 1);
      tap.active = false;
    }
    for (const listener of inst.listeners) {
      const set = this.sessionListeners.get(listener.event);
      set?.delete(listener);
      if (set?.size === 0) this.sessionListeners.delete(listener.event);
      listener.active = false;
    }
  }

  /**
   * 发布 apply 阶段暂存的 Provider。成功路径完全同步，因此外部代码看不到
   * apply 尚未完成的适配器；失败路径在抛错前等待所有已发布项撤销。
   */
  private publishProviderRegistrations(inst: LoadedDshPlugin): Promise<never> | undefined {
    if (inst.providers.length === 0) return undefined;
    const registrar = this.providerRegistrar;
    if (!registrar) {
      return Promise.reject(new Error('DSH 宿主未配置 Provider registrar'));
    }
    try {
      for (const entry of inst.providers) {
        if (entry.disposed) continue;
        const disposer = registrar.register(entry.owner, entry.adapter);
        if (typeof disposer !== 'function') {
          throw new Error('DSH Provider registrar.register 必须返回 disposer');
        }
        entry.registrarDisposer = disposer;
      }
      return undefined;
    } catch (error) {
      // beginProviderDrain 会同步调用每个 registrar disposer；即使其 drain 是异步的，
      // 新调用准入也已在本调用栈内停止。
      return this.beginProviderDrain(inst).then(() => { throw error; });
    }
  }

  /** 返回给插件的幂等 disposer；无论插件是否 await 都观察内部 rejection。 */
  private disposeProviderRegistration(entry: DshProviderRegistration): Promise<void> {
    if (entry.disposal) return entry.disposal;
    entry.disposed = true;
    const disposer = entry.registrarDisposer;
    entry.registrarDisposer = undefined;
    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    entry.disposal = new Promise<void>((resolveWork, rejectWork) => {
      resolveDisposal = resolveWork;
      rejectDisposal = rejectWork;
    });
    if (!disposer) {
      resolveDisposal();
      return entry.disposal;
    }
    try {
      Promise.resolve(disposer()).then(resolveDisposal, rejectDisposal);
    } catch (error) {
      rejectDisposal(error);
    }
    // 插件可以把返回值当普通 void disposer 使用；预先挂 rejection handler，
    // 防止其未 await 时产生 unhandledRejection。宿主 drain 仍会通过 allSettled 观察。
    void entry.disposal.catch(() => undefined);
    return entry.disposal;
  }

  /** 第一次调用同步触发全部 Provider 注销，Promise 完成表示 registrar 已 drain。 */
  private beginProviderDrain(inst: LoadedDshPlugin): Promise<void> {
    if (inst.providerDrain) return inst.providerDrain;
    let resolveDrain!: () => void;
    inst.providerDrain = new Promise<void>((resolveWork) => {
      resolveDrain = resolveWork;
    });
    const work = [...inst.providers]
      .reverse()
      .map((entry) => this.disposeProviderRegistration(entry));
    void Promise.allSettled(work).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(`[dsh-插件] ${inst.record.id} Provider 清理异常: ${errorMessage(result.reason)}`);
        }
      }
      resolveDrain();
    });
    return inst.providerDrain;
  }

  private releaseOperation(inst: LoadedDshPlugin): void {
    inst.activeRequests = Math.max(0, inst.activeRequests - 1);
    if (inst.activeRequests === 0) {
      for (const resolveIdle of inst.idleWaiters) resolveIdle();
      inst.idleWaiters.clear();
    }
  }

  private acquireOperation(inst: LoadedDshPlugin): DshActiveOperation {
    let forced = false;
    let released = false;
    let resolveForced!: (value: typeof DSH_OPERATION_FORCED) => void;
    const forcedPromise = new Promise<typeof DSH_OPERATION_FORCED>((resolveForce) => {
      resolveForced = resolveForce;
    });
    let operation!: DshActiveOperation;
    operation = {
      forced: forcedPromise,
      isForced: () => forced,
      force: () => {
        if (forced) return;
        forced = true;
        resolveForced(DSH_OPERATION_FORCED);
        operation.release();
      },
      release: () => {
        if (released) return;
        released = true;
        inst.activeOperations.delete(operation);
        this.releaseOperation(inst);
      },
    };
    inst.activeRequests++;
    inst.activeOperations.add(operation);
    return operation;
  }

  private forceActiveOperations(inst: LoadedDshPlugin): void {
    for (const operation of [...inst.activeOperations]) operation.force();
  }

  count(): number {
    return this.loaded.size;
  }

  ids(): string[] {
    return [...this.loaded.keys()];
  }

  diagnostics(): DshHostDiagnostics {
    let routes = 0;
    let listeners = 0;
    let indexTaps = 0;
    let inflight = 0;
    for (const inst of this.instances) {
      routes += inst.routes.length;
      listeners += inst.listeners.length;
      indexTaps += inst.indexTaps.length;
      inflight += inst.activeRequests;
    }
    return {
      loaded: this.loaded.size,
      loading: this.loading.size,
      unloading: this.unloading.size,
      instances: this.instances.size,
      routes,
      listeners,
      indexTaps,
      inflight,
    };
  }

  /**
   * HTTP 分发入口：只观察 /ext 命名空间。exact 优先，prefix 取最长段边界匹配。
   * handler Promise 与响应 finish/close 都完成后才释放 drain 租约。
   */
  async dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith(`${DSH_ROUTE_NAMESPACE}/`)) return false;
    let selected: { inst: LoadedDshPlugin; route: MountedDshRoute; score: number } | undefined;
    for (const inst of this.loaded.values()) {
      if (inst.phase !== 'active') continue;
      for (const route of inst.routes) {
        if (!routeMatches(route, pathname)) continue;
        const score = route.kind === 'exact' ? 1_000_000 + route.path.length : route.path.length;
        if (!selected || score > selected.score) selected = { inst, route, score };
      }
    }
    if (!selected) return false;

    const { inst, route } = selected;
    const operation = this.acquireOperation(inst);
    inst.activeResponses.add(res);
    try {
      const responseForPlugin = inst.legacyRoots.size > 0 && /\.(?:m?js|css|html?)$/i.test(pathname)
        ? legacyTextResponse(res, inst.legacyRoots, dshRouteBase(inst.record.id))
        : res;
      const handlerWork = Promise.resolve().then(() => route.handler(req, responseForPlugin));
      // Promise.race 会观察 completion；这条旁路专门记录 force 之后才到达的拒绝，避免静默/未处理。
      void handlerWork.catch((error) => {
        if (operation.isForced()) {
          void error;
          console.warn('[dsh-插件] 路由强制结束后的迟到异常 detail=redacted');
        }
      });
      const completion = Promise.all([handlerWork, waitForResponseCompletion(res)])
        .then(() => undefined);
      const outcome = await Promise.race([completion, operation.forced]);
      if (outcome === DSH_OPERATION_FORCED) return true;
    } catch (error) {
      void error;
      console.warn('[dsh-插件] 路由异常 detail=redacted');
      if (!res.writableEnded && !res.destroyed && !res.headersSent) {
        const requestId = String(res.getHeader('X-Request-Id') ?? '');
        const body = JSON.stringify({
          error: {
            code: 'internal_error',
            message: '插件路由执行失败',
            ...(requestId ? { requestId } : {}),
          },
        });
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      } else if (!res.writableEnded && !res.destroyed) {
        res.destroy();
      }
    } finally {
      inst.activeResponses.delete(res);
      operation.release();
    }
    return true;
  }

  /** HTML 注入管道（SPA 场景 jiuguan 不吐整页 HTML，留作扩展点） */
  applyIndexTaps(html: string): string {
    let out = html;
    for (const entry of this.indexTapFns) {
      try {
        out = entry.fn(out);
        if (entry.instance.legacyRoots.size > 0) {
          out = rewriteLegacyUrls(out, entry.instance.legacyRoots, dshRouteBase(entry.owner));
        }
      } catch { /* tap 失败保留上一阶段结果 */ }
    }
    return out;
  }

  /** 广播会话事件（server 在回合内/完成时调用；对齐官方 session/event 签名 (session, event)） */
  emitSessionEvent(session: DshSessionEventPayload['session'], event: DshSessionEventPayload['event']): void {
    this.emitToListeners('session/event', session, event);
  }

  emitSessionDisposed(session: DshSessionEventPayload['session']): void {
    this.emitToListeners('session/disposed', session);
  }

  /**
   * Awaitable privacy barrier for session deletion. Unlike emitSessionDisposed, this method:
   * - sends only the exact opaque session id (never card/round/user content);
   * - waits for every currently active session/disposed listener;
   * - invokes each listener at most once per plugin instance + session;
   * - bounds uncooperative hooks and reports only stable, content-free error codes.
   *
   * A second context argument is additive for existing listeners and lets updated plugins use a
   * stable operation id plus cooperative cancellation. The host cannot cancel arbitrary plugin
   * code, so a timed-out attempt is retained and reused rather than invoked again.
   */
  async cleanupSession(sessionIdValue: string): Promise<DshSessionCleanupResult> {
    if (typeof sessionIdValue !== 'string' || !DSH_SESSION_ID_RE.test(sessionIdValue)) {
      throw new DshSessionCleanupError(
        'dsh-session-cleanup-invalid-session',
        Object.freeze({ scanned: 0, completed: 0, replayed: 0, failed: 0, timedOut: 0 }),
        Object.freeze([]),
      );
    }
    const sessionId = sessionIdValue;
    const sessionKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const operationId = `session-delete:sha256:${sessionKey}`;
    const entries = [...(this.sessionListeners.get('session/disposed') ?? [])].filter(
      (entry) => entry.active && entry.instance.phase === 'active',
    );
    const outcomes = await Promise.all(entries.map(async (entry) => {
      let attempt = entry.sessionCleanupAttempts.get(sessionKey);
      const replayed = attempt !== undefined;
      if (!attempt) {
        const operation = this.acquireOperation(entry.instance);
        const controller = new AbortController();
        const context: DshSessionCleanupContext = Object.freeze({
          operationId,
          signal: controller.signal,
        });
        const completion = Promise.resolve()
          .then(() => entry.cb(Object.freeze({ id: sessionId }), context))
          .then((result) => {
            if (result === false
              || (result !== null && typeof result === 'object'
                && (result as { ok?: unknown }).ok === false)) {
              throw new DshSessionCleanupRejectedError();
            }
          })
          .finally(() => operation.release());
        // The bounded caller can stop waiting before third-party code settles. Always observe the
        // original Promise so a late rejection cannot become an unhandled process error.
        void completion.catch(() => undefined);
        attempt = { completion, controller, operation };
        entry.sessionCleanupAttempts.set(sessionKey, attempt);
      }
      try {
        await withDeadline(
          attempt.completion,
          this.sessionCleanupTimeoutMs,
          'DSH session cleanup hook',
        );
        return Object.freeze({ pluginId: entry.owner, replayed, code: null });
      } catch (error) {
        let code: DshSessionCleanupFailureCode;
        if (error instanceof DshOperationTimeoutError) {
          code = 'hook-timeout';
          if (!attempt.controller.signal.aborted) {
            attempt.controller.abort(new Error('dsh-session-cleanup-hook-timeout'));
          }
          attempt.operation.force();
        } else {
          code = error instanceof DshSessionCleanupRejectedError ? 'hook-rejected' : 'hook-failed';
        }
        return Object.freeze({ pluginId: entry.owner, replayed, code });
      }
    }));
    const failures = outcomes.flatMap((outcome): DshSessionCleanupFailure[] => (
      outcome.code === null ? [] : [{ pluginId: outcome.pluginId, code: outcome.code }]
    ));
    const summary = Object.freeze({
      scanned: outcomes.length,
      completed: outcomes.length - failures.length,
      replayed: outcomes.filter((outcome) => outcome.replayed).length,
      failed: failures.length,
      timedOut: failures.filter((failure) => failure.code === 'hook-timeout').length,
    });
    if (failures.length > 0) {
      throw new DshSessionCleanupError(
        'dsh-session-cleanup-failed',
        summary,
        Object.freeze(failures.map((failure) => Object.freeze(failure))),
      );
    }
    return Object.freeze({
      scanned: summary.scanned,
      completed: summary.completed,
      replayed: summary.replayed,
    });
  }

  emitSessionCreated(session: DshSessionEventPayload['session']): void {
    this.emitToListeners('session/created', session);
  }

  private emitToListeners(event: string, ...args: unknown[]): void {
    for (const entry of this.sessionListeners.get(event) ?? []) {
      const inst = entry.instance;
      if (!entry.active || inst.phase !== 'active') continue;
      const operation = this.acquireOperation(inst);
      try {
        const result = entry.cb(...args);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          const observed = Promise.resolve(result).then(
            () => undefined,
            (error) => {
              const timing = operation.isForced() ? '强制结束后的迟到异常' : '事件监听异常';
              console.warn(`[dsh-插件] ${entry.owner} ${timing} ${event}: ${errorMessage(error)}`);
            },
          );
          void Promise.race([observed, operation.forced]).finally(() => operation.release());
        } else {
          operation.release();
        }
      } catch (error) {
        console.warn(`[dsh-插件] ${entry.owner} 事件监听异常 ${event}: ${errorMessage(error)}`);
        operation.release();
      }
    }
  }

  /**
   * 桥接辅助：把 jiuguan 回合的 usage 映射为 DSH assistant/message + turn/end 两连发。
   * jiuguan 的 OpenAI usage(prompt_tokens/completion_tokens) → DSH TokenUsage；
   * DeepSeek 的 prompt_cache_hit_tokens/prompt_cache_miss_tokens 若在 raw 中则映射缓存档。
   */
  emitJiuguanTurn(opts: {
    sessionId: string; card?: string; round: number; model: string;
    promptTokens: number; completionTokens: number;
    cacheReadTokens?: number;
  }): void {
    const input = Math.max(0, opts.promptTokens - (opts.cacheReadTokens ?? 0));
    this.emitSessionEvent(
      { id: opts.sessionId, card: opts.card, round: opts.round },
      {
        type: 'assistant/message',
        data: {
          turn: opts.round,
          message: { source: { model: opts.model } },
          usage: {
            inputTokens: input,
            outputTokens: opts.completionTokens,
            ...(opts.cacheReadTokens !== undefined ? { cacheReadTokens: opts.cacheReadTokens } : {}),
          },
        },
      },
    );
    this.emitSessionEvent({ id: opts.sessionId, card: opts.card, round: opts.round }, { type: 'turn/end', data: { turn: opts.round } });
  }

  /** 重载全部启用插件（启动时调用；单插件失败仅告警不阻断其余） */
  async loadAll(records: PluginRecord[], dirOf: (rec: PluginRecord) => string): Promise<DshLoadResult[]> {
    let ok = 0;
    const results: DshLoadResult[] = [];
    for (const rec of records) {
      // registry.kind 是启动期的权威意图：已登记为 DSH 的启用项必须得到 active/failed，
      // 不能再用目录探测静默跳过，否则丢目录/坏 package.json 会在 UI 中伪装成 inactive。
      if (!rec.enabled || rec.kind !== 'dsh') continue;
      try {
        const dir = dirOf(rec);
        await this.load(rec, dir);
        ok++;
        results.push({ id: rec.id, status: 'active' });
      } catch (e) {
        const error = errorMessage(e);
        results.push({ id: rec.id, status: 'failed', error });
        console.warn(`[dsh-插件] ${rec.id} 加载失败: ${error}`);
      }
    }
    if (ok > 0) console.log(`[dsh-插件] 已加载 ${ok} 个 DSH 标准插件`);
    return results;
  }
}

/** 凭据解析默认实现：环境变量优先 → provider.json（JG_API_KEY 复用平台 key） */
export function createEnvCredentialResolver(): (name: string) => Promise<DshCredential | null> {
  return async (name) => {
    const v = process.env[name];
    if (v) return { value: v };
    return null;
  };
}

export { CREDENTIAL_NAMES };
