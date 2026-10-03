/**
 * proxy 包 - Provider URL 历史记忆（测试成功即记录，供面板下拉快速切换）
 * 存储：data/provider-history.json（不含 API key；key 安全原则同 config.ts）
 * 读取优先级：JG_PROVIDER_HISTORY_JSON（测试隔离）> 默认 data/provider-history.json
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/** 历史存储路径（env 覆盖供测试隔离；模块级 import 时捕获） */
export const PROVIDER_HISTORY_JSON = process.env.JG_PROVIDER_HISTORY_JSON
  ? resolve(process.env.JG_PROVIDER_HISTORY_JSON)
  : process.env.JG_USER_DATA_DIR
    ? resolve(process.env.JG_USER_DATA_DIR, 'provider-history.json')
    : resolve(process.cwd(), 'data', 'provider-history.json');

export interface ProviderHistoryEntry {
  /** 展示用原文（仅 trim，保留原始大小写/路径） */
  baseUrl: string;
  /** 该 URL 测试成功时用的模型 */
  model: string;
  /** 最近一次测试成功时间（ISO8601） */
  lastSuccessAt: string;
}

/** 历史上限：超出丢弃最旧 */
export const MAX_HISTORY = 30;

/** 归一化 Base URL 作去重键：trim → 剥 query/hash → 去尾部 / → 小写；空串返回 '' */
export function normalizeBaseUrl(url: string): string {
  const s = url.trim().split(/[?#]/)[0].replace(/\/+$/, '');
  return s === '' ? '' : s.toLowerCase();
}

/** 读历史：文件不存在 / 非法 JSON / 非数组 → []（读不截断，截断只在写路径） */
export function readProviderHistory(): ProviderHistoryEntry[] {
  if (!existsSync(PROVIDER_HISTORY_JSON)) return [];
  try {
    const raw = JSON.parse(readFileSync(PROVIDER_HISTORY_JSON, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is ProviderHistoryEntry =>
      !!e && typeof e === 'object' && typeof (e as ProviderHistoryEntry).baseUrl === 'string',
    );
  } catch {
    return [];
  }
}

/** 写历史（mkdir + writeFile；调用方保证入参合法） */
export function writeProviderHistory(entries: ProviderHistoryEntry[]): void {
  mkdirSync(dirname(PROVIDER_HISTORY_JSON), { recursive: true });
  writeFileSync(PROVIDER_HISTORY_JSON, JSON.stringify(entries, null, 2));
}

/** 记录一次测试成功：去重置顶（已存在则更新 model+时间）、截断上限、写盘；返回最新列表 */
export function recordProviderUrl(baseUrl: string, model: string): ProviderHistoryEntry[] {
  const raw = baseUrl.trim();
  const key = normalizeBaseUrl(raw);
  if (!key) return readProviderHistory();
  const now = new Date().toISOString();
  const next = readProviderHistory().filter((e) => normalizeBaseUrl(e.baseUrl) !== key);
  next.unshift({ baseUrl: raw, model: model?.trim() || '', lastSuccessAt: now });
  if (next.length > MAX_HISTORY) next.length = MAX_HISTORY;
  writeProviderHistory(next);
  return next;
}

/** 删除单条（按归一化匹配）；返回最新列表 */
export function removeProviderUrl(baseUrl: string): ProviderHistoryEntry[] {
  const key = normalizeBaseUrl(baseUrl);
  if (!key) return readProviderHistory();
  const next = readProviderHistory().filter((e) => normalizeBaseUrl(e.baseUrl) !== key);
  writeProviderHistory(next);
  return next;
}
