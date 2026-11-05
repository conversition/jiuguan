import { createHash } from 'node:crypto';
import {
  AGENT_SKILL_KINDS,
  AGENT_SKILL_OWNERS,
  AGENT_SKILL_RISK_TIERS,
  AGENT_SKILL_SOURCE_TYPES,
  normalizeAgentSkillSelectionReceipt,
  type AgentSkillKind,
  type AgentSkillExecutionLimitsV1,
  type AgentSkillOwner,
  type AgentSkillRiskTier,
  type AgentSkillSelectionReceiptV1,
  type AgentSkillSourceType,
} from '@jiuguan/skill-hub';

export const SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION =
  'server-agent-skill-profile-policy-v1' as const;
export const SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION =
  'server-agent-skill-profile-authorization-v1' as const;

export interface AgentSkillFamilyContractV1 {
  readonly kind: AgentSkillKind;
  readonly artifactKind: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly evaluatorId: string;
  readonly owner: AgentSkillOwner;
  readonly sourceType: AgentSkillSourceType;
}

export interface AgentSkillFamilyRuleV1 {
  readonly familyId: string;
  readonly allowedContracts: readonly AgentSkillFamilyContractV1[];
  /** V1 never permits an enrolled Skill to opt itself into promotion. */
  readonly allowAutoPromotion: false;
}

export interface AgentSkillFamilyEnrollmentV1 {
  readonly familyId: string;
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  /** Required enrollments must be present in every authorized selection. */
  readonly required: boolean;
}

export interface ServerAgentSkillProfilePolicyV1 {
  readonly policyVersion: typeof SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION;
  readonly profileId: string;
  readonly familyRules: readonly AgentSkillFamilyRuleV1[];
  readonly enrollments: readonly AgentSkillFamilyEnrollmentV1[];
  readonly maxSkills: number;
  /** Maximum total body tokens selected before any prompt wrapper/compiler overhead. */
  readonly maxInstructionTokens: number;
  /** Per-Skill execution requirements may not exceed this Profile ceiling. */
  readonly executionCeiling: AgentSkillExecutionLimitsV1;
  readonly maxRiskTier: AgentSkillRiskTier;
  readonly allowedTools: readonly string[];
  readonly allowedWritableArtifactKinds: readonly string[];
}

export interface RegisteredServerAgentSkillProfilePolicyV1
  extends ServerAgentSkillProfilePolicyV1 {
  readonly policyRevision: string;
}

export interface ServerAgentSkillProfileAuthorizationV1 {
  readonly authorizationVersion: typeof SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION;
  readonly profileId: string;
  readonly policyRevision: string;
  readonly catalogRevision: string;
  readonly selectionReceiptDigest: string;
  readonly instructionSetDigest: string;
  readonly selectedManifestDigests: readonly string[];
  readonly authorizationDigest: string;
}

export const AGENT_SKILL_PROFILE_POLICY_DENIAL_REASONS = Object.freeze([
  'unknown-profile',
  'selection-limit-exceeded',
  'token-limit-exceeded',
  'budget-conflict',
  'unregistered-manifest',
  'required-manifest-missing',
  'contract-mismatch',
  'auto-promotion-forbidden',
  'risk-tier-exceeded',
  'execution-limit-exceeded',
  'tool-not-allowed',
  'artifact-not-allowed',
] as const);

export type AgentSkillProfilePolicyDenialReason =
  typeof AGENT_SKILL_PROFILE_POLICY_DENIAL_REASONS[number];

export class AgentSkillProfilePolicyDeniedError extends Error {
  readonly code = 'agent-skill-profile-policy-denied' as const;

  constructor(readonly reason: AgentSkillProfilePolicyDenialReason) {
    super(`agent-skill-profile-policy-denied:${reason}`);
    this.name = 'AgentSkillProfilePolicyDeniedError';
  }
}

const POLICY_KEYS = new Set([
  'policyVersion', 'profileId', 'familyRules', 'enrollments', 'maxSkills',
  'maxInstructionTokens', 'executionCeiling', 'maxRiskTier', 'allowedTools',
  'allowedWritableArtifactKinds',
]);
const RULE_KEYS = new Set(['familyId', 'allowedContracts', 'allowAutoPromotion']);
const CONTRACT_KEYS = new Set([
  'kind', 'artifactKind', 'inputSchemaDigest', 'outputSchemaDigest',
  'evaluatorId', 'owner', 'sourceType',
]);
const ENROLLMENT_KEYS = new Set(['familyId', 'skillId', 'version', 'manifestDigest', 'required']);
const EXECUTION_LIMIT_KEYS = new Set([
  'maxModelCalls', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens',
]);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const RISK_ORDER: Readonly<Record<AgentSkillRiskTier, number>> = Object.freeze({
  advisory: 0,
  proposal: 1,
  write: 2,
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  const actual = Object.keys(value);
  const unsupported = actual.find((key) => !keys.has(key));
  if (unsupported !== undefined) throw new TypeError(`${label} contains unsupported field: ${unsupported}`);
  const missing = [...keys].find((key) => !(key in value));
  if (missing !== undefined) throw new TypeError(`${label}.${missing} is required`);
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    throw new TypeError(`${label} must be a stable token`);
  }
  return value;
}

function version(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) {
    throw new TypeError(`${label} must be an immutable version token`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function denseArray(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain between ${minimum} and ${maximum} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be a dense array`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new TypeError(`${label} contains an unsupported value`);
  }
  return value as T[number];
}

function tokenSet(value: unknown, label: string): readonly string[] {
  const input = denseArray(value, label, 0, 256);
  const output = input.map((item, index) => token(item, `${label}[${index}]`)).sort(compareText);
  if (new Set(output).size !== output.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(output);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)), 'utf8')
    .digest('hex')}`;
}

function contractKey(contract: AgentSkillFamilyContractV1): string {
  return [
    contract.kind,
    contract.artifactKind,
    contract.inputSchemaDigest,
    contract.outputSchemaDigest,
    contract.evaluatorId,
    contract.owner,
    contract.sourceType,
  ].join('\u0000');
}

function normalizeContract(input: unknown, familyId: string, index: number): AgentSkillFamilyContractV1 {
  const label = `profilePolicy.familyRules[${familyId}].allowedContracts[${index}]`;
  plainRecord(input, label);
  exactKeys(input, CONTRACT_KEYS, label);
  const normalized = Object.freeze({
    kind: enumValue(input.kind, AGENT_SKILL_KINDS, `${label}.kind`),
    artifactKind: token(input.artifactKind, `${label}.artifactKind`),
    inputSchemaDigest: digest(input.inputSchemaDigest, `${label}.inputSchemaDigest`),
    outputSchemaDigest: digest(input.outputSchemaDigest, `${label}.outputSchemaDigest`),
    evaluatorId: token(input.evaluatorId, `${label}.evaluatorId`),
    owner: enumValue(input.owner, AGENT_SKILL_OWNERS, `${label}.owner`),
    sourceType: enumValue(input.sourceType, AGENT_SKILL_SOURCE_TYPES, `${label}.sourceType`),
  });

  const hostBuiltin = normalized.owner === 'host' && normalized.sourceType === 'builtin';
  const authorFilesystem = normalized.owner === 'author' && normalized.sourceType === 'filesystem';
  const validatedCandidate = normalized.owner === 'author' && normalized.sourceType === 'imported';
  if (!hostBuiltin && !authorFilesystem && !validatedCandidate) {
    throw new TypeError(`${label} source trust pair is not live-consumable in V1`);
  }
  if (validatedCandidate && familyId !== 'skill.candidate-replay') {
    throw new TypeError('author imported contracts must belong to skill.candidate-replay');
  }
  if (familyId === 'skill.foundation') {
    if (!hostBuiltin || normalized.kind !== 'foundation') {
      throw new TypeError('skill.foundation contracts must be host-owned builtin foundations');
    }
  } else if (normalized.kind === 'foundation') {
    throw new TypeError('foundation contracts must belong to skill.foundation');
  }
  if (authorFilesystem && normalized.kind === 'policy') {
    throw new TypeError('author filesystem contracts cannot define system policy');
  }
  if (validatedCandidate && normalized.kind === 'policy') {
    throw new TypeError('validated candidate contracts cannot define system policy');
  }
  return normalized;
}

function normalizeRule(input: unknown, index: number): AgentSkillFamilyRuleV1 {
  const label = `profilePolicy.familyRules[${index}]`;
  plainRecord(input, label);
  exactKeys(input, RULE_KEYS, label);
  const familyId = token(input.familyId, `${label}.familyId`);
  const contractInputs = denseArray(input.allowedContracts, `${label}.allowedContracts`, 1, 64);
  if (input.allowAutoPromotion !== false) {
    throw new TypeError(`${label}.allowAutoPromotion must remain false in V1`);
  }
  const allowedContracts = contractInputs
    .map((item, contractIndex) => normalizeContract(item, familyId, contractIndex))
    .sort((left, right) => compareText(contractKey(left), contractKey(right)));
  const keys = allowedContracts.map(contractKey);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError(`${label}.allowedContracts must not contain duplicates`);
  }
  return Object.freeze({
    familyId,
    allowedContracts: Object.freeze(allowedContracts),
    allowAutoPromotion: false,
  });
}

function normalizeEnrollment(input: unknown, index: number): AgentSkillFamilyEnrollmentV1 {
  const label = `profilePolicy.enrollments[${index}]`;
  plainRecord(input, label);
  exactKeys(input, ENROLLMENT_KEYS, label);
  if (typeof input.required !== 'boolean') {
    throw new TypeError(`${label}.required must be a boolean`);
  }
  const normalized = Object.freeze({
    familyId: token(input.familyId, `${label}.familyId`),
    skillId: token(input.skillId, `${label}.skillId`),
    version: version(input.version, `${label}.version`),
    manifestDigest: digest(input.manifestDigest, `${label}.manifestDigest`),
    required: input.required,
  });
  if (normalized.familyId === 'skill.foundation' && !normalized.required) {
    throw new TypeError('skill.foundation enrollments must be required');
  }
  return normalized;
}

function normalizeExecutionCeiling(input: unknown): AgentSkillExecutionLimitsV1 {
  plainRecord(input, 'profilePolicy.executionCeiling');
  exactKeys(input, EXECUTION_LIMIT_KEYS, 'profilePolicy.executionCeiling');
  return Object.freeze({
    maxModelCalls: safeInteger(
      input.maxModelCalls,
      'profilePolicy.executionCeiling.maxModelCalls',
      0,
      1_000,
    ),
    maxToolCalls: safeInteger(
      input.maxToolCalls,
      'profilePolicy.executionCeiling.maxToolCalls',
      0,
      10_000,
    ),
    maxInputTokens: safeInteger(
      input.maxInputTokens,
      'profilePolicy.executionCeiling.maxInputTokens',
      0,
      10_000_000,
    ),
    maxOutputTokens: safeInteger(
      input.maxOutputTokens,
      'profilePolicy.executionCeiling.maxOutputTokens',
      0,
      10_000_000,
    ),
  });
}

export function normalizeServerAgentSkillProfilePolicy(
  input: unknown,
): RegisteredServerAgentSkillProfilePolicyV1 {
  plainRecord(input, 'profilePolicy');
  exactKeys(input, POLICY_KEYS, 'profilePolicy');
  if (input.policyVersion !== SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION) {
    throw new TypeError(`profilePolicy.policyVersion must be ${SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION}`);
  }
  const ruleInputs = denseArray(input.familyRules, 'profilePolicy.familyRules', 1, 64);
  const familyRules = ruleInputs.map(normalizeRule)
    .sort((left, right) => compareText(left.familyId, right.familyId));
  if (new Set(familyRules.map((item) => item.familyId)).size !== familyRules.length) {
    throw new TypeError('profilePolicy.familyRules must not contain duplicate family ids');
  }
  if (!familyRules.some((item) => item.familyId === 'skill.foundation')) {
    throw new TypeError('profilePolicy.familyRules must include skill.foundation');
  }
  const enrollmentInputs = denseArray(input.enrollments, 'profilePolicy.enrollments', 1, 10_000);
  const enrollments = enrollmentInputs.map(normalizeEnrollment).sort((left, right) => (
    compareText(left.skillId, right.skillId)
    || compareText(left.version, right.version)
    || compareText(left.manifestDigest, right.manifestDigest)
  ));
  const enrollmentRefs = enrollments.map((item) => `${item.skillId}\u0000${item.version}`);
  if (new Set(enrollmentRefs).size !== enrollmentRefs.length) {
    throw new TypeError('profilePolicy.enrollments must bind each Skill version exactly once');
  }
  const familyIds = new Set(familyRules.map((item) => item.familyId));
  if (enrollments.some((item) => !familyIds.has(item.familyId))) {
    throw new TypeError('profilePolicy enrollment refers to a family without a rule');
  }
  const requiredSkillIds = enrollments.filter((item) => item.required).map((item) => item.skillId);
  if (new Set(requiredSkillIds).size !== requiredSkillIds.length) {
    throw new TypeError('profilePolicy cannot require multiple versions of one Skill');
  }
  if (!enrollments.some((item) => item.familyId === 'skill.foundation')) {
    throw new TypeError('profilePolicy must enroll at least one required skill.foundation manifest');
  }

  const core: ServerAgentSkillProfilePolicyV1 = Object.freeze({
    policyVersion: SERVER_AGENT_SKILL_PROFILE_POLICY_VERSION,
    profileId: token(input.profileId, 'profilePolicy.profileId'),
    familyRules: Object.freeze(familyRules),
    enrollments: Object.freeze(enrollments),
    maxSkills: safeInteger(input.maxSkills, 'profilePolicy.maxSkills', 1, 64),
    maxInstructionTokens: safeInteger(
      input.maxInstructionTokens,
      'profilePolicy.maxInstructionTokens',
      0,
      10_000_000,
    ),
    executionCeiling: normalizeExecutionCeiling(input.executionCeiling),
    maxRiskTier: enumValue(input.maxRiskTier, AGENT_SKILL_RISK_TIERS, 'profilePolicy.maxRiskTier'),
    allowedTools: tokenSet(input.allowedTools, 'profilePolicy.allowedTools'),
    allowedWritableArtifactKinds: tokenSet(
      input.allowedWritableArtifactKinds,
      'profilePolicy.allowedWritableArtifactKinds',
    ),
  });
  return Object.freeze({ ...core, policyRevision: canonicalDigest(core) });
}

function selectedContract(
  receipt: AgentSkillSelectionReceiptV1,
  index: number,
): AgentSkillFamilyContractV1 {
  const manifest = receipt.selected[index]!.header.manifest;
  return Object.freeze({
    kind: manifest.kind,
    artifactKind: manifest.artifactKind,
    inputSchemaDigest: manifest.inputSchemaDigest,
    outputSchemaDigest: manifest.outputSchemaDigest,
    evaluatorId: manifest.evaluatorId,
    owner: manifest.owner,
    sourceType: manifest.sourceType,
  });
}

function deny(reason: AgentSkillProfilePolicyDenialReason): never {
  throw new AgentSkillProfilePolicyDeniedError(reason);
}

/**
 * Body-free, server-owned exact policy registry. Family membership comes only from immutable
 * enrollment; manifest capability/name/artifact fields are never used to infer a family.
 * Constructing this registry has no runtime effect until a trusted admission service invokes it.
 */
export class ServerAgentSkillProfilePolicyRegistry {
  readonly policies: readonly RegisteredServerAgentSkillProfilePolicyV1[];
  readonly registryRevision: string;
  readonly #byProfileId: ReadonlyMap<string, RegisteredServerAgentSkillProfilePolicyV1>;

  constructor(policiesInput: readonly ServerAgentSkillProfilePolicyV1[]) {
    const policyInputs = denseArray(
      policiesInput,
      'Agent Skill profile policies',
      0,
      64,
    );
    const policies = policyInputs.map(normalizeServerAgentSkillProfilePolicy)
      .sort((left, right) => compareText(left.profileId, right.profileId));
    if (new Set(policies.map((item) => item.profileId)).size !== policies.length) {
      throw new TypeError('Agent Skill profile policies must not contain duplicate profile ids');
    }
    this.policies = Object.freeze(policies);
    this.#byProfileId = new Map(policies.map((item) => [item.profileId, item]));
    this.registryRevision = canonicalDigest(policies.map((item) => ({
      profileId: item.profileId,
      policyRevision: item.policyRevision,
    })));
    Object.freeze(this);
  }

  byProfileId(profileId: string): RegisteredServerAgentSkillProfilePolicyV1 | undefined {
    return this.#byProfileId.get(profileId);
  }

  authorizeSelection(
    profileId: string,
    receiptInput: AgentSkillSelectionReceiptV1,
  ): ServerAgentSkillProfileAuthorizationV1 {
    const policy = this.#byProfileId.get(profileId);
    if (!policy) return deny('unknown-profile');
    plainRecord(receiptInput, 'selectionReceipt');
    denseArray(receiptInput.selected, 'selectionReceipt.selected', 0, 64);
    denseArray(receiptInput.rejected, 'selectionReceipt.rejected', 0, 10_000);
    const receipt = normalizeAgentSkillSelectionReceipt(receiptInput);
    if (receipt.selected.length > policy.maxSkills) return deny('selection-limit-exceeded');
    if (receipt.usedTokens > policy.maxInstructionTokens) return deny('token-limit-exceeded');
    if (receipt.budgetConflict) return deny('budget-conflict');

    const rules = new Map(policy.familyRules.map((item) => [item.familyId, item]));
    const enrollments = new Map(policy.enrollments.map((item) => (
      [`${item.skillId}\u0000${item.version}`, item] as const
    )));
    const allowedTools = new Set(policy.allowedTools);
    const allowedArtifacts = new Set(policy.allowedWritableArtifactKinds);
    const selectedRefs = new Set(receipt.selected.map(({ header }) => (
      `${header.manifest.skillId}\u0000${header.manifest.version}\u0000${header.manifestDigest}`
    )));
    if (policy.enrollments.some((item) => item.required && !selectedRefs.has(
      `${item.skillId}\u0000${item.version}\u0000${item.manifestDigest}`,
    ))) {
      return deny('required-manifest-missing');
    }

    for (let index = 0; index < receipt.selected.length; index += 1) {
      const header = receipt.selected[index]!.header;
      const manifest = header.manifest;
      const enrollment = enrollments.get(`${manifest.skillId}\u0000${manifest.version}`);
      if (!enrollment || enrollment.manifestDigest !== header.manifestDigest) {
        return deny('unregistered-manifest');
      }
      const rule = rules.get(enrollment.familyId);
      if (!rule || !rule.allowedContracts.some((item) => (
        contractKey(item) === contractKey(selectedContract(receipt, index))
      ))) {
        return deny('contract-mismatch');
      }
      if (manifest.autoPromotion || rule.allowAutoPromotion) return deny('auto-promotion-forbidden');
      if (RISK_ORDER[manifest.riskTier] > RISK_ORDER[policy.maxRiskTier]) {
        return deny('risk-tier-exceeded');
      }
      if (manifest.limits.maxModelCalls > policy.executionCeiling.maxModelCalls
        || manifest.limits.maxToolCalls > policy.executionCeiling.maxToolCalls
        || manifest.limits.maxInputTokens > policy.executionCeiling.maxInputTokens
        || manifest.limits.maxOutputTokens > policy.executionCeiling.maxOutputTokens) {
        return deny('execution-limit-exceeded');
      }
      if (manifest.desiredTools.some((item) => !allowedTools.has(item))) {
        return deny('tool-not-allowed');
      }
      if (manifest.writableArtifactKinds.some((item) => !allowedArtifacts.has(item))) {
        return deny('artifact-not-allowed');
      }
    }

    const core = Object.freeze({
      authorizationVersion: SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION,
      profileId: policy.profileId,
      policyRevision: policy.policyRevision,
      catalogRevision: receipt.catalogRevision,
      selectionReceiptDigest: receipt.receiptDigest,
      instructionSetDigest: receipt.instructionSetDigest,
      selectedManifestDigests: Object.freeze(
        receipt.selected.map((item) => item.header.manifestDigest),
      ),
    });
    return Object.freeze({ ...core, authorizationDigest: canonicalDigest(core) });
  }
}

export function createServerAgentSkillProfilePolicyRegistry(
  policies: readonly ServerAgentSkillProfilePolicyV1[],
): ServerAgentSkillProfilePolicyRegistry {
  return new ServerAgentSkillProfilePolicyRegistry(policies);
}
