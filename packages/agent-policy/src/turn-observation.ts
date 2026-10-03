import { createHash } from 'node:crypto';

const OPAQUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_LIST_ITEMS = 256;

export type ObservationHarnessLane = 'off' | 'shadow' | 'on';

export interface TurnObservationInput {
  readonly observationId: string;
  readonly runId?: string | null;
  readonly sessionId: string;
  readonly round: number;
  readonly assistantMessageId: number;
  readonly sourceRevision: string;
  readonly queryPlanVersion: string;
  readonly routingDigest: string;
  readonly recallHitCount?: number | null;
  readonly recallCodes?: readonly string[] | null;
  readonly worldbookHitCount?: number | null;
  readonly resolvedEntityCount?: number | null;
  readonly ambiguousEntityCount?: number | null;
  readonly skillIds?: readonly string[] | null;
  readonly skillBodyHashes?: readonly string[] | null;
  readonly skillTokens?: number | null;
  readonly assembledPromptTokens?: number | null;
  readonly harnessLane?: ObservationHarnessLane | null;
  readonly harnessEvidenceCount?: number | null;
  readonly modelAttempts?: number | null;
  readonly createdAt?: string;
}

export interface TurnObservation {
  readonly observationId: string;
  readonly runId: string | null;
  readonly sessionId: string;
  readonly round: number;
  readonly assistantMessageId: number;
  readonly sourceRevision: string;
  readonly queryPlanVersion: string;
  readonly routingDigest: string;
  readonly recallHitCount: number | null;
  readonly recallCodes: readonly string[] | null;
  readonly worldbookHitCount: number | null;
  readonly resolvedEntityCount: number | null;
  readonly ambiguousEntityCount: number | null;
  readonly skillIds: readonly string[] | null;
  readonly skillBodyHashes: readonly string[] | null;
  readonly skillTokens: number | null;
  readonly assembledPromptTokens: number | null;
  readonly harnessLane: ObservationHarnessLane | null;
  readonly harnessEvidenceCount: number | null;
  readonly modelAttempts: number | null;
  readonly payloadDigest: string;
  readonly createdAt: string;
}

interface NormalizedFields extends Omit<TurnObservation, 'payloadDigest'> {}

function opaque(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_TOKEN.test(value)) {
    throw new TypeError(`${field} must be an opaque stable token`);
  }
  return value.normalize('NFC');
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function optionalCount(value: unknown, field: string, minimum = 0): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${field} must be null or a safe integer >= ${minimum}`);
  }
  return value as number;
}

function canonicalTimestamp(value: unknown): string {
  const timestamp = value ?? new Date().toISOString();
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError('createdAt must be a canonical ISO timestamp');
  }
  const canonical = new Date(timestamp).toISOString();
  if (canonical !== timestamp) throw new TypeError('createdAt must be a canonical ISO timestamp');
  return canonical;
}

function stableList(value: unknown, field: string, canonicalize = true): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new TypeError(`${field} must be null or a bounded array`);
  }
  const items = value.map((item, index) => opaque(item, `${field}[${index}]`));
  if (canonicalize) return Object.freeze([...new Set(items)].sort());
  if (new Set(items).size !== items.length) throw new TypeError(`${field} must not contain duplicates`);
  return Object.freeze(items);
}

function hashList(value: unknown, field: string): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new TypeError(`${field} must be null or a bounded array`);
  }
  const items = value.map((item, index) => {
    if (typeof item !== 'string' || !SHA256.test(item)) {
      throw new TypeError(`${field}[${index}] must be a sha256 digest`);
    }
    return item;
  });
  return Object.freeze(items);
}

function normalizeFields(input: TurnObservationInput): NormalizedFields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('turn observation must be a plain object');
  }
  if (typeof input.routingDigest !== 'string' || !SHA256.test(input.routingDigest)) {
    throw new TypeError('routingDigest must be a sha256 digest');
  }
  const skillIds = stableList(input.skillIds, 'skillIds', false);
  const skillBodyHashes = hashList(input.skillBodyHashes, 'skillBodyHashes');
  if ((skillIds === null) !== (skillBodyHashes === null)
    || (skillIds !== null && skillBodyHashes !== null && skillIds.length !== skillBodyHashes.length)) {
    throw new TypeError('skillIds and skillBodyHashes must be equally available and have equal lengths');
  }
  const lane = input.harnessLane ?? null;
  if (lane !== null && lane !== 'off' && lane !== 'shadow' && lane !== 'on') {
    throw new TypeError('harnessLane is invalid');
  }
  return Object.freeze({
    observationId: opaque(input.observationId, 'observationId'),
    runId: input.runId === undefined || input.runId === null ? null : opaque(input.runId, 'runId'),
    sessionId: opaque(input.sessionId, 'sessionId'),
    round: positive(input.round, 'round'),
    assistantMessageId: positive(input.assistantMessageId, 'assistantMessageId'),
    sourceRevision: opaque(input.sourceRevision, 'sourceRevision'),
    queryPlanVersion: opaque(input.queryPlanVersion, 'queryPlanVersion'),
    routingDigest: input.routingDigest,
    recallHitCount: optionalCount(input.recallHitCount, 'recallHitCount'),
    recallCodes: stableList(input.recallCodes, 'recallCodes'),
    worldbookHitCount: optionalCount(input.worldbookHitCount, 'worldbookHitCount'),
    resolvedEntityCount: optionalCount(input.resolvedEntityCount, 'resolvedEntityCount'),
    ambiguousEntityCount: optionalCount(input.ambiguousEntityCount, 'ambiguousEntityCount'),
    skillIds,
    skillBodyHashes,
    skillTokens: optionalCount(input.skillTokens, 'skillTokens'),
    assembledPromptTokens: optionalCount(input.assembledPromptTokens, 'assembledPromptTokens'),
    harnessLane: lane,
    harnessEvidenceCount: optionalCount(input.harnessEvidenceCount, 'harnessEvidenceCount'),
    modelAttempts: optionalCount(input.modelAttempts, 'modelAttempts', 1),
    createdAt: canonicalTimestamp(input.createdAt),
  });
}

function payloadObject(fields: NormalizedFields): Record<string, unknown> {
  return {
    sessionId: fields.sessionId,
    round: fields.round,
    assistantMessageId: fields.assistantMessageId,
    sourceRevision: fields.sourceRevision,
    queryPlanVersion: fields.queryPlanVersion,
    routingDigest: fields.routingDigest,
    recallHitCount: fields.recallHitCount,
    recallCodes: fields.recallCodes,
    worldbookHitCount: fields.worldbookHitCount,
    resolvedEntityCount: fields.resolvedEntityCount,
    ambiguousEntityCount: fields.ambiguousEntityCount,
    skillIds: fields.skillIds,
    skillBodyHashes: fields.skillBodyHashes,
    skillTokens: fields.skillTokens,
    assembledPromptTokens: fields.assembledPromptTokens,
    harnessLane: fields.harnessLane,
    harnessEvidenceCount: fields.harnessEvidenceCount,
    modelAttempts: fields.modelAttempts,
  };
}

export function serializeTurnObservationPayload(input: TurnObservationInput): string {
  return JSON.stringify(payloadObject(normalizeFields(input)));
}

export function computeTurnObservationPayloadDigest(input: TurnObservationInput): string {
  return `sha256:${createHash('sha256').update(serializeTurnObservationPayload(input), 'utf8').digest('hex')}`;
}

export function normalizeTurnObservation(input: TurnObservationInput): TurnObservation {
  const fields = normalizeFields(input);
  const payloadDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payloadObject(fields)), 'utf8')
    .digest('hex')}`;
  return Object.freeze({ ...fields, payloadDigest });
}
