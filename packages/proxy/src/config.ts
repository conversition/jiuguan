/**
 * proxy 包 - Provider 配置（密钥不入代码）
 * 读取优先级：显式 overrides > data/provider.json（UI 写入，热更） > 环境变量/.env.local > 默认值
 * 启动流程审查 P0-2：ProviderPanel 写 key → data/provider.json（不回显），新会话即时生效。
 */
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface ProviderConfig {
  /** 酒馆内部选中的 Provider；仅保存公开 id，不包含任何凭据。 */
  providerId: string;
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
  /** API key 单一来源锚定：provider.json(UI 唯一权威) | env(.env.local) | none
   *  仅 loadProviderConfig 填充，供面板/日志展示；非持久化字段 */
  keySource?: 'provider.json' | 'env' | 'none';
  /** API key 指纹（前 4 + 尾 4，如 sk-N4b…Wxy），不回显完整 key */
  keyFingerprint?: string;
}

/** API key 指纹：仅暴露首 4 与末 4 字符，用于面板/日志识别来源、不泄露完整密钥 */
export function fingerprintKey(key: string): string {
  if (!key) return '';
  const s = key.trim();
  if (s.length <= 8) return s.slice(0, 2) + '…';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 运行时配置文件（UI 写入；不入库、不回显 key；可用 JG_PROVIDER_JSON 覆盖路径，测试隔离用） */
export const PROVIDER_JSON_PATH = process.env.JG_PROVIDER_JSON
  ? resolve(process.env.JG_PROVIDER_JSON)
  : process.env.JG_USER_DATA_DIR
    ? resolve(process.env.JG_USER_DATA_DIR, 'provider.json')
    : resolve(process.cwd(), 'data', 'provider.json');

export const DEFAULT_PROVIDER_ID = 'builtin.openai' as const;
const PROVIDER_ID_RE = /^[a-z][a-z0-9.-]{0,63}$/;
let providerWriteSequence = 0;

/**
 * provider.json 一旦存在就必须是可解析的对象；损坏时禁止静默回退到默认
 * Provider，避免用户以为仍在使用已选择的插件 Provider。
 */
export class ProviderConfigFileError extends Error {
  readonly code = 'PROVIDER_CONFIG_FILE_INVALID';

  constructor() {
    super('Provider 配置文件损坏，已拒绝回退默认 Provider');
    this.name = 'ProviderConfigFileError';
  }
}

export class ProviderConfigWriteError extends Error {
  readonly code = 'PROVIDER_CONFIG_WRITE_FAILED';

  constructor(cause?: unknown) {
    super('Provider 配置写入失败', cause === undefined ? undefined : { cause });
    this.name = 'ProviderConfigWriteError';
  }
}

function providerIdValue(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID_RE.test(value)) {
    throw new Error('Provider id 非法');
  }
  return value;
}

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

/**
 * 读取电脑宿主凭据：真实进程环境优先，随后才读取仓库外的 .env.local/.env。
 * 注入参数只用于无文件副作用的边界测试；调用方仍应限制自己允许解析的凭据名。
 */
export function readLocalEnvCredential(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fileEnv: Readonly<Record<string, string>> = loadDotEnvLocal(),
): { value: string; source: 'env' | '.env.local' } | null {
  const direct = env[name];
  if (direct) return { value: direct, source: 'env' };
  const fromFile = fileEnv[name];
  if (fromFile) return { value: fromFile, source: '.env.local' };
  return null;
}

/** 读取 data/provider.json（UI 运行时配置；不存在返回空） */
export function readProviderJson(): Partial<ProviderConfig> {
  if (!existsSync(PROVIDER_JSON_PATH)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(PROVIDER_JSON_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProviderConfigFileError();
    }
    const raw = parsed as Partial<ProviderConfig>;
    return {
      providerId: raw.providerId,
      baseUrl: raw.baseUrl,
      apiKey: raw.apiKey,
      model: raw.model,
      kind: raw.kind === 'anthropic' ? 'anthropic' : undefined,
      prefixCacheThreshold: raw.prefixCacheThreshold,
      timeoutMs: raw.timeoutMs,
    };
  } catch (error) {
    if (error instanceof ProviderConfigFileError) throw error;
    throw new ProviderConfigFileError();
  }
}

/** 写运行时配置（同目录临时文件 + rename，避免半写入；损坏文件不可被静默覆盖） */
export function writeProviderJson(partial: Partial<ProviderConfig>): void {
  const prev = readProviderJson();
  const next: Partial<ProviderConfig> = { ...prev, ...partial };
  const targetDir = dirname(PROVIDER_JSON_PATH);
  const tempPath = `${PROVIDER_JSON_PATH}.${process.pid}.${++providerWriteSequence}.tmp`;
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(tempPath, PROVIDER_JSON_PATH);
  } catch (error) {
    try { rmSync(tempPath, { force: true }); } catch { /* 保留原始写入错误 */ }
    throw new ProviderConfigWriteError(error);
  }
}

const env = { ...loadDotEnvLocal(), ...process.env };

/** 已打印过的 key 指纹（避免每次 loadProviderConfig 刷日志；来源变化时重新打印） */
let printedKeyAnchor = '';

export function loadProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const file = readProviderJson();
  let keySource: ProviderConfig['keySource'];
  let apiKey: string;
  if (overrides.apiKey) {
    keySource = 'provider.json'; // 显式 overrides 视同 UI 锚定
    apiKey = overrides.apiKey;
  } else if (file.apiKey) {
    keySource = 'provider.json'; // UI 面板唯一权威
    apiKey = file.apiKey;
  } else if (env.JG_API_KEY) {
    keySource = 'env'; // 仅未在面板配置时兜底
    apiKey = env.JG_API_KEY;
  } else {
    keySource = 'none';
    apiKey = '';
  }
  const cfg: ProviderConfig = {
    providerId: providerIdValue(
      overrides.providerId ?? file.providerId ?? env.JG_PROVIDER_ID ?? DEFAULT_PROVIDER_ID,
    ),
    baseUrl: overrides.baseUrl ?? file.baseUrl ?? env.JG_API_BASE ?? 'https://opencode.ai/zen/go',
    apiKey,
    model: overrides.model ?? file.model ?? env.JG_MODEL ?? 'deepseek-v4-flash',
    kind: overrides.kind ?? file.kind ?? (env.JG_PROVIDER_KIND === 'anthropic' ? 'anthropic' : 'openai'),
    prefixCacheThreshold: Number(overrides.prefixCacheThreshold ?? file.prefixCacheThreshold ?? env.JG_PREFIX_THRESHOLD ?? 1024),
    timeoutMs: Number(overrides.timeoutMs ?? file.timeoutMs ?? env.JG_TIMEOUT_MS ?? 120000),
    keySource,
    keyFingerprint: fingerprintKey(apiKey),
  };
  // 单一锚定日志：仅来源或指纹变化时打印一次
  const anchor = fingerprintKey(apiKey) || (keySource === 'none' ? 'none' : '');
  if (process.env.JG_ACCESS_MODE !== 'secured' && anchor && anchor !== printedKeyAnchor) {
    printedKeyAnchor = anchor;
    const srcDesc = keySource === 'provider.json'
      ? 'provider.json（UI 面板唯一权威）'
      : keySource === 'env'
        ? 'env（.env.local，未在面板配置时的兜底）'
        : '无';
    console.log(`[Provider] key 来源=${srcDesc}${cfg.apiKey ? ` 指纹=${cfg.keyFingerprint}` : ''}`);
  }
  return cfg;
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
