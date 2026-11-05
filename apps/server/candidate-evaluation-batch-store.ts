/** @author Codex @date 2026-10-17 @version 1.0
 * D-Q3a2b1 durable reservation ledger for one frozen 8x3x2 Candidate evaluation batch.
 * This store proves reservation/terminal persistence only. It does not prove Provider execution,
 * Gateway chronology, sample-model joins, quality verdicts, promotion, or publication.
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import type { AgentSkillValidatorPlanEntryV1 } from '@jiuguan/prompt/agent-skill-compiler';
import {
  CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST,
  isCandidateEvaluationValidatorAuthority,
  normalizeCandidateEvaluationReceipt,
  type CandidateEvaluationArm,
  type CandidateEvaluationOutcome,
  type CandidateEvaluationProof,
  type CandidateEvaluationReceipt,
  type CandidateEvaluationSlotTicket,
  type CandidateEvaluationValidatorAuthority,
} from './skill-hub/candidate-evaluation-validator.ts';
import {
  SKILL_SAMPLE_SUITE_PAIR_COUNT,
  SKILL_SAMPLE_SUITE_REPEAT_COUNT,
  SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
  SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS,
} from './skill-sample-registry.ts';

export const CANDIDATE_EVALUATION_BATCH_DB_FILE = 'agent-skill-candidate-evaluation-batches.sqlite';
export const CANDIDATE_EVALUATION_BATCH_SCHEMA_VERSION = 1;
export const CANDIDATE_EVALUATION_BATCH_APPLICATION_ID = 0x4a474542;
export const CANDIDATE_EVALUATION_BATCH_VERSION = 'candidate-evaluation-batch-v1' as const;
export const CANDIDATE_EVALUATION_COORDINATE_VERSION = 'candidate-evaluation-coordinate-v1' as const;
export const CANDIDATE_EVALUATION_DISPATCH_VERSION = 'candidate-evaluation-dispatch-v1' as const;
export const CANDIDATE_EVALUATION_TERMINAL_VERSION = 'candidate-evaluation-terminal-v1' as const;
export const CANDIDATE_EVALUATION_AGGREGATE_VERSION = 'candidate-evaluation-aggregate-v1' as const;
export const CANDIDATE_EVALUATION_AGGREGATE_PROOF_VERSION =
  'candidate-evaluation-aggregate-proof-v1' as const;
export const CANDIDATE_EVALUATION_COORDINATE_COUNT = SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS;

if (SKILL_SAMPLE_SUITE_SCENARIO_COUNT * SKILL_SAMPLE_SUITE_REPEAT_COUNT
  !== SKILL_SAMPLE_SUITE_PAIR_COUNT
  || SKILL_SAMPLE_SUITE_PAIR_COUNT * 2 !== CANDIDATE_EVALUATION_COORDINATE_COUNT) {
  throw new Error('candidate-evaluation-batch-dimension-contract-invalid');
}

const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,239}$/u;
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_SOURCE_CHARS = 262_144;
const MAX_RECORD_CHARS = 262_144;
const SOURCE_INVALIDATED = Symbol('candidate-evaluation-batch-source-invalidated');

export type CandidateEvaluationBatchState =
  'frozen' | 'ready' | 'running' | 'complete' | 'revoked';
export type CandidateEvaluationTerminalOrigin = 'live-validator' | 'restart-recovery';
export type CandidateEvaluationTerminalReason = CandidateEvaluationReceipt['reasonCode']
  | 'candidate-evaluation-restart-uncertain';

export interface CandidateEvaluationBatchSampleRefV1 {
  readonly scenarioOrdinal: number;
  readonly repeatIndex: number;
  readonly planDigest: string;
  readonly sampleKey: string;
}

export interface CandidateEvaluationBatchSourceV1 {
  readonly rawSessionId: string;
  /** Durable Compile Store lookup anchor. Null exists only when reading a pre-anchor legacy row. */
  readonly compileJobId: string | null;
  /** Durable Sample manifest reconstruction anchor. Null exists only for pre-anchor legacy rows. */
  readonly sampleSuiteId: string | null;
  readonly candidateId: string;
  readonly candidateRevision: 1;
  readonly candidateBindingDigest: string;
  readonly sourceAuthorityRevision: string;
  readonly compiledArtifactDigest: string;
  readonly sampleSuiteDigest: string;
  readonly validatorPolicyDigest: string;
  readonly validatorPlanDigest: string;
  readonly samples: readonly CandidateEvaluationBatchSampleRefV1[];
}

export interface CandidateEvaluationBatchCreateInput
  extends Omit<CandidateEvaluationBatchSourceV1, 'compileJobId' | 'sampleSuiteId'> {
  readonly compileJobId: string;
  readonly sampleSuiteId: string;
}

export interface CandidateEvaluationBatchV1 {
  readonly batchVersion: typeof CANDIDATE_EVALUATION_BATCH_VERSION;
  readonly batchId: string;
  readonly sourceDigest: string;
  readonly createdAt: string;
}

export interface CandidateEvaluationCoordinateV1 {
  readonly coordinateVersion: typeof CANDIDATE_EVALUATION_COORDINATE_VERSION;
  readonly coordinateId: string;
  readonly batchId: string;
  readonly ordinal: number;
  readonly scenarioOrdinal: number;
  readonly repeatIndex: number;
  readonly arm: CandidateEvaluationArm;
  readonly planDigest: string;
  readonly sampleKey: string;
  readonly attempt: 1;
  readonly attemptId: string;
  readonly coordinateDigest: string;
}

export interface CandidateEvaluationDispatchV1 {
  readonly dispatchVersion: typeof CANDIDATE_EVALUATION_DISPATCH_VERSION;
  readonly dispatchId: string;
  readonly batchId: string;
  readonly coordinateId: string;
  readonly ordinal: number;
  readonly attempt: 1;
  readonly requestDigest: string;
  readonly promptBindingDigest: string;
  readonly validatorPlanDigest: string;
  readonly slotDigest: string;
  readonly dispatchedAt: string;
  readonly providerExecution: 'unverified';
  readonly dispatchChronology: 'store-reserved-only';
  readonly dispatchDigest: string;
}

export interface CandidateEvaluationLiveTerminalV1 {
  readonly terminalVersion: typeof CANDIDATE_EVALUATION_TERMINAL_VERSION;
  readonly terminalId: string;
  readonly batchId: string;
  readonly coordinateId: string;
  readonly ordinal: number;
  readonly dispatchDigest: string;
  readonly origin: 'live-validator';
  readonly outcome: CandidateEvaluationOutcome;
  readonly reasonCode: CandidateEvaluationReceipt['reasonCode'];
  readonly responseDigest: string | null;
  readonly candidateReceipt: CandidateEvaluationReceipt;
  readonly candidateReceiptDigest: string;
  readonly recordedAt: string;
  readonly terminalDigest: string;
}

export interface CandidateEvaluationRecoveryTerminalV1 {
  readonly terminalVersion: typeof CANDIDATE_EVALUATION_TERMINAL_VERSION;
  readonly terminalId: string;
  readonly batchId: string;
  readonly coordinateId: string;
  readonly ordinal: number;
  readonly dispatchDigest: string;
  readonly origin: 'restart-recovery';
  readonly outcome: 'inconclusive';
  readonly reasonCode: 'candidate-evaluation-restart-uncertain';
  readonly responseDigest: null;
  readonly candidateReceipt: null;
  readonly candidateReceiptDigest: null;
  readonly recordedAt: string;
  readonly terminalDigest: string;
}

export type CandidateEvaluationTerminalV1 =
  CandidateEvaluationLiveTerminalV1 | CandidateEvaluationRecoveryTerminalV1;

export interface CandidateEvaluationAggregateV1 {
  readonly aggregateVersion: typeof CANDIDATE_EVALUATION_AGGREGATE_VERSION;
  readonly aggregateId: string;
  readonly batchId: string;
  readonly candidateId: string;
  readonly candidateRevision: 1;
  readonly candidateBindingDigest: string;
  readonly sourceAuthorityRevision: string;
  readonly compiledArtifactDigest: string;
  readonly sampleSuiteDigest: string;
  readonly validatorPolicyDigest: string;
  readonly validatorPlanDigest: string;
  readonly expectedCoordinateCount: typeof CANDIDATE_EVALUATION_COORDINATE_COUNT;
  readonly terminalCount: typeof CANDIDATE_EVALUATION_COORDINATE_COUNT;
  readonly orderedCoordinateSetDigest: string;
  readonly orderedReceiptSetDigest: string;
  readonly outcomeCounts: Readonly<Record<CandidateEvaluationOutcome, number>>;
  readonly protocolOutcome: CandidateEvaluationOutcome;
  readonly providerExecution: 'unverified';
  readonly dispatchChronology: 'store-reserved-only';
  readonly qualityVerdict: 'not-declared';
  readonly promotionEligible: false;
  readonly completedAt: string;
  readonly aggregateDigest: string;
}

export interface CandidateEvaluationStoredBatch {
  readonly batch: CandidateEvaluationBatchV1;
  readonly source: CandidateEvaluationBatchSourceV1;
  readonly coordinates: readonly CandidateEvaluationCoordinateV1[];
  readonly dispatches: readonly CandidateEvaluationDispatchV1[];
  readonly terminals: readonly CandidateEvaluationTerminalV1[];
  readonly aggregate: CandidateEvaluationAggregateV1 | null;
  readonly state: CandidateEvaluationBatchState;
  readonly sourceCurrent: boolean;
}

/**
 * Shared read-side trust guard for adoption and promotion.
 * A revoked/stale or merely frozen/running Batch is historical diagnostics, never authority.
 */
export function currentCompleteCandidateEvaluationBatch(
  input: CandidateEvaluationStoredBatch | null,
): CandidateEvaluationStoredBatch | null {
  if (!input || input.state !== 'complete' || input.sourceCurrent !== true
    || input.source.compileJobId === null || input.source.sampleSuiteId === null
    || input.coordinates.length !== CANDIDATE_EVALUATION_COORDINATE_COUNT
    || input.dispatches.length !== CANDIDATE_EVALUATION_COORDINATE_COUNT
    || input.terminals.length !== CANDIDATE_EVALUATION_COORDINATE_COUNT
    || !input.aggregate) return null;
  try {
    const aggregate = input.aggregate;
    if (aggregate.batchId !== input.batch.batchId
      || aggregate.candidateId !== input.source.candidateId
      || aggregate.candidateRevision !== input.source.candidateRevision
      || aggregate.candidateBindingDigest !== input.source.candidateBindingDigest
      || aggregate.sourceAuthorityRevision !== input.source.sourceAuthorityRevision
      || aggregate.compiledArtifactDigest !== input.source.compiledArtifactDigest
      || aggregate.sampleSuiteDigest !== input.source.sampleSuiteDigest
      || aggregate.validatorPolicyDigest !== input.source.validatorPolicyDigest
      || aggregate.validatorPlanDigest !== input.source.validatorPlanDigest
      || aggregate.expectedCoordinateCount !== CANDIDATE_EVALUATION_COORDINATE_COUNT
      || aggregate.terminalCount !== CANDIDATE_EVALUATION_COORDINATE_COUNT
      || !/^sha256:[a-f0-9]{64}$/u.test(aggregate.aggregateDigest)) return null;
  } catch { return null; }
  return input;
}

export interface CandidateEvaluationClaimNextInput {
  readonly batchId: string;
  readonly authority: CandidateEvaluationValidatorAuthority;
  readonly validatorPlan: readonly AgentSkillValidatorPlanEntryV1[];
  readonly expectedCoordinate: Readonly<{
    scenarioOrdinal: number;
    repeatIndex: number;
    arm: CandidateEvaluationArm;
    planDigest: string;
    sampleKey: string;
  }>;
  readonly requestDigest: string;
  readonly promptBindingDigest: string;
}

declare const CANDIDATE_EVALUATION_BATCH_CLAIM: unique symbol;
export interface CandidateEvaluationBatchClaim {
  readonly [CANDIDATE_EVALUATION_BATCH_CLAIM]: true;
  readonly batchId: string;
  readonly coordinate: CandidateEvaluationCoordinateV1;
  readonly dispatch: CandidateEvaluationDispatchV1;
  readonly ticket: CandidateEvaluationSlotTicket;
}

declare const CANDIDATE_EVALUATION_AGGREGATE_PROOF: unique symbol;
export interface CandidateEvaluationAggregateProof {
  readonly [CANDIDATE_EVALUATION_AGGREGATE_PROOF]: true;
  readonly proofVersion: typeof CANDIDATE_EVALUATION_AGGREGATE_PROOF_VERSION;
  readonly batchId: string;
  readonly aggregateDigest: string;
}

export interface CandidateEvaluationAggregateRead {
  readonly aggregate: CandidateEvaluationAggregateV1;
  readonly sourceCurrent: boolean;
}

export type CandidateEvaluationBatchSourceCurrentInput = CandidateEvaluationBatchSourceV1;
type SqlRow = Record<string, unknown>;

const SCHEMA = Object.freeze([
  `CREATE TABLE candidate_evaluation_batch (
    batch_id TEXT NOT NULL PRIMARY KEY CHECK(length(batch_id)=71),
    session_key TEXT NOT NULL,
    candidate_binding_digest TEXT NOT NULL CHECK(length(candidate_binding_digest)=71),
    sample_suite_digest TEXT NOT NULL CHECK(length(sample_suite_digest)=71),
    validator_policy_digest TEXT NOT NULL CHECK(length(validator_policy_digest)=71),
    source_json TEXT NOT NULL CHECK(json_valid(source_json) AND length(source_json)<=262144),
    source_digest TEXT NOT NULL CHECK(length(source_digest)=71),
    created_at TEXT NOT NULL,
    UNIQUE(candidate_binding_digest,sample_suite_digest,validator_policy_digest)
  )`,
  `CREATE TABLE candidate_evaluation_coordinate (
    coordinate_id TEXT NOT NULL PRIMARY KEY CHECK(length(coordinate_id)=71),
    batch_id TEXT NOT NULL REFERENCES candidate_evaluation_batch(batch_id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<48),
    coordinate_json TEXT NOT NULL CHECK(json_valid(coordinate_json) AND length(coordinate_json)<=262144),
    coordinate_digest TEXT NOT NULL CHECK(length(coordinate_digest)=71),
    UNIQUE(batch_id,ordinal)
  )`,
  `CREATE TABLE candidate_evaluation_dispatch (
    dispatch_id TEXT NOT NULL PRIMARY KEY CHECK(length(dispatch_id)=71),
    batch_id TEXT NOT NULL REFERENCES candidate_evaluation_batch(batch_id) ON DELETE CASCADE,
    coordinate_id TEXT NOT NULL UNIQUE REFERENCES candidate_evaluation_coordinate(coordinate_id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<48),
    dispatch_json TEXT NOT NULL CHECK(json_valid(dispatch_json) AND length(dispatch_json)<=262144),
    dispatch_digest TEXT NOT NULL CHECK(length(dispatch_digest)=71),
    dispatched_at TEXT NOT NULL,
    UNIQUE(batch_id,ordinal)
  )`,
  `CREATE TABLE candidate_evaluation_terminal (
    terminal_id TEXT NOT NULL PRIMARY KEY CHECK(length(terminal_id)=71),
    batch_id TEXT NOT NULL REFERENCES candidate_evaluation_batch(batch_id) ON DELETE CASCADE,
    coordinate_id TEXT NOT NULL UNIQUE REFERENCES candidate_evaluation_coordinate(coordinate_id) ON DELETE CASCADE,
    dispatch_id TEXT NOT NULL UNIQUE REFERENCES candidate_evaluation_dispatch(dispatch_id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<48),
    origin TEXT NOT NULL CHECK(origin IN ('live-validator','restart-recovery')),
    outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','inconclusive','invalid')),
    terminal_json TEXT NOT NULL CHECK(json_valid(terminal_json) AND length(terminal_json)<=262144),
    terminal_digest TEXT NOT NULL CHECK(length(terminal_digest)=71),
    recorded_at TEXT NOT NULL,
    UNIQUE(batch_id,ordinal)
  )`,
  `CREATE TABLE candidate_evaluation_aggregate (
    aggregate_id TEXT NOT NULL PRIMARY KEY CHECK(length(aggregate_id)=71),
    batch_id TEXT NOT NULL UNIQUE REFERENCES candidate_evaluation_batch(batch_id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    aggregate_json TEXT NOT NULL CHECK(json_valid(aggregate_json) AND length(aggregate_json)<=262144),
    aggregate_digest TEXT NOT NULL CHECK(length(aggregate_digest)=71),
    completed_at TEXT NOT NULL
  )`,
  `CREATE TABLE candidate_evaluation_batch_revocation (
    batch_id TEXT NOT NULL PRIMARY KEY REFERENCES candidate_evaluation_batch(batch_id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    revoked_at TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK(reason_code='candidate-evaluation-source-invalidated')
  )`,
  `CREATE TABLE candidate_evaluation_session_tombstone (
    session_key TEXT NOT NULL PRIMARY KEY,
    redacted_at TEXT NOT NULL
  )`,
  'CREATE INDEX candidate_evaluation_coordinate_batch ON candidate_evaluation_coordinate(batch_id,ordinal)',
  'CREATE INDEX candidate_evaluation_dispatch_batch ON candidate_evaluation_dispatch(batch_id,ordinal)',
  'CREATE INDEX candidate_evaluation_terminal_batch ON candidate_evaluation_terminal(batch_id,ordinal)',
  'CREATE INDEX candidate_evaluation_batch_session ON candidate_evaluation_batch(session_key)',
  `CREATE TRIGGER candidate_evaluation_one_open_dispatch
    BEFORE INSERT ON candidate_evaluation_dispatch
    WHEN EXISTS(
      SELECT 1 FROM candidate_evaluation_dispatch d
      LEFT JOIN candidate_evaluation_terminal t ON t.dispatch_id=d.dispatch_id
      WHERE d.batch_id=NEW.batch_id AND t.dispatch_id IS NULL
    ) BEGIN SELECT RAISE(ABORT,'candidate evaluation batch already has an open dispatch'); END`,
  ...['batch', 'coordinate', 'dispatch', 'terminal', 'aggregate', 'batch_revocation', 'session_tombstone']
    .map((name) => `CREATE TRIGGER candidate_evaluation_${name}_no_update
      BEFORE UPDATE ON candidate_evaluation_${name}
      BEGIN SELECT RAISE(ABORT,'candidate evaluation record immutable'); END`),
  ...['batch', 'coordinate', 'dispatch', 'terminal', 'aggregate', 'batch_revocation']
    .map((name) => `CREATE TRIGGER candidate_evaluation_${name}_delete_only_after_tombstone
      BEFORE DELETE ON candidate_evaluation_${name}
      WHEN NOT EXISTS(SELECT 1 FROM candidate_evaluation_session_tombstone s
        WHERE s.session_key=OLD.session_key)
      BEGIN SELECT RAISE(ABORT,'candidate evaluation record append-only'); END`),
  `CREATE TRIGGER candidate_evaluation_session_tombstone_no_delete
    BEFORE DELETE ON candidate_evaluation_session_tombstone
    BEGIN SELECT RAISE(ABORT,'candidate evaluation deletion fence permanent'); END`,
]);

function canonical(input: unknown): string {
  if (input === null || typeof input !== 'object') {
    const value = JSON.stringify(input);
    if (value === undefined) throw new Error('candidate-evaluation-batch-data-invalid');
    return value;
  }
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
  const value = input as Record<string, unknown>;
  return `{${Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new Error('candidate-evaluation-batch-data-invalid');
    return `${JSON.stringify(key)}:${canonical(value[key])}`;
  }).join(',')}}`;
}

function hash(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(input), 'utf8').digest('hex')}`;
}

function digest(input: unknown): string {
  if (typeof input !== 'string' || !HASH.test(input)) {
    throw new Error('candidate-evaluation-batch-digest-invalid');
  }
  return input;
}

function token(input: unknown): string {
  if (typeof input !== 'string' || !TOKEN.test(input)) {
    throw new Error('candidate-evaluation-batch-token-invalid');
  }
  return input;
}

function session(input: unknown): string {
  if (typeof input !== 'string' || !SESSION.test(input)) {
    throw new Error('candidate-evaluation-batch-session-invalid');
  }
  return input;
}

function timestamp(input: unknown): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))
    || new Date(input).toISOString() !== input) {
    throw new Error('candidate-evaluation-batch-time-invalid');
  }
  return input;
}

function integer(input: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(input) || Number(input) < minimum || Number(input) > maximum) {
    throw new Error('candidate-evaluation-batch-integer-invalid');
  }
  return Number(input);
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error('candidate-evaluation-batch-data-invalid');
  }
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new Error('candidate-evaluation-batch-fields-invalid');
  }
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('candidate-evaluation-batch-fields-invalid');
    }
  }
  return input as Record<string, unknown>;
}

function dense(input: unknown, length: number): readonly unknown[] {
  if (!Array.isArray(input) || nodeTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Array.prototype || input.length !== length
    || Reflect.ownKeys(input).length !== length + 1) {
    throw new Error('candidate-evaluation-batch-array-invalid');
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('candidate-evaluation-batch-array-invalid');
    }
    return descriptor.value;
  });
}

function freeze<T>(input: T): T {
  if (input && typeof input === 'object' && !Object.isFrozen(input)) {
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) freeze(descriptor.value);
    }
    Object.freeze(input);
  }
  return input;
}

function json(input: unknown, maximum = MAX_RECORD_CHARS): string {
  const value = JSON.stringify(input);
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error('candidate-evaluation-batch-record-too-large');
  }
  return value;
}

function parseJson(input: unknown): unknown {
  if (typeof input !== 'string') throw new Error('candidate-evaluation-batch-storage-invalid');
  try { return JSON.parse(input) as unknown; }
  catch { throw new Error('candidate-evaluation-batch-storage-invalid'); }
}

function normalizedSchemaSql(db: DatabaseSync): readonly string[] {
  return (db.prepare(`SELECT sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as SqlRow[])
    .map((row) => String(row.sql).trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase())
    .sort();
}

function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
  const value = (db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key];
  return integer(value, 0, 0x7fff_ffff);
}

export function inspectCandidateEvaluationBatchSchema(db: DatabaseSync): void {
  if (pragma(db, 'application_id') !== CANDIDATE_EVALUATION_BATCH_APPLICATION_ID
    || pragma(db, 'user_version') !== CANDIDATE_EVALUATION_BATCH_SCHEMA_VERSION) {
    throw new Error('candidate-evaluation-batch-metadata-mismatch');
  }
  const expected = SCHEMA.map((value) => value.trim().replace(/;$/u, '')
    .replace(/\s+/gu, ' ').toLowerCase()).sort();
  if (canonical(normalizedSchemaSql(db)) !== canonical(expected)) {
    throw new Error('candidate-evaluation-batch-schema-mismatch');
  }
}

function initialize(db: DatabaseSync): void {
  if (pragma(db, 'application_id') !== 0 || pragma(db, 'user_version') !== 0) {
    inspectCandidateEvaluationBatchSchema(db);
    return;
  }
  if (normalizedSchemaSql(db).length !== 0) {
    throw new Error('candidate-evaluation-batch-uninitialized-not-empty');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`PRAGMA application_id=${CANDIDATE_EVALUATION_BATCH_APPLICATION_ID}`);
    for (const statement of SCHEMA) db.exec(statement);
    db.exec(`PRAGMA user_version=${CANDIDATE_EVALUATION_BATCH_SCHEMA_VERSION}`);
    inspectCandidateEvaluationBatchSchema(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function stat(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function secureDirectory(path: string): void {
  if (path === parse(path).root) throw new Error('candidate-evaluation-batch-directory-invalid');
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    const entry = stat(current);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error('candidate-evaluation-batch-directory-invalid');
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function normalizeSampleRefs(input: unknown): readonly CandidateEvaluationBatchSampleRefV1[] {
  const values = dense(input, SKILL_SAMPLE_SUITE_PAIR_COUNT);
  const sampleKeys = new Set<string>();
  const planDigests = new Set<string>();
  const result = values.map((item, index) => {
    const value = exactRecord(item, ['scenarioOrdinal', 'repeatIndex', 'planDigest', 'sampleKey']);
    const scenarioOrdinal = integer(value.scenarioOrdinal, 0, SKILL_SAMPLE_SUITE_SCENARIO_COUNT - 1);
    const repeatIndex = integer(value.repeatIndex, 0, SKILL_SAMPLE_SUITE_REPEAT_COUNT - 1);
    const planDigest = digest(value.planDigest);
    const sampleKey = token(value.sampleKey);
    if (scenarioOrdinal !== Math.floor(index / SKILL_SAMPLE_SUITE_REPEAT_COUNT)
      || repeatIndex !== index % SKILL_SAMPLE_SUITE_REPEAT_COUNT
      || sampleKeys.has(sampleKey) || planDigests.has(planDigest)) {
      throw new Error('candidate-evaluation-batch-sample-matrix-invalid');
    }
    sampleKeys.add(sampleKey);
    planDigests.add(planDigest);
    return freeze({ scenarioOrdinal, repeatIndex, planDigest, sampleKey });
  });
  return freeze(result);
}

const SOURCE_KEYS = Object.freeze([
  'rawSessionId', 'compileJobId', 'sampleSuiteId',
  'candidateId', 'candidateRevision', 'candidateBindingDigest',
  'sourceAuthorityRevision', 'compiledArtifactDigest', 'sampleSuiteDigest',
  'validatorPolicyDigest', 'validatorPlanDigest', 'samples',
]);
const LEGACY_SOURCE_KEYS = Object.freeze([
  'rawSessionId', 'candidateId', 'candidateRevision', 'candidateBindingDigest',
  'sourceAuthorityRevision', 'compiledArtifactDigest', 'sampleSuiteDigest',
  'validatorPolicyDigest', 'validatorPlanDigest', 'samples',
]);

function normalizeSource(input: unknown, allowLegacyMissingAnchor?: false): CandidateEvaluationBatchCreateInput;
function normalizeSource(input: unknown, allowLegacyMissingAnchor: true): CandidateEvaluationBatchSourceV1;
function normalizeSource(input: unknown, allowLegacyMissingAnchor = false): CandidateEvaluationBatchSourceV1 {
  let legacy = false;
  let value: Record<string, unknown>;
  try { value = exactRecord(input, SOURCE_KEYS); }
  catch (error) {
    if (!allowLegacyMissingAnchor) throw error;
    value = exactRecord(input, LEGACY_SOURCE_KEYS);
    legacy = true;
  }
  if (value.candidateRevision !== 1
    || value.validatorPolicyDigest !== CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST) {
    throw new Error('candidate-evaluation-batch-source-invalid');
  }
  return freeze({
    rawSessionId: session(value.rawSessionId),
    compileJobId: legacy ? null : token(value.compileJobId),
    sampleSuiteId: legacy ? null : digest(value.sampleSuiteId),
    candidateId: digest(value.candidateId),
    candidateRevision: 1 as const,
    candidateBindingDigest: digest(value.candidateBindingDigest),
    sourceAuthorityRevision: digest(value.sourceAuthorityRevision),
    compiledArtifactDigest: digest(value.compiledArtifactDigest),
    sampleSuiteDigest: digest(value.sampleSuiteDigest),
    validatorPolicyDigest: CANDIDATE_EVALUATION_VALIDATOR_POLICY_DIGEST,
    validatorPlanDigest: digest(value.validatorPlanDigest),
    samples: normalizeSampleRefs(value.samples),
  });
}

export function candidateEvaluationBatchId(input: Pick<CandidateEvaluationBatchSourceV1,
  'candidateBindingDigest' | 'sampleSuiteDigest' | 'validatorPolicyDigest'>): string {
  return hash({
    identityVersion: 'candidate-evaluation-batch-identity-v1',
    candidateBindingDigest: digest(input.candidateBindingDigest),
    sampleSuiteDigest: digest(input.sampleSuiteDigest),
    validatorPolicyDigest: digest(input.validatorPolicyDigest),
  });
}

function createBatchRecord(source: CandidateEvaluationBatchSourceV1, createdAt: string): CandidateEvaluationBatchV1 {
  return freeze({
    batchVersion: CANDIDATE_EVALUATION_BATCH_VERSION,
    batchId: candidateEvaluationBatchId(source),
    sourceDigest: hash(source),
    createdAt: timestamp(createdAt),
  });
}

function normalizeBatch(input: unknown): CandidateEvaluationBatchV1 {
  const value = exactRecord(input, ['batchVersion', 'batchId', 'sourceDigest', 'createdAt']);
  if (value.batchVersion !== CANDIDATE_EVALUATION_BATCH_VERSION) {
    throw new Error('candidate-evaluation-batch-storage-invalid');
  }
  return freeze({
    batchVersion: CANDIDATE_EVALUATION_BATCH_VERSION,
    batchId: digest(value.batchId),
    sourceDigest: digest(value.sourceDigest),
    createdAt: timestamp(value.createdAt),
  });
}

function deriveCoordinates(batch: CandidateEvaluationBatchV1, source: CandidateEvaluationBatchSourceV1):
readonly CandidateEvaluationCoordinateV1[] {
  const arms: readonly CandidateEvaluationArm[] = ['baseline', 'candidate'];
  const result: CandidateEvaluationCoordinateV1[] = [];
  for (const sample of source.samples) {
    for (const arm of arms) {
      const ordinal = result.length;
      const coordinateId = hash(['candidate-evaluation-coordinate-v1', batch.batchId, ordinal]);
      const core = freeze({
        coordinateVersion: CANDIDATE_EVALUATION_COORDINATE_VERSION,
        coordinateId,
        batchId: batch.batchId,
        ordinal,
        scenarioOrdinal: sample.scenarioOrdinal,
        repeatIndex: sample.repeatIndex,
        arm,
        planDigest: sample.planDigest,
        sampleKey: sample.sampleKey,
        attempt: 1 as const,
        attemptId: coordinateId,
      });
      result.push(freeze({ ...core, coordinateDigest: hash(core) }));
    }
  }
  if (result.length !== CANDIDATE_EVALUATION_COORDINATE_COUNT) {
    throw new Error('candidate-evaluation-batch-coordinate-count-invalid');
  }
  return freeze(result);
}

function normalizeCoordinate(input: unknown): CandidateEvaluationCoordinateV1 {
  const value = exactRecord(input, [
    'coordinateVersion', 'coordinateId', 'batchId', 'ordinal', 'scenarioOrdinal', 'repeatIndex',
    'arm', 'planDigest', 'sampleKey', 'attempt', 'attemptId', 'coordinateDigest',
  ]);
  if (value.coordinateVersion !== CANDIDATE_EVALUATION_COORDINATE_VERSION
    || value.attempt !== 1 || value.arm !== 'baseline' && value.arm !== 'candidate') {
    throw new Error('candidate-evaluation-batch-coordinate-invalid');
  }
  const core = freeze({
    coordinateVersion: CANDIDATE_EVALUATION_COORDINATE_VERSION,
    coordinateId: digest(value.coordinateId),
    batchId: digest(value.batchId),
    ordinal: integer(value.ordinal, 0, CANDIDATE_EVALUATION_COORDINATE_COUNT - 1),
    scenarioOrdinal: integer(value.scenarioOrdinal, 0, SKILL_SAMPLE_SUITE_SCENARIO_COUNT - 1),
    repeatIndex: integer(value.repeatIndex, 0, SKILL_SAMPLE_SUITE_REPEAT_COUNT - 1),
    arm: value.arm as CandidateEvaluationArm,
    planDigest: digest(value.planDigest),
    sampleKey: token(value.sampleKey),
    attempt: 1 as const,
    attemptId: token(value.attemptId),
  });
  const coordinateDigest = digest(value.coordinateDigest);
  if (coordinateDigest !== hash(core)
    || core.coordinateId !== hash(['candidate-evaluation-coordinate-v1', core.batchId, core.ordinal])
    || core.attemptId !== core.coordinateId) {
    throw new Error('candidate-evaluation-batch-coordinate-invalid');
  }
  return freeze({ ...core, coordinateDigest });
}

function createDispatch(input: {
  batchId: string;
  coordinate: CandidateEvaluationCoordinateV1;
  requestDigest: string;
  promptBindingDigest: string;
  validatorPlanDigest: string;
  slotDigest: string;
  dispatchedAt: string;
}): CandidateEvaluationDispatchV1 {
  const dispatchId = hash(['candidate-evaluation-dispatch-v1', input.coordinate.coordinateId, 1]);
  const core = freeze({
    dispatchVersion: CANDIDATE_EVALUATION_DISPATCH_VERSION,
    dispatchId,
    batchId: digest(input.batchId),
    coordinateId: input.coordinate.coordinateId,
    ordinal: input.coordinate.ordinal,
    attempt: 1 as const,
    requestDigest: digest(input.requestDigest),
    promptBindingDigest: digest(input.promptBindingDigest),
    validatorPlanDigest: digest(input.validatorPlanDigest),
    slotDigest: digest(input.slotDigest),
    dispatchedAt: timestamp(input.dispatchedAt),
    providerExecution: 'unverified' as const,
    dispatchChronology: 'store-reserved-only' as const,
  });
  return freeze({ ...core, dispatchDigest: hash(core) });
}

function normalizeDispatch(input: unknown): CandidateEvaluationDispatchV1 {
  const value = exactRecord(input, [
    'dispatchVersion', 'dispatchId', 'batchId', 'coordinateId', 'ordinal', 'attempt',
    'requestDigest', 'promptBindingDigest', 'validatorPlanDigest', 'slotDigest', 'dispatchedAt',
    'providerExecution', 'dispatchChronology', 'dispatchDigest',
  ]);
  if (value.dispatchVersion !== CANDIDATE_EVALUATION_DISPATCH_VERSION || value.attempt !== 1
    || value.providerExecution !== 'unverified'
    || value.dispatchChronology !== 'store-reserved-only') {
    throw new Error('candidate-evaluation-batch-dispatch-invalid');
  }
  const core = freeze({
    dispatchVersion: CANDIDATE_EVALUATION_DISPATCH_VERSION,
    dispatchId: digest(value.dispatchId),
    batchId: digest(value.batchId),
    coordinateId: digest(value.coordinateId),
    ordinal: integer(value.ordinal, 0, CANDIDATE_EVALUATION_COORDINATE_COUNT - 1),
    attempt: 1 as const,
    requestDigest: digest(value.requestDigest),
    promptBindingDigest: digest(value.promptBindingDigest),
    validatorPlanDigest: digest(value.validatorPlanDigest),
    slotDigest: digest(value.slotDigest),
    dispatchedAt: timestamp(value.dispatchedAt),
    providerExecution: 'unverified' as const,
    dispatchChronology: 'store-reserved-only' as const,
  });
  const dispatchDigest = digest(value.dispatchDigest);
  if (dispatchDigest !== hash(core)
    || core.dispatchId !== hash(['candidate-evaluation-dispatch-v1', core.coordinateId, 1])) {
    throw new Error('candidate-evaluation-batch-dispatch-invalid');
  }
  return freeze({ ...core, dispatchDigest });
}

function createLiveTerminal(dispatch: CandidateEvaluationDispatchV1, receipt: CandidateEvaluationReceipt,
  recordedAt: string): CandidateEvaluationLiveTerminalV1 {
  const terminalId = hash(['candidate-evaluation-terminal-v1', dispatch.dispatchId]);
  const core = freeze({
    terminalVersion: CANDIDATE_EVALUATION_TERMINAL_VERSION,
    terminalId,
    batchId: dispatch.batchId,
    coordinateId: dispatch.coordinateId,
    ordinal: dispatch.ordinal,
    dispatchDigest: dispatch.dispatchDigest,
    origin: 'live-validator' as const,
    outcome: receipt.outcome,
    reasonCode: receipt.reasonCode,
    responseDigest: receipt.responseDigest,
    candidateReceipt: receipt,
    candidateReceiptDigest: receipt.receiptDigest,
    recordedAt: timestamp(recordedAt),
  });
  return freeze({ ...core, terminalDigest: hash(core) });
}

function createRecoveryTerminal(dispatch: CandidateEvaluationDispatchV1,
  recordedAt: string): CandidateEvaluationRecoveryTerminalV1 {
  const terminalId = hash(['candidate-evaluation-terminal-v1', dispatch.dispatchId]);
  const core = freeze({
    terminalVersion: CANDIDATE_EVALUATION_TERMINAL_VERSION,
    terminalId,
    batchId: dispatch.batchId,
    coordinateId: dispatch.coordinateId,
    ordinal: dispatch.ordinal,
    dispatchDigest: dispatch.dispatchDigest,
    origin: 'restart-recovery' as const,
    outcome: 'inconclusive' as const,
    reasonCode: 'candidate-evaluation-restart-uncertain' as const,
    responseDigest: null,
    candidateReceipt: null,
    candidateReceiptDigest: null,
    recordedAt: timestamp(recordedAt),
  });
  return freeze({ ...core, terminalDigest: hash(core) });
}

function normalizeTerminal(input: unknown): CandidateEvaluationTerminalV1 {
  const value = exactRecord(input, [
    'terminalVersion', 'terminalId', 'batchId', 'coordinateId', 'ordinal', 'dispatchDigest',
    'origin', 'outcome', 'reasonCode', 'responseDigest', 'candidateReceipt',
    'candidateReceiptDigest', 'recordedAt', 'terminalDigest',
  ]);
  if (value.terminalVersion !== CANDIDATE_EVALUATION_TERMINAL_VERSION
    || value.origin !== 'live-validator' && value.origin !== 'restart-recovery') {
    throw new Error('candidate-evaluation-batch-terminal-invalid');
  }
  let receipt: CandidateEvaluationReceipt | null = null;
  if (value.origin === 'live-validator') {
    receipt = normalizeCandidateEvaluationReceipt(value.candidateReceipt);
    if (value.candidateReceiptDigest !== receipt.receiptDigest
      || value.outcome !== receipt.outcome || value.reasonCode !== receipt.reasonCode
      || value.responseDigest !== receipt.responseDigest) {
      throw new Error('candidate-evaluation-batch-terminal-invalid');
    }
  } else if (value.outcome !== 'inconclusive'
    || value.reasonCode !== 'candidate-evaluation-restart-uncertain'
    || value.responseDigest !== null || value.candidateReceipt !== null
    || value.candidateReceiptDigest !== null) {
    throw new Error('candidate-evaluation-batch-terminal-invalid');
  }
  const core = freeze({
    terminalVersion: CANDIDATE_EVALUATION_TERMINAL_VERSION,
    terminalId: digest(value.terminalId),
    batchId: digest(value.batchId),
    coordinateId: digest(value.coordinateId),
    ordinal: integer(value.ordinal, 0, CANDIDATE_EVALUATION_COORDINATE_COUNT - 1),
    dispatchDigest: digest(value.dispatchDigest),
    origin: value.origin,
    outcome: value.outcome as CandidateEvaluationOutcome,
    reasonCode: value.reasonCode as CandidateEvaluationTerminalReason,
    responseDigest: value.responseDigest as string | null,
    candidateReceipt: receipt,
    candidateReceiptDigest: receipt?.receiptDigest ?? null,
    recordedAt: timestamp(value.recordedAt),
  });
  const terminalDigest = digest(value.terminalDigest);
  if (terminalDigest !== hash(core)
    || core.terminalId !== hash(['candidate-evaluation-terminal-v1',
      hash(['candidate-evaluation-dispatch-v1', core.coordinateId, 1])])) {
    throw new Error('candidate-evaluation-batch-terminal-invalid');
  }
  return freeze({ ...core, terminalDigest }) as CandidateEvaluationTerminalV1;
}

function protocolOutcome(counts: Readonly<Record<CandidateEvaluationOutcome, number>>):
CandidateEvaluationOutcome {
  if (counts.invalid > 0) return 'invalid';
  if (counts.inconclusive > 0) return 'inconclusive';
  if (counts.failed > 0) return 'failed';
  return 'passed';
}

function createAggregate(source: CandidateEvaluationBatchSourceV1, batchId: string,
  coordinates: readonly CandidateEvaluationCoordinateV1[],
  terminals: readonly CandidateEvaluationTerminalV1[], completedAt: string): CandidateEvaluationAggregateV1 {
  if (terminals.length !== CANDIDATE_EVALUATION_COORDINATE_COUNT) {
    throw new Error('candidate-evaluation-batch-incomplete');
  }
  const outcomeCounts = freeze({
    passed: terminals.filter((item) => item.outcome === 'passed').length,
    failed: terminals.filter((item) => item.outcome === 'failed').length,
    inconclusive: terminals.filter((item) => item.outcome === 'inconclusive').length,
    invalid: terminals.filter((item) => item.outcome === 'invalid').length,
  });
  const aggregateId = hash(['candidate-evaluation-aggregate-v1', batchId]);
  const core = freeze({
    aggregateVersion: CANDIDATE_EVALUATION_AGGREGATE_VERSION,
    aggregateId,
    batchId,
    candidateId: source.candidateId,
    candidateRevision: 1 as const,
    candidateBindingDigest: source.candidateBindingDigest,
    sourceAuthorityRevision: source.sourceAuthorityRevision,
    compiledArtifactDigest: source.compiledArtifactDigest,
    sampleSuiteDigest: source.sampleSuiteDigest,
    validatorPolicyDigest: source.validatorPolicyDigest,
    validatorPlanDigest: source.validatorPlanDigest,
    expectedCoordinateCount: 48 as const,
    terminalCount: 48 as const,
    orderedCoordinateSetDigest: hash({
      setVersion: 'candidate-evaluation-ordered-coordinate-set-v1',
      values: coordinates.map((item) => ({ ordinal: item.ordinal, digest: item.coordinateDigest })),
    }),
    orderedReceiptSetDigest: hash({
      setVersion: 'candidate-evaluation-ordered-receipt-set-v1',
      values: terminals.map((item) => ({
        ordinal: item.ordinal,
        terminalDigest: item.terminalDigest,
        candidateReceiptDigest: item.candidateReceiptDigest,
      })),
    }),
    outcomeCounts,
    protocolOutcome: protocolOutcome(outcomeCounts),
    providerExecution: 'unverified' as const,
    dispatchChronology: 'store-reserved-only' as const,
    qualityVerdict: 'not-declared' as const,
    promotionEligible: false as const,
    completedAt: timestamp(completedAt),
  });
  return freeze({ ...core, aggregateDigest: hash(core) });
}

function normalizeAggregate(input: unknown): CandidateEvaluationAggregateV1 {
  const value = exactRecord(input, [
    'aggregateVersion', 'aggregateId', 'batchId', 'candidateId', 'candidateRevision',
    'candidateBindingDigest', 'sourceAuthorityRevision', 'compiledArtifactDigest',
    'sampleSuiteDigest', 'validatorPolicyDigest', 'validatorPlanDigest', 'expectedCoordinateCount',
    'terminalCount', 'orderedCoordinateSetDigest', 'orderedReceiptSetDigest',
    'outcomeCounts', 'protocolOutcome', 'providerExecution',
    'dispatchChronology', 'qualityVerdict', 'promotionEligible', 'completedAt', 'aggregateDigest',
  ]);
  const countsValue = exactRecord(value.outcomeCounts, ['passed', 'failed', 'inconclusive', 'invalid']);
  const outcomeCounts = freeze({
    passed: integer(countsValue.passed, 0, CANDIDATE_EVALUATION_COORDINATE_COUNT),
    failed: integer(countsValue.failed, 0, CANDIDATE_EVALUATION_COORDINATE_COUNT),
    inconclusive: integer(countsValue.inconclusive, 0, CANDIDATE_EVALUATION_COORDINATE_COUNT),
    invalid: integer(countsValue.invalid, 0, CANDIDATE_EVALUATION_COORDINATE_COUNT),
  });
  if (value.aggregateVersion !== CANDIDATE_EVALUATION_AGGREGATE_VERSION
    || value.candidateRevision !== 1
    || value.expectedCoordinateCount !== CANDIDATE_EVALUATION_COORDINATE_COUNT
    || value.terminalCount !== CANDIDATE_EVALUATION_COORDINATE_COUNT
    || Object.values(outcomeCounts).reduce((sum, count) => sum + count, 0)
      !== CANDIDATE_EVALUATION_COORDINATE_COUNT
    || value.protocolOutcome !== protocolOutcome(outcomeCounts)
    || value.providerExecution !== 'unverified'
    || value.dispatchChronology !== 'store-reserved-only'
    || value.qualityVerdict !== 'not-declared' || value.promotionEligible !== false) {
    throw new Error('candidate-evaluation-batch-aggregate-invalid');
  }
  const core = freeze({
    aggregateVersion: CANDIDATE_EVALUATION_AGGREGATE_VERSION,
    aggregateId: digest(value.aggregateId),
    batchId: digest(value.batchId),
    candidateId: digest(value.candidateId),
    candidateRevision: 1 as const,
    candidateBindingDigest: digest(value.candidateBindingDigest),
    sourceAuthorityRevision: digest(value.sourceAuthorityRevision),
    compiledArtifactDigest: digest(value.compiledArtifactDigest),
    sampleSuiteDigest: digest(value.sampleSuiteDigest),
    validatorPolicyDigest: digest(value.validatorPolicyDigest),
    validatorPlanDigest: digest(value.validatorPlanDigest),
    expectedCoordinateCount: 48 as const,
    terminalCount: 48 as const,
    orderedCoordinateSetDigest: digest(value.orderedCoordinateSetDigest),
    orderedReceiptSetDigest: digest(value.orderedReceiptSetDigest),
    outcomeCounts,
    protocolOutcome: value.protocolOutcome as CandidateEvaluationOutcome,
    providerExecution: 'unverified' as const,
    dispatchChronology: 'store-reserved-only' as const,
    qualityVerdict: 'not-declared' as const,
    promotionEligible: false as const,
    completedAt: timestamp(value.completedAt),
  });
  const aggregateDigest = digest(value.aggregateDigest);
  if (aggregateDigest !== hash(core)
    || core.aggregateId !== hash(['candidate-evaluation-aggregate-v1', core.batchId])) {
    throw new Error('candidate-evaluation-batch-aggregate-invalid');
  }
  return freeze({ ...core, aggregateDigest });
}

function secureFile(path: string): void {
  const entry = stat(path);
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('candidate-evaluation-batch-file-invalid');
  }
}

interface ClaimOwner {
  readonly authority: CandidateEvaluationValidatorAuthority;
  readonly batchId: string;
  readonly coordinateId: string;
  readonly dispatchDigest: string;
}

interface AggregateProofOwner {
  readonly batchId: string;
  readonly aggregateDigest: string;
}

export class CandidateEvaluationBatchStore {
  readonly filePath: string;
  #db: DatabaseSync;
  #now: () => string;
  #isSessionDeleted: (rawSessionId: string) => boolean;
  #sourceCurrent: (source: CandidateEvaluationBatchSourceCurrentInput) => boolean;
  #claims = new WeakMap<object, ClaimOwner>();
  #aggregateProofs = new WeakMap<object, AggregateProofOwner>();
  #closed = false;

  constructor(options: {
    readonly dataDir: string;
    readonly now?: () => string;
    readonly isSessionDeleted?: (rawSessionId: string) => boolean;
    readonly sourceCurrent: (source: CandidateEvaluationBatchSourceCurrentInput) => boolean;
  }) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || typeof options.dataDir !== 'string' || options.dataDir.trim().length === 0
      || typeof options.sourceCurrent !== 'function'
      || options.now !== undefined && typeof options.now !== 'function'
      || options.isSessionDeleted !== undefined && typeof options.isSessionDeleted !== 'function') {
      throw new Error('candidate-evaluation-batch-options-invalid');
    }
    const dataDir = resolve(options.dataDir);
    secureDirectory(dataDir);
    this.filePath = join(dataDir, CANDIDATE_EVALUATION_BATCH_DB_FILE);
    for (const suffix of ['', '-wal', '-shm', '-journal']) secureFile(`${this.filePath}${suffix}`);
    this.#db = new DatabaseSync(this.filePath);
    try {
      this.#db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON');
      initialize(this.#db);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      if (process.platform !== 'win32') chmodSync(this.filePath, 0o600);
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#isSessionDeleted = options.isSessionDeleted ?? (() => false);
    this.#sourceCurrent = options.sourceCurrent;
  }

  #open(): void {
    if (this.#closed) throw new Error('candidate-evaluation-batch-store-closed');
  }

  #transaction<T>(work: () => T, write = true): T {
    this.#open();
    if (this.#db.isTransaction) throw new Error('candidate-evaluation-batch-nested-transaction');
    this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = work();
      if (!this.#db.isTransaction) throw new Error('candidate-evaluation-batch-transaction-lost');
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #deleted(rawSessionId: string): boolean {
    if (this.#db.prepare(`SELECT 1 FROM candidate_evaluation_session_tombstone
      WHERE session_key=?`).get(rawSessionId)) return true;
    try { return this.#isSessionDeleted(rawSessionId) === true; }
    catch { throw new Error('candidate-evaluation-batch-source-status-unavailable'); }
  }

  #sourceAlive(source: CandidateEvaluationBatchSourceV1): boolean {
    try {
      if (source.compileJobId === null || source.sampleSuiteId === null) return false;
      if (this.#deleted(source.rawSessionId)) return false;
      return this.#sourceCurrent(source) === true;
    }
    catch { return false; }
  }

  /** Must run in a write transaction. Once false (or hook throws), currentness can never revive. */
  #latchCurrent(batchId: string, source: CandidateEvaluationBatchSourceV1): boolean {
    if (this.#db.prepare(`SELECT 1 FROM candidate_evaluation_batch_revocation
      WHERE batch_id=?`).get(batchId)) return false;
    if (this.#sourceAlive(source)) return true;
    this.#db.prepare(`INSERT OR IGNORE INTO candidate_evaluation_batch_revocation
      (batch_id,session_key,revoked_at,reason_code) VALUES(?,?,?,?)`).run(
      batchId, source.rawSessionId, timestamp(this.#now()), 'candidate-evaluation-source-invalidated',
    );
    return false;
  }

  #batchRow(batchId: string): SqlRow | null {
    return (this.#db.prepare('SELECT * FROM candidate_evaluation_batch WHERE batch_id=?')
      .get(batchId) as SqlRow | undefined) ?? null;
  }

  #batchAndSource(batchId: string): {
    batch: CandidateEvaluationBatchV1;
    source: CandidateEvaluationBatchSourceV1;
  } | null {
    const row = this.#batchRow(batchId);
    if (!row) return null;
    const rawSource = parseJson(row.source_json);
    const source = normalizeSource(rawSource, true);
    const batch = normalizeBatch({
      batchVersion: CANDIDATE_EVALUATION_BATCH_VERSION,
      batchId: row.batch_id,
      sourceDigest: row.source_digest,
      createdAt: row.created_at,
    });
    if (row.session_key !== source.rawSessionId
      || row.candidate_binding_digest !== source.candidateBindingDigest
      || row.sample_suite_digest !== source.sampleSuiteDigest
      || row.validator_policy_digest !== source.validatorPolicyDigest
      || batch.batchId !== candidateEvaluationBatchId(source)
      || batch.sourceDigest !== hash(rawSource)) {
      throw new Error('candidate-evaluation-batch-storage-invalid');
    }
    return freeze({ batch, source });
  }

  #coordinates(batch: CandidateEvaluationBatchV1,
    source: CandidateEvaluationBatchSourceV1): readonly CandidateEvaluationCoordinateV1[] {
    const rows = this.#db.prepare(`SELECT * FROM candidate_evaluation_coordinate
      WHERE batch_id=? ORDER BY ordinal`).all(batch.batchId) as SqlRow[];
    const coordinates = rows.map((row) => {
      const value = normalizeCoordinate(parseJson(row.coordinate_json));
      if (row.coordinate_id !== value.coordinateId || row.batch_id !== value.batchId
        || row.ordinal !== value.ordinal || row.coordinate_digest !== value.coordinateDigest
        || row.session_key !== source.rawSessionId) {
        throw new Error('candidate-evaluation-batch-storage-invalid');
      }
      return value;
    });
    const expected = deriveCoordinates(batch, source);
    if (canonical(coordinates) !== canonical(expected)) {
      throw new Error('candidate-evaluation-batch-coordinate-set-invalid');
    }
    return freeze(coordinates);
  }

  #dispatches(batch: CandidateEvaluationBatchV1, source: CandidateEvaluationBatchSourceV1,
    coordinates: readonly CandidateEvaluationCoordinateV1[]): readonly CandidateEvaluationDispatchV1[] {
    const coordinateById = new Map(coordinates.map((item) => [item.coordinateId, item]));
    const rows = this.#db.prepare(`SELECT * FROM candidate_evaluation_dispatch
      WHERE batch_id=? ORDER BY ordinal`).all(batch.batchId) as SqlRow[];
    return freeze(rows.map((row) => {
      const value = normalizeDispatch(parseJson(row.dispatch_json));
      const coordinate = coordinateById.get(value.coordinateId);
      if (!coordinate || row.dispatch_id !== value.dispatchId || row.batch_id !== value.batchId
        || row.coordinate_id !== value.coordinateId || row.ordinal !== value.ordinal
        || row.dispatch_digest !== value.dispatchDigest || row.dispatched_at !== value.dispatchedAt
        || row.session_key !== source.rawSessionId || value.ordinal !== coordinate.ordinal
        || value.validatorPlanDigest !== source.validatorPlanDigest) {
        throw new Error('candidate-evaluation-batch-storage-invalid');
      }
      return value;
    }));
  }

  #terminals(batch: CandidateEvaluationBatchV1, source: CandidateEvaluationBatchSourceV1,
    coordinates: readonly CandidateEvaluationCoordinateV1[],
    dispatches: readonly CandidateEvaluationDispatchV1[]): readonly CandidateEvaluationTerminalV1[] {
    const coordinateById = new Map(coordinates.map((item) => [item.coordinateId, item]));
    const dispatchByCoordinate = new Map(dispatches.map((item) => [item.coordinateId, item]));
    const rows = this.#db.prepare(`SELECT * FROM candidate_evaluation_terminal
      WHERE batch_id=? ORDER BY ordinal`).all(batch.batchId) as SqlRow[];
    return freeze(rows.map((row) => {
      const value = normalizeTerminal(parseJson(row.terminal_json));
      const dispatch = dispatchByCoordinate.get(value.coordinateId);
      if (!dispatch || row.terminal_id !== value.terminalId || row.batch_id !== value.batchId
        || row.coordinate_id !== value.coordinateId || row.dispatch_id !== dispatch.dispatchId
        || row.ordinal !== value.ordinal || row.origin !== value.origin || row.outcome !== value.outcome
        || row.terminal_digest !== value.terminalDigest || row.recorded_at !== value.recordedAt
        || row.session_key !== source.rawSessionId || value.dispatchDigest !== dispatch.dispatchDigest) {
        throw new Error('candidate-evaluation-batch-storage-invalid');
      }
      const coordinate = coordinateById.get(value.coordinateId);
      if (!coordinate) throw new Error('candidate-evaluation-batch-storage-invalid');
      if (value.origin === 'live-validator') {
        this.#assertReceiptBinding(value.candidateReceipt, source, coordinate, dispatch);
      }
      return value;
    }));
  }

  #aggregate(batch: CandidateEvaluationBatchV1, source: CandidateEvaluationBatchSourceV1,
    coordinates: readonly CandidateEvaluationCoordinateV1[],
    terminals: readonly CandidateEvaluationTerminalV1[]): CandidateEvaluationAggregateV1 | null {
    const row = this.#db.prepare('SELECT * FROM candidate_evaluation_aggregate WHERE batch_id=?')
      .get(batch.batchId) as SqlRow | undefined;
    if (!row) return null;
    const aggregate = normalizeAggregate(parseJson(row.aggregate_json));
    if (row.aggregate_id !== aggregate.aggregateId || row.batch_id !== aggregate.batchId
      || row.aggregate_digest !== aggregate.aggregateDigest || row.completed_at !== aggregate.completedAt
      || row.session_key !== source.rawSessionId
      || aggregate.candidateBindingDigest !== source.candidateBindingDigest
      || aggregate.sampleSuiteDigest !== source.sampleSuiteDigest
      || terminals.length !== CANDIDATE_EVALUATION_COORDINATE_COUNT) {
      throw new Error('candidate-evaluation-batch-storage-invalid');
    }
    const expected = createAggregate(source, batch.batchId, coordinates, terminals, aggregate.completedAt);
    if (canonical(aggregate) !== canonical(expected)) {
      throw new Error('candidate-evaluation-batch-aggregate-evidence-invalid');
    }
    return aggregate;
  }

  #readStored(batchId: string, checkCurrent: boolean): CandidateEvaluationStoredBatch | null {
    const retained = this.#batchAndSource(batchId);
    if (!retained) return null;
    const coordinates = this.#coordinates(retained.batch, retained.source);
    const dispatches = this.#dispatches(retained.batch, retained.source, coordinates);
    const terminals = this.#terminals(retained.batch, retained.source, coordinates, dispatches);
    const aggregate = this.#aggregate(retained.batch, retained.source, coordinates, terminals);
    const sourceCurrent = checkCurrent
      ? this.#latchCurrent(retained.batch.batchId, retained.source)
      : !this.#db.prepare(`SELECT 1 FROM candidate_evaluation_batch_revocation
        WHERE batch_id=?`).get(retained.batch.batchId);
    const state: CandidateEvaluationBatchState = !sourceCurrent ? 'revoked'
      : aggregate ? 'complete'
      : dispatches.length > terminals.length ? 'running'
      : dispatches.length > 0 ? 'ready'
      : 'frozen';
    return freeze({ ...retained, coordinates, dispatches, terminals, aggregate, state, sourceCurrent });
  }

  createBatch(input: CandidateEvaluationBatchCreateInput,
    rootIdempotencyKey: string): CandidateEvaluationStoredBatch {
    token(rootIdempotencyKey);
    const source = normalizeSource(input);
    const batchId = candidateEvaluationBatchId(source);
    const createdAt = timestamp(this.#now());
    return this.#transaction(() => {
      const existing = this.#readStored(batchId, true);
      if (existing) {
        if (existing.batch.sourceDigest !== hash(source)
          || canonical(existing.source) !== canonical(source)) {
          throw new Error('candidate-evaluation-batch-idempotency-conflict');
        }
        return existing;
      }
      if (!this.#sourceAlive(source)) throw new Error('candidate-evaluation-batch-source-invalidated');
      const batch = createBatchRecord(source, createdAt);
      this.#db.prepare(`INSERT INTO candidate_evaluation_batch
        (batch_id,session_key,candidate_binding_digest,sample_suite_digest,
          validator_policy_digest,source_json,source_digest,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(
        batch.batchId, source.rawSessionId, source.candidateBindingDigest, source.sampleSuiteDigest,
        source.validatorPolicyDigest, json(source, MAX_SOURCE_CHARS), batch.sourceDigest, batch.createdAt,
      );
      for (const coordinate of deriveCoordinates(batch, source)) {
        this.#db.prepare(`INSERT INTO candidate_evaluation_coordinate
          (coordinate_id,batch_id,session_key,ordinal,coordinate_json,coordinate_digest)
          VALUES(?,?,?,?,?,?)`).run(
          coordinate.coordinateId, batch.batchId, source.rawSessionId, coordinate.ordinal,
          json(coordinate), coordinate.coordinateDigest,
        );
      }
      const stored = this.#readStored(batch.batchId, false);
      if (!stored) throw new Error('candidate-evaluation-batch-persistence-unconfirmed');
      return stored;
    });
  }

  readBatch(batchId: string): CandidateEvaluationStoredBatch | null {
    digest(batchId);
    return this.#transaction(() => this.#readStored(batchId, true));
  }

  /** Readback for operator evidence: check currentness without recording a permanent revocation. */
  readCurrentBatchWithoutRevocation(batchId: string): CandidateEvaluationStoredBatch | null {
    digest(batchId);
    return this.#transaction(() => {
      const stored = this.#readStored(batchId, false);
      return stored && stored.sourceCurrent && this.#sourceAlive(stored.source) ? stored : null;
    }, false);
  }

  /** One stable batch page, with no permanent revocation written by discovery. */
  listCompletedForCandidate(candidateId: string, cursor = ''): Readonly<{
    batches: readonly Readonly<{ batchId: string; sampleSuiteId: string }>[];
    hasMore: boolean; nextCursor: string | null; unavailable: boolean;
  }> {
    digest(candidateId);
    if (cursor) digest(cursor);
    return this.#transaction(() => {
      const rows = this.#db.prepare(`SELECT b.batch_id FROM candidate_evaluation_batch b
        WHERE json_extract(b.source_json, '$.candidateId')=? AND b.batch_id>?
          AND EXISTS(SELECT 1 FROM candidate_evaluation_aggregate a WHERE a.batch_id=b.batch_id)
          AND NOT EXISTS(SELECT 1 FROM candidate_evaluation_batch_revocation r WHERE r.batch_id=b.batch_id)
        ORDER BY b.batch_id LIMIT 2`).all(candidateId, cursor) as SqlRow[];
      const batches: Array<Readonly<{ batchId: string; sampleSuiteId: string }>> = [];
      let unavailable = false;
      for (const row of rows.slice(0, 1)) {
        const stored = currentCompleteCandidateEvaluationBatch(this.#readStored(digest(row.batch_id), false));
        if (!stored || !this.#sourceAlive(stored.source)) { unavailable = true; continue; }
        if (stored.source.candidateId !== candidateId || !stored.source.sampleSuiteId) {
          throw new Error('candidate-evaluation-batch-storage-invalid');
        }
        batches.push(Object.freeze({ batchId: stored.batch.batchId, sampleSuiteId: stored.source.sampleSuiteId }));
      }
      return Object.freeze({ batches: Object.freeze(batches), hasMore: rows.length > 1,
        nextCursor: rows.length ? digest(rows[0]!.batch_id) : null, unavailable });
    }, false);
  }

  claimNext(input: CandidateEvaluationClaimNextInput): CandidateEvaluationBatchClaim | null {
    const value = exactRecord(input, [
      'batchId', 'authority', 'validatorPlan', 'expectedCoordinate', 'requestDigest',
      'promptBindingDigest',
    ]);
    const batchId = digest(value.batchId);
    const requestDigest = digest(value.requestDigest);
    const promptBindingDigest = digest(value.promptBindingDigest);
    const expectedValue = exactRecord(value.expectedCoordinate, [
      'scenarioOrdinal', 'repeatIndex', 'arm', 'planDigest', 'sampleKey',
    ]);
    const expectedCoordinate = freeze({
      scenarioOrdinal: integer(expectedValue.scenarioOrdinal, 0, SKILL_SAMPLE_SUITE_SCENARIO_COUNT - 1),
      repeatIndex: integer(expectedValue.repeatIndex, 0, SKILL_SAMPLE_SUITE_REPEAT_COUNT - 1),
      arm: expectedValue.arm as CandidateEvaluationArm,
      planDigest: digest(expectedValue.planDigest),
      sampleKey: token(expectedValue.sampleKey),
    });
    if (expectedCoordinate.arm !== 'baseline' && expectedCoordinate.arm !== 'candidate') {
      throw new Error('candidate-evaluation-batch-coordinate-mismatch');
    }
    if (!isCandidateEvaluationValidatorAuthority(value.authority)) {
      throw new Error('candidate-evaluation-batch-validator-authority-invalid');
    }
    if (!Array.isArray(value.validatorPlan) || nodeTypes.isProxy(value.validatorPlan)) {
      throw new Error('candidate-evaluation-batch-validator-plan-invalid');
    }
    const authority = value.authority;
    const validatorPlan = value.validatorPlan as readonly AgentSkillValidatorPlanEntryV1[];
    const reserved = this.#transaction(() => {
      const retained = this.#batchAndSource(batchId);
      if (!retained) return null;
      if (!this.#latchCurrent(batchId, retained.source)) {
        return SOURCE_INVALIDATED;
      }
      if (this.#db.prepare('SELECT 1 FROM candidate_evaluation_aggregate WHERE batch_id=?')
        .get(batchId)) return null;
      if (this.#db.prepare(`SELECT 1 FROM candidate_evaluation_dispatch d
        LEFT JOIN candidate_evaluation_terminal t ON t.dispatch_id=d.dispatch_id
        WHERE d.batch_id=? AND t.dispatch_id IS NULL`).get(batchId)) return null;
      const row = this.#db.prepare(`SELECT c.coordinate_json FROM candidate_evaluation_coordinate c
        WHERE c.batch_id=? AND NOT EXISTS(
          SELECT 1 FROM candidate_evaluation_dispatch d WHERE d.coordinate_id=c.coordinate_id)
        ORDER BY c.ordinal LIMIT 1`).get(batchId) as SqlRow | undefined;
      if (!row) return null;
      const coordinate = normalizeCoordinate(parseJson(row.coordinate_json));
      if (coordinate.scenarioOrdinal !== expectedCoordinate.scenarioOrdinal
        || coordinate.repeatIndex !== expectedCoordinate.repeatIndex
        || coordinate.arm !== expectedCoordinate.arm
        || coordinate.planDigest !== expectedCoordinate.planDigest
        || coordinate.sampleKey !== expectedCoordinate.sampleKey) {
        throw new Error('candidate-evaluation-batch-coordinate-mismatch');
      }
      const ticket = authority.issueSlot({
        planDigest: coordinate.planDigest,
        sampleKey: coordinate.sampleKey,
        arm: coordinate.arm,
        attemptId: coordinate.attemptId,
        candidateId: retained.source.candidateId,
        candidateRevision: retained.source.candidateRevision,
        candidateBindingDigest: retained.source.candidateBindingDigest,
        sourceAuthorityRevision: retained.source.sourceAuthorityRevision,
        compiledArtifactDigest: retained.source.compiledArtifactDigest,
        validatorPlanDigest: retained.source.validatorPlanDigest,
        requestDigest,
        promptBindingDigest,
        validatorPlan,
      });
      const dispatch = createDispatch({
        batchId, coordinate, requestDigest, promptBindingDigest,
        validatorPlanDigest: retained.source.validatorPlanDigest,
        slotDigest: ticket.slotDigest,
        dispatchedAt: timestamp(this.#now()),
      });
      this.#db.prepare(`INSERT INTO candidate_evaluation_dispatch
        (dispatch_id,batch_id,coordinate_id,session_key,ordinal,dispatch_json,
          dispatch_digest,dispatched_at) VALUES(?,?,?,?,?,?,?,?)`).run(
        dispatch.dispatchId, batchId, coordinate.coordinateId, retained.source.rawSessionId,
        coordinate.ordinal, json(dispatch), dispatch.dispatchDigest, dispatch.dispatchedAt,
      );
      return freeze({ coordinate, dispatch, ticket });
    });
    if (reserved === SOURCE_INVALIDATED) {
      throw new Error('candidate-evaluation-batch-source-invalidated');
    }
    if (!reserved) return null;
    const claim = freeze({
      batchId,
      coordinate: reserved.coordinate,
      dispatch: reserved.dispatch,
      ticket: reserved.ticket,
    }) as CandidateEvaluationBatchClaim;
    this.#claims.set(claim, freeze({
      authority,
      batchId,
      coordinateId: claim.coordinate.coordinateId,
      dispatchDigest: claim.dispatch.dispatchDigest,
    }));
    return claim;
  }

  #dispatchForClaim(claim: CandidateEvaluationBatchClaim, owner: ClaimOwner):
  CandidateEvaluationDispatchV1 | null {
    const row = this.#db.prepare('SELECT dispatch_json FROM candidate_evaluation_dispatch WHERE dispatch_id=?')
      .get(claim.dispatch.dispatchId) as SqlRow | undefined;
    if (!row) return null;
    const dispatch = normalizeDispatch(parseJson(row.dispatch_json));
    if (owner.batchId !== claim.batchId || owner.coordinateId !== claim.coordinate.coordinateId
      || owner.dispatchDigest !== claim.dispatch.dispatchDigest
      || canonical(dispatch) !== canonical(claim.dispatch)) return null;
    return dispatch;
  }

  ownsClaim(claim: CandidateEvaluationBatchClaim): boolean {
    if (!claim || typeof claim !== 'object') return false;
    const owner = this.#claims.get(claim);
    if (!owner) return false;
    try {
      return this.#transaction(() => {
        const dispatch = this.#dispatchForClaim(claim, owner);
        if (!dispatch || this.#db.prepare(
          'SELECT 1 FROM candidate_evaluation_terminal WHERE dispatch_id=?',
        ).get(dispatch.dispatchId)) return false;
        const retained = this.#batchAndSource(owner.batchId);
        return Boolean(retained && this.#latchCurrent(owner.batchId, retained.source));
      });
    } catch { return false; }
  }

  #assertReceiptBinding(receipt: CandidateEvaluationReceipt,
    source: CandidateEvaluationBatchSourceV1, coordinate: CandidateEvaluationCoordinateV1,
    dispatch: CandidateEvaluationDispatchV1): void {
    if (receipt.planDigest !== coordinate.planDigest || receipt.sampleKey !== coordinate.sampleKey
      || receipt.arm !== coordinate.arm || receipt.attemptId !== coordinate.attemptId
      || receipt.candidateId !== source.candidateId
      || receipt.candidateRevision !== source.candidateRevision
      || receipt.candidateBindingDigest !== source.candidateBindingDigest
      || receipt.sourceAuthorityRevision !== source.sourceAuthorityRevision
      || receipt.compiledArtifactDigest !== source.compiledArtifactDigest
      || receipt.validatorPlanDigest !== source.validatorPlanDigest
      || receipt.validatorPolicyDigest !== source.validatorPolicyDigest
      || receipt.requestDigest !== dispatch.requestDigest
      || receipt.promptBindingDigest !== dispatch.promptBindingDigest
      || receipt.slotDigest !== dispatch.slotDigest
      || Date.parse(receipt.occurredAt) < Date.parse(dispatch.dispatchedAt)) {
      throw new Error('candidate-evaluation-batch-proof-binding-mismatch');
    }
  }

  #maybeAggregate(batchId: string, completedAt: string): CandidateEvaluationAggregateV1 | null {
    const existing = this.#db.prepare('SELECT aggregate_json FROM candidate_evaluation_aggregate WHERE batch_id=?')
      .get(batchId) as SqlRow | undefined;
    if (existing) return normalizeAggregate(parseJson(existing.aggregate_json));
    const stored = this.#readStored(batchId, false);
    if (!stored || stored.terminals.length !== CANDIDATE_EVALUATION_COORDINATE_COUNT) return null;
    const aggregate = createAggregate(
      stored.source, batchId, stored.coordinates, stored.terminals, completedAt,
    );
    this.#db.prepare(`INSERT INTO candidate_evaluation_aggregate
      (aggregate_id,batch_id,session_key,aggregate_json,aggregate_digest,completed_at)
      VALUES(?,?,?,?,?,?)`).run(
      aggregate.aggregateId, batchId, stored.source.rawSessionId, json(aggregate),
      aggregate.aggregateDigest, aggregate.completedAt,
    );
    return aggregate;
  }

  finish(claim: CandidateEvaluationBatchClaim,
    proof: CandidateEvaluationProof): CandidateEvaluationLiveTerminalV1 {
    if (!claim || typeof claim !== 'object') {
      throw new Error('candidate-evaluation-batch-claim-not-owned');
    }
    const owner = this.#claims.get(claim);
    if (!owner) throw new Error('candidate-evaluation-batch-claim-not-owned');
    const currentReceipt = owner.authority.readCurrentForTicket(claim.ticket, proof);
    if (!currentReceipt) throw new Error('candidate-evaluation-batch-proof-not-current');
    const receipt = normalizeCandidateEvaluationReceipt(currentReceipt);
    const recordedAt = timestamp(this.#now());
    const terminal = this.#transaction(() => {
      const retained = this.#batchAndSource(owner.batchId);
      if (!retained) throw new Error('candidate-evaluation-batch-missing');
      const dispatch = this.#dispatchForClaim(claim, owner);
      if (!dispatch) throw new Error('candidate-evaluation-batch-claim-not-owned');
      this.#assertReceiptBinding(receipt, retained.source, claim.coordinate, dispatch);
      if (!this.#latchCurrent(owner.batchId, retained.source)) {
        return SOURCE_INVALIDATED;
      }
      const priorRow = this.#db.prepare(
        'SELECT terminal_json FROM candidate_evaluation_terminal WHERE dispatch_id=?',
      ).get(dispatch.dispatchId) as SqlRow | undefined;
      if (priorRow) {
        const prior = normalizeTerminal(parseJson(priorRow.terminal_json));
        if (prior.origin === 'live-validator'
          && prior.candidateReceiptDigest === receipt.receiptDigest) return prior;
        throw new Error('candidate-evaluation-batch-terminal-conflict');
      }
      const terminal = createLiveTerminal(dispatch, receipt, recordedAt);
      this.#db.prepare(`INSERT INTO candidate_evaluation_terminal
        (terminal_id,batch_id,coordinate_id,dispatch_id,session_key,ordinal,origin,outcome,
          terminal_json,terminal_digest,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        terminal.terminalId, terminal.batchId, terminal.coordinateId, dispatch.dispatchId,
        retained.source.rawSessionId, terminal.ordinal, terminal.origin, terminal.outcome,
        json(terminal), terminal.terminalDigest, terminal.recordedAt,
      );
      this.#maybeAggregate(owner.batchId, terminal.recordedAt);
      return terminal;
    });
    if (terminal === SOURCE_INVALIDATED) {
      throw new Error('candidate-evaluation-batch-source-invalidated');
    }
    return terminal;
  }

  /** Startup-only repair: every committed dispatch without a terminal becomes data-only uncertain. */
  recoverUncertain(limit = 1_000): readonly CandidateEvaluationRecoveryTerminalV1[] {
    integer(limit, 1, 100_000);
    return this.#transaction(() => {
      const rows = this.#db.prepare(`SELECT d.dispatch_json
        FROM candidate_evaluation_dispatch d
        LEFT JOIN candidate_evaluation_terminal t ON t.dispatch_id=d.dispatch_id
        WHERE t.dispatch_id IS NULL ORDER BY d.rowid LIMIT ?`).all(limit) as SqlRow[];
      const recovered: CandidateEvaluationRecoveryTerminalV1[] = [];
      for (const row of rows) {
        const dispatch = normalizeDispatch(parseJson(row.dispatch_json));
        const retained = this.#batchAndSource(dispatch.batchId);
        if (!retained) throw new Error('candidate-evaluation-batch-storage-invalid');
        const terminal = createRecoveryTerminal(dispatch, timestamp(this.#now()));
        this.#db.prepare(`INSERT INTO candidate_evaluation_terminal
          (terminal_id,batch_id,coordinate_id,dispatch_id,session_key,ordinal,origin,outcome,
            terminal_json,terminal_digest,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          terminal.terminalId, terminal.batchId, terminal.coordinateId, dispatch.dispatchId,
          retained.source.rawSessionId, terminal.ordinal, terminal.origin, terminal.outcome,
          json(terminal), terminal.terminalDigest, terminal.recordedAt,
        );
        recovered.push(terminal);
        this.#maybeAggregate(dispatch.batchId, terminal.recordedAt);
      }
      return freeze(recovered);
    });
  }

  readAggregate(batchId: string): CandidateEvaluationAggregateRead | null {
    digest(batchId);
    return this.#transaction(() => {
      const stored = this.#readStored(batchId, true);
      if (!stored?.aggregate) return null;
      return freeze({ aggregate: stored.aggregate, sourceCurrent: stored.sourceCurrent });
    });
  }

  issueCurrentAggregateProof(batchId: string): CandidateEvaluationAggregateProof | null {
    digest(batchId);
    const aggregate = this.#transaction(() => {
      const stored = this.#readStored(batchId, true);
      return stored?.sourceCurrent ? stored.aggregate : null;
    });
    if (!aggregate) return null;
    const proof = freeze({
      proofVersion: CANDIDATE_EVALUATION_AGGREGATE_PROOF_VERSION,
      batchId,
      aggregateDigest: aggregate.aggregateDigest,
    }) as CandidateEvaluationAggregateProof;
    this.#aggregateProofs.set(proof, freeze({ batchId, aggregateDigest: aggregate.aggregateDigest }));
    return proof;
  }

  readCurrentAggregate(proof: CandidateEvaluationAggregateProof): CandidateEvaluationAggregateV1 | null {
    if (!proof || typeof proof !== 'object') return null;
    const owner = this.#aggregateProofs.get(proof);
    if (!owner) return null;
    try {
      return this.#transaction(() => {
        const stored = this.#readStored(owner.batchId, true);
        const aggregate = stored?.sourceCurrent ? stored.aggregate : null;
        if (!aggregate) return null;
        return aggregate.aggregateDigest === owner.aggregateDigest ? aggregate : null;
      });
    } catch { return null; }
  }

  redactSession(rawSessionId: string): number {
    const sessionKey = session(rawSessionId);
    const redactedAt = timestamp(this.#now());
    return this.#transaction(() => {
      this.#db.prepare(`INSERT OR IGNORE INTO candidate_evaluation_session_tombstone
        (session_key,redacted_at) VALUES(?,?)`).run(sessionKey, redactedAt);
      const row = this.#db.prepare(
        'SELECT COUNT(*) AS count FROM candidate_evaluation_batch WHERE session_key=?',
      ).get(sessionKey) as SqlRow;
      const count = integer(row.count, 0, Number.MAX_SAFE_INTEGER);
      this.#db.prepare('DELETE FROM candidate_evaluation_batch WHERE session_key=?').run(sessionKey);
      return count;
    });
  }

  status(): Readonly<{
    batchCount: number;
    coordinateCount: number;
    dispatchCount: number;
    terminalCount: number;
    aggregateCount: number;
    revokedBatchCount: number;
    tombstoneCount: number;
  }> {
    return this.#transaction(() => {
      const count = (table: string): number => {
        const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as SqlRow;
        return integer(row.count, 0, Number.MAX_SAFE_INTEGER);
      };
      return freeze({
        batchCount: count('candidate_evaluation_batch'),
        coordinateCount: count('candidate_evaluation_coordinate'),
        dispatchCount: count('candidate_evaluation_dispatch'),
        terminalCount: count('candidate_evaluation_terminal'),
        aggregateCount: count('candidate_evaluation_aggregate'),
        revokedBatchCount: count('candidate_evaluation_batch_revocation'),
        tombstoneCount: count('candidate_evaluation_session_tombstone'),
      });
    }, false);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
