import { createHash } from 'node:crypto';
import {
  ADMITTED_AGENT_SKILL_VERSION,
  AGENT_SKILL_ADMISSION_VERSION,
  AGENT_SKILL_TRUST_CLASSES,
  computeAgentSkillBodyHash,
  exactAgentSkillTokens,
  normalizeAgentSkillHeader,
  type AdmittedAgentSkillV1,
  type AgentSkillAdmissionV1,
  type AgentSkillHeaderV1,
  type AgentSkillOwner,
  type AgentSkillSourceType,
  type AgentSkillTrustClass,
} from '@jiuguan/skill-hub';

export const SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION =
  'server-agent-skill-source-authority-snapshot-v1' as const;

export interface ServerAgentSkillSourceAuthorityEntryV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bodyHash: string;
  readonly sourceHash: string;
  readonly sourceRevision: string;
  readonly trustClass: AgentSkillTrustClass;
  readonly evidenceDigest: string;
}

export interface ServerAgentSkillSourceAuthoritySnapshotSeedV1 {
  readonly snapshotVersion: typeof SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION;
  readonly entries: readonly ServerAgentSkillSourceAuthorityEntryV1[];
}

export interface ServerAgentSkillSourceAuthoritySnapshotV1
  extends ServerAgentSkillSourceAuthoritySnapshotSeedV1 {
  readonly authorityRevision: string;
}

export interface AgentSkillSourceAuthorityIdentityV1 {
  readonly skillId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly bodyHash: string;
  readonly sourceHash: string;
  readonly sourceRevision: string;
}

export const AGENT_SKILL_SOURCE_AUTHORITY_DENIAL_REASONS = Object.freeze([
  'unregistered-identity',
  'trust-matrix-mismatch',
] as const);

export type AgentSkillSourceAuthorityDenialReason =
  typeof AGENT_SKILL_SOURCE_AUTHORITY_DENIAL_REASONS[number];

export class AgentSkillSourceAuthorityDeniedError extends Error {
  readonly code = 'agent-skill-source-authority-denied' as const;

  constructor(readonly reason: AgentSkillSourceAuthorityDenialReason) {
    super(`agent-skill-source-authority-denied:${reason}`);
    this.name = 'AgentSkillSourceAuthorityDeniedError';
  }
}

const SNAPSHOT_SEED_KEYS = new Set(['snapshotVersion', 'entries']);
const SNAPSHOT_KEYS = new Set(['snapshotVersion', 'entries', 'authorityRevision']);
const ENTRY_KEYS = new Set([
  'skillId', 'version', 'manifestDigest', 'bodyHash', 'sourceHash', 'sourceRevision',
  'trustClass', 'evidenceDigest',
]);
const IDENTITY_KEYS = new Set([
  'skillId', 'version', 'manifestDigest', 'bodyHash', 'sourceHash', 'sourceRevision',
]);
const ADMISSION_KEYS = new Set([
  'admissionVersion', 'catalogRevision', 'selectionReceiptDigest', 'instructionSetDigest',
  'totalBodyTokens', 'skills', 'admissionDigest',
]);
const ADMITTED_KEYS = new Set(['admittedVersion', 'header', 'body', 'snapshot']);
const ADMITTED_SNAPSHOT_KEYS = new Set([
  'skillId', 'version', 'manifestDigest', 'bodyHash', 'bodyTokens', 'sourceHash', 'sourceRevision',
]);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

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
  const unsupported = Object.keys(value).find((key) => !keys.has(key));
  if (unsupported !== undefined) throw new TypeError(`${label} contains unsupported field: ${unsupported}`);
  const missing = [...keys].find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${label}.${missing} is required`);
}

function denseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be an array with at most ${maximum} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be a dense array`);
  }
  return value;
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

function safeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${label} must be a safe integer between 0 and ${maximum}`);
  }
  return value as number;
}

function trustClass(value: unknown, label: string): AgentSkillTrustClass {
  if (typeof value !== 'string'
    || !AGENT_SKILL_TRUST_CLASSES.includes(value as AgentSkillTrustClass)) {
    throw new TypeError(`${label} contains an unsupported value`);
  }
  return value as AgentSkillTrustClass;
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

function identityKey(identity: AgentSkillSourceAuthorityIdentityV1): string {
  return [
    identity.skillId,
    identity.version,
    identity.manifestDigest,
    identity.bodyHash,
    identity.sourceHash,
    identity.sourceRevision,
  ].join('\u0000');
}

function skillVersionKey(identity: Readonly<{ skillId: string; version: string }>): string {
  return `${identity.skillId}\u0000${identity.version}`;
}

function entryOrder(
  left: ServerAgentSkillSourceAuthorityEntryV1,
  right: ServerAgentSkillSourceAuthorityEntryV1,
): number {
  return compareText(left.skillId, right.skillId)
    || compareText(left.version, right.version)
    || compareText(left.manifestDigest, right.manifestDigest)
    || compareText(left.bodyHash, right.bodyHash)
    || compareText(left.sourceHash, right.sourceHash)
    || compareText(left.sourceRevision, right.sourceRevision)
    || compareText(left.trustClass, right.trustClass)
    || compareText(left.evidenceDigest, right.evidenceDigest);
}

function normalizeIdentity(input: unknown, label: string): AgentSkillSourceAuthorityIdentityV1 {
  plainRecord(input, label);
  exactKeys(input, IDENTITY_KEYS, label);
  return Object.freeze({
    skillId: token(input.skillId, `${label}.skillId`),
    version: version(input.version, `${label}.version`),
    manifestDigest: digest(input.manifestDigest, `${label}.manifestDigest`),
    bodyHash: digest(input.bodyHash, `${label}.bodyHash`),
    sourceHash: digest(input.sourceHash, `${label}.sourceHash`),
    sourceRevision: token(input.sourceRevision, `${label}.sourceRevision`),
  });
}

function normalizeEntry(input: unknown, index: number): ServerAgentSkillSourceAuthorityEntryV1 {
  const label = `sourceAuthority.entries[${index}]`;
  plainRecord(input, label);
  exactKeys(input, ENTRY_KEYS, label);
  return Object.freeze({
    ...normalizeIdentity({
      skillId: input.skillId,
      version: input.version,
      manifestDigest: input.manifestDigest,
      bodyHash: input.bodyHash,
      sourceHash: input.sourceHash,
      sourceRevision: input.sourceRevision,
    }, `${label}.identity`),
    trustClass: trustClass(input.trustClass, `${label}.trustClass`),
    evidenceDigest: digest(input.evidenceDigest, `${label}.evidenceDigest`),
  });
}

function normalizeEntries(input: unknown): readonly ServerAgentSkillSourceAuthorityEntryV1[] {
  const entries = denseArray(input, 'sourceAuthority.entries', 10_000)
    .map(normalizeEntry)
    .sort(entryOrder);
  const versionKeys = entries.map(skillVersionKey);
  if (new Set(versionKeys).size !== versionKeys.length) {
    throw new TypeError('sourceAuthority.entries must bind each immutable Skill version exactly once');
  }
  return Object.freeze(entries);
}

function snapshotCore(entries: readonly ServerAgentSkillSourceAuthorityEntryV1[]):
Readonly<ServerAgentSkillSourceAuthoritySnapshotSeedV1> {
  return Object.freeze({
    snapshotVersion: SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION,
    entries,
  });
}

/**
 * Construct the server-owned source review snapshot. Trust is asserted only by entries installed
 * here; no Manifest field can create or upgrade an entry.
 */
export function createServerAgentSkillSourceAuthoritySnapshot(
  input: unknown,
): ServerAgentSkillSourceAuthoritySnapshotV1 {
  plainRecord(input, 'sourceAuthority');
  exactKeys(input, SNAPSHOT_SEED_KEYS, 'sourceAuthority');
  if (input.snapshotVersion !== SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION) {
    throw new TypeError(
      `sourceAuthority.snapshotVersion must be ${SERVER_AGENT_SKILL_SOURCE_AUTHORITY_SNAPSHOT_VERSION}`,
    );
  }
  const core = snapshotCore(normalizeEntries(input.entries));
  return Object.freeze({ ...core, authorityRevision: canonicalDigest(core) });
}

/** Validate a persisted snapshot and its canonical revision before installing it as authority. */
export function normalizeServerAgentSkillSourceAuthoritySnapshot(
  input: unknown,
): ServerAgentSkillSourceAuthoritySnapshotV1 {
  plainRecord(input, 'sourceAuthoritySnapshot');
  exactKeys(input, SNAPSHOT_KEYS, 'sourceAuthoritySnapshot');
  const core = createServerAgentSkillSourceAuthoritySnapshot({
    snapshotVersion: input.snapshotVersion,
    entries: input.entries,
  });
  const authorityRevision = digest(
    input.authorityRevision,
    'sourceAuthoritySnapshot.authorityRevision',
  );
  if (authorityRevision !== core.authorityRevision) {
    throw new TypeError('sourceAuthoritySnapshot.authorityRevision mismatch');
  }
  return core;
}

function expectedSourcePair(
  value: AgentSkillTrustClass,
): readonly [AgentSkillOwner, AgentSkillSourceType] {
  if (value === 'host-builtin') return ['host', 'builtin'];
  if (value === 'reviewed-author') return ['author', 'filesystem'];
  if (value === 'validated-candidate') return ['author', 'imported'];
  return ['learned', 'learned'];
}

function normalizeAdmittedSkill(input: unknown, index: number): AdmittedAgentSkillV1 {
  const label = `skillAdmission.skills[${index}]`;
  plainRecord(input, label);
  exactKeys(input, ADMITTED_KEYS, label);
  if (input.admittedVersion !== ADMITTED_AGENT_SKILL_VERSION) {
    throw new TypeError(`${label}.admittedVersion must be ${ADMITTED_AGENT_SKILL_VERSION}`);
  }
  const header = normalizeAgentSkillHeader(input.header);
  if (typeof input.body !== 'string') throw new TypeError(`${label}.body must be a string`);
  const bodyHash = computeAgentSkillBodyHash(input.body);
  const bodyTokens = exactAgentSkillTokens(input.body);
  plainRecord(input.snapshot, `${label}.snapshot`);
  exactKeys(input.snapshot, ADMITTED_SNAPSHOT_KEYS, `${label}.snapshot`);
  const snapshot = Object.freeze({
    skillId: token(input.snapshot.skillId, `${label}.snapshot.skillId`),
    version: version(input.snapshot.version, `${label}.snapshot.version`),
    manifestDigest: digest(input.snapshot.manifestDigest, `${label}.snapshot.manifestDigest`),
    bodyHash: digest(input.snapshot.bodyHash, `${label}.snapshot.bodyHash`),
    bodyTokens: safeInteger(input.snapshot.bodyTokens, `${label}.snapshot.bodyTokens`, 10_000_000),
    sourceHash: digest(input.snapshot.sourceHash, `${label}.snapshot.sourceHash`),
    sourceRevision: token(input.snapshot.sourceRevision, `${label}.snapshot.sourceRevision`),
  });
  const manifest = header.manifest;
  if (snapshot.skillId !== manifest.skillId
    || snapshot.version !== manifest.version
    || snapshot.manifestDigest !== header.manifestDigest
    || snapshot.bodyHash !== manifest.bodyHash
    || snapshot.bodyTokens !== manifest.bodyTokens
    || snapshot.sourceHash !== manifest.sourceHash
    || snapshot.sourceRevision !== manifest.sourceRevision
    || bodyHash !== manifest.bodyHash
    || bodyTokens !== manifest.bodyTokens) {
    throw new TypeError(`${label} does not match its exact materialized identity`);
  }
  return Object.freeze({
    admittedVersion: ADMITTED_AGENT_SKILL_VERSION,
    header,
    body: input.body,
    snapshot,
  });
}

function normalizeAdmission(input: unknown): AgentSkillAdmissionV1 {
  plainRecord(input, 'skillAdmission');
  exactKeys(input, ADMISSION_KEYS, 'skillAdmission');
  if (input.admissionVersion !== AGENT_SKILL_ADMISSION_VERSION) {
    throw new TypeError(`skillAdmission.admissionVersion must be ${AGENT_SKILL_ADMISSION_VERSION}`);
  }
  const skills = denseArray(input.skills, 'skillAdmission.skills', 64).map(normalizeAdmittedSkill);
  const refs = skills.map(({ snapshot }) => skillVersionKey(snapshot));
  if (new Set(refs).size !== refs.length) {
    throw new TypeError('skillAdmission.skills must not contain duplicate Skill versions');
  }
  const totalBodyTokens = safeInteger(
    input.totalBodyTokens,
    'skillAdmission.totalBodyTokens',
    10_000_000,
  );
  if (skills.reduce((sum, item) => sum + item.snapshot.bodyTokens, 0) !== totalBodyTokens) {
    throw new TypeError('skillAdmission.totalBodyTokens mismatch');
  }
  const core = Object.freeze({
    admissionVersion: AGENT_SKILL_ADMISSION_VERSION,
    catalogRevision: token(input.catalogRevision, 'skillAdmission.catalogRevision'),
    selectionReceiptDigest: digest(
      input.selectionReceiptDigest,
      'skillAdmission.selectionReceiptDigest',
    ),
    instructionSetDigest: digest(input.instructionSetDigest, 'skillAdmission.instructionSetDigest'),
    totalBodyTokens,
    skills: Object.freeze(skills),
  });
  const admissionDigest = digest(input.admissionDigest, 'skillAdmission.admissionDigest');
  if (admissionDigest !== canonicalDigest(core)) {
    throw new TypeError('skillAdmission.admissionDigest mismatch');
  }
  return Object.freeze({ ...core, admissionDigest });
}

function deny(reason: AgentSkillSourceAuthorityDenialReason): never {
  throw new AgentSkillSourceAuthorityDeniedError(reason);
}

/**
 * Read-only exact source authority. `promoted-learned` is represented for future promotion
 * evidence, but Profile Policy V1 intentionally still rejects learned/learned contracts.
 */
export class ServerAgentSkillSourceAuthorityRegistry {
  readonly snapshot: ServerAgentSkillSourceAuthoritySnapshotV1;
  readonly authorityRevision: string;
  readonly #byExactIdentity: ReadonlyMap<string, ServerAgentSkillSourceAuthorityEntryV1>;

  constructor(snapshotInput: unknown) {
    const snapshot = normalizeServerAgentSkillSourceAuthoritySnapshot(snapshotInput);
    this.snapshot = snapshot;
    this.authorityRevision = snapshot.authorityRevision;
    this.#byExactIdentity = new Map(snapshot.entries.map((entry) => [identityKey(entry), entry]));
    Object.freeze(this);
  }

  lookupExact(identityInput: unknown): ServerAgentSkillSourceAuthorityEntryV1 | undefined {
    return this.#byExactIdentity.get(identityKey(normalizeIdentity(identityInput, 'sourceIdentity')));
  }

  /**
   * Body-free preflight for the selection Receipt path. A service must call this for every
   * selected header before any body loader is invoked, then call `authorizeAdmission` again after
   * materialization to close the header/body TOCTOU window.
   */
  authorizeHeader(headerInput: unknown): ServerAgentSkillSourceAuthorityEntryV1 {
    const header: AgentSkillHeaderV1 = normalizeAgentSkillHeader(headerInput);
    const manifest = header.manifest;
    const entry = this.lookupExact({
      skillId: manifest.skillId,
      version: manifest.version,
      manifestDigest: header.manifestDigest,
      bodyHash: manifest.bodyHash,
      sourceHash: manifest.sourceHash,
      sourceRevision: manifest.sourceRevision,
    });
    if (!entry) return deny('unregistered-identity');
    const [owner, sourceType] = expectedSourcePair(entry.trustClass);
    if (manifest.owner !== owner || manifest.sourceType !== sourceType) {
      return deny('trust-matrix-mismatch');
    }
    return entry;
  }

  authorizeAdmittedSkill(skillInput: unknown): ServerAgentSkillSourceAuthorityEntryV1 {
    const skill = normalizeAdmittedSkill(skillInput, 0);
    return this.authorizeHeader(skill.header);
  }

  authorizeAdmission(admissionInput: unknown): readonly ServerAgentSkillSourceAuthorityEntryV1[] {
    const admission = normalizeAdmission(admissionInput);
    return Object.freeze(admission.skills.map((skill) => this.authorizeAdmittedSkill(skill)));
  }
}

export function createServerAgentSkillSourceAuthorityRegistry(
  input: unknown,
): ServerAgentSkillSourceAuthorityRegistry {
  return new ServerAgentSkillSourceAuthorityRegistry(
    createServerAgentSkillSourceAuthoritySnapshot(input),
  );
}
