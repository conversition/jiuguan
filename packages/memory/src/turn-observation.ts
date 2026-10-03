import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const OPAQUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export type ObservationHarnessLane = 'off' | 'shadow' | 'on';

/** Storage boundary: callers normalize the candidate in agent-policy before append. */
export interface TurnObservationRecord {
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

export class TurnObservationConflictError extends Error {
  readonly code = 'turn-observation-identity-conflict';
  constructor(message = 'TurnObservation identity is already bound to a different payload') {
    super(message);
    this.name = 'TurnObservationConflictError';
  }
}

function opaque(value: unknown, field: string): string {
  if (typeof value !== 'string' || !OPAQUE_TOKEN.test(value)) throw new Error(`${field} storage is invalid`);
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${field} storage is invalid`);
  return value as number;
}

function nullableCount(value: unknown, field: string, minimum = 0): number | null {
  return value === null ? null : integer(value, field, minimum);
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('created_at storage is invalid');
  }
  return value;
}

function validateList(
  value: unknown,
  field: string,
  options: { hash?: boolean; sortedUnique?: boolean; unique?: boolean } = {},
): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${field} storage is invalid`);
  const items = value.map((item) => {
    if (typeof item !== 'string' || (options.hash ? !SHA256.test(item) : !OPAQUE_TOKEN.test(item))) {
      throw new Error(`${field} storage is invalid`);
    }
    return item;
  });
  if (options.unique && new Set(items).size !== items.length) throw new Error(`${field} storage is invalid`);
  if (options.sortedUnique) {
    const canonical = [...new Set(items)].sort();
    if (JSON.stringify(canonical) !== JSON.stringify(items)) throw new Error(`${field} storage is not canonical`);
  }
  return Object.freeze(items);
}

function payloadObject(value: TurnObservationRecord): Record<string, unknown> {
  return {
    sessionId: value.sessionId,
    round: value.round,
    assistantMessageId: value.assistantMessageId,
    sourceRevision: value.sourceRevision,
    queryPlanVersion: value.queryPlanVersion,
    routingDigest: value.routingDigest,
    recallHitCount: value.recallHitCount,
    recallCodes: value.recallCodes,
    worldbookHitCount: value.worldbookHitCount,
    resolvedEntityCount: value.resolvedEntityCount,
    ambiguousEntityCount: value.ambiguousEntityCount,
    skillIds: value.skillIds,
    skillBodyHashes: value.skillBodyHashes,
    skillTokens: value.skillTokens,
    assembledPromptTokens: value.assembledPromptTokens,
    harnessLane: value.harnessLane,
    harnessEvidenceCount: value.harnessEvidenceCount,
    modelAttempts: value.modelAttempts,
  };
}

function validateRecord(input: TurnObservationRecord): TurnObservationRecord {
  const lane = input.harnessLane;
  if (lane !== null && lane !== 'off' && lane !== 'shadow' && lane !== 'on') {
    throw new Error('harness_lane storage is invalid');
  }
  const skillIds = validateList(input.skillIds, 'skill_ids', { unique: true });
  const skillBodyHashes = validateList(input.skillBodyHashes, 'skill_body_hashes', { hash: true });
  if ((skillIds === null) !== (skillBodyHashes === null)
    || (skillIds !== null && skillBodyHashes !== null && skillIds.length !== skillBodyHashes.length)) {
    throw new Error('skill evidence storage is invalid');
  }
  if (!SHA256.test(input.routingDigest) || !SHA256.test(input.payloadDigest)) {
    throw new Error('digest storage is invalid');
  }
  const record: TurnObservationRecord = Object.freeze({
    observationId: opaque(input.observationId, 'observation_id'),
    runId: input.runId === null ? null : opaque(input.runId, 'run_id'),
    sessionId: opaque(input.sessionId, 'session_id'),
    round: integer(input.round, 'round', 1),
    assistantMessageId: integer(input.assistantMessageId, 'assistant_message_id', 1),
    sourceRevision: opaque(input.sourceRevision, 'source_revision'),
    queryPlanVersion: opaque(input.queryPlanVersion, 'query_plan_version'),
    routingDigest: input.routingDigest,
    recallHitCount: nullableCount(input.recallHitCount, 'recall_hit_count'),
    recallCodes: validateList(input.recallCodes, 'recall_codes', { sortedUnique: true }),
    worldbookHitCount: nullableCount(input.worldbookHitCount, 'worldbook_hit_count'),
    resolvedEntityCount: nullableCount(input.resolvedEntityCount, 'resolved_entity_count'),
    ambiguousEntityCount: nullableCount(input.ambiguousEntityCount, 'ambiguous_entity_count'),
    skillIds,
    skillBodyHashes,
    skillTokens: nullableCount(input.skillTokens, 'skill_tokens'),
    assembledPromptTokens: nullableCount(input.assembledPromptTokens, 'assembled_prompt_tokens'),
    harnessLane: lane,
    harnessEvidenceCount: nullableCount(input.harnessEvidenceCount, 'harness_evidence_count'),
    modelAttempts: nullableCount(input.modelAttempts, 'model_attempts', 1),
    payloadDigest: input.payloadDigest,
    createdAt: canonicalTimestamp(input.createdAt),
  });
  const expected = `sha256:${createHash('sha256').update(JSON.stringify(payloadObject(record)), 'utf8').digest('hex')}`;
  if (record.payloadDigest !== expected) throw new Error('TurnObservation payload digest mismatch');
  return record;
}

function jsonList(value: readonly string[] | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function parseJsonList(value: unknown, field: string): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${field} storage is invalid`);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} storage is invalid`);
  }
  return parsed;
}

function parseRow(row: Record<string, unknown>): TurnObservationRecord {
  return validateRecord({
    observationId: row.observation_id as string,
    runId: row.run_id as string | null,
    sessionId: row.session_id as string,
    round: row.round as number,
    assistantMessageId: row.assistant_message_id as number,
    sourceRevision: row.source_revision as string,
    queryPlanVersion: row.query_plan_version as string,
    routingDigest: row.routing_digest as string,
    recallHitCount: row.recall_hit_count as number | null,
    recallCodes: parseJsonList(row.recall_codes_json, 'recall_codes_json'),
    worldbookHitCount: row.worldbook_hit_count as number | null,
    resolvedEntityCount: row.resolved_entity_count as number | null,
    ambiguousEntityCount: row.ambiguous_entity_count as number | null,
    skillIds: parseJsonList(row.skill_ids_json, 'skill_ids_json'),
    skillBodyHashes: parseJsonList(row.skill_body_hashes_json, 'skill_body_hashes_json'),
    skillTokens: row.skill_tokens as number | null,
    assembledPromptTokens: row.assembled_prompt_tokens as number | null,
    harnessLane: row.harness_lane as ObservationHarnessLane | null,
    harnessEvidenceCount: row.harness_evidence_count as number | null,
    modelAttempts: row.model_attempts as number | null,
    payloadDigest: row.payload_digest as string,
    createdAt: row.created_at as string,
  });
}

export class TurnObservationStore {
  constructor(private readonly db: DatabaseSync) {}

  get(observationId: string): TurnObservationRecord | null {
    const row = this.db.prepare('SELECT * FROM turn_observation WHERE observation_id = ?')
      .get(opaque(observationId, 'observation_id')) as Record<string, unknown> | undefined;
    return row ? parseRow(row) : null;
  }

  getByRunId(runId: string): TurnObservationRecord | null {
    const row = this.db.prepare('SELECT * FROM turn_observation WHERE run_id = ?')
      .get(opaque(runId, 'run_id')) as Record<string, unknown> | undefined;
    return row ? parseRow(row) : null;
  }

  /** P14-01C 只读分析入口；不 attach 外部账本，也不改变 Observation。 */
  list(filters: { sessionId?: string; round?: number; limit?: number } = {}): TurnObservationRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(opaque(filters.sessionId, 'session_id'));
    }
    if (filters.round !== undefined) {
      where.push('round = ?');
      params.push(integer(filters.round, 'round', 1));
    }
    const limit = filters.limit === undefined ? 10_000 : integer(filters.limit, 'limit', 1);
    if (limit > 10_000) throw new Error('limit storage is invalid');
    const sql = 'SELECT * FROM turn_observation'
      + (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY created_at, observation_id LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(parseRow);
  }

  append(input: TurnObservationRecord): TurnObservationRecord {
    const observation = validateRecord(input);
    const byObservationId = this.get(observation.observationId);
    const byRunId = observation.runId ? this.getByRunId(observation.runId) : null;
    if (byObservationId && byRunId && byObservationId.observationId !== byRunId.observationId) {
      throw new TurnObservationConflictError();
    }
    const existing = byObservationId ?? byRunId;
    if (existing) {
      const samePayload = existing.payloadDigest === observation.payloadDigest;
      const observationIdentityCompatible = !byObservationId || existing.runId === observation.runId;
      if (!samePayload || !observationIdentityCompatible) throw new TurnObservationConflictError();
      return existing;
    }

    this.db.prepare(
      `INSERT INTO turn_observation (
        observation_id, run_id, session_id, round, assistant_message_id, source_revision,
        query_plan_version, routing_digest, recall_hit_count, recall_codes_json,
        worldbook_hit_count, resolved_entity_count, ambiguous_entity_count,
        skill_ids_json, skill_body_hashes_json, skill_tokens, assembled_prompt_tokens,
        harness_lane, harness_evidence_count, model_attempts, payload_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      observation.observationId, observation.runId, observation.sessionId, observation.round,
      observation.assistantMessageId, observation.sourceRevision, observation.queryPlanVersion,
      observation.routingDigest, observation.recallHitCount, jsonList(observation.recallCodes),
      observation.worldbookHitCount, observation.resolvedEntityCount, observation.ambiguousEntityCount,
      jsonList(observation.skillIds), jsonList(observation.skillBodyHashes), observation.skillTokens,
      observation.assembledPromptTokens, observation.harnessLane, observation.harnessEvidenceCount,
      observation.modelAttempts, observation.payloadDigest, observation.createdAt,
    );
    return observation;
  }
}
