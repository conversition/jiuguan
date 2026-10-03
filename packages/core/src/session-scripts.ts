/**
 * 会话脚本清单与能力描述（FE-B1/B3 · 通用核心）
 *
 * ── 设计约束（FE-B 通用性要求）────────────────────────────────────────────
 * 1. 示例卡 是**首个真实验收样本**，不是宿主的业务模型。本文件（通用核心）不得内置
 *    卡名、剧情列表、世界书 UID、变量初值或任何卡专属业务算法。
 * 2. 通用核心只处理：脚本身份 / 启用状态 / 原始顺序 / 执行方式 / 所需能力 / 导出能力 /
 *    明确依赖 / 执行环境 / 权限 / 初始化状态 / 错误 / 清理与恢复。
 * 3. `story-data`、`story-logic` 这类名称只是**卡片适配标签**（adapterTags），
 *    仅用于报告与选型提示，**绝不作为所有卡的固定执行阶段**。
 * 4. 调度只依据 `dependsOn` + 原始顺序；依赖无法确定时**明确记录**（unknownDeps），
 *    不以长度、名称或猜测强行执行。
 * 5. MVU 是**可装配能力**：不使用 MVU 的卡不被强制初始化 MVU；
 *    需要 DOM 的卡走浏览器后端，不影响纯文本 / 无头 / CLI 路径。
 *
 * 文件内按三层组织：§A 通用核心 → §B 协议适配 → §C 卡片适配配置
 */

import { createHash } from 'node:crypto';
import type { CardImportManifest, NormalizedCardScript } from './chara.ts';

// ══════════════════════════ §A 通用核心 ══════════════════════════

/** 脚本使用到的能力（与具体卡无关的通用能力名） */
export type ScriptCapability =
  | 'mvu-kernel'          // 加载变量更新内核（远程 bundle）
  | 'mvu-schema'          // 向内核注册变量结构
  | 'shared-export'       // 向全局导出共享对象/函数
  | 'bypass-generation'   // 旁路生成（不经主聊天发送的后台生成）
  | 'dom-ui'              // 挂载 DOM 界面
  | 'network-module'      // 需要远程 ESM 模块
  | 'storage';            // 需要本地存储（localStorage / IndexedDB）

export type ScriptExecution = 'classic' | 'module';
/** 执行环境：page = 需要真实页面（DOM）；any = 纯逻辑，任意运行时 */
export type ScriptEnvironment = 'page' | 'any';

export interface SessionScriptDescriptor {
  // ── 身份与顺序 ──
  id: string;
  name: string;
  enabled: boolean;
  /** 卡内原始顺序（调度稳定序；不因名称/长度改变） */
  order: number;
  contentHash: string;
  contentLength: number;
  // ── 执行方式与环境 ──
  execution: ScriptExecution;
  environment: ScriptEnvironment;
  /** 本脚本使用到的能力（通用名） */
  capabilities: ScriptCapability[];
  // ── 依赖（明确） ──
  /** 本脚本向全局导出的符号 */
  provides: string[];
  /** 本脚本从全局读取的符号 */
  requires: string[];
  /** 明确依赖的其它脚本 id（requires ∩ provides，或由卡片配置补充） */
  dependsOn: string[];
  /** 依赖来源：derived = 由符号推导；declared = 卡片配置补充 */
  dependsOnSource: 'derived' | 'declared' | 'mixed';
  /** 无法确定的依赖（明确记录，不猜测） */
  unknownDeps: string[];
  // ── 卡片适配标签（仅报告/选型，非执行阶段） ──
  adapterTags: string[];
  adapterTagReasons: string[];
  notes: string[];
}

export interface DeferredScript {
  id: string;
  name: string;
  reason: string;
  /** 分类：disabled / unrecognized / optional-plugin / environment-unsupported / dependency-cycle */
  kind: 'disabled' | 'unrecognized' | 'optional-plugin' | 'environment-unsupported' | 'dependency-cycle'
    | 'capability-unsupported' | 'upstream-unavailable'
    /** 卡片配置层声明"本批不装载"（限定适用版本 + 记录原因；不是权限放宽） */
    | 'scoped-out';
  /** 是否可选（可选缺失 → 降级；必需缺失 → 阻止） */
  optional: boolean;
}

export interface SessionCapabilityReport {
  /** 清单内脚本使用到的能力 */
  used: ScriptCapability[];
  /** 需要运行时提供者但当前未就绪的能力（**不阻止开局**：其业务由 Agent/StateStore 接管，相应脚本不装载） */
  unsupportedRuntime: ScriptCapability[];
  /** 已由清单内脚本满足的能力 */
  satisfied: ScriptCapability[];
  /** **必需但缺失** → 必须阻止相关模式启动（不得显示"已就绪"） */
  missing: ScriptCapability[];
  /** 需要宿主运行时提供的能力（如 dom-ui 需浏览器后端） */
  hostRequired: ScriptCapability[];
  /** 可选模块未启用（如插件），准确降级而非失败 */
  optionalNotEnabled: string[];
}

// ────────────────────────── 供给能力（宿主/卡片）与操作级就绪（FE-C0） ──────────────────────────

/**
 * 供给能力（宿主/卡片），与「脚本使用到的能力」分开命名空间 ——
 * 避免把「脚本用到某能力」当成「业务操作可用」。
 */
export type OperationCapability =
  | 'worldbook-write'   // 世界书写入（宿主）
  | 'draft'             // 草稿桥（宿主）
  | 'variable-store'    // 权威状态仓库（宿主；FE-C1 起与引擎是否存在无关）
  | 'variables-write'   // 变量写入路径（宿主 Mvu 门面 / replaceVariables）
  | 'mvu-adapter'       // 变量更新适配器（回合内按 schema 解释更新）
  | 'mvu-schema';       // 变量结构注册与校验

export type OperationName = 'preview' | 'draft' | 'commit-variables' | 'variable-turn';

export interface OperationRequirement {
  capability: OperationCapability;
  required: boolean;
  /** 为什么需要 / 为什么不需要（可审计；避免"感觉缺了就全阻断"） */
  why: string;
}

/**
 * 各业务操作的能力要求。
 *
 * **取证**：示例卡 开局页自身的 `useMvu = !!MvuObj`（只判 `getMvuData` 是否为函数），
 * 走的是 `getMvuData` / `replaceMvuData` 的 `stat_data` 读写 —— **不经过 schema 校验**；
 * schema（变量结构）作用于**回合内** AI 产出的变量更新。故：
 *  - `commit-variables`（正式变量型开局）需要：世界书写入 + 权威状态仓库 + 变量写入路径；
 *  - `variable-turn`（回合内变量演化）才需要 mvu-adapter / mvu-schema。
 * 这样既不把「界面成功」当「变量已保存」，也不把可选能力当成开局硬依赖。
 */
export const OPERATION_REQUIREMENTS: Record<OperationName, OperationRequirement[]> = {
  preview: [],
  draft: [{ capability: 'draft', required: true, why: '草稿链需要宿主草稿桥' }],
  'commit-variables': [
    { capability: 'worldbook-write', required: true, why: '开局要写入初始化/开场世界书条目' },
    { capability: 'variable-store', required: true, why: '开局要保存第 0 楼变量且必须可读回' },
    { capability: 'variables-write', required: true, why: '开局要经 Mvu 门面/replaceVariables 真正写入变量' },
  ],
  'variable-turn': [
    { capability: 'mvu-adapter', required: true, why: '回合内变量更新需要适配器解释' },
    { capability: 'mvu-schema', required: true, why: '回合内更新需要 schema 校验' },
  ],
};

/** 提供者来源：卡片自带 / 宿主显式选定 / 无 */
export type ProviderSource = 'card' | 'host' | 'none';

/** 能力状态的**五段式**：发现需求 → 选定提供者 → 加载完成 → 初始化完成 → 操作能力验证通过 */
export type CapabilityStage = 'discovered' | 'provider-selected' | 'loaded' | 'initialized' | 'verified';

export interface CapabilityResolution {
  capability: OperationCapability;
  /** 该能力被哪些操作需要 */
  requiredBy: string[];
  source: ProviderSource;
  providerId?: string;
  version?: string;
  /** 同名多个提供者（无明确协议/配置裁决）→ 歧义，不得默认取第一个 */
  ambiguousWith?: string[];
  stage: CapabilityStage;
  ok: boolean;
  reason: string;
}

export interface OperationReadiness {
  operation: OperationName;
  ok: boolean;
  /** 缺失的必需能力 */
  missing: OperationCapability[];
  reason: string;
}

/** 宿主可提供的能力（协议适配层声明；`available=false` 表示本批未实现，**不得**当作可用） */
export interface HostProviderDeclaration {
  capability: OperationCapability;
  providerId: string;
  version: string;
  available: boolean;
  note: string;
}

/**
 * 宿主能力声明（默认值；可由 `BuildPlanOptions.hostProviders` 覆盖 —— 用于「用户显式选择兼容实现」）。
 * 关键点：`mvu-adapter` / `mvu-schema` 默认 **available=false** —— 直到有真实协议提供者（FE-C3）。
 */
export const DEFAULT_HOST_PROVIDERS: HostProviderDeclaration[] = [
  { capability: 'worldbook-write', providerId: 'host:worldbook-bridge', version: 'fe02', available: true, note: '世界书读写 RPC + 形状桥接' },
  { capability: 'draft', providerId: 'host:draft-bridge', version: 'fe01', available: true, note: '草稿桥（只发 draft，不自动发送）' },
  { capability: 'variable-store', providerId: 'host:state-store', version: 'fe-c1', available: true, note: '权威状态仓库（与引擎生命周期解耦）' },
  { capability: 'variables-write', providerId: 'host:mvu-facade', version: 'fe01', available: true, note: 'Mvu 门面 getMvuData/replaceMvuData + replaceVariables' },
  { capability: 'mvu-adapter', providerId: 'host:mvu-adapter', version: 'none', available: false, note: '待 FE-C3：真实 z / schema 注册 / MVU 协议适配' },
  { capability: 'mvu-schema', providerId: 'host:mvu-schema', version: 'none', available: false, note: '待 FE-C3：真实 Zod + registerMvuSchema' },
];

export const ALL_OPERATION_CAPABILITIES: OperationCapability[] = [
  'worldbook-write', 'draft', 'variable-store', 'variables-write', 'mvu-adapter', 'mvu-schema',
];

/** 单脚本的执行准入结论（FE-04.0：让「Agent 主导模式」真正落到执行清单，可审计） */
export interface ScriptAdmission {
  id: string;
  name: string;
  decision: 'load' | 'not-load';
  /** 执行位置：page = 必须在可见页面 realm（导出全局 / 挂载 DOM / 使用页面存储）；session = 会话级副作用模块 */
  scope: ScriptScope;
  /** 该脚本的保留产出（导出的全局符号；空 = 纯副作用） */
  retainedOutput: string[];
  reason: string;
}

export type ScriptScope = 'page' | 'session';

/**
 * **能力 → 其运行时提供者**（通用核心：描述「这项能力需要谁提供」，不是卡片特判）。
 * 提供者未就绪时，**消费该能力且没有其它保留产出**的脚本不装载 ——
 * 而不是让它空跑/报错，也不是靠补齐一整套框架来消除错误。
 */
export const CAPABILITY_PROVIDER_REQUIREMENTS: Partial<Record<ScriptCapability, OperationCapability>> = {
  // 变量更新内核：需要变量更新适配器提供者（卡片自带内核，或用户显式选定的宿主实现）
  'mvu-kernel': 'mvu-adapter',
  // 变量结构注册：注册函数由变量更新适配器提供
  'mvu-schema': 'mvu-adapter',
};

export interface SessionScriptPlan {
  version: 2;
  cardName: string;
  manifestHash: string;
  /** 本次实际执行的运行环境（决定哪些脚本被 environment-unsupported 推迟） */
  environment: RunEnvironment;
  descriptors: SessionScriptDescriptor[];
  /** 拓扑排序后的可执行脚本 id（仅 enabled 且未被推迟） */
  executionOrder: string[];
  deferred: DeferredScript[];
  /** 同名多提供者（无明确裁决）→ 歧义；不得默认取第一个当作正确实现（FE-C0） */
  ambiguousProviders: { symbol: string; providers: string[]; reason: string }[];
  /** 能力供给解析（五段式；FE-C0） */
  capabilityResolutions: CapabilityResolution[];
  /** 操作级就绪（区分预览 / 草稿 / 正式变量开局 / 回合内演化；FE-C0） */
  operationReadiness: OperationReadiness[];
  /** **阻止性**结构问题（必需能力缺失 / 依赖成环）→ 必须阻止相关模式启动 */
  gaps: string[];
  /** **非阻止性**记录（未知依赖 / 可选模块未启用）→ 必须显示，但不阻止 */
  warnings: string[];
  /** 未知依赖明细：读取了某共享全局，但清单内无提供者（可能由消息内嵌 UI 或运行时提供） */
  unknownDeps: { script: string; symbol: string; note: string }[];
  capabilities: SessionCapabilityReport;
  /** 是否需要浏览器运行后端（存在 dom-ui 需求且环境为 browser） */
  requiresBrowserRuntime: boolean;
  /** 未识别脚本（保留原始顺序但不执行） */
  unrecognized: { id: string; name: string; reason: string }[];
  /** 使用的卡片适配器 id（可审计） */
  adapterIds: string[];
  /** 逐脚本执行准入结论（FE-04.0） */
  admission: ScriptAdmission[];
}

export type RunEnvironment = 'browser' | 'headless';

export interface BuildPlanOptions {
  /** 运行环境；默认 browser。headless（CLI / 单测）会把 dom-ui 脚本推迟而非失败 */
  environment?: RunEnvironment;
  /** 额外卡片适配器（默认使用内置注册表） */
  adapters?: CardScriptAdapter[];
  /** 宿主能力声明（默认 DEFAULT_HOST_PROVIDERS）。用于「用户显式选择兼容实现」而不改卡片内容 */
  hostProviders?: HostProviderDeclaration[];
}

// ────────────────────────── 内容分析工具（通用，无卡名） ──────────────────────────

/** 去掉行注释与块注释，避免注释里的关键词造成误判 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 顶层 ESM import（含 `import 'x'` 与 `import a from 'x'`） */
function moduleImports(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

const GLOBAL_HOSTS = '(?:target|window|globalThis|top|parent|self)';
const EXPLICIT_HOSTS = '(?:window|globalThis|top|parent|self)';

/**
 * 向全局赋值的符号。
 * `window.X = …` 一类**显式宿主赋值**始终计入；
 * `target.X = …` 形式（常见于 `targets.forEach(target => …)` 的多宿主挂载）仅在
 * X 的命名像共享导出（PascalCase / SCREAMING_CASE / __ 前缀）时计入 ——
 * 否则会把 `target.enabled = true` 这类局部字段误判为导出。
 */
function globalProvides(code: string): string[] {
  const out = new Set<string>();
  const explicit = new RegExp(`${EXPLICIT_HOSTS}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)`, 'g');
  for (const m of code.matchAll(explicit)) out.add(m[1]);
  const viaTarget = new RegExp(`target\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)`, 'g');
  for (const m of code.matchAll(viaTarget)) {
    const sym = m[1];
    if (/^__/.test(sym) || /^[A-Z]/.test(sym) || /^[A-Z0-9_]{3,}$/.test(sym)) out.add(sym);
  }
  return [...out];
}

/** 从全局读取的符号（赋值除外）：`target.CardShared.STORY_MAP` */
function globalReads(code: string, candidates: string[]): string[] {
  const out: string[] = [];
  for (const name of candidates) {
    const re = new RegExp(`${GLOBAL_HOSTS}\\s*\\.\\s*${name.replace(/[$]/g, '\\$')}\\b(?!\\s*=(?!=))`);
    if (re.test(code)) out.push(name);
  }
  return out;
}

/** 命名像共享符号（PascalCase / SCREAMING_CASE / __ 前缀） */
function looksLikeSharedSymbol(sym: string): boolean {
  return /^__/.test(sym) || /^[A-Z]/.test(sym) || /^[A-Z0-9_]{3,}$/.test(sym);
}

/**
 * 通过全局宿主**读取**的符号候选（不限清单内已知符号）。
 * 用于发现「读了某个共享符号，但清单内无人提供」的**未知依赖** —— 明确记录，不猜测。
 */
function globalReadCandidates(code: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`${GLOBAL_HOSTS}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b(?!\\s*=(?!=))`, 'g');
  for (const m of code.matchAll(re)) if (looksLikeSharedSymbol(m[1])) out.add(m[1]);
  return [...out];
}

/** 只含 import 语句（剥注释与空白后无其它逻辑） */
function isBareImportOnly(code: string): boolean {
  const stripped = stripComments(code).replace(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"][^'"]+['"];?/gm, '');
  return stripped.trim().length === 0;
}

// ══════════════════════════ §B 协议适配 ══════════════════════════
// TavernHelper / MVU 等**协议**形状的识别。协议名（非卡名）出现在此层是允许的。

/** MVU 内核 bundle 的远程地址特征（协议适配层；不含卡名） */
const MVU_KERNEL_URL_RE = /MagVarUpdate|magvarupdate|magvar|\/mvu[-_.]|\/bundle\.js/i;
/** 变量结构注册协议 */
const MVU_SCHEMA_RE = /\bregisterMvuSchema\s*\(/;
/** MVU 运行时对象协议 */
const MVU_RUNTIME_RE = /\bMvu\s*\.\s*(?:events|getMvuData|replaceMvuData|setMvuVariable)\b/;
/** 旁路生成协议：不经过主聊天发送的后台生成 */
const BYPASS_GENERATION_RE = /\bgenerateRaw\s*\(|\bgenerateQuietPrompt\s*\(|\bTavernHelper\s*\.\s*generate\b/;
/** DOM 界面挂载特征（含 jQuery 的 `$(` 惯用法：选择器 / ready 回调均需 DOM） */
const DOM_RE = /document\s*\.\s*(?:getElementById|createElement|querySelector|head|body)\b|\$\(/;
/** 存储特征 */
const STORAGE_RE = /\blocalStorage\b|\bIndexedDB\b|\bindexedDB\b|\bGM_setValue\b/;

/**
 * 宿主兼容契约提供的全局符号（协议适配层）。
 * 这些符号由宿主 shim / 兼容运行时提供，不属于「卡片脚本之间的依赖」，
 * 因此不参与 unknownDeps 判定 —— 否则每张卡都会报一堆假缺口。
 */
export const HOST_PROVIDED_GLOBALS = new Set([
  // SillyTavern 生态
  'SillyTavern', 'TavernHelper', 'toastr', 'eventSource', 'eventOn', 'eventEmit', 'eventRemoveListener',
  'jQuery', '_', 'z', 'getContext', 'substituteParams', 'formatAsTavernRegexedString',
  // 宿主兼容接口
  'getSTFn', 'getVariables', 'replaceVariables', 'waitGlobalInitialized',
  'getWorldbook', 'getCharWorldbookNames', 'updateWorldbookWith', 'getLastMessageId',
  'getChatMessages', 'getMessageId', 'setExtensionPrompt', 'generateRaw', 'triggerSlash',
  // MVU 协议
  'Mvu', 'MvuEvents', 'MagVarUpdate', 'registerMvuSchema',
]);

/** 通用能力探测（协议层）：返回脚本使用到的能力集合 */
export function detectCapabilities(script: NormalizedCardScript): ScriptCapability[] {
  const code = stripComments(script.content);
  const caps = new Set<ScriptCapability>();
  const imports = moduleImports(script.content);
  if (imports.some((u) => /^https?:/i.test(u))) caps.add('network-module');
  if (isBareImportOnly(script.content) && script.remoteImports.some((u) => MVU_KERNEL_URL_RE.test(u))) caps.add('mvu-kernel');
  if (MVU_SCHEMA_RE.test(code) || MVU_RUNTIME_RE.test(code)) caps.add('mvu-schema');
  if (BYPASS_GENERATION_RE.test(code)) caps.add('bypass-generation');
  if (globalProvides(code).length > 0) caps.add('shared-export');
  if (DOM_RE.test(code)) caps.add('dom-ui');
  if (STORAGE_RE.test(code)) caps.add('storage');
  return [...caps];
}

/** 内核脚本选取（通用）：能力含 mvu-kernel 者；不再按长度/卡名选择 */
export function pickMvuKernel(plan: SessionScriptPlan, manifest: CardImportManifest): NormalizedCardScript | undefined {
  const byId = new Map(manifest.scripts.map((s) => [s.id, s]));
  const d = plan.executionOrder
    .map((id) => plan.descriptors.find((x) => x.id === id))
    .find((x) => x?.capabilities.includes('mvu-kernel'));
  return d ? byId.get(d.id) : undefined;
}

// ══════════════════════════ §C 卡片适配配置 ══════════════════════════
// 卡片专属标签 / 依赖补充 / 版本化兼容规则。**独立存放、限定适用版本、记录原因**。
// 禁止把卡片业务搬进通用核心；此处的规则只影响「标签」与「补充声明」，不改变通用调度。

export interface AdapterTagRule {
  tag: string;
  reason: string;
  test: (ctx: AdapterContext) => boolean;
}

export interface AdapterContext {
  name: string;
  raw: string;
  code: string;
  remoteImports: string[];
  provides: string[];
  capabilities: ScriptCapability[];
  /** 依赖的其它脚本数量（0 = 生产者；>0 = 消费者） */
  dependsOnCount: number;
}

export interface CardScriptAdapter {
  /** 适配器标识（可审计） */
  id: string;
  /** 适用卡范围（按卡名匹配；不含业务逻辑） */
  match: (m: CardImportManifest) => boolean;
  /** 适用版本说明（记录用） */
  appliesTo: string;
  /** 仅打标签（报告/选型），不改变调度 */
  tagRules: AdapterTagRule[];
  /** 旧卡无显式依赖声明时，补充必要关系（可选） */
  hints?: {
    byNamePattern?: { pattern: RegExp; requires?: string[]; provides?: string[] }[];
    /**
     * 声明式"本批不装载"（**卡片配置层**，必须限定适用版本 + 记录原因）。
     * 用途：该能力的实现属后续阶段（例如手机 UI 属 FE-05），本批既不能装也不能假装已支持。
     * 纪律：只减不增 —— 这里只能停止装载，不能放宽权限或复活被禁用的脚本。
     */
    defer?: { pattern: RegExp; reason: string; appliesTo: string }[];
  };
}

/**
 * 公开版不内置针对私人角色卡或第三方远程页面的特化适配器。
 * 调用方仍可通过 opts.adapters 注入自己的 CardScriptAdapter。
 */
export const BUILTIN_CARD_ADAPTERS: CardScriptAdapter[] = [];

function classify(manifest: CardImportManifest, ctx: AdapterContext, adapters: CardScriptAdapter[]): { tags: string[]; reasons: string[]; adapterIds: string[] } {
  const tags: string[] = [];
  const reasons: string[] = [];
  const adapterIds: string[] = [];
  for (const a of adapters) {
    if (!a.match(manifest)) continue;
    adapterIds.push(a.id);
    for (const rule of a.tagRules) {
      if (rule.test(ctx)) { tags.push(rule.tag); reasons.push(`${a.id}: ${rule.reason}`); }
    }
  }
  return { tags, reasons, adapterIds };
}

/** 能力 ↔ 相关全局符号（用于歧义裁决） */
const CAPABILITY_SYMBOLS: Partial<Record<OperationCapability, string[]>> = {
  'mvu-adapter': ['Mvu'],
  'mvu-schema': ['registerMvuSchema'],
};

/**
 * 能力供给解析（FE-C0 五段式）。
 * 纪律：`provider-selected` ≠ `verified` —— 找到提供者不算能力可用，
 * 必须有运行时验证（浏览器宿主或宿主探针）才升到 `verified`。
 */
export function resolveCapabilities(
  manifest: CardImportManifest,
  descriptors: SessionScriptDescriptor[],
  executionOrder: string[],
  hostProviders: HostProviderDeclaration[],
  ambiguousProviders: { symbol: string; providers: string[]; reason: string }[],
): CapabilityResolution[] {
  const requiredBy: Partial<Record<OperationCapability, string[]>> = {};
  for (const [op, reqs] of Object.entries(OPERATION_REQUIREMENTS)) {
    for (const r of reqs) if (r.required) requiredBy[r.capability] = [...(requiredBy[r.capability] ?? []), op];
  }
  const usedScriptCaps = new Set(descriptors.filter((d) => d.enabled).map((d) => d).flatMap((d) => d.capabilities));
  const out: CapabilityResolution[] = [];
  for (const cap of ALL_OPERATION_CAPABILITIES) {
    const host = hostProviders.find((h) => h.capability === cap);
    const amb = ambiguousProviders.find((a) => (CAPABILITY_SYMBOLS[cap] ?? []).includes(a.symbol));
    // 卡片侧提供者候选（**提供者 ≠ 已验证**）：按能力找候选，不看是否已准入 ——
    // 「找到了卡片提供者，但它未被准入装载」必须能被如实报出（而不是显示"未发现提供者"）。
    const candidate = cap === 'mvu-adapter'
      ? descriptors.find((d) => d.enabled && d.capabilities.includes('mvu-kernel'))
      : cap === 'mvu-schema'
        ? descriptors.find((d) => d.enabled && d.capabilities.includes('mvu-schema'))
        : undefined;
    const cardProvider = candidate && executionOrder.includes(candidate.id) ? candidate : undefined;

    let source: ProviderSource = 'none';
    let providerId: string | undefined;
    let version: string | undefined;
    let stage: CapabilityStage = 'discovered';
    let ok = false;
    let reason: string;

    if (host?.available) {
      source = 'host'; providerId = host.providerId; version = host.version;
      stage = 'loaded';
      ok = true;
      reason = `宿主提供（${host.version}）：${host.note}`;
    } else if (cardProvider) {
      source = 'card'; providerId = cardProvider.id; version = cardProvider.contentHash.slice(0, 8);
      stage = 'provider-selected';
      ok = false;
      reason = `卡片脚本「${cardProvider.name}」被选为提供者，但尚未运行时验证（provider-selected ≠ verified）`;
    } else if (candidate) {
      // 找到卡片侧提供者但其**未被准入装载**（例如本宿主缺少该内核的运行前提）→ 如实报告
      source = 'card'; providerId = candidate.id; version = candidate.contentHash.slice(0, 8);
      stage = 'provider-selected';
      ok = false;
      reason = `卡片脚本「${candidate.name}」是该能力的提供者，但未通过执行准入（未装载）；`
        + '需要宿主补齐该内核对运行前提的支持后才可用（本轮不靠补齐框架消除错误）';
    } else if (host && !host.available) {
      source = 'none'; providerId = host.providerId; version = host.version;
      stage = 'discovered'; ok = false;
      reason = `宿主声明存在但当前不可用：${host.note}`;
    } else {
      stage = usedScriptCaps.has('mvu-schema') && (cap === 'mvu-adapter' || cap === 'mvu-schema')
        ? 'discovered' : 'discovered';
      ok = false;
      reason = '未发现提供者';
    }

    if (amb) {
      ok = false;
      stage = 'provider-selected';
      reason = `${amb.reason}（提供者：${amb.providers.length} 个）——按契约不得默认取第一个`;
    }

    out.push({
      capability: cap,
      requiredBy: requiredBy[cap] ?? [],
      source, providerId, version,
      ambiguousWith: amb?.providers,
      stage, ok, reason,
    });
  }
  return out;
}

/** 操作级就绪：每个业务操作按其必需能力逐项判定（缺一即不就绪，附明确原因） */
export function buildOperationReadiness(resolutions: CapabilityResolution[]): OperationReadiness[] {
  const byCap = new Map(resolutions.map((r) => [r.capability, r]));
  const out: OperationReadiness[] = [];
  for (const op of Object.keys(OPERATION_REQUIREMENTS) as OperationName[]) {
    const reqs = OPERATION_REQUIREMENTS[op].filter((r) => r.required);
    const missing = reqs.filter((r) => !byCap.get(r.capability)?.ok).map((r) => r.capability);
    const ok = missing.length === 0;
    const reason = ok
      ? (reqs.length ? `所需能力齐备：${reqs.map((r) => r.capability).join(' + ')}` : '无额外能力要求')
      : missing.map((c) => `${c}（${byCap.get(c)?.reason ?? '未发现提供者'}）`).join('；');
    out.push({ operation: op, ok, missing, reason });
  }
  return out;
}

// ────────────────────────── 计划构建 ──────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 拓扑排序：按原始 order 依次 DFS，依赖先于被依赖者输出（保持原卡顺序） */
function topoSort(descriptors: SessionScriptDescriptor[]): { order: string[]; cycle: string[] } {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  const sorted = [...descriptors].sort((a, b) => a.order - b.order);
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const cycle = new Set<string>();
  const visit = (id: string) => {
    const st = state.get(id);
    if (st === 'done') return;
    if (st === 'visiting') { cycle.add(id); return; }
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep);
    state.set(id, 'done');
    order.push(id);
  };
  for (const d of sorted) visit(d.id);
  return { order, cycle: [...cycle] };
}

export function buildSessionScriptPlan(manifest: CardImportManifest, opts: BuildPlanOptions = {}): SessionScriptPlan {
  const environment: RunEnvironment = opts.environment ?? 'browser';
  const adapters = opts.adapters ?? BUILTIN_CARD_ADAPTERS;
  const hostProviders = opts.hostProviders ?? DEFAULT_HOST_PROVIDERS;

  // 1) 通用字段抽取（能力/导出/依赖线索）
  const analyzed = manifest.scripts.map((s) => {
    const code = stripComments(s.content);
    return {
      script: s,
      code,
      execution: (moduleImports(s.content).length > 0 ? 'module' : 'classic') as ScriptExecution,
      capabilities: detectCapabilities(s),
      provides: globalProvides(code),
    };
  });

  // 2) 依赖推导（requires ∩ provides）+ 卡片配置补充
  //    先算依赖，再打标签 —— 因为「生产者 vs 消费者」判定需要依赖信息。
  const providerOf = new Map<string, string>();
  const providersBySymbol = new Map<string, string[]>();
  for (const a of analyzed) {
    for (const p of a.provides) {
      if (!providerOf.has(p)) providerOf.set(p, a.script.id);
      providersBySymbol.set(p, [...(providersBySymbol.get(p) ?? []), a.script.id]);
    }
  }
  const allProvided = [...providerOf.keys()];
  // 同名多提供者：内容哈希相同视为重复（不算歧义）；不同实现且无明确裁决 → 歧义
  const ambiguousProviders: { symbol: string; providers: string[]; reason: string }[] = [];
  for (const [sym, ids] of providersBySymbol) {
    if (ids.length < 2) continue;
    const hashes = new Set(ids.map((id) => analyzed.find((a) => a.script.id === id)?.script.contentHash));
    if (hashes.size < 2) continue;
    ambiguousProviders.push({
      symbol: sym,
      providers: ids,
      reason: `符号 ${sym} 有 ${ids.length} 个内容不同的提供者；无明确协议/配置裁决时不得默认取第一个`,
    });
  }

  const withDeps = analyzed.map((a) => {
    const reads = globalReads(a.code, allProvided);
    const derived = [...new Set(reads.map((r) => providerOf.get(r)!).filter((id) => id && id !== a.script.id))];
    // 卡片配置补充（旧卡无显式声明时）
    const declared: string[] = [];
    for (const ad of adapters) {
      if (!ad.match(manifest) || !ad.hints?.byNamePattern) continue;
      for (const h of ad.hints.byNamePattern) {
        if (!h.pattern.test(a.script.name)) continue;
        for (const need of h.requires ?? []) {
          const pid = analyzed.find((x) => x.provides.includes(need))?.script.id;
          if (pid && pid !== a.script.id && !derived.includes(pid)) declared.push(pid);
        }
      }
    }
    return { ...a, reads, derived, declared, dependsOn: [...new Set([...derived, ...declared])] };
  });

  // 3) 卡片适配标签（仅报告；不参与调度）
  const adapterIds = new Set<string>();
  const tagged = withDeps.map((a) => {
    const ctx: AdapterContext = {
      name: a.script.name, raw: a.script.content, code: a.code,
      remoteImports: a.script.remoteImports, provides: a.provides,
      capabilities: a.capabilities, dependsOnCount: a.dependsOn.length,
    };
    const { tags, reasons, adapterIds: ids } = classify(manifest, ctx, adapters);
    for (const id of ids) adapterIds.add(id);
    return { ...a, tags, reasons };
  });

  const descriptors: SessionScriptDescriptor[] = tagged.map((a) => {
    // 未知依赖：读取了共享符号，但清单内无人提供、也不属于宿主契约（明确记录，不猜测执行）
    const unknownDeps = globalReadCandidates(a.code)
      .filter((r) => !providerOf.has(r) && !HOST_PROVIDED_GLOBALS.has(r));
    return {
      id: a.script.id,
      name: a.script.name,
      enabled: a.script.enabled,
      order: a.script.order,
      contentHash: a.script.contentHash,
      contentLength: a.script.content.length,
      execution: a.execution,
      environment: (a.capabilities.includes('dom-ui') ? 'page' : 'any') as ScriptEnvironment,
      capabilities: a.capabilities,
      provides: a.provides,
      requires: a.reads,
      dependsOn: a.dependsOn,
      dependsOnSource: a.derived.length && a.declared.length ? 'mixed' : a.declared.length ? 'declared' : 'derived',
      unknownDeps,
      adapterTags: a.tags,
      adapterTagReasons: a.reasons,
      notes: [],
    };
  });

  // 4) 可执行集合筛选（通用规则，不含业务阶段）
  const deferred: DeferredScript[] = [];
  const unrecognized: { id: string; name: string; reason: string }[] = [];
  const runnable: SessionScriptDescriptor[] = [];
  /** 逐脚本执行准入结论（在过滤阶段就会写入"卡片配置声明不装载"的条目） */
  const admission: ScriptAdmission[] = [];
  for (const d of descriptors) {
    if (!d.enabled) {
      deferred.push({ id: d.id, name: d.name, reason: 'disabled（卡内已禁用，不加载）', kind: 'disabled', optional: true });
      continue;
    }
    // 卡片配置层：声明式的"本批不装载"（限定适用版本 + 记录原因）
    const scopedOut = adapters
      .filter((ad) => ad.match(manifest))
      .flatMap((ad) => (ad.hints?.defer ?? []).map((h) => ({ ad, h })))
      .find(({ h }) => h.pattern.test(d.name));
    if (scopedOut) {
      deferred.push({
        id: d.id, name: d.name, kind: 'scoped-out', optional: true,
        reason: `本批不装载（卡片配置 ${scopedOut.ad.id}，适用版本：${scopedOut.h.appliesTo}）：${scopedOut.h.reason}`,
      });
      admission.push({
        id: d.id, name: d.name, decision: 'not-load', scope: 'session', retainedOutput: [],
        reason: scopedOut.h.reason,
      });
      continue;
    }
    if (d.adapterTags.includes('plugin') || d.capabilities.includes('bypass-generation')) {
      // 插件 = 可选模块（持久实例 + 旁路生成）：不阻止普通开局，准确降级
      deferred.push({ id: d.id, name: d.name, reason: 'optional-plugin（持久插件/旁路生成，本轮不加载）', kind: 'optional-plugin', optional: true });
      continue;
    }
    if (d.capabilities.length === 0 && d.provides.length === 0) {
      deferred.push({ id: d.id, name: d.name, reason: 'unrecognized（无任何可识别能力/导出，不猜测执行）', kind: 'unrecognized', optional: true });
      unrecognized.push({ id: d.id, name: d.name, reason: '无任何可识别能力/导出' });
      continue;
    }
    // 运行环境不支持的能力 → 推迟（不是失败：无头路径不应被浏览器依赖破坏，反之亦然）
    //  · page（需要 DOM）
    //  · network-module（远程 ESM）：Node 沙箱 / vm 无法加载远程模块
    const envBlocker = d.environment === 'page'
      ? '需要 DOM 页面'
      : (environment === 'headless' && d.capabilities.includes('network-module') ? '需要远程 ESM 模块（Node 沙箱不支持）' : null);
    if (environment === 'headless' && envBlocker) {
      deferred.push({ id: d.id, name: d.name, reason: `environment-unsupported（${envBlocker}，当前为 ${environment}）`, kind: 'environment-unsupported', optional: true });
      continue;
    }
    runnable.push(d);
  }

  // 4b) 执行准入（FE-04.0）：把「Agent 主导模式」真正落到执行清单
  //     准入 = 作者启用 ∧ 环境支持 ∧ 不消费未就绪的运行时提供者 ∧ 上游已装载
  //     纪律：sideEffectModules（无导出模块名单）**不是执行许可**；
  //          已被 Agent 接管的运行时内核与重复后台，停止入口而不是让它空跑报错。
  const hostProviderOk = (cap: OperationCapability): boolean =>
    (hostProviders.find((h) => h.capability === cap)?.available ?? false) === true;
  const scopeOf = (d: SessionScriptDescriptor): ScriptScope =>
    (d.provides.length > 0 || d.capabilities.includes('dom-ui') || d.capabilities.includes('storage'))
      ? 'page' : 'session';

  const warnings: string[] = [];
  // 同名脚本消歧（真实卡里存在同名但启用状态不同的脚本，例如"资源预载"的禁用副本）
  const nameCount = new Map<string, number>();
  for (const d of descriptors) nameCount.set(d.name, (nameCount.get(d.name) ?? 0) + 1);
  const labelOf = (d: SessionScriptDescriptor): string =>
    (nameCount.get(d.name) ?? 0) > 1 ? `${d.name} #${d.id.slice(0, 6)}` : d.name;

  const notLoad = new Set<string>(deferred.map((x) => x.id));
  const unsupportedRuntime = new Set<ScriptCapability>();
  let pending = [...runnable];
  // 传递性：上游被判定不装载时，下游（且无自留产出者）随之不装载 —— 反复直到稳定
  for (let pass = 0; pass < runnable.length + 1 && pending.length; pass += 1) {
    const next: SessionScriptDescriptor[] = [];
    let changed = false;
    for (const d of pending) {
      const blockedCaps = d.capabilities.filter((c) => {
        const need = CAPABILITY_PROVIDER_REQUIREMENTS[c];
        return !!need && !hostProviderOk(need);
      });
      const blockedUpstream = d.dependsOn.filter((id) => notLoad.has(id));
      const hasOutput = d.provides.length > 0;
      if (blockedCaps.length && !hasOutput) {
        for (const c of blockedCaps) unsupportedRuntime.add(c);
        deferred.push({
          id: d.id, name: labelOf(d), kind: 'capability-unsupported', optional: true,
          reason: `未支持运行时（${blockedCaps.join(', ')} 的提供者未就绪；其业务由 Agent/StateStore 接管，不装载）`,
        });
        admission.push({
          id: d.id, name: labelOf(d), decision: 'not-load', scope: scopeOf(d), retainedOutput: [],
          reason: `消费未就绪的运行时能力 ${blockedCaps.join(', ')}，且自身无保留产出`,
        });
        notLoad.add(d.id);
        changed = true;
        continue;
      }
      if (blockedUpstream.length && !hasOutput) {
        const names = blockedUpstream.map((id) => descriptors.find((x) => x.id === id)?.name ?? id);
        deferred.push({
          id: d.id, name: labelOf(d), kind: 'upstream-unavailable', optional: true,
          reason: `上游未装载（依赖 ${names.join(', ')} 未装载，且自身无保留产出）`,
        });
        admission.push({
          id: d.id, name: labelOf(d), decision: 'not-load', scope: scopeOf(d), retainedOutput: [],
          reason: `上游未装载：${names.join(', ')}`,
        });
        notLoad.add(d.id);
        changed = true;
        continue;
      }
      next.push(d);
    }
    pending = next;
    if (!changed) break;
  }
  // 通过准入者：记录结论（含"含未支持子能力但仍有保留产出"的部分支持）
  for (const d of pending) {
    const blockedCaps = d.capabilities.filter((c) => {
      const need = CAPABILITY_PROVIDER_REQUIREMENTS[c];
      return !!need && !hostProviderOk(need);
    });
    for (const c of blockedCaps) unsupportedRuntime.add(c);
    if (blockedCaps.length) {
      warnings.push(`部分支持：${labelOf(d)} 含未就绪运行时能力 ${blockedCaps.join(', ')}，其保留导出 ${d.provides.join(', ')} 仍装载`);
    }
    const blockedUpstream = d.dependsOn.filter((id) => notLoad.has(id));
    if (blockedUpstream.length) {
      const names = blockedUpstream.map((id) => descriptors.find((x) => x.id === id)?.name ?? id);
      warnings.push(`上游未装载：${labelOf(d)} 依赖 ${names.join(', ')}（该依赖未装载，本脚本按保留产出继续装载）`);
    }
    admission.push({
      id: d.id, name: labelOf(d), decision: 'load', scope: scopeOf(d), retainedOutput: d.provides,
      reason: blockedCaps.length
        ? `保留产出 ${d.provides.join(', ')}；未就绪子能力 ${blockedCaps.join(', ')} 不装载`
        : `准入通过（作用域 ${scopeOf(d)}）`,
    });
  }

  const { order: executionOrder, cycle } = topoSort(pending);
  for (const id of cycle) {
    const d = descriptors.find((x) => x.id === id)!;
    deferred.push({ id, name: d.name, reason: 'dependency-cycle（依赖成环，拒绝执行）', kind: 'dependency-cycle', optional: false });
  }
  const finalOrder = executionOrder.filter((id) => !cycle.includes(id));

  // 5) 能力报告（正确失败：必需缺失必须能被指出）
  const enabledDescriptors = descriptors.filter((d) => d.enabled);
  const used = [...new Set(enabledDescriptors.flatMap((d) => d.capabilities))];
  const providedCaps = new Set(enabledDescriptors.flatMap((d) => d.capabilities));
  const missing: ScriptCapability[] = [];
  // mvu-schema 需要 mvu-kernel 提供者（无内核则结构无法注册）
  if (providedCaps.has('mvu-schema') && !providedCaps.has('mvu-kernel')) missing.push('mvu-kernel');
  // 共享导出消费者需要提供者：以「读取了共享形状全局符号」为准（不限于清单内已知符号），
  // 否则「提供者被移除」时无法识别为必需能力缺失（会误判为"无需提供者"）。
  const hasConsumer = enabledDescriptors.some((d) => {
    const src = withDeps.find((x) => x.script.id === d.id)?.code ?? '';
    return globalReadCandidates(src).some((r) => !HOST_PROVIDED_GLOBALS.has(r));
  });
  if (hasConsumer && !providedCaps.has('shared-export')) missing.push('shared-export');
  const hostRequired: ScriptCapability[] = used.filter((c) => c === 'dom-ui' || c === 'storage');

  // 分级：gaps = 阻止性；warnings = 记录性（不阻止）
  const gaps: string[] = [];
  for (const m of missing) gaps.push(`必需能力缺失：${m}`);
  if (cycle.length) gaps.push(`依赖成环：${cycle.join(', ')}`);

  const unknownDeps: { script: string; symbol: string; note: string }[] = [];
  for (const d of descriptors) {
    for (const u of d.unknownDeps) {
      const note = '清单内无提供者；可能由消息内嵌 UI 或运行时提供（不阻止开局）';
      unknownDeps.push({ script: d.name, symbol: u, note });
      warnings.push(`依赖未知：${d.name} 读取了 ${u} —— ${note}`);
    }
  }
  for (const d of deferred) {
    if (d.optional) warnings.push(`已降级：${d.name} —— ${d.reason}`);
  }

  // 脚本身份冲突（**记录性**，不阻止开局，但必须展示）：
  // 同一 id 对应「内容或启用状态不同」的多个脚本时，执行序与运行包都按 id 索引，
  // 只能解析到其中一个 → 另一个可能**从未运行**却不报错。此前该判定只在 manifest 内部计算，
  // 从不进入本计划的 warnings，等于被静默吞掉。这里如实登记，交由报告/诊断展示。
  for (const id of manifest.capabilities.conflicts ?? []) {
    warnings.push(
      `脚本身份冲突：id「${id}」对应多个内容或启用状态不同的脚本 —— `
      + '执行序与运行包按 id 索引只能装载其中之一，另一个不会运行；建议重命名或移除重复脚本（不阻止开局）',
    );
  }

  const capabilities: SessionCapabilityReport = {
    used,
    // 需要运行时提供者但未就绪的能力：不阻止开局（业务由 Agent/StateStore 接管），相应脚本不装载
    unsupportedRuntime: [...unsupportedRuntime],
    satisfied: [...providedCaps].filter((c) => !unsupportedRuntime.has(c)),
    missing,
    hostRequired,
    optionalNotEnabled: deferred.filter((d) => d.kind === 'optional-plugin').map((d) => d.name),
  };

  const manifestHash = sha256(
    `${manifest.cardName}|${manifest.contentHash}|${manifest.scripts.map((s) => `${s.id}:${s.contentHash}:${s.enabled ? 1 : 0}`).join('|')}`,
  ).slice(0, 32);

  // FE-C0：能力供给解析 + 操作级就绪（区分"预览/草稿成功"与"变量型正式开局成功"）
  const capabilityResolutions = resolveCapabilities(manifest, descriptors, finalOrder, hostProviders, ambiguousProviders);
  const operationReadiness = buildOperationReadiness(capabilityResolutions);

  return {
    version: 2,
    cardName: manifest.cardName,
    manifestHash,
    environment,
    descriptors,
    executionOrder: finalOrder,
    deferred,
    ambiguousProviders,
    capabilityResolutions,
    operationReadiness,
    gaps,
    warnings,
    unknownDeps,
    capabilities,
    requiresBrowserRuntime: environment === 'browser' && used.includes('dom-ui'),
    unrecognized,
    adapterIds: [...adapterIds],
    admission,
  };
}

/** 按适配标签取脚本（**仅用于报告/诊断**；调度不得依赖） */
export function scriptsByAdapterTag(plan: SessionScriptPlan, tag: string, manifest: CardImportManifest): NormalizedCardScript[] {
  const byId = new Map(manifest.scripts.map((s) => [s.id, s]));
  return plan.executionOrder
    .map((id) => plan.descriptors.find((d) => d.id === id))
    .filter((d): d is SessionScriptDescriptor => !!d && d.adapterTags.includes(tag))
    .map((d) => byId.get(d.id))
    .filter((s): s is NormalizedCardScript => !!s);
}

// ────────────────────────── 共享脚本运行包（FE-B2） ──────────────────────────

export interface SharedScriptBundleData {
  sessionId: string;
  cardName: string;
  manifestHash: string;
  environment: RunEnvironment;
  scripts: { id: string; name: string; execution: ScriptExecution; environment: ScriptEnvironment; capabilities: ScriptCapability[]; scope: ScriptScope; provides: string[]; content: string; dependsOn: string[] }[];
  /** 期望出现在全局的导出符号 */
  expectExports: string[];
  /** 必需但缺失的能力 → 前端必须明确阻断，而不是显示"已就绪" */
  missingCapabilities: ScriptCapability[];
  /** **阻止性**结构缺口（必需能力缺失 / 依赖成环） */
  gaps: string[];
  /** **非阻止性**记录（未知依赖 / 可选模块降级）——必须显示，但不阻断 */
  warnings: string[];
  deferred: { name: string; reason: string; optional: boolean }[];
  requiresBrowserRuntime: boolean;
  /** 操作级能力要求（FE-C0）：运行时据此做**实测**验证与阻断 */
  operationPlan: { operation: string; requires: string[] }[];
  /** 计划层能力可用性（宿主声明）；运行时可用实测覆盖 */
  capabilityPlanOk: Record<string, boolean>;
  /** 未就绪时必须阻止的操作（缺一即不可部分写入） */
  blockingOperations: string[];
  /** 无导出且需在**页面 realm** 运行的模块（注入门槛据此触发：它们必须与页面同 realm） */
  pageScopeModules: string[];
  /** 无导出且属**会话级**的模块：由会话宿主执行一次，不进每条消息页面 */
  sessionScopeModules: string[];
  /** 准入未装载（已由 Agent 接管 / 上游未装载）：明确列出，不假装已加载 */
  notLoaded: { name: string; reason: string }[];
  /** 逐脚本准入结论（可审计） */
  admission: ScriptAdmission[];
}

/** 由脚本清单构建「共享脚本运行包」（纯函数；无 IO） */
export function buildSharedScriptBundle(
  plan: SessionScriptPlan,
  manifest: CardImportManifest,
  sessionId: string,
): SharedScriptBundleData {
  const byId = new Map(manifest.scripts.map((s) => [s.id, s]));
  const descById = new Map(plan.descriptors.map((d) => [d.id, d]));
  const admById0 = new Map(plan.admission.map((a) => [a.id, a]));
  const scripts = plan.executionOrder
    .map((id) => descById.get(id))
    .filter((d): d is SessionScriptDescriptor => !!d)
    .map((d) => ({
      id: d.id,
      name: d.name,
      execution: d.execution,
      environment: d.environment,
      capabilities: d.capabilities,
      // FE-04.0：作用域与保留产出随包下发 —— 页面 realm 与会话宿主据此各取所需
      scope: admById0.get(d.id)?.scope ?? 'page',
      provides: d.provides,
      content: byId.get(d.id)?.content ?? '',
      dependsOn: d.dependsOn,
    }));
  const expectExports = [...new Set(plan.executionOrder.flatMap((id) => descById.get(id)?.provides ?? []))];
  // FE-04.0：按**准入 + 作用域**拆分无导出模块（不再把"无导出名单"当成执行许可）
  //  · pageScope：必须在可见页面 realm（导出全局 / 挂载 DOM / 使用页面存储）→ 允许注入页面
  //  · sessionScope：纯会话级副作用（无导出、无 DOM、无存储）→ 由**会话宿主**执行一次，不进每条消息
  const admById = new Map(plan.admission.map((a) => [a.id, a]));
  const pageScopeModules = scripts
    .filter((s2) => {
      const a = admById.get(s2.id);
      return !!a && a.decision === 'load' && a.retainedOutput.length === 0 && a.scope === 'page';
    })
    .map((s2) => s2.name);
  const sessionScopeModules = scripts
    .filter((s2) => {
      const a = admById.get(s2.id);
      return !!a && a.decision === 'load' && a.retainedOutput.length === 0 && a.scope === 'session';
    })
    .map((s2) => s2.name);
  const notLoaded = plan.deferred
    .filter((d) => d.kind === 'capability-unsupported' || d.kind === 'upstream-unavailable')
    .map((d) => ({ name: d.name, reason: d.reason }));
  return {
    sessionId,
    cardName: plan.cardName,
    manifestHash: plan.manifestHash,
    environment: plan.environment,
    scripts,
    expectExports,
    pageScopeModules,
    sessionScopeModules,
    notLoaded,
    admission: plan.admission,
    missingCapabilities: plan.capabilities.missing,
    gaps: plan.gaps,
    warnings: plan.warnings,
    deferred: plan.deferred.map((d) => ({ name: d.name, reason: d.reason, optional: d.optional })),
    requiresBrowserRuntime: plan.requiresBrowserRuntime,
    operationPlan: plan.operationReadiness.map((o) => ({
      operation: o.operation,
      requires: OPERATION_REQUIREMENTS[o.operation].filter((r) => r.required).map((r) => r.capability),
    })),
    capabilityPlanOk: Object.fromEntries(plan.capabilityResolutions.map((r) => [r.capability, r.ok])),
    // 只有**正式开局**属于"缺一即不可执行"；回合内演化缺失时降级提示，不阻断开局
    blockingOperations: ['commit-variables'],
  };
}
