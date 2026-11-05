import { createHash } from 'node:crypto';

export const NPC_MAINTENANCE_PROPOSAL_VERSION = 'npc-maintenance-proposal-v1' as const;
export type NpcMaintenanceFactKind =
  | 'profile'
  | 'objective_fact'
  | 'belief'
  | 'knowledge'
  | 'secret'
  | 'goal'
  | 'history_only';
export type NpcMaintenanceConfidence = 'high' | 'medium' | 'low';
export type NpcMaintenanceStatus = 'confirmed' | 'pending' | 'unresolved' | 'last-known' | 'unknown';

export interface NpcMaintenanceFactEntry {
  readonly kind: NpcMaintenanceFactKind;
  readonly characterId: string;
  readonly field: string;
  readonly value: unknown;
  readonly status: NpcMaintenanceStatus;
  readonly confidence: NpcMaintenanceConfidence;
  readonly effectiveRound: number;
  readonly expectedEntityVersion: number;
  readonly sourceRefs: readonly string[];
}

export interface NpcMaintenanceRelationshipEntry {
  readonly kind: 'relationship';
  readonly characterId: string;
  readonly toCharacterId: string;
  readonly relationType: string;
  readonly perspective: 'objective' | 'subjective';
  readonly status: NpcMaintenanceStatus;
  readonly confidence: NpcMaintenanceConfidence;
  readonly effectiveRound: number;
  readonly expectedEntityVersion: number;
  readonly sourceRefs: readonly string[];
}

/**
 * Identity resolution proposed by Maintenance.
 *
 * It binds evidence to an already-allowed stable character/version. The entry is always
 * review-only at the automatic policy boundary; only a separately approved alias flow
 * may consume it, so the model cannot create or retarget identities directly.
 */
export interface NpcMaintenanceIdentityResolutionEntry {
  readonly kind: 'identity_resolution';
  readonly mentionKey: string;
  readonly alias: string;
  readonly characterId: string;
  readonly confidence: 'high' | 'medium';
  readonly expectedEntityVersion: number;
  readonly sourceRefs: readonly string[];
}

export interface NpcMaintenanceUnresolvedEntry {
  readonly kind: 'unresolved';
  readonly mentionDigest: string;
  readonly reasonCode: 'ambiguous-mention' | 'unknown-character' | 'conflicting-identity';
  readonly confidence: 'low';
  readonly sourceRefs: readonly string[];
}

export type NpcMaintenanceEntry =
  | NpcMaintenanceFactEntry
  | NpcMaintenanceRelationshipEntry
  | NpcMaintenanceIdentityResolutionEntry
  | NpcMaintenanceUnresolvedEntry;

export interface NpcMaintenanceProposal {
  readonly version: typeof NPC_MAINTENANCE_PROPOSAL_VERSION;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly entries: readonly NpcMaintenanceEntry[];
  readonly proposalDigest: string;
}

export interface NpcMaintenanceProposalContext {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly allowedCharacterIds: readonly string[];
  readonly allowedSourceRefs: readonly string[];
  /** Per-character subset of allowedSourceRefs derived from exact stable-id/name/alias hits. */
  readonly allowedSourceRefsByCharacter?: Readonly<Record<string, readonly string[]>>;
  /** Exact digest bindings for the complete message rows visible to Provider. */
  readonly sourceEvidence?: readonly Readonly<{
    readonly ref: string;
    readonly messageId: number;
    readonly round: number;
    readonly role: 'user' | 'assistant';
    readonly contentDigest: string;
  }>[];
  /** Digest of the current Provider-visible evidence set (never message content). */
  readonly evidenceSetDigest?: string;
  /** Incomplete registered NPCs the Provider is expected to examine. */
  readonly completionTargetIds?: readonly string[];
  readonly expectedEntityVersions: Readonly<Record<string, number>>;
  readonly maxRound: number;
}

export interface NpcMaintenanceNoopTerminal {
  readonly reasonCode: 'no-applicable-evidence';
  readonly examinedCharacterIds: readonly string[];
  readonly evidenceSetDigest: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const FIELD = /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_.:\-\u4e00-\u9fff]{0,63}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONFIDENCE = new Set<NpcMaintenanceConfidence>(['high', 'medium', 'low']);
const STATUS = new Set<NpcMaintenanceStatus>(['confirmed', 'pending', 'unresolved', 'last-known', 'unknown']);
const FACT_KINDS = new Set<NpcMaintenanceFactKind>([
  'profile', 'objective_fact', 'belief', 'knowledge', 'secret', 'goal', 'history_only',
]);
const UNRESOLVED_REASONS = new Set(['ambiguous-mention', 'unknown-character', 'conflicting-identity']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const AMBIGUOUS_IDENTITY_TERMS = new Set([
  '主角', '玩家', '用户', '旁白', '叙述者', '观众', '众人', '大家', '人群', '群众', '路人', '陌生人', '神秘人',
  '守卫', '士兵', '村民', '学生', '店员', '服务员', '护士', '工作人员',
  '他', '她', '它', '祂', '他们', '她们', '它们', '你', '您', '我', '俺', '咱', '我们',
  '老师', '先生', '小姐', '大人', '阁下', '哥哥', '姐姐', '妹妹', '弟弟', '老大', '老板',
  '医生', '教授', '会长', '学生会长', '社长', '同学', '前辈', '后辈', '对方', '某人',
  '那个人', '这个人', '未知人物', '不明人物',
  'he', 'him', 'she', 'her', 'it', 'they', 'them', 'you', 'i', 'we', 'someone', 'somebody',
  'player', 'user', 'narrator', 'npc', 'crowd', 'teacher', 'doctor', 'professor', 'president',
  'chair', 'boss', 'master', 'senior', 'junior',
]);
const IDENTITY_CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const MAX_ENTRIES = 64;

/**
 * Stable, value-free reasons that may be returned to a model after a rejected NPC
 * proposal. Keep these codes about the field/contract class only: proposal values,
 * character ids and source references must never be copied into the error channel.
 */
export type NpcMaintenanceProposalRejectionCode =
  | 'proposal-shape-invalid'
  | 'proposal-value-invalid'
  | 'proposal-context-invalid'
  | 'proposal-binding-mismatch'
  | 'proposal-field-invalid'
  | 'proposal-duplicate-target'
  | 'source-ref-not-allowed'
  | 'source-ref-duplicate'
  | 'character-id-not-allowed'
  | 'character-version-stale'
  | 'effective-round-out-of-range'
  | 'identity-text-invalid'
  | 'relationship-target-not-allowed'
  | 'evidence-classification-invalid';

export class NpcMaintenanceProposalRejectedError extends TypeError {
  readonly name = 'NpcMaintenanceProposalRejectedError';

  constructor(
    readonly rejectionCode: NpcMaintenanceProposalRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

export function npcMaintenanceProposalRejectionCode(
  error: unknown,
): NpcMaintenanceProposalRejectionCode | undefined {
  return error instanceof NpcMaintenanceProposalRejectedError
    ? error.rejectionCode
    : undefined;
}

function reject(
  rejectionCode: NpcMaintenanceProposalRejectionCode,
  message: string,
): never {
  throw new NpcMaintenanceProposalRejectedError(rejectionCode, message);
}

function plain(
  value: unknown,
  label: string,
  rejectionCode: NpcMaintenanceProposalRejectionCode = 'proposal-shape-invalid',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(rejectionCode, label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject(rejectionCode, label + ' must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject('proposal-shape-invalid', label + ' has unsupported or missing fields');
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).sort().map((key) => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
}

function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) reject('proposal-value-invalid', 'npc value nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 2_000) {
      reject('proposal-value-invalid', 'npc string value is too long');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('proposal-value-invalid', 'npc numeric value must be finite');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) reject('proposal-value-invalid', 'npc array value is too large');
    return Object.freeze(value.map((item) => safeValue(item, depth + 1)));
  }
  const row = plain(value, 'npc value', 'proposal-value-invalid');
  if (Object.keys(row).length > 32 || Object.keys(row).some((key) => FORBIDDEN_KEYS.has(key) || key.length > 64)) {
    reject('proposal-value-invalid', 'npc object value contains unsafe fields');
  }
  return Object.freeze(Object.fromEntries(
    Object.keys(row).sort().map((key) => [key, safeValue(row[key], depth + 1)]),
  ));
}

function sourceRefs(value: unknown, allowed: ReadonlySet<string>, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || value.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    reject('source-ref-not-allowed', label + ' contains an unknown or invalid source');
  }
  const normalized = [...new Set(value as string[])].sort();
  if (normalized.length !== value.length) {
    reject('source-ref-duplicate', label + ' contains duplicate sources');
  }
  return Object.freeze(normalized);
}

function confidence(value: unknown): NpcMaintenanceConfidence {
  if (typeof value !== 'string' || !CONFIDENCE.has(value as NpcMaintenanceConfidence)) {
    reject('evidence-classification-invalid', 'npc confidence is invalid');
  }
  return value as NpcMaintenanceConfidence;
}

function status(value: unknown): NpcMaintenanceStatus {
  if (typeof value !== 'string' || !STATUS.has(value as NpcMaintenanceStatus)) {
    reject('evidence-classification-invalid', 'npc status is invalid');
  }
  return value as NpcMaintenanceStatus;
}

function identityText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || IDENTITY_CONTROL.test(value)) {
    reject('identity-text-invalid', label + ' is invalid');
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const length = [...normalized].length;
  if (length < 2 || length > maxLength) reject('identity-text-invalid', label + ' is invalid');
  const probes = new Set([
    normalized,
    ...normalized.split(/[|:：]/u),
  ].map((item) => item.trim().toLocaleLowerCase('en-US')).filter(Boolean));
  const prefixed = /^(?:npc|char)[_\-](.+)$/iu.exec(normalized);
  if (prefixed?.[1]) probes.add(prefixed[1].trim().toLocaleLowerCase('en-US'));
  if ([...probes].some((item) => AMBIGUOUS_IDENTITY_TERMS.has(item))) {
    reject('identity-text-invalid', label + ' cannot be a pronoun or ambiguous title');
  }
  return normalized;
}

function boundIdentityCharacter(
  row: Record<string, unknown>,
  context: {
    characterIds: ReadonlySet<string>;
    expectedVersions: Readonly<Record<string, number>>;
  },
): { characterId: string; expectedEntityVersion: number } {
  if (typeof row.characterId !== 'string' || !context.characterIds.has(row.characterId)) {
    reject('character-id-not-allowed', 'npc identity characterId is not an allowed resolved character');
  }
  const expected = context.expectedVersions[row.characterId];
  if (!Number.isSafeInteger(row.expectedEntityVersion) || row.expectedEntityVersion !== expected) {
    reject('character-version-stale', 'npc identity expectedEntityVersion is stale or invalid');
  }
  return {
    characterId: row.characterId,
    expectedEntityVersion: row.expectedEntityVersion as number,
  };
}

function boundCharacter(
  row: Record<string, unknown>,
  context: {
    characterIds: ReadonlySet<string>;
    expectedVersions: Readonly<Record<string, number>>;
    maxRound: number;
  },
): { characterId: string; expectedEntityVersion: number; effectiveRound: number } {
  if (typeof row.characterId !== 'string' || !context.characterIds.has(row.characterId)) {
    reject('character-id-not-allowed', 'npc characterId is not an allowed resolved character');
  }
  const expected = context.expectedVersions[row.characterId];
  if (!Number.isSafeInteger(row.expectedEntityVersion) || row.expectedEntityVersion !== expected) {
    reject('character-version-stale', 'npc expectedEntityVersion is stale or invalid');
  }
  if (!Number.isSafeInteger(row.effectiveRound) || (row.effectiveRound as number) < 1
    || (row.effectiveRound as number) > context.maxRound) {
    reject('effective-round-out-of-range', 'npc effectiveRound is invalid');
  }
  return {
    characterId: row.characterId,
    expectedEntityVersion: row.expectedEntityVersion as number,
    effectiveRound: row.effectiveRound as number,
  };
}

/**
 * A typed successful terminal for an evidence-bearing snapshot that contains no
 * applicable NPC fact. It is bound to the same target set and evidence digest as
 * the Provider request, so an empty result is auditable without becoming a
 * protocol failure or a business write.
 */
export function normalizeNpcMaintenanceNoopTerminal(
  value: unknown,
  context: NpcMaintenanceProposalContext,
): NpcMaintenanceNoopTerminal {
  if (!DIGEST.test(context.evidenceSetDigest ?? '')
    || !Array.isArray(context.completionTargetIds)
    || context.completionTargetIds.length > 64
    || new Set(context.completionTargetIds).size !== context.completionTargetIds.length
    || context.completionTargetIds.some((characterId) => (
      typeof characterId !== 'string' || !context.allowedCharacterIds.includes(characterId)
    ))) {
    reject('proposal-context-invalid', 'npc no-op context is invalid');
  }
  const row = plain(value, 'npc no-op terminal');
  exact(row, ['reasonCode', 'examinedCharacterIds', 'evidenceSetDigest'], 'npc no-op terminal');
  if (row.reasonCode !== 'no-applicable-evidence'
    || row.evidenceSetDigest !== context.evidenceSetDigest
    || !Array.isArray(row.examinedCharacterIds)
    || row.examinedCharacterIds.length !== context.completionTargetIds.length
    || row.examinedCharacterIds.some((characterId) => typeof characterId !== 'string')) {
    reject('proposal-binding-mismatch', 'npc no-op terminal binding is invalid');
  }
  const expected = [...context.completionTargetIds].sort();
  const examined = [...row.examinedCharacterIds as string[]].sort();
  if (new Set(examined).size !== examined.length
    || JSON.stringify(examined) !== JSON.stringify(expected)) {
    reject('character-id-not-allowed', 'npc no-op examined characters do not match completion targets');
  }
  return Object.freeze({
    reasonCode: 'no-applicable-evidence',
    examinedCharacterIds: Object.freeze(examined),
    evidenceSetDigest: context.evidenceSetDigest!,
  });
}

export function normalizeNpcMaintenanceProposal(
  value: unknown,
  inputContext: NpcMaintenanceProposalContext,
): NpcMaintenanceProposal {
  if (!TOKEN.test(inputContext.sessionId) || !DIGEST.test(inputContext.sourceRevision)
    || !Number.isSafeInteger(inputContext.maxRound) || inputContext.maxRound < 1
    || !Array.isArray(inputContext.allowedCharacterIds) || inputContext.allowedCharacterIds.length < 1
    || inputContext.allowedCharacterIds.length > 64
    || new Set(inputContext.allowedCharacterIds).size !== inputContext.allowedCharacterIds.length
    || inputContext.allowedCharacterIds.some((item) => !TOKEN.test(item))
    || !Array.isArray(inputContext.allowedSourceRefs) || inputContext.allowedSourceRefs.length < 1
    || inputContext.allowedSourceRefs.length > 128
    || new Set(inputContext.allowedSourceRefs).size !== inputContext.allowedSourceRefs.length
    || inputContext.allowedSourceRefs.some((item) => !TOKEN.test(item))) {
    reject('proposal-context-invalid', 'npc maintenance context is invalid');
  }
  const expectedKeys = Object.keys(inputContext.expectedEntityVersions).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify([...inputContext.allowedCharacterIds].sort())
    || expectedKeys.some((key) => !Number.isSafeInteger(inputContext.expectedEntityVersions[key])
      || inputContext.expectedEntityVersions[key]! < 0)) {
    reject('proposal-context-invalid', 'npc expectedEntityVersions must exactly cover allowed characters');
  }
  const globalSourceRefs = new Set(inputContext.allowedSourceRefs);
  let sourceRefsByCharacter: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  if (inputContext.allowedSourceRefsByCharacter !== undefined) {
    const mapping = plain(inputContext.allowedSourceRefsByCharacter, 'npc source-ref mapping', 'proposal-context-invalid');
    if (JSON.stringify(Object.keys(mapping).sort()) !== JSON.stringify([...inputContext.allowedCharacterIds].sort())) {
      reject('proposal-context-invalid', 'npc source-ref mapping must exactly cover allowed characters');
    }
    const rows = new Map<string, ReadonlySet<string>>();
    for (const characterId of inputContext.allowedCharacterIds) {
      const refs = mapping[characterId];
      if (!Array.isArray(refs) || refs.length > 128
        || refs.some((ref) => typeof ref !== 'string' || !globalSourceRefs.has(ref))
        || new Set(refs).size !== refs.length) {
        reject('proposal-context-invalid', 'npc source-ref mapping contains invalid character evidence');
      }
      rows.set(characterId, new Set(refs as string[]));
    }
    sourceRefsByCharacter = rows;
  }
  const context = {
    characterIds: new Set(inputContext.allowedCharacterIds),
    sourceRefs: globalSourceRefs,
    sourceRefsByCharacter,
    expectedVersions: inputContext.expectedEntityVersions,
    maxRound: inputContext.maxRound,
  };
  const characterSourceRefs = (characterId: string): ReadonlySet<string> => (
    context.sourceRefsByCharacter?.get(characterId) ?? context.sourceRefs
  );

  const proposal = plain(value, 'npc maintenance proposal');
  exact(proposal, ['version', 'sessionId', 'sourceRevision', 'entries'], 'npc maintenance proposal');
  if (proposal.version !== NPC_MAINTENANCE_PROPOSAL_VERSION
    || proposal.sessionId !== inputContext.sessionId
    || proposal.sourceRevision !== inputContext.sourceRevision
    || !Array.isArray(proposal.entries)
    || proposal.entries.length < 1
    || proposal.entries.length > MAX_ENTRIES) {
    reject('proposal-binding-mismatch', 'npc maintenance proposal binding is invalid');
  }

  const entries = proposal.entries.map((raw, index): NpcMaintenanceEntry => {
    const row = plain(raw, 'npc entry ' + index);
    if (row.kind === 'unresolved') {
      exact(row, ['kind', 'mentionDigest', 'reasonCode', 'confidence', 'sourceRefs'], 'npc unresolved');
      if (typeof row.mentionDigest !== 'string' || !DIGEST.test(row.mentionDigest)
        || typeof row.reasonCode !== 'string' || !UNRESOLVED_REASONS.has(row.reasonCode)
        || row.confidence !== 'low') {
        reject('proposal-field-invalid', 'npc unresolved entry is invalid');
      }
      return Object.freeze({
        kind: 'unresolved',
        mentionDigest: row.mentionDigest,
        reasonCode: row.reasonCode as NpcMaintenanceUnresolvedEntry['reasonCode'],
        confidence: 'low',
        sourceRefs: sourceRefs(row.sourceRefs, context.sourceRefs, 'npc unresolved sourceRefs'),
      });
    }
    if (row.kind === 'identity_resolution') {
      exact(row, [
        'kind', 'mentionKey', 'alias', 'characterId', 'confidence',
        'expectedEntityVersion', 'sourceRefs',
      ], 'npc identity resolution');
      if (row.confidence !== 'high' && row.confidence !== 'medium') {
        reject('evidence-classification-invalid', 'npc identity confidence must be high or medium');
      }
      const bound = boundIdentityCharacter(row, context);
      return Object.freeze({
        kind: 'identity_resolution',
        mentionKey: identityText(row.mentionKey, 'npc identity mentionKey', 240),
        alias: identityText(row.alias, 'npc identity alias', 160),
        ...bound,
        confidence: row.confidence,
        sourceRefs: sourceRefs(row.sourceRefs, characterSourceRefs(bound.characterId), 'npc identity sourceRefs'),
      });
    }
    if (row.kind === 'relationship') {
      exact(row, [
        'kind', 'characterId', 'toCharacterId', 'relationType', 'perspective', 'status', 'confidence',
        'effectiveRound', 'expectedEntityVersion', 'sourceRefs',
      ], 'npc relationship');
      const bound = boundCharacter(row, context);
      if (typeof row.toCharacterId !== 'string' || !context.characterIds.has(row.toCharacterId)
        || row.toCharacterId === bound.characterId) {
        reject('relationship-target-not-allowed', 'npc relationship endpoint or type is invalid');
      }
      if (typeof row.relationType !== 'string' || !FIELD.test(row.relationType)
        || (row.perspective !== 'objective' && row.perspective !== 'subjective')) {
        reject('proposal-field-invalid', 'npc relationship endpoint or type is invalid');
      }
      const normalizedConfidence = confidence(row.confidence);
      const normalizedStatus = status(row.status);
      if (row.perspective === 'objective'
        && (normalizedConfidence !== 'high' || normalizedStatus !== 'confirmed')) {
        reject('evidence-classification-invalid', 'objective relationship requires high confirmed evidence');
      }
      const leftRefs = characterSourceRefs(bound.characterId);
      const rightRefs = characterSourceRefs(row.toCharacterId);
      const relationshipRefs = context.sourceRefsByCharacter === undefined
        ? context.sourceRefs
        : new Set([...leftRefs].filter((ref) => rightRefs.has(ref)));
      return Object.freeze({
        kind: 'relationship',
        ...bound,
        toCharacterId: row.toCharacterId,
        relationType: row.relationType,
        perspective: row.perspective,
        status: normalizedStatus,
        confidence: normalizedConfidence,
        sourceRefs: sourceRefs(row.sourceRefs, relationshipRefs, 'npc relationship sourceRefs'),
      });
    }

    exact(row, [
      'kind', 'characterId', 'field', 'value', 'status', 'confidence',
      'effectiveRound', 'expectedEntityVersion', 'sourceRefs',
    ], 'npc fact');
    if (typeof row.kind !== 'string' || !FACT_KINDS.has(row.kind as NpcMaintenanceFactKind)
      || typeof row.field !== 'string' || !FIELD.test(row.field)) {
      reject('proposal-field-invalid', 'npc fact kind or field is invalid');
    }
    const bound = boundCharacter(row, context);
    const normalizedConfidence = confidence(row.confidence);
    const normalizedStatus = status(row.status);
    if (row.kind === 'objective_fact'
      && (normalizedConfidence !== 'high' || normalizedStatus !== 'confirmed')) {
      reject('evidence-classification-invalid', 'objective fact requires high confirmed evidence');
    }
    if ((row.kind === 'belief' || row.kind === 'goal')
      && normalizedStatus === 'confirmed') {
      reject('evidence-classification-invalid', 'belief and goal cannot be confirmed objective state');
    }
    const normalizedValue = safeValue(row.value);
    if (Buffer.byteLength(canonical(normalizedValue), 'utf8') > 4_096) {
      reject('proposal-value-invalid', 'npc value is too large');
    }
    return Object.freeze({
      kind: row.kind as NpcMaintenanceFactKind,
      ...bound,
      field: row.field,
      value: normalizedValue,
      status: normalizedStatus,
      confidence: normalizedConfidence,
      sourceRefs: sourceRefs(row.sourceRefs, characterSourceRefs(bound.characterId), 'npc fact sourceRefs'),
    });
  });

  // One spelling may never resolve to two characters in the same typed proposal, even
  // if the model varies confidence or swaps mentionKey/alias fields between entries.
  const identityOwners = new Map<string, { characterId: string; entryIndex: number }>();
  const writeTargets = new Set<string>();
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.kind === 'unresolved') {
      const target = `unresolved\0${entry.mentionDigest}`;
      if (writeTargets.has(target)) {
        reject('proposal-duplicate-target', 'npc maintenance proposal contains duplicate unresolved targets');
      }
      writeTargets.add(target);
      continue;
    }
    if (entry.kind === 'relationship') {
      const target = [
        'relationship', entry.characterId, entry.toCharacterId,
        entry.relationType, entry.perspective,
      ].join('\0');
      if (writeTargets.has(target)) {
        reject('proposal-duplicate-target', 'npc maintenance proposal contains duplicate relationship targets');
      }
      writeTargets.add(target);
      continue;
    }
    if (entry.kind !== 'identity_resolution') {
      const storedField = entry.kind === 'profile'
        ? `profile\0${entry.field}`
        : entry.kind === 'objective_fact'
          ? `fact\0${entry.field}`
          : `fact\0${entry.kind === 'history_only' ? 'history' : entry.kind}.${entry.field}`;
      const target = `fact\0${entry.characterId}\0${storedField}`;
      if (writeTargets.has(target)) {
        reject('proposal-duplicate-target', 'npc maintenance proposal contains duplicate fact targets');
      }
      writeTargets.add(target);
      continue;
    }
    const identityTarget = `identity\0${entry.characterId}\0${entry.alias.toLocaleLowerCase('en-US')}`;
    if (writeTargets.has(identityTarget)) {
      reject('proposal-duplicate-target', 'npc maintenance proposal contains duplicate identity targets');
    }
    writeTargets.add(identityTarget);
    for (const identity of new Set([entry.mentionKey, entry.alias])) {
      const key = identity.normalize('NFKC').toLocaleLowerCase('en-US');
      const owner = identityOwners.get(key);
      if (owner !== undefined && owner.entryIndex !== entryIndex) {
        if (owner.characterId !== entry.characterId) {
          reject('proposal-duplicate-target', 'npc identity resolution contains conflicting identity bindings');
        }
        reject('proposal-duplicate-target', 'npc maintenance proposal contains duplicate identity spellings');
      }
      identityOwners.set(key, { characterId: entry.characterId, entryIndex });
    }
  }

  const normalizedEntries = entries
    .map((entry) => ({ entry, key: canonical(entry) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(normalizedEntries.map((item) => item.key)).size !== normalizedEntries.length) {
    reject('proposal-duplicate-target', 'npc maintenance proposal contains duplicate entries');
  }
  const normalized = Object.freeze({
    version: NPC_MAINTENANCE_PROPOSAL_VERSION,
    sessionId: inputContext.sessionId,
    sourceRevision: inputContext.sourceRevision,
    entries: Object.freeze(normalizedEntries.map((item) => item.entry)),
  });
  return Object.freeze({ ...normalized, proposalDigest: digest(normalized) });
}
