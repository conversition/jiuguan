/**
 * proxy 包 - Provider 配置（密钥不入代码）
 * 读取优先级：显式 overrides > data/provider.json（UI 写入，热更） > 环境变量/.env.local > 默认值
 * 启动流程审查 P0-2：ProviderPanel 写 key → data/provider.json（不回显），新会话即时生效。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface ProviderConfig {
  /** OpenAI 兼容 base URL（不含 /v1） */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** provider 类型：openai(默认，隐式前缀缓存) | anthropic(cache_control 断点) */
  kind: 'openai' | 'anthropic';
  /** 稳定前缀目标（OpenAI 兼容隐式前缀缓存 ≥1024 tokens 门槛，审查 §4.2） */
  prefixCacheThreshold: number;
  /** 请求超时（ms） */
  timeoutMs: number;
}

/** 运行时配置文件（UI 写入；不入库、不回显 key；可用 JG_PROVIDER_JSON 覆盖路径，测试隔离用） */
export const PROVIDER_JSON_PATH = process.env.JG_PROVIDER_JSON
  ? resolve(process.env.JG_PROVIDER_JSON)
  : resolve(process.cwd(), 'data', 'provider.json');

/** 从 .env.local 加载（KEY=VALUE 每行，忽略 # 注释） */
function loadDotEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  const candidates = [resolve(process.cwd(), '.env.local'), resolve(process.cwd(), '.env')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    } catch { /* 忽略读取失败 */ }
  }
  return out;
}

/** 读取 data/provider.json（UI 运行时配置；不存在返回空） */
export function readProviderJson(): Partial<ProviderConfig> {
  if (!existsSync(PROVIDER_JSON_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(PROVIDER_JSON_PATH, 'utf8')) as Partial<ProviderConfig>;
    return {
      baseUrl: raw.baseUrl,
      apiKey: raw.apiKey,
      model: raw.model,
      kind: raw.kind === 'anthropic' ? 'anthropic' : undefined,
      prefixCacheThreshold: raw.prefixCacheThreshold,
      timeoutMs: raw.timeoutMs,
    };
  } catch {
    return {};
  }
}

/** 写运行时配置（仅写给定字段，保留其余；key 不回显——由调用方决定） */
export function writeProviderJson(partial: Partial<ProviderConfig>): void {
  const prev = readProviderJson();
  const next: Partial<ProviderConfig> = { ...prev, ...partial };
  mkdirSync(dirname(PROVIDER_JSON_PATH), { recursive: true });
  writeFileSync(PROVIDER_JSON_PATH, JSON.stringify(next, null, 2));
}

const env = { ...loadDotEnvLocal(), ...process.env };

export function loadProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const file = readProviderJson();
  return {
    baseUrl: overrides.baseUrl ?? file.baseUrl ?? env.JG_API_BASE ?? 'https://opencode.ai/zen/go',
    apiKey: overrides.apiKey ?? file.apiKey ?? env.JG_API_KEY ?? '',
    model: overrides.model ?? file.model ?? env.JG_MODEL ?? 'deepseek-v4-flash',
    kind: overrides.kind ?? file.kind ?? (env.JG_PROVIDER_KIND === 'anthropic' ? 'anthropic' : 'openai'),
    prefixCacheThreshold: Number(overrides.prefixCacheThreshold ?? file.prefixCacheThreshold ?? env.JG_PREFIX_THRESHOLD ?? 1024),
    timeoutMs: Number(overrides.timeoutMs ?? file.timeoutMs ?? env.JG_TIMEOUT_MS ?? 120000),
  };
}

/** 校验配置，缺 key 时给出明确指引 */
export function assertProviderReady(cfg: ProviderConfig): void {
  if (!cfg.apiKey) {
    throw new Error(
      '缺少 API key。请在 jiuguan/ 下创建 .env.local，或在"Provider"面板填写并保存：\n' +
      'JG_API_BASE=https://opencode.ai/zen/go\n' +
      'JG_API_KEY=sk-...\n' +
      'JG_MODEL=deepseek-v4-flash'
    );
  }
}
