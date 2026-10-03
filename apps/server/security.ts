import type { IncomingMessage } from 'node:http';
import { isAbsolute, resolve } from 'node:path';

/**
 * P5.1 起，请求来源/JSON framing 由 `http-policy.ts` 的中央策略统一判定
 * （Host → 静态 containment → Origin / Fetch Metadata / JSON framing → 路由）。
 *
 * 本文件**不再**提供第二条、更弱的写操作门禁：旧的 `admitLocalJsonMutation`
 * 只检查 loopback 主机名，不看精确 Origin allowlist、不参与 route scope，且生产
 * 链路中已无调用方，只被自己的测试使用。留着它等于给后来者一条"看起来能用、
 * 实际绕过中央策略"的旁路，因此在 P5.2-A0 删除；等价断言改由中央策略测试覆盖。
 */

export const BODY_LIMITS = {
  log: 256 * 1024,
  json: 1024 * 1024,
  turn: 8 * 1024 * 1024,
  assetJson: 16 * 1024 * 1024,
  cardUpload: 80 * 1024 * 1024,
  /** A2-02：配对请求（code + device claim + scopes）4 KiB 足够，压缩攻击面。 */
  authPair: 4 * 1024,
} as const;

export function bodyLimitForPath(pathname: string): number {
  if (pathname === '/api/auth/pair') return BODY_LIMITS.authPair;
  if (pathname === '/api/log') return BODY_LIMITS.log;
  if (pathname === '/api/turn' || pathname === '/api/turn-jobs' || pathname.includes('/regenerate')) {
    return BODY_LIMITS.turn;
  }
  if (pathname === '/api/card/import' || pathname.endsWith('/png')) return BODY_LIMITS.cardUpload;
  if (pathname === '/api/preset/import' || pathname === '/api/worldbook/import' || pathname === '/api/preset/save' || pathname === '/api/worldbook/save') {
    return BODY_LIMITS.assetJson;
  }
  // 世界书写回（FE-02）：变化条目可能整条很长，按资产 JSON 档位
  if (pathname.endsWith('/worldbook-update')) return BODY_LIMITS.assetJson;
  return BODY_LIMITS.json;
}

export class PayloadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body too large; limit=${limit}`);
    this.name = 'PayloadTooLargeError';
  }
}

export function assertContentLength(req: IncomingMessage, limit: number): void {
  const raw = req.headers['content-length'];
  if (!raw) return;
  const len = Number(Array.isArray(raw) ? raw[0] : raw);
  if (Number.isFinite(len) && len > limit) throw new PayloadTooLargeError(limit);
}

/** 读 body 超过绝对 deadline 时抛出（A2-02：配对端点要求整体 deadline）。 */
export class BodyDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`request body exceeded deadline of ${deadlineMs}ms`);
    this.name = 'BodyDeadlineError';
  }
}

/**
 * 限流读 body：content-length 预检 + 流式累积双重把关。
 * 超限后**不 destroy socket**（destroy 会连带销毁 res，客户端只能看到 ECONNRESET 而非 413），
 * 改为停止累积并继续排空剩余数据，让调用方正常回写 413 JSON。
 *
 * `deadlineMs` 给出可选的绝对 deadline（自调用时刻起）：慢速滴流的攻击者
 * 不能长期占用连接与解析器，超时后 reject BodyDeadlineError 并 resume 排空。
 */
export function readLimitedBody(
  req: IncomingMessage,
  limit: number,
  options: { deadlineMs?: number } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    try {
      assertContentLength(req, limit);
    } catch (e) {
      reject(e);
      return;
    }
    let data = '';
    let size = 0;
    let aborted = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fail: unknown, ok?: Record<string, unknown>) => {
      if (aborted) return;
      aborted = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (fail !== null && fail !== undefined) reject(fail);
      else if (ok !== undefined) resolveBody(ok);
    };
    if (options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs) && options.deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        req.resume();
        settle(new BodyDeadlineError(options.deadlineMs as number));
      }, options.deadlineMs);
    }
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        req.resume();
        settle(new PayloadTooLargeError(limit));
        return;
      }
      data += c.toString('utf8');
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        settle(null, data ? JSON.parse(data) as Record<string, unknown> : {});
      } catch (e) {
        settle(e);
      }
    });
    req.on('error', (e) => settle(e));
  });
}

export interface AuthRateLimiter {
  /** 单次准入判定；`key` 通常是 remoteAddress。true = 放行，false = 超限。 */
  admit(key: string, nowMs: number): boolean;
}

export interface AuthRateLimiterOptions {
  /** 单 key（每个远端地址）在窗口内的最大请求数。 */
  readonly perKeyLimit: number;
  /** 全局窗口内的最大请求数（防分布式撞库占满预算）。 */
  readonly globalLimit: number;
  /** 固定窗口长度（毫秒）。 */
  readonly windowMs: number;
}

/**
 * 固定窗口限流器（进程内，内存态；重启即清零——对配对撞码足够：
 * 配对码本身还有 attempts 与 TTL 两层持久防线）。
 * 只用于认证类端点的 **pre-body** 判定：超限请求不读 body、不进 handler。
 */
export function createAuthRateLimiter(options: AuthRateLimiterOptions): AuthRateLimiter {
  const buckets = new Map<string, { windowStart: number; count: number }>();
  let globalWindowStart = 0;
  let globalCount = 0;
  let lastPrune = 0;

  const windowOf = (nowMs: number): number => Math.floor(nowMs / options.windowMs);

  return {
    admit(key, nowMs) {
      const window = windowOf(nowMs);
      // 窗口推进时顺带修剪，防止 Map 无界增长。
      if (window - lastPrune >= 4) {
        lastPrune = window;
        for (const [k, bucket] of buckets) {
          if (bucket.windowStart < window) buckets.delete(k);
        }
      }

      if (globalWindowStart < window) {
        globalWindowStart = window;
        globalCount = 0;
      }
      globalCount += 1;
      if (globalCount > options.globalLimit) return false;

      const bucket = buckets.get(key);
      if (bucket === undefined || bucket.windowStart < window) {
        buckets.set(key, { windowStart: window, count: 1 });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= options.perKeyLimit;
    },
  };
}

/**
 * 把客户端提交的会话数据库名约束在用户数据目录内。
 *
 * API 只接受列表接口返回的单个 `.db` 文件名；绝不接受绝对路径、目录分隔符、
 * `.`/`..` 或 NUL。额外的 resolve 校验作为第二道防线，避免平台路径语义差异。
 */
export function resolveSessionDatabase(dataDir: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const name = candidate.trim();
  if (
    name.length === 0
    || name.length > 240
    || name !== candidate
    || name === '.'
    || name === '..'
    || /[<>:"|?*\u0000-\u001f\u007f]/.test(name)
    || name.includes('/')
    || name.includes('\\')
    || isAbsolute(name)
    || !name.toLowerCase().endsWith('.db')
  ) {
    return null;
  }
  const root = resolve(dataDir);
  const target = resolve(root, name);
  const expectedPrefix = root.endsWith('\\') || root.endsWith('/') ? root : `${root}${process.platform === 'win32' ? '\\' : '/'}`;
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(target).startsWith(normalize(expectedPrefix)) ? target : null;
}
