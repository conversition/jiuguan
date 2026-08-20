/**
 * 前端日志模块（v0.6.1）
 * 能力：
 *  - 分级日志（debug/info/warn/error）+ 分类标签（turn/sse/session/render/sys）+ 时间戳
 *  - 全局捕获 window.onerror / unhandledrejection → error 级日志（带 stack）
 *  - 内存环形缓冲（保留最近 N 条）+ 一键下载成 .log 文件
 *  - 去抖批量 POST /api/log 由后端落盘 data/web.log（失败静默）
 *  - 脱敏：记录 data 时剥掉 apiKey/key/authorization 等敏感字段
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogScope = 'turn' | 'sse' | 'session' | 'render' | 'sys' | 'ui';

export interface LogEntry {
  level: LogLevel;
  scope: LogScope;
  ts: string;
  msg: string;
  data?: unknown;
}

const APP_VERSION = '0.6.1';
const RING_CAPACITY = 2000;
const FLUSH_DEBOUNCE_MS = 1000;

/** 敏感字段名（大小写不敏感匹配 key）——日志落盘前剥掉，避免 Provider key / token 泄露 */
const SENSITIVE_KEYS = /^(api_?key|key|token|authorization|auth|secret|password)$/i;

/** 内存环形缓冲 */
const ring: LogEntry[] = [];

/** 待推送后端的队列 */
let pending: LogEntry[] = [];
let flushTimer: number | null = null;
let flushInFlight = false;
let globalHooked = false;

/** 脱敏：递归遍历对象，剥掉/遮蔽敏感字段 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

/** 把任意值转成可安全序列化的结构（Error 取 message+stack；循环引用兜底） */
function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value?.stack };
  }
  try {
    return redact(value);
  } catch {
    return String(value);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function push(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
  // DevTools 实时可见
  const args: unknown[] = [`[jiuguan] [${entry.level}] [${entry.scope}] ${entry.msg}`];
  if (entry.data !== undefined) args.push(entry.data);
  if (entry.level === 'error') {
    // eslint-disable-next-line no-console
    console.error(...args);
  } else if (entry.level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(...args);
  } else {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
  scheduleFlush();
}

function log(level: LogLevel, scope: LogScope, msg: string, data?: unknown): void {
  push({ level, scope, ts: nowIso(), msg, data: data === undefined ? undefined : normalize(data) });
}

export const logger = {
  debug: (scope: LogScope, msg: string, data?: unknown) => log('debug', scope, msg, data),
  info: (scope: LogScope, msg: string, data?: unknown) => log('info', scope, msg, data),
  warn: (scope: LogScope, msg: string, data?: unknown) => log('warn', scope, msg, data),
  error: (scope: LogScope, msg: string, data?: unknown) => log('error', scope, msg, data),
  /** 导出环形缓冲为下载 .log 文件 */
  download: downloadLogs,
};

/** 批量推给后端（去抖）；失败静默，不阻塞业务 */
function scheduleFlush(): void {
  if (typeof fetch === 'undefined') return; // 非浏览器环境跳过
  pending.push(ring[ring.length - 1]);
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(flushToServer, FLUSH_DEBOUNCE_MS);
}

async function flushToServer(): Promise<void> {
  flushTimer = null;
  if (pending.length === 0) return;
  if (flushInFlight) return; // 上一批未回，等下一轮
  flushInFlight = true;
  const batch = pending;
  pending = [];
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'web', version: APP_VERSION, entries: batch }),
    });
  } catch {
    // 后端不可达（如仅前端调试）时静默，日志仍留在环形缓冲可下载
    pending.unshift(...batch.slice(0, 200));
  } finally {
    flushInFlight = false;
  }
}

/** 逐行导出环形缓冲为下载文件 */
function downloadLogs(): void {
  const lines = [`jiuguan 前端日志  v${APP_VERSION}  ${nowIso()}`, ...ring.map((e) => JSON.stringify(e))];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jiuguan-前端日志-${Date.now()}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 初始化：挂全局 JS 错误 / 未捕获 Promise 拒绝捕获（幂等，仅一次） */
export function initGlobalLogger(): void {
  if (globalHooked || typeof window === 'undefined') return;
  globalHooked = true;
  window.addEventListener('error', (e) => {
    // 资源加载错误没有 message/stack，单独标记
    if (e.message) {
      logger.error('sys', '全局 error', { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno });
    } else {
      logger.error('sys', '资源加载失败', { target: (e.target as HTMLElement)?.tagName ?? '?', src: (e.target as HTMLImageElement)?.src });
    }
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? e.reason : { message: String(e.reason) };
    logger.error('sys', '未捕获的 Promise 拒绝', reason);
  });
  logger.info('sys', '前端日志模块已初始化', { version: APP_VERSION, ua: navigator.userAgent });
}
