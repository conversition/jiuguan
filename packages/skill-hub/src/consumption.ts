import {
  type AdmittedAgentSkillV1,
  type AgentSkillAdmissionV1,
} from './materialization.ts';
import {
  ADMITTED_AGENT_SKILL_VERSION,
  AGENT_SKILL_ADMISSION_VERSION,
} from './materialization.ts';
import {
  AGENT_SKILL_KINDS,
  computeAgentSkillBodyHash,
  exactAgentSkillTokens,
  normalizeAgentSkillHeader,
  type AgentSkillKind,
  type AgentSkillOwner,
  type AgentSkillSourceType,
} from './manifest.ts';
import {
  assertExactKeys,
  assertPlainRecord,
  canonicalJson,
  compareText,
  deepFreeze,
  digestCanonical,
  member,
  safeInteger,
  sha256Digest,
  stableToken,
  versionToken,
} from './internal.ts';

export const AGENT_SKILL_PROGRAM_VERSION = 'agent-skill-program-v1' as const;
export const AGENT_SKILL_SOURCE_PROOF_VERSION = 'agent-skill-source-proof-v1' as const;
export const AGENT_SKILL_CONSUMPTION_VERSION = 'agent-skill-consumption-v1' as const;
export const SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION =
  'server-agent-skill-profile-authorization-v1' as const;

export const AGENT_SKILL_TRUST_CLASSES = Object.freeze([
  'host-builtin', 'reviewed-author', 'validated-candidate', 'promoted-learned',
] as const);
export type AgentSkillTrustClass = typeof AGENT_SKILL_TRUST_CLASSES[number];

export type AgentSkillProgramArgumentV1 = string | number | boolean;

export interface AgentSkillProgramOperationV1 {
  readonly primitiveId: string;
  /** Flat, bounded values only. Strings are opaque tokens, never natural-language instructions. */
  readonly args: Readonly<Record<string, AgentSkillProgramArgumentV1>>;
}

/**
 * Safe Skill body IR. It deliberately has no free-text field. A Prompt compiler must additionally
 * reject unknown primitive IDs and render only host-owned fixed templates.
 */
export interface AgentSkillProgramV1 {
  readonly programVersion: typeof AGENT_SKILL_PROGRAM_VERSION;
  readonly kind: AgentSkillKind;
  readonly operations: readonly AgentSkillProgramOperationV1[];
}

/**
 * Opaque evidence emitted by the trusted admission service after source review. This shape binds
 * that evidence to one exact admission and immutable Skill identity; parsing it does not turn a
 * caller-authored object into authority. Live callers must obtain it from the server authority.
 */
export interface AgentSkillSourceProofV1 {
  readonly proofVersion: typeof AGENT_SKILL_SOURCE_PROOF_VERSION;
  readonly admissionDigest: string;
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bodyHash: string;
  readonly trustClass: AgentSkillTrustClass;
  readonly profileId: string;
  /** Exact ProfileAdmissionService authorization; never derived from manifest owner/source fields. */
  readonly profileAuthorizationDigest: string;
  readonly profilePolicyRevision: string;
  readonly profileRegistryRevision: string;
  readonly authorityRevision: string;
  readonly evidenceDigest: string;
}

/**
 * Exact server Profile authorization augmented by the service revisions that verified it. The
 * safe compiler validates its integrity and bindings but does not mint this authority.
 */
export interface AgentSkillProfileAuthorizationV1 {
  readonly authorizationVersion: typeof SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION;
  readonly profileId: string;
  readonly policyRevision: string;
  readonly registryRevision: string;
  readonly authorityRevision: string;
  readonly catalogRevision: string;
  readonly selectionReceiptDigest: string;
  readonly instructionSetDigest: string;
  readonly selectedManifestDigests: readonly string[];
  readonly authorizationDigest: string;
}

export interface ConsumableAgentSkillProgramV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bodyHash: string;
  readonly kind: AgentSkillKind;
  readonly evaluatorId: string;
  readonly trustClass: AgentSkillTrustClass;
  readonly sourceProofDigest: string;
  readonly program: AgentSkillProgramV1;
  readonly programDigest: string;
}

export interface AgentSkillConsumptionSetV1 {
  readonly consumptionVersion: typeof AGENT_SKILL_CONSUMPTION_VERSION;
  readonly catalogRevision: string;
  readonly selectionReceiptDigest: string;
  readonly instructionSetDigest: string;
  readonly admissionDigest: string;
  readonly profileId: string;
  readonly profileAuthorizationDigest: string;
  readonly profilePolicyRevision: string;
  readonly profileRegistryRevision: string;
  readonly authorityRevision: string;
  readonly sourceProofSetDigest: string;
  readonly programs: readonly ConsumableAgentSkillProgramV1[];
  readonly consumptionDigest: string;
}

const PROGRAM_KEYS = new Set(['programVersion', 'kind', 'operations']);
const OPERATION_KEYS = new Set(['primitiveId', 'args']);
const ADMISSION_KEYS = new Set([
  'admissionVersion', 'catalogRevision', 'selectionReceiptDigest', 'instructionSetDigest',
  'totalBodyTokens', 'skills', 'admissionDigest',
]);
const ADMITTED_KEYS = new Set(['admittedVersion', 'header', 'body', 'snapshot']);
const SNAPSHOT_KEYS = new Set([
  'skillId', 'version', 'manifestDigest', 'bodyHash', 'bodyTokens', 'sourceHash', 'sourceRevision',
]);
const SOURCE_PROOF_KEYS = new Set([
  'proofVersion', 'admissionDigest', 'skillId', 'version', 'manifestDigest', 'bodyHash',
  'trustClass', 'profileId', 'profileAuthorizationDigest', 'profilePolicyRevision', 'profileRegistryRevision',
  'authorityRevision', 'evidenceDigest',
]);
const PROFILE_AUTHORIZATION_KEYS = new Set([
  'authorizationVersion', 'profileId', 'policyRevision', 'registryRevision', 'authorityRevision',
  'catalogRevision', 'selectionReceiptDigest', 'instructionSetDigest', 'selectedManifestDigests',
  'authorizationDigest',
]);
export const AGENT_SKILL_PROGRAM_LIMITS = Object.freeze({ bodyChars: 65_536, operations: 32, arguments: 16 });
const MAX_PROGRAM_BODY_CHARS = AGENT_SKILL_PROGRAM_LIMITS.bodyChars;
const MAX_PROGRAM_OPERATIONS = AGENT_SKILL_PROGRAM_LIMITS.operations;
const MAX_OPERATION_ARGUMENTS = AGENT_SKILL_PROGRAM_LIMITS.arguments;

function assertDenseArray(value: readonly unknown[], label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be dense`);
  }
}

function normalizeProgramArgument(value: unknown, label: string): AgentSkillProgramArgumentV1 {
  if (typeof value === 'string') return stableToken(value, label);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return safeInteger(value, label, -1_000_000, 1_000_000);
  throw new TypeError(`${label} must be an opaque token, safe integer, or boolean`);
}

function normalizeOperation(input: unknown, index: number): AgentSkillProgramOperationV1 {
  const label = `skillProgram.operations[${index}]`;
  assertPlainRecord(input, label);
  assertExactKeys(input, OPERATION_KEYS, OPERATION_KEYS, label);
  assertPlainRecord(input.args, `${label}.args`);
  const keys = Object.keys(input.args).sort(compareText);
  if (keys.length > MAX_OPERATION_ARGUMENTS) {
    throw new TypeError(`${label}.args must contain at most ${MAX_OPERATION_ARGUMENTS} fields`);
  }
  const args: Record<string, AgentSkillProgramArgumentV1> = {};
  for (const key of keys) {
    const normalizedKey = stableToken(key, `${label}.args key`);
    args[normalizedKey] = normalizeProgramArgument(input.args[key], `${label}.args.${normalizedKey}`);
  }
  return deepFreeze({
    primitiveId: stableToken(input.primitiveId, `${label}.primitiveId`),
    args,
  });
}

export function normalizeAgentSkillProgram(input: unknown): AgentSkillProgramV1 {
  assertPlainRecord(input, 'skillProgram');
  assertExactKeys(input, PROGRAM_KEYS, PROGRAM_KEYS, 'skillProgram');
  if (input.programVersion !== AGENT_SKILL_PROGRAM_VERSION) {
    throw new TypeError(`skillProgram.programVersion must be ${AGENT_SKILL_PROGRAM_VERSION}`);
  }
  if (!Array.isArray(input.operations)
    || input.operations.length < 1
    || input.operations.length > MAX_PROGRAM_OPERATIONS) {
    throw new TypeError(`skillProgram.operations must contain between 1 and ${MAX_PROGRAM_OPERATIONS} items`);
  }
  assertDenseArray(input.operations, 'skillProgram.operations');
  const operations = input.operations.map(normalizeOperation);
  const operationDigests = operations.map(digestCanonical);
  if (new Set(operationDigests).size !== operationDigests.length) {
    throw new TypeError('skillProgram.operations must not contain exact duplicates');
  }
  return deepFreeze({
    programVersion: AGENT_SKILL_PROGRAM_VERSION,
    kind: member(input.kind, AGENT_SKILL_KINDS, 'skillProgram.kind'),
    operations: Object.freeze(operations),
  });
}

/** Stable pre-compiler denial for existing free-form SKILL.md/Markdown bodies. */
export class LegacyAgentSkillBodyError extends Error {
  readonly code = 'legacy-uncompiled' as const;

  constructor() {
    super('legacy-uncompiled');
    this.name = 'LegacyAgentSkillBodyError';
  }
}

/** Parse exact canonical JSON. Whitespace, alternate key order and duplicate JSON keys all fail. */
export function parseAgentSkillProgramBody(body: unknown): AgentSkillProgramV1 {
  if (typeof body !== 'string' || body.length < 1 || body.length > MAX_PROGRAM_BODY_CHARS) {
    throw new TypeError('Skill program body must be a non-empty bounded string');
  }
  if (!body.startsWith('{')) throw new LegacyAgentSkillBodyError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new TypeError('Skill program body must be valid canonical JSON');
  }
  const program = normalizeAgentSkillProgram(parsed);
  if (body !== canonicalJson(program)) {
    throw new TypeError('Skill program body must equal its canonical JSON encoding');
  }
  return program;
}

function normalizeAdmittedSkill(input: unknown, index: number): AdmittedAgentSkillV1 {
  const label = `skillAdmission.skills[${index}]`;
  assertPlainRecord(input, label);
  assertExactKeys(input, ADMITTED_KEYS, ADMITTED_KEYS, label);
  if (input.admittedVersion !== ADMITTED_AGENT_SKILL_VERSION) {
    throw new TypeError(`${label}.admittedVersion must be ${ADMITTED_AGENT_SKILL_VERSION}`);
  }
  const header = normalizeAgentSkillHeader(input.header);
  if (typeof input.body !== 'string') throw new TypeError(`${label}.body must be a string`);
  const bodyHash = computeAgentSkillBodyHash(input.body);
  const bodyTokens = exactAgentSkillTokens(input.body);
  const manifest = header.manifest;
  if (bodyHash !== manifest.bodyHash) throw new TypeError(`${label}.bodyHash mismatch`);
  if (bodyTokens !== manifest.bodyTokens) throw new TypeError(`${label}.bodyTokens mismatch`);

  assertPlainRecord(input.snapshot, `${label}.snapshot`);
  assertExactKeys(input.snapshot, SNAPSHOT_KEYS, SNAPSHOT_KEYS, `${label}.snapshot`);
  const snapshot = deepFreeze({
    skillId: stableToken(input.snapshot.skillId, `${label}.snapshot.skillId`),
    version: versionToken(input.snapshot.version, `${label}.snapshot.version`),
    manifestDigest: sha256Digest(input.snapshot.manifestDigest, `${label}.snapshot.manifestDigest`),
    bodyHash: sha256Digest(input.snapshot.bodyHash, `${label}.snapshot.bodyHash`),
    bodyTokens: safeInteger(input.snapshot.bodyTokens, `${label}.snapshot.bodyTokens`, 1, 10_000_000),
    sourceHash: sha256Digest(input.snapshot.sourceHash, `${label}.snapshot.sourceHash`),
    sourceRevision: stableToken(input.snapshot.sourceRevision, `${label}.snapshot.sourceRevision`),
  });
  if (snapshot.skillId !== manifest.skillId
    || snapshot.version !== manifest.version
    || snapshot.manifestDigest !== header.manifestDigest
    || snapshot.bodyHash !== manifest.bodyHash
    || snapshot.bodyTokens !== manifest.bodyTokens
    || snapshot.sourceHash !== manifest.sourceHash
    || snapshot.sourceRevision !== manifest.sourceRevision) {
    throw new TypeError(`${label}.snapshot does not match its immutable header and body`);
  }
  return deepFreeze({
    admittedVersion: ADMITTED_AGENT_SKILL_VERSION,
    header,
    body: input.body,
    snapshot,
  });
}

function normalizeAdmission(input: unknown): AgentSkillAdmissionV1 {
  assertPlainRecord(input, 'skillAdmission');
  assertExactKeys(input, ADMISSION_KEYS, ADMISSION_KEYS, 'skillAdmission');
  if (input.admissionVersion !== AGENT_SKILL_ADMISSION_VERSION) {
    throw new TypeError(`skillAdmission.admissionVersion must be ${AGENT_SKILL_ADMISSION_VERSION}`);
  }
  if (!Array.isArray(input.skills) || input.skills.length < 1 || input.skills.length > 64) {
    throw new TypeError('skillAdmission.skills must be an array with between 1 and 64 items');
  }
  assertDenseArray(input.skills, 'skillAdmission.skills');
  const skills = Object.freeze(input.skills.map(normalizeAdmittedSkill));
  const identities = skills.map((skill) => `${skill.snapshot.skillId}\u0000${skill.snapshot.version}`);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError('skillAdmission.skills must not contain duplicate Skill versions');
  }
  const skillIds = skills.map((skill) => skill.snapshot.skillId);
  if (new Set(skillIds).size !== skillIds.length) {
    throw new TypeError('skillAdmission.skills must not contain multiple versions of one skillId');
  }
  const totalBodyTokens = safeInteger(
    input.totalBodyTokens,
    'skillAdmission.totalBodyTokens',
    0,
    10_000_000,
  );
  if (skills.reduce((sum, skill) => sum + skill.snapshot.bodyTokens, 0) !== totalBodyTokens) {
    throw new TypeError('skillAdmission.totalBodyTokens mismatch');
  }
  const instructionSetDigest = sha256Digest(
    input.instructionSetDigest,
    'skillAdmission.instructionSetDigest',
  );
  const expectedInstructionSetDigest = digestCanonical(skills.map((skill) => ({
    skillId: skill.header.manifest.skillId,
    version: skill.header.manifest.version,
    manifestDigest: skill.header.manifestDigest,
    bodyHash: skill.header.manifest.bodyHash,
    sourceHash: skill.header.manifest.sourceHash,
    sourceRevision: skill.header.manifest.sourceRevision,
  })));
  if (instructionSetDigest !== expectedInstructionSetDigest) {
    throw new TypeError('skillAdmission.instructionSetDigest mismatch');
  }
  const core = deepFreeze({
    admissionVersion: AGENT_SKILL_ADMISSION_VERSION,
    catalogRevision: stableToken(input.catalogRevision, 'skillAdmission.catalogRevision'),
    selectionReceiptDigest: sha256Digest(
      input.selectionReceiptDigest,
      'skillAdmission.selectionReceiptDigest',
    ),
    instructionSetDigest,
    totalBodyTokens,
    skills,
  });
  const admissionDigest = sha256Digest(input.admissionDigest, 'skillAdmission.admissionDigest');
  if (admissionDigest !== digestCanonical(core)) throw new TypeError('skillAdmission.admissionDigest mismatch');
  return deepFreeze({ ...core, admissionDigest });
}

function normalizeSourceProof(input: unknown, index: number): AgentSkillSourceProofV1 {
  const label = `sourceProofs[${index}]`;
  assertPlainRecord(input, label);
  assertExactKeys(input, SOURCE_PROOF_KEYS, SOURCE_PROOF_KEYS, label);
  if (input.proofVersion !== AGENT_SKILL_SOURCE_PROOF_VERSION) {
    throw new TypeError(`${label}.proofVersion must be ${AGENT_SKILL_SOURCE_PROOF_VERSION}`);
  }
  return deepFreeze({
    proofVersion: AGENT_SKILL_SOURCE_PROOF_VERSION,
    admissionDigest: sha256Digest(input.admissionDigest, `${label}.admissionDigest`),
    skillId: stableToken(input.skillId, `${label}.skillId`),
    version: versionToken(input.version, `${label}.version`),
    manifestDigest: sha256Digest(input.manifestDigest, `${label}.manifestDigest`),
    bodyHash: sha256Digest(input.bodyHash, `${label}.bodyHash`),
    trustClass: member(input.trustClass, AGENT_SKILL_TRUST_CLASSES, `${label}.trustClass`),
    profileId: stableToken(input.profileId, `${label}.profileId`),
    profileAuthorizationDigest: sha256Digest(
      input.profileAuthorizationDigest,
      `${label}.profileAuthorizationDigest`,
    ),
    profilePolicyRevision: sha256Digest(input.profilePolicyRevision, `${label}.profilePolicyRevision`),
    profileRegistryRevision: sha256Digest(input.profileRegistryRevision, `${label}.profileRegistryRevision`),
    authorityRevision: stableToken(input.authorityRevision, `${label}.authorityRevision`),
    evidenceDigest: sha256Digest(input.evidenceDigest, `${label}.evidenceDigest`),
  });
}

function normalizeProfileAuthorization(input: unknown): AgentSkillProfileAuthorizationV1 {
  assertPlainRecord(input, 'profileAuthorization');
  assertExactKeys(
    input,
    PROFILE_AUTHORIZATION_KEYS,
    PROFILE_AUTHORIZATION_KEYS,
    'profileAuthorization',
  );
  if (input.authorizationVersion !== SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION) {
    throw new TypeError(
      `profileAuthorization.authorizationVersion must be ${SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION}`,
    );
  }
  if (!Array.isArray(input.selectedManifestDigests)
    || input.selectedManifestDigests.length < 1
    || input.selectedManifestDigests.length > 64) {
    throw new TypeError('profileAuthorization.selectedManifestDigests must contain between 1 and 64 items');
  }
  assertDenseArray(input.selectedManifestDigests, 'profileAuthorization.selectedManifestDigests');
  const selectedManifestDigests = Object.freeze(input.selectedManifestDigests.map((digest, index) => (
    sha256Digest(digest, `profileAuthorization.selectedManifestDigests[${index}]`)
  )));
  if (new Set(selectedManifestDigests).size !== selectedManifestDigests.length) {
    throw new TypeError('profileAuthorization.selectedManifestDigests must not contain duplicates');
  }
  const serverCore = deepFreeze({
    authorizationVersion: SERVER_AGENT_SKILL_PROFILE_AUTHORIZATION_VERSION,
    profileId: stableToken(input.profileId, 'profileAuthorization.profileId'),
    policyRevision: sha256Digest(input.policyRevision, 'profileAuthorization.policyRevision'),
    catalogRevision: stableToken(input.catalogRevision, 'profileAuthorization.catalogRevision'),
    selectionReceiptDigest: sha256Digest(
      input.selectionReceiptDigest,
      'profileAuthorization.selectionReceiptDigest',
    ),
    instructionSetDigest: sha256Digest(
      input.instructionSetDigest,
      'profileAuthorization.instructionSetDigest',
    ),
    selectedManifestDigests,
  });
  const authorizationDigest = sha256Digest(
    input.authorizationDigest,
    'profileAuthorization.authorizationDigest',
  );
  if (authorizationDigest !== digestCanonical(serverCore)) {
    throw new TypeError('profileAuthorization.authorizationDigest mismatch');
  }
  return deepFreeze({
    ...serverCore,
    registryRevision: sha256Digest(input.registryRevision, 'profileAuthorization.registryRevision'),
    authorityRevision: stableToken(input.authorityRevision, 'profileAuthorization.authorityRevision'),
    authorizationDigest,
  });
}

function identityKey(skillId: string, version: string): string {
  return `${skillId}\u0000${version}`;
}

function expectedSourcePair(trustClass: AgentSkillTrustClass): readonly [AgentSkillOwner, AgentSkillSourceType] {
  if (trustClass === 'host-builtin') return ['host', 'builtin'];
  if (trustClass === 'reviewed-author') return ['author', 'filesystem'];
  if (trustClass === 'validated-candidate') return ['author', 'imported'];
  return ['learned', 'learned'];
}

function assertTrustMatrix(
  kind: AgentSkillKind,
  owner: AgentSkillOwner,
  sourceType: AgentSkillSourceType,
  proof: AgentSkillSourceProofV1,
): void {
  const [expectedOwner, expectedSource] = expectedSourcePair(proof.trustClass);
  if (owner !== expectedOwner || sourceType !== expectedSource) {
    throw new TypeError(`source proof does not match manifest source identity: ${proof.skillId}@${proof.version}`);
  }
  if ((kind === 'foundation' || kind === 'policy') && proof.trustClass !== 'host-builtin') {
    throw new TypeError(`${kind} Skills require host-builtin source authority`);
  }
}

/**
 * Atomically validate a complete admission for safe compilation. No raw body is returned, and no
 * caller may omit a source proof. Any invalid member rejects the entire set before rendering.
 */
export function prepareAgentSkillConsumptionSet(
  admissionInput: unknown,
  sourceProofInputs: unknown,
  profileAuthorizationInput: unknown,
): AgentSkillConsumptionSetV1 {
  const admission = normalizeAdmission(admissionInput);
  const profileAuthorization = normalizeProfileAuthorization(profileAuthorizationInput);
  if (profileAuthorization.catalogRevision !== admission.catalogRevision
    || profileAuthorization.selectionReceiptDigest !== admission.selectionReceiptDigest
    || profileAuthorization.instructionSetDigest !== admission.instructionSetDigest
    || profileAuthorization.selectedManifestDigests.length !== admission.skills.length
    || profileAuthorization.selectedManifestDigests.some((digest, index) => (
      digest !== admission.skills[index]?.header.manifestDigest
    ))) {
    throw new TypeError('profileAuthorization does not match the exact admitted instruction set');
  }
  if (!Array.isArray(sourceProofInputs) || sourceProofInputs.length !== admission.skills.length) {
    throw new TypeError('sourceProofs must contain exactly one proof for every admitted Skill');
  }
  assertDenseArray(sourceProofInputs, 'sourceProofs');
  const proofs = sourceProofInputs.map(normalizeSourceProof);
  const proofByIdentity = new Map<string, AgentSkillSourceProofV1>();
  for (const proof of proofs) {
    const key = identityKey(proof.skillId, proof.version);
    if (proofByIdentity.has(key)) throw new TypeError('sourceProofs must not contain duplicate Skill versions');
    proofByIdentity.set(key, proof);
  }
  const authorizationKeys = new Set(proofs.map((proof) => canonicalJson({
    profileId: proof.profileId,
    profileAuthorizationDigest: proof.profileAuthorizationDigest,
    profilePolicyRevision: proof.profilePolicyRevision,
    profileRegistryRevision: proof.profileRegistryRevision,
    authorityRevision: proof.authorityRevision,
  })));
  if (authorizationKeys.size > 1) {
    throw new TypeError('sourceProofs must bind one exact Profile authorization');
  }

  const programs = admission.skills.map((skill): ConsumableAgentSkillProgramV1 => {
    const manifest = skill.header.manifest;
    const proof = proofByIdentity.get(identityKey(manifest.skillId, manifest.version));
    if (!proof) throw new TypeError(`source proof missing: ${manifest.skillId}@${manifest.version}`);
    if (proof.admissionDigest !== admission.admissionDigest
      || proof.manifestDigest !== skill.header.manifestDigest
      || proof.bodyHash !== manifest.bodyHash) {
      throw new TypeError(`source proof identity mismatch: ${manifest.skillId}@${manifest.version}`);
    }
    if (proof.profileId !== profileAuthorization.profileId
      || proof.profileAuthorizationDigest !== profileAuthorization.authorizationDigest
      || proof.profilePolicyRevision !== profileAuthorization.policyRevision
      || proof.profileRegistryRevision !== profileAuthorization.registryRevision
      || proof.authorityRevision !== profileAuthorization.authorityRevision) {
      throw new TypeError(`source proof Profile authorization mismatch: ${manifest.skillId}@${manifest.version}`);
    }
    assertTrustMatrix(manifest.kind, manifest.owner, manifest.sourceType, proof);
    const program = parseAgentSkillProgramBody(skill.body);
    if (program.kind !== manifest.kind) {
      throw new TypeError(`Skill program kind mismatch: ${manifest.skillId}@${manifest.version}`);
    }
    return deepFreeze({
      skillId: manifest.skillId,
      version: manifest.version,
      manifestDigest: skill.header.manifestDigest,
      bodyHash: manifest.bodyHash,
      kind: manifest.kind,
      evaluatorId: manifest.evaluatorId,
      trustClass: proof.trustClass,
      sourceProofDigest: digestCanonical(proof),
      program,
      programDigest: digestCanonical(program),
    });
  });

  const sourceProofSetDigest = digestCanonical(programs.map((program) => ({
    skillId: program.skillId,
    version: program.version,
    sourceProofDigest: program.sourceProofDigest,
  })));
  const core = deepFreeze({
    consumptionVersion: AGENT_SKILL_CONSUMPTION_VERSION,
    catalogRevision: admission.catalogRevision,
    selectionReceiptDigest: admission.selectionReceiptDigest,
    instructionSetDigest: admission.instructionSetDigest,
    admissionDigest: admission.admissionDigest,
    profileId: profileAuthorization.profileId,
    profileAuthorizationDigest: profileAuthorization.authorizationDigest,
    profilePolicyRevision: profileAuthorization.policyRevision,
    profileRegistryRevision: profileAuthorization.registryRevision,
    authorityRevision: profileAuthorization.authorityRevision,
    sourceProofSetDigest,
    programs: Object.freeze(programs),
  });
  return deepFreeze({ ...core, consumptionDigest: digestCanonical(core) });
}
