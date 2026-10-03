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
  readonly expectedEntityVersions: Readonly<Record<string, number>>;
  readonly maxRound: number;
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
const MAX_ENTRIES = 64;

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + ' must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(label + ' has unsupported or missing fields');
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
  if (depth > 4) throw new TypeError('npc value nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && value.length > 2_000) throw new TypeError('npc string value is too long');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('npc numeric value must be finite');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new TypeError('npc array value is too large');
    return Object.freeze(value.map((item) => safeValue(item, depth + 1)));
  }
  const row = plain(value, 'npc value');
  if (Object.keys(row).length > 32 || Object.keys(row).some((key) => FORBIDDEN_KEYS.has(key) || key.length > 64)) {
    throw new TypeError('npc object value contains unsafe fields');
  }
  return Object.freeze(Object.fromEntries(
    Object.keys(row).sort().map((key) => [key, safeValue(row[key], depth + 1)]),
  ));
}

function sourceRefs(value: unknown, allowed: ReadonlySet<string>, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32
    || value.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    throw new TypeError(label + ' contains an unknown or invalid source');
  }
  const normalized = [...new Set(value as string[])].sort();
  if (normalized.length !== value.length) throw new TypeError(label + ' contains duplicate sources');
  return Object.freeze(normalized);
}

function confidence(value: unknown): NpcMaintenanceConfidence {
  if (typeof value !== 'string' || !CONFIDENCE.has(value as NpcMaintenanceConfidence)) {
    throw new TypeError('npc confidence is invalid');
  }
  return value as NpcMaintenanceConfidence;
}

function status(value: unknown): NpcMaintenanceStatus {
  if (typeof value !== 'string' || !STATUS.has(value as NpcMaintenanceStatus)) {
    throw new TypeError('npc status is invalid');
  }
  return value as NpcMaintenanceStatus;
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
    throw new TypeError('npc characterId is not an allowed resolved character');
  }
  const expected = context.expectedVersions[row.characterId];
  if (!Number.isSafeInteger(row.expectedEntityVersion) || row.expectedEntityVersion !== expected) {
    throw new TypeError('npc expectedEntityVersion is stale or invalid');
  }
  if (!Number.isSafeInteger(row.effectiveRound) || (row.effectiveRound as number) < 1
    || (row.effectiveRound as number) > context.maxRound) {
    throw new TypeError('npc effectiveRound is invalid');
  }
  return {
    characterId: row.characterId,
    expectedEntityVersion: row.expectedEntityVersion as number,
    effectiveRound: row.effectiveRound as number,
  };
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
    throw new TypeError('npc maintenance context is invalid');
  }
  const expectedKeys = Object.keys(inputContext.expectedEntityVersions).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify([...inputContext.allowedCharacterIds].sort())
    || expectedKeys.some((key) => !Number.isSafeInteger(inputContext.expectedEntityVersions[key])
      || inputContext.expectedEntityVersions[key]! < 0)) {
    throw new TypeError('npc expectedEntityVersions must exactly cover allowed characters');
  }
  const context = {
    characterIds: new Set(inputContext.allowedCharacterIds),
    sourceRefs: new Set(inputContext.allowedSourceRefs),
    expectedVersions: inputContext.expectedEntityVersions,
    maxRound: inputContext.maxRound,
  };

  const proposal = plain(value, 'npc maintenance proposal');
  exact(proposal, ['version', 'sessionId', 'sourceRevision', 'entries'], 'npc maintenance proposal');
  if (proposal.version !== NPC_MAINTENANCE_PROPOSAL_VERSION
    || proposal.sessionId !== inputContext.sessionId
    || proposal.sourceRevision !== inputContext.sourceRevision
    || !Array.isArray(proposal.entries)
    || proposal.entries.length < 1
    || proposal.entries.length > MAX_ENTRIES) {
    throw new TypeError('npc maintenance proposal binding is invalid');
  }

  const entries = proposal.entries.map((raw, index): NpcMaintenanceEntry => {
    const row = plain(raw, 'npc entry ' + index);
    if (row.kind === 'unresolved') {
      exact(row, ['kind', 'mentionDigest', 'reasonCode', 'confidence', 'sourceRefs'], 'npc unresolved');
      if (typeof row.mentionDigest !== 'string' || !DIGEST.test(row.mentionDigest)
        || typeof row.reasonCode !== 'string' || !UNRESOLVED_REASONS.has(row.reasonCode)
        || row.confidence !== 'low') {
        throw new TypeError('npc unresolved entry is invalid');
      }
      return Object.freeze({
        kind: 'unresolved',
        mentionDigest: row.mentionDigest,
        reasonCode: row.reasonCode as NpcMaintenanceUnresolvedEntry['reasonCode'],
        confidence: 'low',
        sourceRefs: sourceRefs(row.sourceRefs, context.sourceRefs, 'npc unresolved sourceRefs'),
      });
    }
    if (row.kind === 'relationship') {
      exact(row, [
        'kind', 'characterId', 'toCharacterId', 'relationType', 'perspective', 'status', 'confidence',
        'effectiveRound', 'expectedEntityVersion', 'sourceRefs',
      ], 'npc relationship');
      const bound = boundCharacter(row, context);
      if (typeof row.toCharacterId !== 'string' || !context.characterIds.has(row.toCharacterId)
        || row.toCharacterId === bound.characterId
        || typeof row.relationType !== 'string' || !FIELD.test(row.relationType)
        || (row.perspective !== 'objective' && row.perspective !== 'subjective')) {
        throw new TypeError('npc relationship endpoint or type is invalid');
      }
      const normalizedConfidence = confidence(row.confidence);
      const normalizedStatus = status(row.status);
      if (row.perspective === 'objective'
        && (normalizedConfidence !== 'high' || normalizedStatus !== 'confirmed')) {
        throw new TypeError('objective relationship requires high confirmed evidence');
      }
      return Object.freeze({
        kind: 'relationship',
        ...bound,
        toCharacterId: row.toCharacterId,
        relationType: row.relationType,
        perspective: row.perspective,
        status: normalizedStatus,
        confidence: normalizedConfidence,
        sourceRefs: sourceRefs(row.sourceRefs, context.sourceRefs, 'npc relationship sourceRefs'),
      });
    }

    exact(row, [
      'kind', 'characterId', 'field', 'value', 'status', 'confidence',
      'effectiveRound', 'expectedEntityVersion', 'sourceRefs',
    ], 'npc fact');
    if (typeof row.kind !== 'string' || !FACT_KINDS.has(row.kind as NpcMaintenanceFactKind)
      || typeof row.field !== 'string' || !FIELD.test(row.field)) {
      throw new TypeError('npc fact kind or field is invalid');
    }
    const bound = boundCharacter(row, context);
    const normalizedConfidence = confidence(row.confidence);
    const normalizedStatus = status(row.status);
    if (row.kind === 'objective_fact'
      && (normalizedConfidence !== 'high' || normalizedStatus !== 'confirmed')) {
      throw new TypeError('objective fact requires high confirmed evidence');
    }
    if ((row.kind === 'belief' || row.kind === 'goal')
      && normalizedStatus === 'confirmed') {
      throw new TypeError('belief and goal cannot be confirmed objective state');
    }
    const normalizedValue = safeValue(row.value);
    if (Buffer.byteLength(canonical(normalizedValue), 'utf8') > 4_096) {
      throw new TypeError('npc value is too large');
    }
    return Object.freeze({
      kind: row.kind as NpcMaintenanceFactKind,
      ...bound,
      field: row.field,
      value: normalizedValue,
      status: normalizedStatus,
      confidence: normalizedConfidence,
      sourceRefs: sourceRefs(row.sourceRefs, context.sourceRefs, 'npc fact sourceRefs'),
    });
  });

  const normalizedEntries = entries
    .map((entry) => ({ entry, key: canonical(entry) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(normalizedEntries.map((item) => item.key)).size !== normalizedEntries.length) {
    throw new TypeError('npc maintenance proposal contains duplicate entries');
  }
  const normalized = Object.freeze({
    version: NPC_MAINTENANCE_PROPOSAL_VERSION,
    sessionId: inputContext.sessionId,
    sourceRevision: inputContext.sourceRevision,
    entries: Object.freeze(normalizedEntries.map((item) => item.entry)),
  });
  return Object.freeze({ ...normalized, proposalDigest: digest(normalized) });
}
