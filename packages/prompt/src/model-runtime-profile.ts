import { createHash } from 'node:crypto';
import type { ContextModelProfile } from './context-plan.ts';

export const MODEL_RUNTIME_PROFILE_VERSION = 'model-runtime-profile-v1' as const;
export const DEFAULT_CONSERVATIVE_CONTEXT_TOKENS = 32_768;
const MIN_OUTPUT_RESERVE_TOKENS = 4_096;
const MAX_PROFILE_JSON_CHARS = 65_536;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

export interface ModelRuntimeProfile {
  readonly version: typeof MODEL_RUNTIME_PROFILE_VERSION;
  readonly providerIdDigest: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly tokenizer: 'provider-exact' | 'local-exact' | 'conservative-estimate';
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly inputMicrousdPerMillionTokens?: number;
  readonly outputMicrousdPerMillionTokens?: number;
  readonly source: 'static-declaration' | 'provider-verified';
  readonly updatedAt: string;
}

interface StaticProfileDeclaration {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly tokenizer: ModelRuntimeProfile['tokenizer'];
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly inputMicrousdPerMillionTokens?: number;
  readonly outputMicrousdPerMillionTokens?: number;
  readonly updatedAt: string;
}

function integer(value: unknown, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}-invalid`);
  return Number(value);
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error('model-profile-updated-at-invalid');
  return value;
}

function providerDigest(providerId: string): string {
  return `sha256:${createHash('sha256').update(providerId, 'utf8').digest('hex')}`;
}

function optionalRate(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return integer(value, label);
}

function parseDeclaration(value: unknown): StaticProfileDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('model-profile-declaration-invalid');
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    'providerId', 'modelId', 'contextWindowTokens', 'maxOutputTokens', 'tokenizer',
    'supportsTools', 'supportsStreaming', 'inputMicrousdPerMillionTokens',
    'outputMicrousdPerMillionTokens', 'updatedAt',
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))
    || (row.tokenizer !== 'provider-exact' && row.tokenizer !== 'local-exact'
      && row.tokenizer !== 'conservative-estimate')
    || typeof row.supportsTools !== 'boolean' || typeof row.supportsStreaming !== 'boolean') {
    throw new Error('model-profile-declaration-invalid');
  }
  const contextWindowTokens = integer(row.contextWindowTokens, 'model-profile-context-window');
  const maxOutputTokens = integer(row.maxOutputTokens, 'model-profile-max-output');
  if (maxOutputTokens >= contextWindowTokens) throw new Error('model-profile-output-exceeds-window');
  const inputRate = optionalRate(row.inputMicrousdPerMillionTokens, 'model-profile-input-rate');
  const outputRate = optionalRate(row.outputMicrousdPerMillionTokens, 'model-profile-output-rate');
  if ((inputRate === undefined) !== (outputRate === undefined)) {
    throw new Error('model-profile-rates-must-be-paired');
  }
  return Object.freeze({
    providerId: id(row.providerId, 'model-profile-provider'),
    modelId: id(row.modelId, 'model-profile-model'),
    contextWindowTokens,
    maxOutputTokens,
    tokenizer: row.tokenizer,
    supportsTools: row.supportsTools,
    supportsStreaming: row.supportsStreaming,
    ...(inputRate === undefined ? {} : {
      inputMicrousdPerMillionTokens: inputRate,
      outputMicrousdPerMillionTokens: outputRate,
    }),
    updatedAt: timestamp(row.updatedAt),
  });
}

export function parseStaticModelRuntimeProfiles(
  raw: string | undefined,
): readonly StaticProfileDeclaration[] {
  if (!raw?.trim()) return Object.freeze([]);
  if (raw.length > MAX_PROFILE_JSON_CHARS) throw new Error('model-profile-json-too-large');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('model-profile-json-invalid'); }
  if (!Array.isArray(parsed) || parsed.length > 32) throw new Error('model-profile-json-invalid');
  const declarations = parsed.map(parseDeclaration);
  const keys = new Set<string>();
  for (const declaration of declarations) {
    const key = `${declaration.providerId}\0${declaration.modelId}`;
    if (keys.has(key)) throw new Error('model-profile-duplicate');
    keys.add(key);
  }
  return Object.freeze(declarations);
}

function optionalPositiveEnv(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return integer(parsed, label);
}

export function resolveModelRuntimeProfile(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly supportsTools?: boolean;
  readonly supportsStreaming?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ModelRuntimeProfile {
  const env = input.env ?? process.env;
  const providerId = id(input.providerId, 'model-profile-provider');
  const modelId = id(input.modelId, 'model-profile-model');
  const declarations = parseStaticModelRuntimeProfiles(env.JG_MODEL_RUNTIME_PROFILES_JSON);
  const declared = declarations.find((entry) => (
    entry.providerId === providerId && entry.modelId === modelId
  ));
  const defaultReserve = Math.max(
    MIN_OUTPUT_RESERVE_TOKENS,
    Math.ceil(DEFAULT_CONSERVATIVE_CONTEXT_TOKENS * 0.2),
  );
  const base = declared ?? Object.freeze({
    providerId,
    modelId,
    contextWindowTokens: DEFAULT_CONSERVATIVE_CONTEXT_TOKENS,
    maxOutputTokens: defaultReserve,
    tokenizer: 'conservative-estimate' as const,
    supportsTools: input.supportsTools === true,
    supportsStreaming: input.supportsStreaming === true,
    updatedAt: new Date(0).toISOString(),
  });
  const requestedContext = optionalPositiveEnv(
    env.JG_MODEL_CONTEXT_TOKENS,
    'model-profile-context-override',
  );
  if (requestedContext !== undefined && requestedContext > base.contextWindowTokens) {
    throw new Error('unverified-model-context-expansion');
  }
  const contextWindowTokens = Math.min(
    base.contextWindowTokens,
    requestedContext ?? base.contextWindowTokens,
  );
  const requestedOutput = optionalPositiveEnv(
    env.JG_MODEL_MAX_OUTPUT_TOKENS,
    'model-profile-output-override',
  );
  if (requestedOutput !== undefined && requestedOutput > base.maxOutputTokens) {
    throw new Error('unverified-model-output-expansion');
  }
  const maxOutputTokens = Math.min(base.maxOutputTokens, requestedOutput ?? base.maxOutputTokens);
  if (maxOutputTokens >= contextWindowTokens) throw new Error('model-profile-output-exceeds-window');
  return Object.freeze({
    version: MODEL_RUNTIME_PROFILE_VERSION,
    providerIdDigest: providerDigest(providerId),
    modelId,
    contextWindowTokens,
    maxOutputTokens,
    tokenizer: base.tokenizer,
    supportsTools: base.supportsTools,
    supportsStreaming: base.supportsStreaming,
    ...('inputMicrousdPerMillionTokens' in base ? {
      inputMicrousdPerMillionTokens: base.inputMicrousdPerMillionTokens,
      outputMicrousdPerMillionTokens: base.outputMicrousdPerMillionTokens,
    } : {}),
    source: 'static-declaration',
    updatedAt: base.updatedAt,
  });
}

export function modelRuntimeProfileDigest(profile: ModelRuntimeProfile): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(profile), 'utf8').digest('hex')}`;
}

export function contextModelProfileFromRuntime(
  profile: ModelRuntimeProfile,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ContextModelProfile {
  const minimumReserve = Math.max(
    MIN_OUTPUT_RESERVE_TOKENS,
    Math.ceil(profile.contextWindowTokens * 0.2),
  );
  if (minimumReserve > profile.maxOutputTokens) {
    throw new Error('model-profile-output-reserve-unavailable');
  }
  const requestedReserve = optionalPositiveEnv(
    env.JG_FINAL_OUTPUT_RESERVE_TOKENS,
    'model-profile-output-reserve',
  );
  const outputReserveTokens = Math.max(minimumReserve, requestedReserve ?? minimumReserve);
  if (outputReserveTokens > profile.maxOutputTokens) throw new Error('model-profile-output-reserve-exceeds-capability');
  const minimumSafetyPercent = profile.tokenizer === 'conservative-estimate' ? 5 : 2;
  const requestedSafetyPercent = optionalPositiveEnv(
    env.JG_CONTEXT_SAFETY_MARGIN_PERCENT,
    'model-profile-safety-percent',
  );
  const safetyPercent = Math.max(minimumSafetyPercent, requestedSafetyPercent ?? minimumSafetyPercent);
  if (safetyPercent > 8) throw new Error('model-profile-safety-percent-invalid');
  return Object.freeze({
    modelContextTokens: profile.contextWindowTokens,
    outputReserveTokens,
    safetyMarginTokens: Math.ceil((profile.contextWindowTokens - outputReserveTokens) * safetyPercent / 100),
  });
}
