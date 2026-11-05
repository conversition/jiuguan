/**
 * SKP-1 第一步：SkillPackage v2（`agent-skill-package-v2`）。
 *
 * v1 只描述「一个 manifest + 一段 body」。真实交付还需要回答四类问题，而它们
 * 都不该塞进 manifest（manifest 是**权限要求**，不是资源账本、也不是发布记录）：
 *
 * 1. **包里到底有哪些文件**：`resources[]` 逐项 `path/role/bytes/sha256`，
 *    恰好一个 `role=body`，且它的摘要必须等于 manifest 的 `bodyHash`。
 *    这样「包」是可校验的，不用信任目录里还有什么。
 * 2. **谁拥有它**：`ownerRef` 是稳定的人格/团队引用，不是自由文本。
 * 3. **在什么环境里允许跑**：`environment.modelPolicy`（any / allowlist + 窗口下限）
 *    与 sandbox/context 策略引用。它们只是**要求**，admission 仍要用宿主授权去证。
 * 4. **发布与效果**：`release` 是发布状态机（draft/published/deprecated/retired），
 *    `effect` 是**读模型**（样本数/通过数/评测套件引用），永远不是发布权威。
 *
 * 本文件是纯合同：不读盘、不算 hash、不发布。资源摘要由调用方（迁移器/编译器）算好再传。
 */
import {
  assertExactKeys,
  assertPlainRecord,
  boundedString,
  compareText,
  deepFreeze,
  digestCanonical,
  isoTimestamp,
  member,
  safeInteger,
  sha256Digest,
  stableToken,
  uniqueSortedTokens,
} from './internal.ts';
import {
  normalizeAgentSkillBundle,
  type AgentSkillBundleV1,
} from './manifest.ts';

export const AGENT_SKILL_PACKAGE_V2_VERSION = 'agent-skill-package-v2' as const;

export const AGENT_SKILL_RESOURCE_ROLES = Object.freeze([
  'body', 'reference', 'template', 'schema', 'sample', 'asset',
] as const);
export type AgentSkillResourceRole = typeof AGENT_SKILL_RESOURCE_ROLES[number];

export const AGENT_SKILL_MODEL_POLICY_MODES = Object.freeze(['any', 'allowlist'] as const);
export type AgentSkillModelPolicyMode = typeof AGENT_SKILL_MODEL_POLICY_MODES[number];

export const AGENT_SKILL_ACCEPTANCE_KINDS = Object.freeze([
  'static', 'replay', 'shadow', 'canary', 'human',
] as const);
export type AgentSkillAcceptanceKind = typeof AGENT_SKILL_ACCEPTANCE_KINDS[number];

export const AGENT_SKILL_RELEASE_STATES = Object.freeze([
  'draft', 'published', 'deprecated', 'retired',
] as const);
export type AgentSkillReleaseState = typeof AGENT_SKILL_RELEASE_STATES[number];

export interface AgentSkillResourceV1 {
  /** 包内相对路径，`/` 分隔，不允许 `..`、绝对路径或反斜杠。 */
  readonly path: string;
  readonly role: AgentSkillResourceRole;
  readonly mediaType: string;
  /** UTF-8 字节数（正文按 UTF-8 计，不按字符计）。 */
  readonly bytes: number;
  readonly sha256: string;
}

export interface AgentSkillEnvironmentPolicyV1 {
  readonly modelPolicy: Readonly<{
    readonly mode: AgentSkillModelPolicyMode;
    readonly allowedModelIds: readonly string[];
    readonly minContextTokens: number;
    readonly maxOutputTokens: number;
  }>;
  readonly sandboxProfileRef: string;
  readonly contextPolicyRef: string;
}

export interface AgentSkillAcceptanceCheckV1 {
  readonly kind: AgentSkillAcceptanceKind;
  readonly ref: string;
  readonly required: boolean;
}

export interface AgentSkillAcceptanceV1 {
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly checks: readonly AgentSkillAcceptanceCheckV1[];
}

export interface AgentSkillReleaseV1 {
  readonly state: AgentSkillReleaseState;
  readonly publishedAt?: string;
  readonly deprecatedAt?: string;
  readonly deprecationReason?: string;
  readonly replacementRef?: string;
}

/** 效果**读模型**：从评测/回放聚合出来的观测值，不参与发布判定。 */
export interface AgentSkillEffectReadModelV1 {
  readonly sampleCount: number;
  readonly passCount: number;
  readonly lastEvaluatedAt?: string;
  readonly qualitySuiteRef?: string;
}

export interface AgentSkillPackageV2 {
  readonly packageVersion: typeof AGENT_SKILL_PACKAGE_V2_VERSION;
  readonly bundle: AgentSkillBundleV1;
  readonly resources: readonly AgentSkillResourceV1[];
  readonly ownerRef: string;
  readonly environment: AgentSkillEnvironmentPolicyV1;
  readonly acceptance: AgentSkillAcceptanceV1;
  readonly release: AgentSkillReleaseV1;
  readonly effect: AgentSkillEffectReadModelV1;
  readonly packageDigest: string;
}

const PACKAGE_KEYS = new Set([
  'packageVersion', 'bundle', 'resources', 'ownerRef', 'environment',
  'acceptance', 'release', 'effect', 'packageDigest',
]);
const REQUIRED_PACKAGE_KEYS = new Set(
  [...PACKAGE_KEYS].filter((key) => key !== 'packageDigest'),
);
const RESOURCE_KEYS = new Set(['path', 'role', 'mediaType', 'bytes', 'sha256']);
const ENVIRONMENT_KEYS = new Set(['modelPolicy', 'sandboxProfileRef', 'contextPolicyRef']);
const MODEL_POLICY_KEYS = new Set(['mode', 'allowedModelIds', 'minContextTokens', 'maxOutputTokens']);
const ACCEPTANCE_KEYS = new Set(['inputSchemaRef', 'outputSchemaRef', 'checks']);
const CHECK_KEYS = new Set(['kind', 'ref', 'required']);
const RELEASE_KEYS = new Set(['state', 'publishedAt', 'deprecatedAt', 'deprecationReason', 'replacementRef']);
const EFFECT_KEYS = new Set(['sampleCount', 'passCount', 'lastEvaluatedAt', 'qualitySuiteRef']);
const MAX_RESOURCES = 256;
const MAX_BYTES = 16 * 1024 * 1024;

function resourcePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new TypeError(`${label} must be a bounded relative path`);
  }
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`${label} must be a portable relative path`);
  }
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} must not contain empty, '.' or '..' segments`);
  }
  return value;
}

function normalizeResource(value: unknown, index: number): AgentSkillResourceV1 {
  const label = `package.resources[${index}]`;
  assertPlainRecord(value, label);
  assertExactKeys(value, RESOURCE_KEYS, RESOURCE_KEYS, label);
  const role = member(value.role, AGENT_SKILL_RESOURCE_ROLES, `${label}.role`);
  const bytes = safeInteger(value.bytes, `${label}.bytes`, 0, MAX_BYTES);
  return deepFreeze({
    path: resourcePath(value.path, `${label}.path`),
    role,
    mediaType: boundedString(value.mediaType, `${label}.mediaType`, 120),
    bytes,
    sha256: sha256Digest(value.sha256, `${label}.sha256`),
  });
}

function normalizeResources(
  value: unknown,
  bodyHash: string,
): readonly AgentSkillResourceV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RESOURCES) {
    throw new TypeError(`package.resources must have 1..${MAX_RESOURCES} items`);
  }
  const resources = value
    .map((item, index) => normalizeResource(item, index))
    .sort((left, right) => compareText(left.path, right.path));
  const paths = resources.map((item) => item.path);
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) {
    throw new TypeError('package.resources must not repeat a path');
  }
  const bodies = resources.filter((item) => item.role === 'body');
  if (bodies.length !== 1) throw new TypeError('package.resources must contain exactly one body');
  // 包的正文摘要必须与 manifest 的 bodyHash 对齐：否则「包里那段字」和「声明的那段字」不是同一段。
  if (bodies[0]!.sha256 !== bodyHash) {
    throw new TypeError('package body resource sha256 must equal manifest.bodyHash');
  }
  return Object.freeze(resources);
}

function normalizeModelPolicy(value: unknown): AgentSkillEnvironmentPolicyV1['modelPolicy'] {
  assertPlainRecord(value, 'package.environment.modelPolicy');
  assertExactKeys(value, MODEL_POLICY_KEYS, MODEL_POLICY_KEYS, 'package.environment.modelPolicy');
  const mode = member(value.mode, AGENT_SKILL_MODEL_POLICY_MODES,
    'package.environment.modelPolicy.mode');
  const allowedModelIds = uniqueSortedTokens(
    value.allowedModelIds, 'package.environment.modelPolicy.allowedModelIds',
  );
  // any 与 allowlist 互斥：any 却带清单 = 清单被静默忽略，是权限谎报的常见形态。
  if (mode === 'any' && allowedModelIds.length > 0) {
    throw new TypeError('package.environment.modelPolicy.mode=any forbids allowedModelIds');
  }
  if (mode === 'allowlist' && allowedModelIds.length === 0) {
    throw new TypeError('package.environment.modelPolicy.mode=allowlist requires allowedModelIds');
  }
  return deepFreeze({
    mode,
    allowedModelIds,
    minContextTokens: safeInteger(value.minContextTokens,
      'package.environment.modelPolicy.minContextTokens', 0, 10_000_000),
    maxOutputTokens: safeInteger(value.maxOutputTokens,
      'package.environment.modelPolicy.maxOutputTokens', 1, 10_000_000),
  });
}

function normalizeAcceptance(value: unknown): AgentSkillAcceptanceV1 {
  assertPlainRecord(value, 'package.acceptance');
  assertExactKeys(value, ACCEPTANCE_KEYS, ACCEPTANCE_KEYS, 'package.acceptance');
  if (!Array.isArray(value.checks) || value.checks.length > 32) {
    throw new TypeError('package.acceptance.checks must be an array with at most 32 items');
  }
  const checks = value.checks.map((item, index) => {
    const label = `package.acceptance.checks[${index}]`;
    assertPlainRecord(item, label);
    assertExactKeys(item, CHECK_KEYS, CHECK_KEYS, label);
    if (typeof item.required !== 'boolean') throw new TypeError(`${label}.required must be boolean`);
    return deepFreeze({
      kind: member(item.kind, AGENT_SKILL_ACCEPTANCE_KINDS, `${label}.kind`),
      ref: stableToken(item.ref, `${label}.ref`),
      required: item.required,
    });
  }).sort((left, right) => compareText(left.kind, right.kind) || compareText(left.ref, right.ref));
  const refs = checks.map((item) => `${item.kind}\u0000${item.ref}`);
  if (new Set(refs).size !== refs.length) {
    throw new TypeError('package.acceptance.checks must not contain duplicates');
  }
  return deepFreeze({
    inputSchemaRef: stableToken(value.inputSchemaRef, 'package.acceptance.inputSchemaRef'),
    outputSchemaRef: stableToken(value.outputSchemaRef, 'package.acceptance.outputSchemaRef'),
    checks,
  });
}

function normalizeRelease(value: unknown): AgentSkillReleaseV1 {
  assertPlainRecord(value, 'package.release');
  assertExactKeys(value, RELEASE_KEYS, new Set(['state']), 'package.release');
  const state = member(value.state, AGENT_SKILL_RELEASE_STATES, 'package.release.state');
  const publishedAt = value.publishedAt === undefined
    ? undefined : isoTimestamp(value.publishedAt, 'package.release.publishedAt');
  const deprecatedAt = value.deprecatedAt === undefined
    ? undefined : isoTimestamp(value.deprecatedAt, 'package.release.deprecatedAt');
  const deprecationReason = value.deprecationReason === undefined
    ? undefined : stableToken(value.deprecationReason, 'package.release.deprecationReason');
  const replacementRef = value.replacementRef === undefined
    ? undefined : stableToken(value.replacementRef, 'package.release.replacementRef');
  if (state === 'published' && publishedAt === undefined) {
    throw new TypeError('package.release.state=published requires publishedAt');
  }
  if ((state === 'deprecated' || state === 'retired')
    && (deprecatedAt === undefined || deprecationReason === undefined)) {
    throw new TypeError(`package.release.state=${state} requires deprecatedAt and deprecationReason`);
  }
  if (state === 'retired' && replacementRef === undefined) {
    throw new TypeError('package.release.state=retired requires replacementRef');
  }
  if (state === 'draft' && (publishedAt !== undefined || deprecatedAt !== undefined
    || deprecationReason !== undefined || replacementRef !== undefined)) {
    throw new TypeError('package.release draft must not claim publication or deprecation');
  }
  if (state === 'published' && (deprecatedAt !== undefined || deprecationReason !== undefined || replacementRef !== undefined)) {
    throw new TypeError('package.release published must not claim deprecation');
  }
  if (publishedAt !== undefined && deprecatedAt !== undefined && deprecatedAt < publishedAt) {
    throw new TypeError('package.release deprecation must not precede publication');
  }
  return deepFreeze({
    state,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(deprecatedAt === undefined ? {} : { deprecatedAt }),
    ...(deprecationReason === undefined ? {} : { deprecationReason }),
    ...(replacementRef === undefined ? {} : { replacementRef }),
  });
}

function normalizeEffect(value: unknown): AgentSkillEffectReadModelV1 {
  assertPlainRecord(value, 'package.effect');
  assertExactKeys(value, EFFECT_KEYS, new Set(['sampleCount', 'passCount']), 'package.effect');
  const sampleCount = safeInteger(value.sampleCount, 'package.effect.sampleCount', 0, 10_000_000);
  const passCount = safeInteger(value.passCount, 'package.effect.passCount', 0, 10_000_000);
  if (passCount > sampleCount) {
    throw new TypeError('package.effect.passCount must not exceed sampleCount');
  }
  const lastEvaluatedAt = value.lastEvaluatedAt === undefined
    ? undefined : isoTimestamp(value.lastEvaluatedAt, 'package.effect.lastEvaluatedAt');
  const qualitySuiteRef = value.qualitySuiteRef === undefined
    ? undefined : stableToken(value.qualitySuiteRef, 'package.effect.qualitySuiteRef');
  if (sampleCount > 0 && lastEvaluatedAt === undefined) {
    throw new TypeError('package.effect with samples requires lastEvaluatedAt');
  }
  return deepFreeze({
    sampleCount,
    passCount,
    ...(lastEvaluatedAt === undefined ? {} : { lastEvaluatedAt }),
    ...(qualitySuiteRef === undefined ? {} : { qualitySuiteRef }),
  });
}

function bodyLessPackage(value: Omit<AgentSkillPackageV2, 'packageDigest'>) {
  return {
    packageVersion: value.packageVersion,
    bundle: value.bundle,
    resources: value.resources,
    ownerRef: value.ownerRef,
    environment: value.environment,
    acceptance: value.acceptance,
    release: value.release,
    effect: value.effect,
  };
}

/**
 * 规范化一个 v2 包。bundle 必须是 v1 的合法 bundle（header 自证 + body 摘要/口径一致），
 * 且调用方传入的 `bundleDigest` 必须等于重算值——否则「包里那段字」和「声明的那段字」不是同一段。
 */
export function normalizeAgentSkillPackageV2(input: unknown): AgentSkillPackageV2 {
  assertPlainRecord(input, 'package');
  // packageDigest 可由调用方省略（构建期）；给了就必须与重算值一致。
  assertExactKeys(input, PACKAGE_KEYS, REQUIRED_PACKAGE_KEYS, 'package');
  if (input.packageVersion !== AGENT_SKILL_PACKAGE_V2_VERSION) {
    throw new TypeError(`package.packageVersion must be ${AGENT_SKILL_PACKAGE_V2_VERSION}`);
  }
  const bundle = normalizeAgentSkillBundle(input.bundle);
  const resources = normalizeResources(input.resources, bundle.header.manifest.bodyHash);
  return buildNormalized(input, bundle, resources);
}

/** 同义入口：`create` 只做「从零构建」，落盘仍是同一份规范化结果。 */
export const createAgentSkillPackageV2 = normalizeAgentSkillPackageV2;

function buildNormalized(
  input: Record<string, unknown>,
  bundle: AgentSkillBundleV1,
  resources: readonly AgentSkillResourceV1[],
): AgentSkillPackageV2 {
  const environmentRecord = input.environment;
  assertPlainRecord(environmentRecord, 'package.environment');
  assertExactKeys(environmentRecord, ENVIRONMENT_KEYS, ENVIRONMENT_KEYS, 'package.environment');
  const environment = deepFreeze({
    modelPolicy: normalizeModelPolicy(environmentRecord.modelPolicy),
    sandboxProfileRef: stableToken(environmentRecord.sandboxProfileRef,
      'package.environment.sandboxProfileRef'),
    contextPolicyRef: stableToken(environmentRecord.contextPolicyRef,
      'package.environment.contextPolicyRef'),
  });
  const withoutDigest = bodyLessPackage({
    packageVersion: AGENT_SKILL_PACKAGE_V2_VERSION,
    bundle,
    resources,
    ownerRef: stableToken(input.ownerRef, 'package.ownerRef'),
    environment,
    acceptance: normalizeAcceptance(input.acceptance),
    release: normalizeRelease(input.release),
    effect: normalizeEffect(input.effect),
  });
  const packageDigest = digestCanonical(withoutDigest);
  if (input.packageDigest !== undefined) {
    if (sha256Digest(input.packageDigest, 'package.packageDigest') !== packageDigest) {
      throw new TypeError('package.packageDigest mismatch');
    }
  }
  return deepFreeze({ ...withoutDigest, packageDigest });
}

