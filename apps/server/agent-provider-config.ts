import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export type AgentProviderConfig =
  | { readonly mode: 'inherit-main' }
  | { readonly mode: 'override'; readonly providerId: string; readonly model: string };

export interface AgentProviderConfigOptions {
  readonly path?: string;
  /**
   * P16 T-1：凭据封锁（测试安全门）下由权威入口传入 true，禁止读取
   * `agent-provider.json`——即使隔离路径下存在该文件，也不得据此指向真实上游。
   */
  readonly ignoreFile?: boolean;
}

export interface AgentProviderSelection {
  readonly providerId: string;
  readonly model: string;
}

export interface AgentProviderSelectionInput {
  readonly config: AgentProviderConfig;
  readonly main: AgentProviderSelection;
  readonly describe: (providerId: string) => { readonly configured: boolean } | undefined;
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const MODEL_MAX_LENGTH = 256;
let writeSequence = 0;

export const AGENT_PROVIDER_JSON_PATH = process.env.JG_AGENT_PROVIDER_JSON
  ? resolve(process.env.JG_AGENT_PROVIDER_JSON)
  : process.env.JG_USER_DATA_DIR
    ? resolve(process.env.JG_USER_DATA_DIR, 'agent-provider.json')
    : resolve(process.cwd(), 'data', 'agent-provider.json');

export class AgentProviderConfigFileError extends Error {
  readonly code = 'AGENT_PROVIDER_CONFIG_FILE_INVALID';

  constructor() {
    super('Agent Provider 配置文件损坏，已拒绝回退主 Provider');
    this.name = 'AgentProviderConfigFileError';
  }
}

export class AgentProviderConfigWriteError extends Error {
  readonly code = 'AGENT_PROVIDER_CONFIG_WRITE_FAILED';

  constructor(cause?: unknown) {
    super('Agent Provider 配置写入失败', cause === undefined ? undefined : { cause });
    this.name = 'AgentProviderConfigWriteError';
  }
}

export class AgentProviderSelectionError extends Error {
  readonly code: 'agent-provider-not-found' | 'agent-provider-not-configured';
  readonly providerId: string;

  constructor(
    code: 'agent-provider-not-found' | 'agent-provider-not-configured',
    providerId: string,
  ) {
    super(code === 'agent-provider-not-found'
      ? `Agent Provider 不可用: ${providerId}`
      : `Agent Provider 未配置: ${providerId}`);
    this.name = 'AgentProviderSelectionError';
    this.code = code;
    this.providerId = providerId;
  }
}

export function normalizeAgentProviderConfig(value: unknown): AgentProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProviderConfigFileError();
  }
  const raw = value as Record<string, unknown>;
  if (raw.mode === 'inherit-main') {
    if (Object.keys(raw).some((key) => key !== 'mode')) throw new AgentProviderConfigFileError();
    return Object.freeze({ mode: 'inherit-main' });
  }
  if (raw.mode !== 'override'
    || Object.keys(raw).some((key) => !['mode', 'providerId', 'model'].includes(key))
    || typeof raw.providerId !== 'string'
    || !PROVIDER_ID_RE.test(raw.providerId)
    || typeof raw.model !== 'string') {
    throw new AgentProviderConfigFileError();
  }
  const model = raw.model.trim();
  if (model.length < 1 || model.length > MODEL_MAX_LENGTH) {
    throw new AgentProviderConfigFileError();
  }
  return Object.freeze({ mode: 'override', providerId: raw.providerId, model });
}

/** Missing config intentionally means live inheritance; corrupt config fails closed. */
export function loadAgentProviderConfig(
  options: AgentProviderConfigOptions = {},
): AgentProviderConfig {
  // P16 T-1：凭据封锁模式下不读取 agent-provider.json（即使隔离路径下存在），
  // 避免测试进程通过该文件间接指向真实上游。
  if (options.ignoreFile) return Object.freeze({ mode: 'inherit-main' });
  const path = resolve(options.path ?? AGENT_PROVIDER_JSON_PATH);
  if (!existsSync(path)) return Object.freeze({ mode: 'inherit-main' });
  try {
    return normalizeAgentProviderConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof AgentProviderConfigFileError) throw error;
    throw new AgentProviderConfigFileError();
  }
}

/** Writes only the public routing tuple; credentials and upstream URLs cannot enter this file. */
export function writeAgentProviderConfig(
  config: AgentProviderConfig,
  options: AgentProviderConfigOptions = {},
): AgentProviderConfig {
  const normalized = normalizeAgentProviderConfig(config);
  const path = resolve(options.path ?? AGENT_PROVIDER_JSON_PATH);
  const tempPath = `${path}.${process.pid}.${++writeSequence}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, JSON.stringify(normalized, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(tempPath, path);
    return normalized;
  } catch (error) {
    try { rmSync(tempPath, { force: true }); } catch { /* keep original error */ }
    throw new AgentProviderConfigWriteError(error);
  }
}

/** Resolve once at an Agent ticket boundary. No missing/unconfigured override may fall back. */
export function resolveAgentProviderSelection(
  input: AgentProviderSelectionInput,
): AgentProviderSelection {
  const selected = input.config.mode === 'inherit-main'
    ? input.main
    : { providerId: input.config.providerId, model: input.config.model };
  const descriptor = input.describe(selected.providerId);
  if (!descriptor) throw new AgentProviderSelectionError('agent-provider-not-found', selected.providerId);
  if (!descriptor.configured) {
    throw new AgentProviderSelectionError('agent-provider-not-configured', selected.providerId);
  }
  return Object.freeze({ providerId: selected.providerId, model: selected.model });
}
