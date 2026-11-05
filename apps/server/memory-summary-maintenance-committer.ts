import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { agentClosureTimestamp } from '../../packages/agent-closure/index.ts';
import {
  validateSessionAuthorityForOwnedAdapter,
  type SessionAuthorityCoordinate,
} from '../../packages/memory/public/session-database.ts';
import { SUMMARY_CURRENT_OWNER_KEY }
  from '../../packages/memory/public/maintenance-summary-consumption-outbox.ts';
import { MaintenanceMemoryWriteReceipts, type MemoryWriteFactProjection, type MemoryWriteIntent,
  type MemoryWriteProjection, type MemoryWriteReadback,
  type MemoryWriteStoredHistory } from './maintenance-memory-write-receipt.ts';
import { MaintenanceSummaryWriteReceipts, type SummaryWriteIntent, type SummaryWriteProjection,
  type SummaryWriteReadback, type SummaryWriteStoredHistory } from './maintenance-summary-write-receipt.ts';
import { parseAgentLoopSummaryWriteOrigin, type AgentLoopSummaryWriteOrigin } from './agent-loop-summary-write-origin.ts';
import { normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import {
  isMemoryConsolidationApplyContext,
  isMemoryConsolidationProposalContext,
  isRollingSummaryApplyContext,
  maintenanceMessageEvidenceBinding,
  maintenanceSummaryInputDigest,
  maintenanceValueDigest,
  normalizeMemoryConsolidationProposal,
  validateMaintenanceProposal,
  type MaintenanceMessageEvidenceBinding,
  type MaintenancePendingProposalRecordLike,
  type MemoryConsolidationProposalContext,
  type RollingSummaryProposalContext,
} from './memory-summary-maintenance-types.ts';

export interface MemorySummarySessionBinding {
  readonly sessionId: string;
  readonly memory: {
    readonly db: DatabaseSync;
    transaction<T>(work: () => T): T;
    /** Present on the real MemoryDb. Legacy test bindings need not implement it
     * unless they opt into the current-fact read boundary. */
    readSessionAuthority?(): SessionAuthorityCoordinate;
  };
}

type SessionMemory = MemorySummarySessionBinding['memory'];

export type MemorySummaryCommitResult =
  | Readonly<{
    status: 'committed';
    receipt: Readonly<Record<string, unknown>>;
    rollbackAnchor: Readonly<Record<string, unknown>>;
  }>
  | Readonly<{ status: 'stale'; actualRevision: string }>;

export type MemorySummaryRollbackResult = Readonly<Record<string, unknown>>;

export interface MemoryWriteHistoricalEvidence {
  readonly intent: MemoryWriteIntent;
  readonly state: 'applied' | 'rolled_back';
  readonly readback: MemoryWriteStoredHistory['readback'];
  readonly updatedAt: string;
  readonly rollbackDigest?: string;
}

export interface MemoryRetrievalHitIdentity {
  readonly rowId: number;
  readonly code: string;
  /** Uses memoryWriteDigest(fullDescription), never a truncated recall fragment. */
  readonly contentDigest: string;
}

export interface SummaryWriteHistoricalEvidence {
  readonly intent: SummaryWriteIntent;
  readonly state: 'applied' | 'rolled_back';
  readonly readback: SummaryWriteStoredHistory['readback'];
  readonly updatedAt: string;
  readonly rollbackDigest?: string;
}

/** Own business origin plus the original intent/readback; never a live AL permit. */
export interface AgentLoopSummaryWriteHistoricalEvidence extends SummaryWriteHistoricalEvidence {
  readonly origin: AgentLoopSummaryWriteOrigin;
}

/** Private local artifact only. Neither its body nor a copy is an AL capability. */
export interface AgentLoopSummaryWriteHistoricalArtifact {
  readonly proposal: MaintenancePendingProposalRecordLike['proposal'];
  readonly evidence: AgentLoopSummaryWriteHistoricalEvidence;
}

export interface SummaryRetrievalIdentity {
  readonly summaryDigest: string;
  readonly throughRound: number;
  readonly historyEpoch: number;
}

export interface MemorySummaryHistoryReconcileResult {
  readonly rollbackRound: number;
  readonly rolledBackRunIds: readonly string[];
}

export const MAINTENANCE_MEMORY_CURRENT_FACT_VERSION =
  'maintenance-memory-current-fact-v1' as const;

export interface MaintenanceMemoryCurrentFactOwnerLineage {
  readonly runId: string;
  readonly targetRevision: string;
  readonly intentDigest: string;
  readonly operationDigest: string;
  readonly truthVersion: number;
  readonly historyEpoch: number;
  readonly committedAt: string;
  readonly readbackDigest: string;
}

/** A current central-Memory fact, proven against its row, marker and surviving
 * maintenance owners. Summary state is deliberately absent from this shape. */
export interface MaintenanceMemoryCurrentFact {
  readonly snapshotVersion: typeof MAINTENANCE_MEMORY_CURRENT_FACT_VERSION;
  readonly factDigest: string;
  readonly revision: string;
  readonly rowDigest: string;
  readonly ledgerDigest: string;
  readonly row: Readonly<{
    id: number;
    code: string;
    description: string;
    characters: string;
    refs: string;
    resolved: 0;
  }>;
  readonly marker: Readonly<{
    createdByMaintenance: boolean;
    owners: readonly string[];
  }>;
  readonly lineage: readonly MaintenanceMemoryCurrentFactOwnerLineage[];
}

export const MAINTENANCE_ROLLING_SUMMARY_CURRENT_VERSION =
  'maintenance-rolling-summary-current-v1' as const;

export interface MaintenanceRollingSummaryCurrentOwner {
  readonly version: 'maintenance-summary-current-owner-v1';
  readonly runId: string;
  readonly intentDigest: string;
  readonly operationDigest: string;
  readonly targetRevision: string;
  readonly summaryDigest: string;
  readonly throughRound: number;
  readonly historyEpoch: number;
}

export interface MaintenanceRollingSummaryCurrentLineage {
  readonly runId: string;
  readonly sourceRevision: string;
  readonly proposalDigest: string;
  readonly targetRevision: string;
  readonly intentDigest: string;
  readonly operationDigest: string;
  readonly truthVersion: number;
  readonly historyEpoch: number;
  readonly throughRound: number;
  readonly summaryDigest: string;
  readonly committedAt: string;
  readonly verifiedAt: string;
  readonly readbackDigest: string;
}

/** The one current rolling Summary, proven against memory_meta, history_epoch,
 * the unique current-owner row and its persisted verified producer receipt. */
export interface MaintenanceRollingSummaryCurrentSnapshot {
  readonly snapshotVersion: typeof MAINTENANCE_ROLLING_SUMMARY_CURRENT_VERSION;
  readonly summary: string;
  readonly summaryDigest: string;
  readonly throughRound: number;
  readonly historyEpoch: number;
  readonly revision: string;
  readonly owner: MaintenanceRollingSummaryCurrentOwner;
  readonly lineage: MaintenanceRollingSummaryCurrentLineage;
}

interface OperationMarker {
  readonly version: 'memory-summary-maintenance-operation-v1';
  readonly status: 'applied' | 'rolled_back';
  readonly taskKind: 'memory_consolidation' | 'rolling_summary';
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly proposalDigest: string;
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly rollbackAnchor: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

const OPERATION_PREFIX = 'maintenance_memory_summary_operation:';
const FACT_PREFIX = 'maintenance_memory_fact:';
const TRUTH_VERSION_KEY = 'maintenance_memory_truth_version';
const MAX_MEMORY_RETRIEVAL_HITS = 128;
const MAX_MEMORY_RETRIEVAL_OWNERS = 128;

interface MemoryFactMarker {
  readonly version: 'maintenance-memory-fact-v1';
  readonly factDigest: string;
  readonly rowId: number;
  readonly code: string;
  readonly description: string;
  readonly characters: string;
  readonly refs: string;
  readonly resolved: 0;
  readonly createdByMaintenance: boolean;
  readonly owners: readonly string[];
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Pin host data without invoking getters/toJSON or retaining mutable aliases.
 * Preserve original key order: legacy proposal/context digests are byte based. */
function pinAgentLoopSummaryPending(input: MaintenancePendingProposalRecordLike): MaintenancePendingProposalRecordLike {
  let nodes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 32_768 || depth > 16) throw new Error('agent-loop-summary-write-input-invalid');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') throw new Error('agent-loop-summary-write-input-invalid');
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error('agent-loop-summary-write-input-invalid');
      return Object.freeze(Array.from({ length: value.length }, (_, i) => {
        const field = Object.getOwnPropertyDescriptor(value, String(i));
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new Error('agent-loop-summary-write-input-invalid');
        return copy(field.value, depth + 1);
      }));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('agent-loop-summary-write-input-invalid');
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !field?.enumerable || !Object.hasOwn(field, 'value')) throw new Error('agent-loop-summary-write-input-invalid');
      result[key] = copy(field.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const pinned = copy(input, 0) as MaintenancePendingProposalRecordLike;
  const keys = ['jobRunId', 'sessionId', 'taskKind', 'sourceRevision', 'proposal', 'context'];
  if (Object.keys(pinned).length !== keys.length || keys.some(key => !Object.hasOwn(pinned, key))
    || JSON.stringify(pinned).length > 1_048_576) throw new Error('agent-loop-summary-write-input-invalid');
  return pinned;
}

function memoryRollbackDigest(marker: Pick<OperationMarker, 'runId' | 'sessionId' | 'proposalDigest'>,
  at: string): string {
  return digest({ version: 'maintenance-memory-rollback-v1', runId: marker.runId,
    sessionId: marker.sessionId, proposalDigest: marker.proposalDigest, rolledBackAt: at });
}

function summaryRollbackDigest(marker: Pick<OperationMarker, 'runId' | 'sessionId' | 'proposalDigest'>,
  at: string): string {
  return digest({ version: 'maintenance-summary-rollback-v1', runId: marker.runId,
    sessionId: marker.sessionId, proposalDigest: marker.proposalDigest, rolledBackAt: at });
}

function stale(actualRevision: string): MemorySummaryCommitResult {
  return Object.freeze({ status: 'stale' as const, actualRevision });
}

function operationKey(runId: string): string {
  if (!/^mjob_[a-f0-9]{32}$/u.test(runId)) throw new Error('maintenance-memory-summary-run-id-invalid');
  return `${OPERATION_PREFIX}${runId}`;
}

function factKey(factDigest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(factDigest)) {
    throw new Error('maintenance-memory-fact-digest-invalid');
  }
  return `${FACT_PREFIX}${factDigest.slice('sha256:'.length)}`;
}

function readFactMarker(memory: SessionMemory, sessionId: string, factDigest: string): MemoryFactMarker | null {
  const row = memory.db.prepare(
    'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
  ).get(sessionId, factKey(factDigest)) as { value: string } | undefined;
  if (!row) return null;
  if (typeof row.value !== 'string' || row.value.length > 65_536) {
    throw new Error('maintenance-memory-fact-ledger-corrupt');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.value); } catch { throw new Error('maintenance-memory-fact-ledger-corrupt'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('maintenance-memory-fact-ledger-corrupt');
  }
  const marker = parsed as Partial<MemoryFactMarker>;
  if (marker.version !== 'maintenance-memory-fact-v1' || marker.factDigest !== factDigest
    || !Number.isSafeInteger(marker.rowId) || Number(marker.rowId) < 1
    || typeof marker.code !== 'string' || typeof marker.description !== 'string'
    || typeof marker.characters !== 'string' || typeof marker.refs !== 'string'
    || marker.resolved !== 0 || typeof marker.createdByMaintenance !== 'boolean'
    || !Array.isArray(marker.owners) || marker.owners.length < 1
    || marker.owners.length > MAX_MEMORY_RETRIEVAL_OWNERS
    || new Set(marker.owners).size !== marker.owners.length
    || marker.owners.some((owner) => typeof owner !== 'string' || !/^mjob_[a-f0-9]{32}$/u.test(owner))) {
    throw new Error('maintenance-memory-fact-ledger-corrupt');
  }
  return marker as MemoryFactMarker;
}

function writeFactMarker(memory: SessionMemory, sessionId: string, marker: MemoryFactMarker, now: string): void {
  memory.db.prepare(
    `INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).run(sessionId, factKey(marker.factDigest), JSON.stringify(marker), now);
  const readback = readFactMarker(memory, sessionId, marker.factDigest);
  if (!readback || digest(readback) !== digest(marker)) {
    throw new Error('maintenance-memory-fact-ledger-readback-failed');
  }
}

function exactFactRow(memory: SessionMemory, marker: MemoryFactMarker): boolean {
  const row = memory.db.prepare(
    'SELECT id,code,description,characters,refs,resolved FROM memory_event WHERE id=?',
  ).get(marker.rowId) as Record<string, unknown> | undefined;
  return Boolean(row && row.id === marker.rowId && row.code === marker.code
    && row.description === marker.description && row.characters === marker.characters
    && row.refs === marker.refs && row.resolved === marker.resolved);
}

function readRetrievalFact(memory: SessionMemory, sessionId: string, hit: MemoryRetrievalHitIdentity):
  Readonly<{ marker: MemoryFactMarker; rowDigest: string }> | null {
  if (!hit || !Number.isSafeInteger(hit.rowId) || hit.rowId < 1 || typeof hit.code !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(hit.contentDigest)) {
    throw new Error('memory-retrieval-hit-invalid');
  }
  if (!/^MEM:[a-f0-9]{64}$/u.test(hit.code)) return null;
  const factDigest = `sha256:${hit.code.slice('MEM:'.length)}`;
  const marker = readFactMarker(memory, sessionId, factDigest);
  if (!marker || marker.rowId !== hit.rowId || marker.code !== hit.code) return null;
  const row = memory.db.prepare(
    'SELECT id,code,description,characters,refs,resolved FROM memory_event WHERE id=?',
  ).get(hit.rowId) as Record<string, unknown> | undefined;
  if (!row || row.id !== marker.rowId || row.code !== marker.code || row.description !== marker.description
    || row.characters !== marker.characters || row.refs !== marker.refs || row.resolved !== marker.resolved
    || digest(row.description) !== hit.contentDigest) return null;
  return Object.freeze({ marker, rowDigest: digest(row) });
}

/**
 * `memory_event.id` is an INTEGER PRIMARY KEY and may be reused after the
 * previous tail row is deleted.  Any vector left behind for that numeric id
 * would then describe a different fact while RetrievalEngine resolves it to
 * the new row.  Keep vector invalidation in the same business transaction as
 * the event mutation; rebuilding embeddings remains an optional, asynchronous
 * concern.
 */
function clearEventVectors(memory: SessionMemory, rowId: number): void {
  memory.db.prepare(
    "DELETE FROM vec_memory WHERE source='event' AND row_id=?",
  ).run(rowId);
}

function readMarker(memory: SessionMemory, sessionId: string, runId: string): OperationMarker | null {
  const row = memory.db.prepare(
    'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
  ).get(sessionId, operationKey(runId)) as { value: string } | undefined;
  if (!row) return null;
  let value: unknown;
  try { value = JSON.parse(row.value); } catch { throw new Error('maintenance-memory-summary-ledger-corrupt'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('maintenance-memory-summary-ledger-corrupt');
  }
  const marker = value as Partial<OperationMarker>;
  if (marker.version !== 'memory-summary-maintenance-operation-v1'
    || !['applied', 'rolled_back'].includes(String(marker.status))
    || !['memory_consolidation', 'rolling_summary'].includes(String(marker.taskKind))
    || marker.runId !== runId || marker.sessionId !== sessionId
    || typeof marker.sourceRevision !== 'string'
    || typeof marker.proposalDigest !== 'string'
    || !marker.receipt || typeof marker.receipt !== 'object' || Array.isArray(marker.receipt)
    || !marker.rollbackAnchor || typeof marker.rollbackAnchor !== 'object'
    || Array.isArray(marker.rollbackAnchor) || typeof marker.updatedAt !== 'string') {
    throw new Error('maintenance-memory-summary-ledger-corrupt');
  }
  return marker as OperationMarker;
}

function writeMarker(memory: SessionMemory, marker: OperationMarker): void {
  memory.db.prepare(
    `INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).run(marker.sessionId, operationKey(marker.runId), JSON.stringify(marker), marker.updatedAt);
  const readback = readMarker(memory, marker.sessionId, marker.runId);
  if (!readback || readback.proposalDigest !== marker.proposalDigest || readback.status !== marker.status) {
    throw new Error('maintenance-memory-summary-ledger-readback-failed');
  }
}

function markerResult(marker: OperationMarker): MemorySummaryCommitResult {
  if (marker.status !== 'applied') throw new Error('maintenance-memory-summary-operation-rolled-back');
  return Object.freeze({
    status: 'committed' as const,
    receipt: Object.freeze({ ...marker.receipt, deduped: true }),
    rollbackAnchor: Object.freeze(structuredClone(marker.rollbackAnchor)),
  });
}

function historyEpoch(memory: SessionMemory, sessionId: string): number {
  const row = memory.db.prepare(
    `SELECT value FROM session_control
     WHERE session_key=? AND control_key='history_epoch'`,
  ).get(sessionId) as { value: string } | undefined;
  const value = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('maintenance-history-epoch-corrupt');
  }
  return value;
}

function bumpTruthVersion(memory: SessionMemory, sessionId: string, now: string): number {
  const row = memory.db.prepare(
    'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
  ).get(sessionId, TRUTH_VERSION_KEY) as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error('maintenance-memory-truth-version-corrupt');
  }
  const next = current + 1;
  memory.db.prepare(
    `INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(session_key,control_key) DO UPDATE SET
       value=excluded.value,updated_at=excluded.updated_at`,
  ).run(sessionId, TRUTH_VERSION_KEY, String(next), now);
  const readback = memory.db.prepare(
    'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
  ).get(sessionId, TRUTH_VERSION_KEY) as { value: string } | undefined;
  if (Number(readback?.value) !== next) {
    throw new Error('maintenance-memory-truth-version-readback-failed');
  }
  return next;
}

function evidenceMatches(
  memory: SessionMemory,
  evidence: MaintenanceMessageEvidenceBinding,
): boolean {
  const row = memory.db.prepare(
    'SELECT id,round,role,content FROM chat_log WHERE id=?',
  ).get(evidence.messageId) as {
    id: number; round: number; role: string; content: string;
  } | undefined;
  if (!row || row.id !== evidence.messageId || row.round !== evidence.round
    || row.role !== evidence.role) return false;
  try {
    return maintenanceMessageEvidenceBinding(row).contentDigest === evidence.contentDigest;
  } catch {
    return false;
  }
}

function evidenceSetMatches(
  memory: SessionMemory,
  evidence: readonly MaintenanceMessageEvidenceBinding[],
): boolean {
  return evidence.every((row) => evidenceMatches(memory, row));
}

function appliedMarkers(memory: SessionMemory, sessionId: string): readonly OperationMarker[] {
  const rows = memory.db.prepare(
    `SELECT control_key FROM session_control
     WHERE session_key=? AND control_key LIKE ? ORDER BY control_key`,
  ).all(sessionId, `${OPERATION_PREFIX}%`) as Array<{ control_key: string }>;
  return rows.map((row) => {
    const runId = row.control_key.slice(OPERATION_PREFIX.length);
    const marker = readMarker(memory, sessionId, runId);
    if (!marker) throw new Error('maintenance-memory-summary-ledger-corrupt');
    return marker;
  }).filter((marker) => marker.status === 'applied');
}

interface CanonicalMemoryFactIdentity {
  readonly subject: string;
  readonly predicate: string;
  readonly value: string | number | boolean | null;
}

function canonicalMemoryFactIdentity(
  fact: ReturnType<typeof normalizeMemoryConsolidationProposal>['facts'][number],
): CanonicalMemoryFactIdentity {
  return Object.freeze({
    subject: fact.subject.normalize('NFC'),
    predicate: fact.predicate.normalize('NFC'),
    value: typeof fact.value === 'string' ? fact.value.normalize('NFC') : fact.value,
  });
}

function renderMemoryFact(fact: CanonicalMemoryFactIdentity): string {
  const rendered = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
  return `[长期记忆/confirmed/high] ${fact.subject} · ${fact.predicate}：${rendered}`;
}

/**
 * Trusted-local committer for the two memory domains. It never calls a model.
 * Business writes and operation markers share one transaction. Each domain has a separate post-COMMIT check.
 * SQLite FTS external-content triggers observe these writes in that same transaction. PostgreSQL/pgvector
 * remains a derived, rebuildable asynchronous index; approval success never depends on, or claims, a
 * synchronous vector-index update.
 */
export class MemorySummaryMaintenanceCommitter {
  readonly #writeReceipts: MaintenanceMemoryWriteReceipts;
  readonly #freshReadbacks = new WeakMap<object, MemoryWriteIntent>();
  readonly #summaryWriteReceipts: MaintenanceSummaryWriteReceipts;
  readonly #freshSummaryReadbacks = new WeakMap<object, SummaryWriteIntent>();

  constructor(
    private readonly binding: MemorySummarySessionBinding,
    private readonly currentRevision: (sessionId: string) => string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.#writeReceipts = new MaintenanceMemoryWriteReceipts(binding.memory, {
      sessionId: binding.sessionId, now,
      readOperation: (runId) => {
        const marker = readMarker(binding.memory, binding.sessionId, runId);
        return marker ? { status: marker.status, operationDigest: digest(marker) } : null;
      },
      readProjection: (expected) => this.#memoryWriteProjection(expected),
    });
    this.#summaryWriteReceipts = new MaintenanceSummaryWriteReceipts(binding.memory, {
      sessionId: binding.sessionId, now,
      readOperation: (runId) => {
        const marker = readMarker(binding.memory, binding.sessionId, runId);
        return marker ? { status: marker.status, operationDigest: digest(marker),
          ...(typeof marker.receipt.agentLoopOriginDigest === 'string'
            ? { agentLoopOriginDigest: marker.receipt.agentLoopOriginDigest } : {}) } : null;
      },
      readProjection: (expected) => this.#summaryWriteProjection(expected),
    });
  }

  /** Private-brand/session binding probe for trusted local adapters. */
  assertMemoryFactSessionBinding(rawSessionId: string, memoryIdentity: object): void {
    void this.#writeReceipts;
    if (rawSessionId !== this.binding.sessionId || memoryIdentity !== this.binding.memory) {
      throw new Error('maintenance-memory-current-fact-session-conflict');
    }
  }

  /** Private-brand/session binding probe for the rolling Summary adapter. */
  assertRollingSummarySessionBinding(rawSessionId: string, memoryIdentity: object): void {
    void this.#summaryWriteReceipts;
    if (rawSessionId !== this.binding.sessionId || memoryIdentity !== this.binding.memory) {
      throw new Error('maintenance-rolling-summary-current-session-conflict');
    }
  }

  /**
   * Reads one current maintenance-owned event fact. The real MemoryDb
   * transaction is the stable source snapshot; Session authority is bracketed
   * so schema drift, reopen/ABA during that read, and concurrent semantic writes
   * fail closed. The coordinate is deliberately not persisted as fact revision.
   * Only MEM facts in memory_event participate -- rolling summaries never do.
   */
  readCurrentMemoryFact(code: string): MaintenanceMemoryCurrentFact | null {
    void this.#writeReceipts;
    if (!/^MEM:[a-f0-9]{64}$/u.test(code)) {
      throw new Error('maintenance-memory-current-fact-code-invalid');
    }
    const memory = this.binding.memory;
    if (memory.db.isTransaction !== false || typeof memory.readSessionAuthority !== 'function') {
      throw new Error('maintenance-memory-current-fact-authority-unavailable');
    }
    const authority = (): SessionAuthorityCoordinate => {
      if (!validateSessionAuthorityForOwnedAdapter(memory.db)) {
        throw new Error('maintenance-memory-current-fact-authority-required');
      }
      const value = memory.readSessionAuthority!.call(memory);
      if (!value || typeof value.generation !== 'string'
        || !/^session-db:[0-9a-f-]{36}$/u.test(value.generation)
        || !Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw new Error('maintenance-memory-current-fact-authority-invalid');
      }
      return Object.freeze({ generation: value.generation, revision: value.revision });
    };
    const sameAuthority = (left: SessionAuthorityCoordinate, right: SessionAuthorityCoordinate) => (
      left.generation === right.generation && left.revision === right.revision
    );
    const before = authority();
    const current = memory.transaction((): MaintenanceMemoryCurrentFact | null => {
      if (memory.db.isTransaction !== true) {
        throw new Error('maintenance-memory-current-fact-transaction-required');
      }
      const locked = authority();
      if (!sameAuthority(before, locked)) {
        throw new Error('maintenance-memory-current-fact-authority-drift');
      }
      const factDigest = `sha256:${code.slice('MEM:'.length)}`;
      const marker = readFactMarker(memory, this.binding.sessionId, factDigest);
      const rows = memory.db.prepare(
        `SELECT id,code,description,characters,refs,resolved
         FROM memory_event WHERE code=? ORDER BY id LIMIT 2`,
      ).all(code) as Array<Record<string, unknown>>;
      if (!marker && rows.length === 0) return null;
      if (!marker || rows.length !== 1 || !exactFactRow(memory, marker)) {
        throw new Error('maintenance-memory-current-fact-source-drift');
      }
      const source = rows[0]!;
      if (source.id !== marker.rowId || source.code !== marker.code
        || source.description !== marker.description || source.characters !== marker.characters
        || source.refs !== marker.refs || source.resolved !== marker.resolved) {
        throw new Error('maintenance-memory-current-fact-source-drift');
      }
      const retrieval = readRetrievalFact(memory, this.binding.sessionId, Object.freeze({
        rowId: marker.rowId,
        code,
        contentDigest: digest(marker.description),
      }));
      if (!retrieval || retrieval.marker.factDigest !== factDigest) {
        throw new Error('maintenance-memory-current-fact-source-drift');
      }
      const row = Object.freeze({
        id: marker.rowId,
        code: marker.code,
        description: marker.description,
        characters: marker.characters,
        refs: marker.refs,
        resolved: 0 as const,
      });
      const rowDigest = retrieval.rowDigest;
      const owners = Object.freeze([...retrieval.marker.owners].sort());
      const ledgerDigest = digest({ ...retrieval.marker, owners });
      const lineage: MaintenanceMemoryCurrentFactOwnerLineage[] = [];
      for (const runId of owners) {
        try {
          const history = this.#readMemoryWriteEvidenceInTransaction(runId);
          const facts = history?.intent.facts.filter((fact) => fact.factDigest === factDigest) ?? [];
          if (!history || history.state !== 'applied' || !history.readback
            || history.intent.sessionId !== this.binding.sessionId
            || facts.length !== 1 || facts[0]!.rowId !== marker.rowId
            || facts[0]!.rowDigest !== rowDigest) continue;
          lineage.push(Object.freeze({
            runId,
            targetRevision: history.intent.targetRevision,
            intentDigest: history.intent.intentDigest,
            operationDigest: history.intent.operationDigest,
            truthVersion: history.intent.truthVersion,
            historyEpoch: history.intent.historyEpoch,
            committedAt: history.intent.committedAt,
            readbackDigest: history.readback.readbackDigest,
          }));
        } catch (error) {
          if (memory.db.isTransaction !== true) throw error;
          // One optional owner receipt cannot attest this fact and cannot
          // suppress another independently verified surviving owner.
        }
      }
      if (lineage.length < 1) {
        throw new Error('maintenance-memory-current-fact-readback-required');
      }
      const revision = digest({
        version: 'maintenance-memory-current-fact-revision-v1',
        ledgerDigest,
        owners: lineage.map((owner) => ({
          runId: owner.runId,
          targetRevision: owner.targetRevision,
          readbackDigest: owner.readbackDigest,
        })),
      });
      const tail = authority();
      if (!sameAuthority(locked, tail)) {
        throw new Error('maintenance-memory-current-fact-authority-drift');
      }
      return Object.freeze({
        snapshotVersion: MAINTENANCE_MEMORY_CURRENT_FACT_VERSION,
        factDigest,
        revision,
        rowDigest,
        ledgerDigest,
        row,
        marker: Object.freeze({ createdByMaintenance: retrieval.marker.createdByMaintenance, owners }),
        lineage: Object.freeze(lineage),
      });
    });
    const after = authority();
    if (!sameAuthority(before, after)) {
      throw new Error('maintenance-memory-current-fact-authority-drift');
    }
    return current;
  }

  /**
   * Reads the one current maintenance-owned rolling Summary. The body and its
   * (digest, throughRound, historyEpoch) identity come from the same real
   * MemoryDb transaction as the unique current-owner row and verified receipt.
   * Session authority is bracketed around that transaction, but its aggregate
   * revision is intentionally not used as the Summary semantic revision.
   */
  readCurrentRollingSummary(): MaintenanceRollingSummaryCurrentSnapshot | null {
    void this.#summaryWriteReceipts;
    const memory = this.binding.memory;
    if (memory.db.isTransaction !== false || typeof memory.readSessionAuthority !== 'function') {
      throw new Error('maintenance-rolling-summary-current-authority-unavailable');
    }
    const authority = (): SessionAuthorityCoordinate => {
      if (!validateSessionAuthorityForOwnedAdapter(memory.db)) {
        throw new Error('maintenance-rolling-summary-current-authority-required');
      }
      const value = memory.readSessionAuthority!.call(memory);
      if (!value || typeof value.generation !== 'string'
        || !/^session-db:[0-9a-f-]{36}$/u.test(value.generation)
        || !Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw new Error('maintenance-rolling-summary-current-authority-invalid');
      }
      return Object.freeze({ generation: value.generation, revision: value.revision });
    };
    const sameAuthority = (left: SessionAuthorityCoordinate, right: SessionAuthorityCoordinate) => (
      left.generation === right.generation && left.revision === right.revision
    );
    const before = authority();
    const current = memory.transaction((): MaintenanceRollingSummaryCurrentSnapshot | null => {
      if (memory.db.isTransaction !== true) {
        throw new Error('maintenance-rolling-summary-current-transaction-required');
      }
      const locked = authority();
      if (!sameAuthority(before, locked)) {
        throw new Error('maintenance-rolling-summary-current-authority-drift');
      }
      const stored = memory.db.prepare(
        'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
      ).get(this.binding.sessionId, SUMMARY_CURRENT_OWNER_KEY) as { value: string } | undefined;
      if (!stored) return null;
      if (typeof stored.value !== 'string' || stored.value.length > 2_048) {
        throw new Error('maintenance-rolling-summary-current-owner-invalid');
      }
      const row = memory.db.prepare(
        "SELECT COALESCE(longterm,'') longterm,COALESCE(summary_round,0) summaryRound FROM memory_meta WHERE id=1",
      ).get() as { longterm: string; summaryRound: number } | undefined;
      if (!row || typeof row.longterm !== 'string' || row.longterm.length < 1
        || !Number.isSafeInteger(row.summaryRound) || row.summaryRound < 1) {
        throw new Error('maintenance-rolling-summary-current-source-drift');
      }
      const identity = Object.freeze({
        summaryDigest: digest(row.longterm),
        throughRound: row.summaryRound,
        historyEpoch: historyEpoch(memory, this.binding.sessionId),
      });
      const history = this.readSummaryRetrievalLineageInTransaction(identity);
      if (!history || history.state !== 'applied' || !history.readback) {
        throw new Error('maintenance-rolling-summary-current-readback-required');
      }
      const owner = this.#summaryCurrentOwner(history.intent);
      if (JSON.stringify(owner) !== stored.value) {
        throw new Error('maintenance-rolling-summary-current-owner-drift');
      }
      const readback = history.readback;
      const lineage: MaintenanceRollingSummaryCurrentLineage = Object.freeze({
        runId: history.intent.runId,
        sourceRevision: history.intent.sourceRevision,
        proposalDigest: history.intent.proposalDigest,
        targetRevision: history.intent.targetRevision,
        intentDigest: history.intent.intentDigest,
        operationDigest: history.intent.operationDigest,
        truthVersion: history.intent.truthVersion,
        historyEpoch: history.intent.historyEpoch,
        throughRound: history.intent.throughRound,
        summaryDigest: history.intent.summaryDigest,
        committedAt: history.intent.committedAt,
        verifiedAt: readback.verifiedAt,
        readbackDigest: readback.readbackDigest,
      });
      const revision = digest({
        version: 'maintenance-rolling-summary-current-revision-v1',
        owner,
        lineage,
      });
      const tail = authority();
      if (!sameAuthority(locked, tail)) {
        throw new Error('maintenance-rolling-summary-current-authority-drift');
      }
      return Object.freeze({
        snapshotVersion: MAINTENANCE_ROLLING_SUMMARY_CURRENT_VERSION,
        summary: row.longterm,
        ...identity,
        revision,
        owner,
        lineage,
      });
    });
    const after = authority();
    if (!sameAuthority(before, after)) {
      throw new Error('maintenance-rolling-summary-current-authority-drift');
    }
    return current;
  }

  commit(pending: MaintenancePendingProposalRecordLike): MemorySummaryCommitResult {
    if (pending.sessionId !== this.binding.sessionId
      || (pending.taskKind !== 'memory_consolidation' && pending.taskKind !== 'rolling_summary')) {
      throw new Error('maintenance-memory-summary-session-conflict');
    }
    const proposalDigest = digest(pending.proposal);
    const prior = readMarker(this.binding.memory, pending.sessionId, pending.jobRunId);
    if (prior) {
      if (prior.proposalDigest !== proposalDigest || prior.taskKind !== pending.taskKind
        || prior.sourceRevision !== pending.sourceRevision) {
        throw new Error('maintenance-memory-summary-operation-intent-conflict');
      }
      return this.#withDomainReadback(markerResult(prior), pending.jobRunId);
    }
    const result = this.binding.memory.transaction(() => {
      const replay = readMarker(this.binding.memory, pending.sessionId, pending.jobRunId);
      if (replay) {
        if (replay.proposalDigest !== proposalDigest || replay.taskKind !== pending.taskKind) {
          throw new Error('maintenance-memory-summary-operation-intent-conflict');
        }
        return markerResult(replay);
      }
      return pending.taskKind === 'memory_consolidation'
        ? this.#commitMemory(pending, proposalDigest)
        : this.#commitSummary(pending, proposalDigest);
    });
    return this.#withDomainReadback(result, pending.jobRunId);
  }

  /** Trusted-local producer only. Origin JSON is metadata, never an execution
   * permit; the AL host capability/Runtime admission remain separate boundaries.
   * Unlike legacy commit(), its own intent and origin are mandatory business TX
   * participants. A post-COMMIT readback gap never authorizes writing again.
   * The trusted assertion must not execute transaction control or manipulate
   * the connection. Tail checks detect drift; they are not an SQL sandbox and
   * cannot undo a raw COMMIT performed by an already privileged host callback. */
  commitAgentLoopSummary(
    input: MaintenancePendingProposalRecordLike,
    originInput: AgentLoopSummaryWriteOrigin,
    authorizeCommit: (stage: 'before-write' | 'after-write') => unknown,
  ): MemorySummaryCommitResult {
    if (this.binding.memory.db.isTransaction !== false || typeof authorizeCommit !== 'function') {
      throw new Error('agent-loop-summary-write-boundary-invalid');
    }
    const pending = pinAgentLoopSummaryPending(input), origin = parseAgentLoopSummaryWriteOrigin(originInput);
    if (pending.taskKind !== 'rolling_summary' || pending.sessionId !== this.binding.sessionId
      || pending.jobRunId !== origin.runId || pending.sessionId !== origin.sessionId
      || pending.sourceRevision !== origin.sourceRevision || digest(pending.proposal) !== origin.proposalDigest
      || digest(pending.context) !== origin.contextDigest || !isRollingSummaryApplyContext(pending.context)
      || origin.attemptId !== `attempt.al.${origin.claimDigest.slice(7)}`) {
      throw new Error('agent-loop-summary-write-origin-conflict');
    }
    const normalizedProposal = validateMaintenanceProposal('rolling_summary', pending.proposal.payload, pending.context);
    if (pending.proposal.taskKind !== 'rolling_summary' || digest(normalizedProposal) !== origin.proposalDigest) {
      throw new Error('agent-loop-summary-write-proposal-invalid');
    }
    let lastNow = origin.authorizedAt;
    const assertTime = () => {
      const now = agentClosureTimestamp(this.now(), 'agent-loop-summary-write-now');
      if (now < lastNow || now < origin.authorizedAt || now >= origin.authorizationExpiresAt) {
        throw new Error('agent-loop-summary-write-authorization-expired');
      }
      lastNow = now;
    };
    const authorize = (stage: 'before-write' | 'after-write') => {
      assertTime();
      const before = this.#agentLoopAuthorizationSnapshot();
      if (stage === 'before-write' && this.currentRevision(pending.sessionId) !== pending.sourceRevision) {
        throw new Error('agent-loop-summary-write-source-stale');
      }
      const result = authorizeCommit(stage);
      if (result !== undefined) {
        if (result !== null && typeof result === 'object') {
          try { void Promise.prototype.then.call(result, () => undefined, () => undefined); }
          catch { /* A foreign then getter is never read. */ }
        }
        throw new Error('agent-loop-summary-write-authorization-invalid');
      }
      if (stage === 'before-write' && this.currentRevision(pending.sessionId) !== pending.sourceRevision) {
        throw new Error('agent-loop-summary-write-source-stale');
      }
      assertTime();
      if (this.binding.memory.db.isTransaction !== true || this.#agentLoopAuthorizationSnapshot() !== before) {
        throw new Error('agent-loop-summary-write-authorization-mutated');
      }
      // Tail validation itself may take time on a large Session. Do not stamp
      // a commit using the clock sampled before that final read-only scan.
      assertTime();
    };
    const result = this.binding.memory.transaction(() => {
      const prior = readMarker(this.binding.memory, pending.sessionId, pending.jobRunId);
      const previousOrigin = this.#summaryWriteReceipts.readAgentLoopOriginInTransaction(pending.jobRunId);
      if (prior || previousOrigin) {
        const history = this.#readAgentLoopSummaryWriteEvidenceInTransaction(pending.jobRunId);
        if (!prior || !history || history.origin.originDigest !== origin.originDigest
          || prior.sourceRevision !== pending.sourceRevision || prior.proposalDigest !== origin.proposalDigest
          || prior.taskKind !== 'rolling_summary' || history.state !== 'applied') {
          throw new Error('agent-loop-summary-write-replay-conflict');
        }
        return markerResult(prior);
      }
      authorize('before-write');
      const write = this.#commitSummary(pending, origin.proposalDigest, origin);
      if (write.status === 'stale') return write;
      const evidence = this.#readAgentLoopSummaryWriteEvidenceInTransaction(pending.jobRunId);
      if (!evidence || evidence.origin.originDigest !== origin.originDigest || evidence.state !== 'applied') {
        throw new Error('agent-loop-summary-write-evidence-required');
      }
      if (evidence.intent.committedAt < lastNow) throw new Error('agent-loop-summary-write-authorization-expired');
      lastNow = evidence.intent.committedAt;
      // Own writes (including intent/owner metadata) change the aggregate source
      // token. From here on assert the live claim, not the old source snapshot.
      authorize('after-write');
      return write;
    });
    return this.#withDomainReadback(result, pending.jobRunId);
  }

  /** Source assertion callbacks are read-only even for noop/ABA SQL writes.
   * Bind schema and all ordinary Session tables; virtual/shadow index storage
   * is derived, not another origin/intent authority. No new persistence. */
  #agentLoopAuthorizationSnapshot(): string {
    const db = this.binding.memory.db;
    if (db.isTransaction !== true) throw new Error('agent-loop-summary-write-transaction-required');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const tempSchema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_temp_master ORDER BY type,name').all();
    const databases = db.prepare('PRAGMA database_list').all() as Array<{ name: string }>;
    if (databases.some(row => row.name !== 'main' && row.name !== 'temp')) throw new Error('agent-loop-summary-write-attached-database');
    const tables = (db.prepare('PRAGMA table_list').all() as Array<{ schema: string; name: string; type: string }>)
      .filter(row => ['main', 'temp'].includes(row.schema) && row.type === 'table' && row.name !== 'sqlite_schema')
      .sort((a, b) => `${a.schema}.${a.name}` < `${b.schema}.${b.name}` ? -1 : `${a.schema}.${a.name}` > `${b.schema}.${b.name}` ? 1 : 0)
      .map(row => ({ schema: row.schema, name: row.name,
        rows: db.prepare(`SELECT * FROM "${row.schema}"."${row.name.replace(/"/gu, '""')}"`).all() }));
    return digest({ schema, tempSchema, databases, tables, changes: db.prepare('SELECT total_changes() AS value').get(),
      applicationId: db.prepare('PRAGMA application_id').get(), version: db.prepare('PRAGMA user_version').get() });
  }

  recover(pending: MaintenancePendingProposalRecordLike): MemorySummaryCommitResult | null {
    if (pending.sessionId !== this.binding.sessionId) throw new Error('maintenance-memory-summary-session-conflict');
    const marker = readMarker(this.binding.memory, pending.sessionId, pending.jobRunId);
    if (!marker) return null;
    const proposalDigest = digest(pending.proposal);
    if (marker.proposalDigest !== proposalDigest || marker.taskKind !== pending.taskKind
      || marker.sourceRevision !== pending.sourceRevision) {
      throw new Error('maintenance-memory-summary-operation-intent-conflict');
    }
    // A history rewrite may have already reconciled and removed the business
    // write while the separate control DB still says pending. In that state a
    // reject is safe, while re-applying the old run remains forbidden by commit().
    if (marker.status === 'rolled_back') return null;
    return this.#withDomainReadback(markerResult(marker), pending.jobRunId);
  }

  /** Read historical metadata only: never query current fact rows, assets, Provider or revision snapshots. */
  readMemoryWriteEvidence(runId: string): MemoryWriteHistoricalEvidence | null {
    if (this.binding.memory.db.isTransaction !== false) throw new Error('memory-write-evidence-outer-transaction');
    const result = this.binding.memory.transaction(() => this.#readMemoryWriteEvidenceInTransaction(runId));
    if (this.binding.memory.db.isTransaction !== false) throw new Error('memory-write-evidence-outer-transaction');
    return result;
  }

  /** Historical Summary metadata has its own protocol; current memory_meta cannot recreate a missing receipt. */
  readSummaryWriteEvidence(runId: string): SummaryWriteHistoricalEvidence | null {
    if (this.binding.memory.db.isTransaction !== false) throw new Error('summary-write-evidence-outer-transaction');
    const result = this.binding.memory.transaction(() => this.#readSummaryWriteEvidenceInTransaction(runId));
    if (this.binding.memory.db.isTransaction !== false) throw new Error('summary-write-evidence-outer-transaction');
    return result;
  }

  /** Historical origin join only. It does not reconstruct a missing post-COMMIT
   * readback, consult today's source token, authorize or replay a domain write. */
  readAgentLoopSummaryWriteEvidence(runId: string): AgentLoopSummaryWriteHistoricalEvidence | null {
    if (this.binding.memory.db.isTransaction !== false) throw new Error('agent-loop-summary-evidence-outer-transaction');
    const result = this.binding.memory.transaction(() => this.#readAgentLoopSummaryWriteEvidenceInTransaction(runId));
    if (this.binding.memory.db.isTransaction !== false) throw new Error('agent-loop-summary-evidence-outer-transaction');
    return result;
  }

  /** Read this run's ORIGINAL after-image, never today's Summary. The original
   * verified historical join is mandatory; this reader cannot repair a pending
   * receipt, revive a rollback or retrofit a legacy write with AL provenance.
   * Original context bytes were not stored in this anchor and are not invented. */
  readAgentLoopSummaryWriteArtifact(runId: string): AgentLoopSummaryWriteHistoricalArtifact | null {
    if (this.binding.memory.db.isTransaction !== false) throw new Error('agent-loop-summary-artifact-outer-transaction');
    if (typeof runId !== 'string' || !/^mjob_[a-f0-9]{32}$/u.test(runId)) {
      throw new Error('agent-loop-summary-artifact-input-invalid');
    }
    const result = this.binding.memory.transaction(() => {
      const evidence = this.#readAgentLoopSummaryWriteEvidenceInTransaction(runId);
      if (!evidence) return null;
      if (evidence.state !== 'applied' || evidence.readback === null || evidence.readback.status !== 'verified') {
        throw new Error('agent-loop-summary-artifact-unavailable');
      }
      const marker = readMarker(this.binding.memory, this.binding.sessionId, runId);
      if (!marker || marker.status !== 'applied') throw new Error('agent-loop-summary-artifact-unavailable');
      const anchor = normalizeAgentLoopActionObject(marker.rollbackAnchor, ['version', 'taskKind', 'runId', 'sessionId',
        'proposalDigest', 'historyEpoch', 'baseSummaryDigest', 'inputDigest', 'sourceEvidence', 'before', 'after']);
      const before = normalizeAgentLoopActionObject(anchor.before, ['longterm', 'summaryRound']);
      const after = normalizeAgentLoopActionObject(anchor.after, ['longterm', 'summaryRound']);
      const { intent, origin, readback } = evidence;
      if (anchor.version !== 'memory-summary-maintenance-rollback-v1' || anchor.taskKind !== 'rolling_summary'
        || anchor.runId !== runId || anchor.sessionId !== this.binding.sessionId || anchor.proposalDigest !== origin.proposalDigest
        || anchor.historyEpoch !== intent.historyEpoch || anchor.historyEpoch !== readback.historyEpoch
        || typeof before.longterm !== 'string' || !Number.isSafeInteger(before.summaryRound) || Number(before.summaryRound) < 0
        || typeof after.longterm !== 'string' || after.longterm.length < 1 || after.longterm.length > 16_000
        || !Number.isSafeInteger(after.summaryRound) || Number(after.summaryRound) <= Number(before.summaryRound)
        || after.summaryRound !== intent.throughRound || after.summaryRound !== readback.throughRound
        || digest(after.longterm) !== intent.summaryDigest || intent.summaryDigest !== readback.summaryDigest
        || anchor.baseSummaryDigest !== maintenanceValueDigest(before.longterm) || !Array.isArray(anchor.sourceEvidence)
        || anchor.inputDigest !== maintenanceSummaryInputDigest({ historyEpoch: intent.historyEpoch,
          expectedSummaryRound: Number(before.summaryRound), targetRound: Number(after.summaryRound),
          baseSummaryDigest: String(anchor.baseSummaryDigest), sourceEvidence: anchor.sourceEvidence as MaintenanceMessageEvidenceBinding[] })
        || marker.receipt.status !== 'committed' || marker.receipt.writes !== 1 || marker.receipt.deduped !== false
        || marker.receipt.throughRound !== after.summaryRound || marker.receipt.writeDigest !== digest(after)
        || marker.receipt.committedAt !== intent.committedAt || marker.receipt.agentLoopOriginDigest !== origin.originDigest) {
        throw new Error('agent-loop-summary-artifact-invalid');
      }
      // The original proposal/context protocol is byte-based, not key-sorted.
      // The only two legal payload fields have two possible original orders;
      // recover the one bound by its durable digest instead of changing history.
      const payloads = [{ summary: after.longterm, throughRound: Number(after.summaryRound) },
        { throughRound: Number(after.summaryRound), summary: after.longterm }];
      const proposals = payloads.map(payload => Object.freeze({ taskKind: 'rolling_summary' as const,
        payload: Object.freeze(payload) }));
      const matching = proposals.filter(proposal => digest(proposal) === origin.proposalDigest
        && digest(proposal) === intent.proposalDigest && digest(proposal) === readback.proposalDigest);
      if (matching.length !== 1) throw new Error('agent-loop-summary-artifact-invalid');
      return Object.freeze({ proposal: matching[0]!, evidence });
    });
    if (this.binding.memory.db.isTransaction !== false) throw new Error('agent-loop-summary-artifact-outer-transaction');
    return result;
  }

  #readAgentLoopSummaryWriteEvidenceInTransaction(runId: string): AgentLoopSummaryWriteHistoricalEvidence | null {
    const record = this.#summaryWriteReceipts.readAgentLoopOriginInTransaction(runId);
    const marker = readMarker(this.binding.memory, this.binding.sessionId, runId);
    if (!record) {
      if (marker?.receipt.agentLoopOriginDigest !== undefined) throw new Error('agent-loop-summary-evidence-origin-missing');
      return null;
    }
    const history = this.#readSummaryWriteEvidenceInTransaction(runId), origin = record.origin;
    if (!marker || !history || marker.taskKind !== 'rolling_summary'
      || history.intent.intentDigest !== record.intentDigest || history.intent.operationDigest !== record.operationDigest
      || history.intent.committedAt !== record.committedAt || history.intent.runId !== origin.runId
      || history.intent.sessionId !== origin.sessionId || history.intent.sourceRevision !== origin.sourceRevision
      || history.intent.proposalDigest !== origin.proposalDigest
      || marker.status === 'applied' && (marker.receipt.agentLoopOriginDigest !== origin.originDigest
        || digest(marker) !== record.operationDigest)) throw new Error('agent-loop-summary-evidence-origin-conflict');
    return Object.freeze({ ...history, origin });
  }

  #readSummaryWriteEvidenceInTransaction(runId: string): SummaryWriteHistoricalEvidence | null {
    if (this.binding.memory.db.isTransaction !== true) throw new Error('summary-write-evidence-transaction-required');
    const marker = readMarker(this.binding.memory, this.binding.sessionId, runId);
    const history = this.#summaryWriteReceipts.readHistoryInTransaction(runId);
    if (!marker || !history) return null;
    const expected = history.intent;
    const updatedAt = agentClosureTimestamp(marker.updatedAt, 'summary-operation-updated-at');
    if (marker.taskKind !== 'rolling_summary' || marker.sessionId !== expected.sessionId
      || marker.runId !== expected.runId || marker.sourceRevision !== expected.sourceRevision
      || marker.proposalDigest !== expected.proposalDigest || updatedAt < expected.committedAt
      || (marker.status === 'applied' && (history.state === 'invalidated'
        || digest(marker) !== expected.operationDigest))
      || (marker.status === 'rolled_back' && (marker.receipt.status !== 'rolled_back'
        || marker.receipt.taskKind !== 'rolling_summary' || marker.receipt.runId !== runId
        || marker.receipt.sessionId !== expected.sessionId
        || marker.receipt.proposalDigest !== expected.proposalDigest
        || (history.readback !== null && updatedAt < history.readback.verifiedAt)))) {
      throw new Error('summary-write-evidence-operation-drift');
    }
    return Object.freeze({ intent: expected, state: marker.status, readback: history.readback, updatedAt,
      ...(marker.status === 'rolled_back' ? {
        rollbackDigest: typeof marker.receipt.rollbackDigest === 'string'
          && marker.receipt.rollbackDigest === summaryRollbackDigest(marker, updatedAt)
          ? marker.receipt.rollbackDigest : digest(marker.receipt),
      } : {}) });
  }

  /** A unique current owner binds retrieval; matching current bytes alone cannot select an old producer. */
  readSummaryRetrievalLineage(summary: SummaryRetrievalIdentity): SummaryWriteHistoricalEvidence | null {
    if (this.binding.memory.db.isTransaction !== false) throw new Error('summary-retrieval-outer-transaction');
    const result = this.binding.memory.transaction(() => this.readSummaryRetrievalLineageInTransaction(summary));
    if (this.binding.memory.db.isTransaction !== false) throw new Error('summary-retrieval-outer-transaction');
    return result;
  }

  /** Current consistency is checked inside the consumer transaction without reconstructing historical readback. */
  readSummaryRetrievalLineageInTransaction(summary: SummaryRetrievalIdentity): SummaryWriteHistoricalEvidence | null {
    if (this.binding.memory.db.isTransaction !== true) throw new Error('summary-retrieval-transaction-required');
    if (!summary || !/^sha256:[a-f0-9]{64}$/u.test(summary.summaryDigest)
      || !Number.isSafeInteger(summary.throughRound) || summary.throughRound < 1
      || !Number.isSafeInteger(summary.historyEpoch) || summary.historyEpoch < 0) {
      throw new Error('summary-retrieval-identity-invalid');
    }
    const stored = this.binding.memory.db.prepare(
      'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
    ).get(this.binding.sessionId, SUMMARY_CURRENT_OWNER_KEY) as { value: string } | undefined;
    if (!stored || typeof stored.value !== 'string' || stored.value.length > 2_048) return null;
    try {
      const owner = JSON.parse(stored.value) as { runId: string };
      const history = this.#readSummaryWriteEvidenceInTransaction(owner.runId);
      if (!history || history.state !== 'applied' || !history.readback
        || JSON.stringify(this.#summaryCurrentOwner(history.intent)) !== stored.value) return null;
      const expected = history.intent;
      if (expected.summaryDigest !== summary.summaryDigest || expected.throughRound !== summary.throughRound
        || expected.historyEpoch !== summary.historyEpoch) return null;
      const current = this.binding.memory.db.prepare(
        "SELECT COALESCE(longterm,'') longterm,COALESCE(summary_round,0) summaryRound FROM memory_meta WHERE id=1",
      ).get() as { longterm: string; summaryRound: number } | undefined;
      if (!current || typeof current.longterm !== 'string' || digest(current.longterm) !== summary.summaryDigest
        || current.summaryRound !== summary.throughRound
        || historyEpoch(this.binding.memory, this.binding.sessionId) !== summary.historyEpoch) return null;
      return history;
    } catch (error) {
      if (this.binding.memory.db.isTransaction !== true) throw error;
      return null;
    }
  }

  #summaryCurrentOwner(expected: SummaryWriteIntent): MaintenanceRollingSummaryCurrentOwner {
    return Object.freeze({
      version: 'maintenance-summary-current-owner-v1', runId: expected.runId,
      intentDigest: expected.intentDigest, operationDigest: expected.operationDigest,
      targetRevision: expected.targetRevision, summaryDigest: expected.summaryDigest,
      throughRound: expected.throughRound, historyEpoch: expected.historyEpoch,
    });
  }

  #setSummaryCurrentOwner(expected: SummaryWriteIntent | null, required = false): void {
    let opened = false;
    try {
      this.binding.memory.db.exec('SAVEPOINT summary_current_owner;');
      opened = true;
      this.binding.memory.db.prepare('DELETE FROM session_control WHERE session_key=? AND control_key=?')
        .run(this.binding.sessionId, SUMMARY_CURRENT_OWNER_KEY);
      if (expected) {
        this.binding.memory.db.prepare(
          'INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)',
        ).run(this.binding.sessionId, SUMMARY_CURRENT_OWNER_KEY,
          JSON.stringify(this.#summaryCurrentOwner(expected)), this.now());
      }
      this.binding.memory.db.exec('RELEASE summary_current_owner;');
    } catch (error) {
      if (this.binding.memory.db.isTransaction !== true) throw error;
      if (opened) this.binding.memory.db.exec('ROLLBACK TO summary_current_owner; RELEASE summary_current_owner;');
      if (required) throw error;
      // Monotonic summary watermarks and the mandatory history epoch also fence any retained old owner.
    }
  }

  /** Current retrieval consistency cannot mint or replace an already persisted historical readback. */
  readMemoryRetrievalLineage(hits: readonly MemoryRetrievalHitIdentity[]): readonly MemoryWriteHistoricalEvidence[] {
    if (this.binding.memory.db.isTransaction !== false) throw new Error('memory-retrieval-outer-transaction');
    const result = this.binding.memory.transaction(() => this.readMemoryRetrievalLineageInTransaction(hits));
    if (this.binding.memory.db.isTransaction !== false) throw new Error('memory-retrieval-outer-transaction');
    return result;
  }

  /** The final turn transaction rechecks current ownership without changing the historical receipt. */
  readMemoryRetrievalLineageInTransaction(hits: readonly MemoryRetrievalHitIdentity[]):
    readonly MemoryWriteHistoricalEvidence[] {
    if (this.binding.memory.db.isTransaction !== true) throw new Error('memory-retrieval-transaction-required');
    if (!Array.isArray(hits) || hits.length > MAX_MEMORY_RETRIEVAL_HITS) {
      throw new Error('memory-retrieval-hit-limit');
    }
    const facts = new Map<string, NonNullable<ReturnType<typeof readRetrievalFact>>>();
    const owners = new Set<string>();
    for (const hit of hits) {
      const fact = readRetrievalFact(this.binding.memory, this.binding.sessionId, hit);
      if (!fact) continue;
      facts.set(fact.marker.factDigest, fact);
      for (const owner of fact.marker.owners) {
        owners.add(owner);
        if (owners.size > MAX_MEMORY_RETRIEVAL_OWNERS) throw new Error('memory-retrieval-owner-limit');
      }
    }
    const evidence: MemoryWriteHistoricalEvidence[] = [];
    for (const runId of [...owners].sort()) {
      try {
        const historical = this.#readMemoryWriteEvidenceInTransaction(runId);
        if (!historical || historical.state !== 'applied' || historical.readback === null) continue;
        const covered = historical.intent.facts.every((expected) => {
          const current = facts.get(expected.factDigest);
          return current !== undefined && current.marker.rowId === expected.rowId
            && current.marker.owners.includes(runId) && current.rowDigest === expected.rowDigest;
        });
        if (covered) evidence.push(historical);
      } catch (error) {
        if (this.binding.memory.db.isTransaction !== true) throw error;
        // One damaged owner's optional lineage cannot attest another owner or block normal retrieval.
      }
    }
    if (this.binding.memory.db.isTransaction !== true) throw new Error('memory-retrieval-transaction-required');
    return Object.freeze(evidence);
  }

  #readMemoryWriteEvidenceInTransaction(runId: string): MemoryWriteHistoricalEvidence | null {
    if (this.binding.memory.db.isTransaction !== true) throw new Error('memory-write-evidence-transaction-required');
    const marker = readMarker(this.binding.memory, this.binding.sessionId, runId);
    const history = this.#writeReceipts.readHistoryInTransaction(runId);
    if (!marker || !history) return null;
    const expected = history.intent;
    const updatedAt = agentClosureTimestamp(marker.updatedAt, 'memory-operation-updated-at');
    if (marker.taskKind !== 'memory_consolidation' || marker.sessionId !== expected.sessionId
      || marker.runId !== expected.runId || marker.sourceRevision !== expected.sourceRevision
      || marker.proposalDigest !== expected.proposalDigest || updatedAt < expected.committedAt
      || (marker.status === 'applied' && (history.state === 'invalidated'
        || digest(marker) !== expected.operationDigest))
      || (marker.status === 'rolled_back' && (marker.receipt.status !== 'rolled_back'
        || marker.receipt.taskKind !== 'memory_consolidation' || marker.receipt.runId !== runId
        || marker.receipt.sessionId !== expected.sessionId || marker.receipt.proposalDigest !== expected.proposalDigest
        || (history.readback !== null && updatedAt < history.readback.verifiedAt)))) {
      throw new Error('memory-write-evidence-operation-drift');
    }
    return Object.freeze({ intent: expected, state: marker.status, readback: history.readback, updatedAt,
      ...(marker.status === 'rolled_back' ? {
        rollbackDigest: typeof marker.receipt.rollbackDigest === 'string'
          && marker.receipt.rollbackDigest === memoryRollbackDigest(marker, updatedAt)
          ? marker.receipt.rollbackDigest : digest(marker.receipt),
      } : {}) });
  }

  #withDomainReadback(result: MemorySummaryCommitResult, runId: string): MemorySummaryCommitResult {
    if (result.status === 'committed' && result.receipt.taskKind === 'rolling_summary') {
      return this.#withSummaryReadback(result, runId);
    }
    if (result.status !== 'committed' || result.receipt.taskKind !== 'memory_consolidation') return result;
    let readback: MemoryWriteReadback;
    let targetRevision: string | null = null;
    try {
      const fresh = this.#freshReadbacks.get(result);
      this.#freshReadbacks.delete(result);
      targetRevision = fresh?.targetRevision ?? this.#writeReceipts.targetRevision(runId);
      readback = fresh ? this.#writeReceipts.verifyFresh(fresh) : this.#writeReceipts.recorded(runId);
    } catch {
      readback = Object.freeze({ status: 'unavailable', reasonCode: 'memory-readback-unavailable' });
    }
    // The old in-transaction anchor digest is never allowed to masquerade as authoritative readback.
    const { readbackDigest: _legacy, readback: _previous, ...receipt } = result.receipt;
    targetRevision ??= digest({ runId, sessionId: receipt.sessionId, proposalDigest: receipt.proposalDigest });
    return Object.freeze({ ...result, receipt: Object.freeze({ ...receipt, targetRevision, readback }) });
  }

  #withSummaryReadback(result: Extract<MemorySummaryCommitResult, { status: 'committed' }>,
    runId: string): MemorySummaryCommitResult {
    let readback: SummaryWriteReadback;
    let targetRevision: string | null = null;
    try {
      const fresh = this.#freshSummaryReadbacks.get(result);
      this.#freshSummaryReadbacks.delete(result);
      targetRevision = fresh?.targetRevision ?? this.#summaryWriteReceipts.targetRevision(runId);
      readback = fresh ? this.#summaryWriteReceipts.verifyFresh(fresh) : this.#summaryWriteReceipts.recorded(runId);
    } catch {
      readback = Object.freeze({ status: 'unavailable', reasonCode: 'summary-readback-unavailable' });
    }
    const { readbackDigest: _legacy, readback: _previous, ...receipt } = result.receipt;
    targetRevision ??= digest({ runId, sessionId: receipt.sessionId, proposalDigest: receipt.proposalDigest });
    return Object.freeze({ ...result, receipt: Object.freeze({ ...receipt, targetRevision, readback }) });
  }

  #factWriteProjection(runId: string, facts: readonly { factDigest: string; rowId: number }[]):
    readonly MemoryWriteFactProjection[] {
    return facts.map((fact) => {
      const ledger = readFactMarker(this.binding.memory, this.binding.sessionId, fact.factDigest);
      if (!ledger || ledger.rowId !== fact.rowId || !ledger.owners.includes(runId)) {
        throw new Error('memory-readback-ownership-drift');
      }
      const row = this.binding.memory.db.prepare(
        'SELECT id,code,description,characters,refs,resolved FROM memory_event WHERE id=?',
      ).get(fact.rowId) as Record<string, unknown> | undefined;
      if (!row || row.id !== ledger.rowId || row.code !== ledger.code || row.description !== ledger.description
        || row.characters !== ledger.characters || row.refs !== ledger.refs || row.resolved !== ledger.resolved) {
        throw new Error('memory-readback-fact-drift');
      }
      return Object.freeze({ factDigest: fact.factDigest, rowId: fact.rowId,
        rowDigest: digest(row), ledgerDigest: digest({ ...ledger, owners: [...ledger.owners].sort() }) });
    });
  }

  #memoryWriteProjection(expected: MemoryWriteIntent): MemoryWriteProjection | null {
    const marker = readMarker(this.binding.memory, this.binding.sessionId, expected.runId);
    if (!marker || marker.status !== 'applied' || marker.taskKind !== 'memory_consolidation') return null;
    const head = this.binding.memory.db.prepare(
      'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
    ).get(this.binding.sessionId, TRUTH_VERSION_KEY) as { value: string } | undefined;
    return Object.freeze({ operationDigest: digest(marker), truthVersion: Number(head?.value),
      historyEpoch: historyEpoch(this.binding.memory, this.binding.sessionId),
      facts: this.#factWriteProjection(expected.runId, expected.facts) });
  }

  #summaryWriteProjection(expected: SummaryWriteIntent): SummaryWriteProjection | null {
    const marker = readMarker(this.binding.memory, this.binding.sessionId, expected.runId);
    if (!marker || marker.status !== 'applied' || marker.taskKind !== 'rolling_summary') return null;
    const summary = this.binding.memory.db.prepare(
      "SELECT COALESCE(longterm,'') longterm,COALESCE(summary_round,0) summaryRound FROM memory_meta WHERE id=1",
    ).get() as { longterm: string; summaryRound: number } | undefined;
    if (!summary || typeof summary.longterm !== 'string') return null;
    const head = this.binding.memory.db.prepare(
      'SELECT value FROM session_control WHERE session_key=? AND control_key=?',
    ).get(this.binding.sessionId, TRUTH_VERSION_KEY) as { value: string } | undefined;
    return Object.freeze({ operationDigest: digest(marker), throughRound: summary.summaryRound,
      summaryDigest: digest(summary.longterm), truthVersion: Number(head?.value),
      historyEpoch: historyEpoch(this.binding.memory, this.binding.sessionId) });
  }

  /**
   * Reconcile durable Memory/Summary operations after regenerate/delete has
   * restored the session ledger and advanced historyEpoch. The caller invokes
   * this inside the session transaction, so business truth and operation
   * markers either roll back together or not at all.
   */
  reconcileHistoryRollback(rollbackRound: number): MemorySummaryHistoryReconcileResult {
    if (!Number.isSafeInteger(rollbackRound) || rollbackRound < 1) {
      throw new Error('maintenance-history-rollback-round-invalid');
    }
    return this.binding.memory.transaction(() => {
      const rolledBackRunIds: string[] = [];
      for (const marker of appliedMarkers(this.binding.memory, this.binding.sessionId)) {
        let affected = false;
        let alreadyRestored = false;
        if (marker.taskKind === 'memory_consolidation') {
          const facts = marker.rollbackAnchor.facts;
          if (!Array.isArray(facts) || facts.length < 1) {
            affected = true; // Legacy anchor: fail safe rather than retain unprovable truth.
          } else {
            affected = facts.some((candidate) => {
              if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true;
              const fact = candidate as Record<string, unknown>;
              if (!Number.isSafeInteger(fact.effectiveRound)
                || !Array.isArray(fact.sourceEvidence)) return true;
              const evidence = fact.sourceEvidence as readonly MaintenanceMessageEvidenceBinding[];
              return Number(fact.effectiveRound) >= rollbackRound
                || evidence.some((row) => row.round >= rollbackRound)
                || !evidenceSetMatches(this.binding.memory, evidence);
            });
          }
          if (affected) this.#rollbackMemory(marker.rollbackAnchor);
        } else {
          const before = marker.rollbackAnchor.before;
          const after = marker.rollbackAnchor.after;
          if (!before || typeof before !== 'object' || Array.isArray(before)
            || !after || typeof after !== 'object' || Array.isArray(after)) {
            throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
          }
          const beforeRow = before as Record<string, unknown>;
          const afterRow = after as Record<string, unknown>;
          if (!Number.isSafeInteger(afterRow.summaryRound)) {
            throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
          }
          affected = Number(afterRow.summaryRound) >= rollbackRound;
          if (affected) {
            const current = this.binding.memory.db.prepare(
              `SELECT COALESCE(longterm,'') longterm,
                      COALESCE(summary_round,0) summaryRound
               FROM memory_meta WHERE id=1`,
            ).get() as { longterm: string; summaryRound: number } | undefined;
            if (!current) throw new Error('maintenance-summary-rollback-conflict');
            if (current.longterm === afterRow.longterm
              && current.summaryRound === afterRow.summaryRound) {
              this.#rollbackSummary(marker.rollbackAnchor);
            } else if (typeof beforeRow.longterm === 'string'
              && Number.isSafeInteger(beforeRow.summaryRound)
              && current.summaryRound <= Number(beforeRow.summaryRound)) {
              // round_ledger already restored this operation's before-image (or
              // an even earlier one); only the operation marker needs repair.
              alreadyRestored = true;
            } else {
              throw new Error('maintenance-summary-rollback-conflict');
            }
          }
        }
        if (!affected) continue;
        const rollbackAt = this.now();
        const receipt = Object.freeze({
          status: 'rolled_back', taskKind: marker.taskKind, runId: marker.runId,
          sessionId: marker.sessionId, proposalDigest: marker.proposalDigest,
          deduped: false, reason: 'history-rewrite-reconciled', rollbackRound,
          alreadyRestored,
          ...(marker.taskKind === 'memory_consolidation'
            ? { rollbackDigest: memoryRollbackDigest(marker, rollbackAt), rolledBackAt: rollbackAt }
            : { rollbackDigest: summaryRollbackDigest(marker, rollbackAt), rolledBackAt: rollbackAt }),
        });
        writeMarker(this.binding.memory, Object.freeze({
          ...marker,
          status: 'rolled_back',
          receipt,
          updatedAt: rollbackAt,
        }));
        if (marker.taskKind === 'memory_consolidation') this.#writeReceipts.invalidate(marker.runId);
        else this.#summaryWriteReceipts.invalidate(marker.runId);
        rolledBackRunIds.push(marker.runId);
      }
      if (rolledBackRunIds.length > 0) {
        bumpTruthVersion(this.binding.memory, this.binding.sessionId, this.now());
      }
      return Object.freeze({
        rollbackRound,
        rolledBackRunIds: Object.freeze(rolledBackRunIds),
      });
    });
  }

  rollback(anchorValue: Readonly<Record<string, unknown>>): MemorySummaryRollbackResult {
    const runId = String(anchorValue.runId ?? '');
    const sessionId = String(anchorValue.sessionId ?? '');
    const proposalDigest = String(anchorValue.proposalDigest ?? '');
    if (sessionId !== this.binding.sessionId) throw new Error('maintenance-memory-summary-session-conflict');
    return this.binding.memory.transaction(() => {
      const marker = readMarker(this.binding.memory, sessionId, runId);
      if (!marker || marker.proposalDigest !== proposalDigest) {
        throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
      }
      if (marker.status === 'rolled_back') {
        return Object.freeze({
          ...marker.receipt,
          deduped: true,
        });
      }
      if (digest(marker.rollbackAnchor) !== digest(anchorValue)) {
        throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
      }
      if (marker.taskKind === 'memory_consolidation') this.#rollbackMemory(marker.rollbackAnchor);
      else this.#rollbackSummary(marker.rollbackAnchor);
      bumpTruthVersion(this.binding.memory, sessionId, this.now());
      const rollbackAt = this.now();
      const receipt = Object.freeze({
        status: 'rolled_back', taskKind: marker.taskKind, runId, sessionId,
        proposalDigest, deduped: false,
        ...(marker.taskKind === 'memory_consolidation'
          ? { rollbackDigest: memoryRollbackDigest(marker, rollbackAt), rolledBackAt: rollbackAt }
          : { rollbackDigest: summaryRollbackDigest(marker, rollbackAt), rolledBackAt: rollbackAt }),
      });
      writeMarker(this.binding.memory, Object.freeze({
        ...marker,
        status: 'rolled_back',
        receipt,
        updatedAt: rollbackAt,
      }));
      if (marker.taskKind === 'memory_consolidation') this.#writeReceipts.invalidate(marker.runId);
      else this.#summaryWriteReceipts.invalidate(marker.runId);
      return receipt;
    });
  }

  #commitMemory(
    pending: MaintenancePendingProposalRecordLike,
    proposalDigest: string,
  ): MemorySummaryCommitResult {
    if (!isMemoryConsolidationProposalContext(pending.context)
      || !isMemoryConsolidationApplyContext(pending.context)) {
      throw new Error('maintenance-memory-context-invalid');
    }
    const context = pending.context;
    const proposal = normalizeMemoryConsolidationProposal(pending.proposal.payload, context);
    if (proposal.sessionId !== pending.sessionId || proposal.sourceRevision !== pending.sourceRevision) {
      throw new Error('maintenance-memory-context-mismatch');
    }
    if (historyEpoch(this.binding.memory, pending.sessionId) !== context.historyEpoch
      || !evidenceSetMatches(this.binding.memory, context.sourceEvidence)) {
      return stale(this.currentRevision(pending.sessionId));
    }
    const eligibleFacts = proposal.facts.filter((fact) => (
      fact.status === 'confirmed' && fact.confidence === 'high'
    ));
    if (eligibleFacts.length < 1) throw new Error('maintenance-memory-no-confirmed-writes');
    const factAnchors: Array<Record<string, unknown>> = [];
    let writes = 0;
    let reused = 0;
    const createdAt = this.now();
    eligibleFacts.forEach((fact, index) => {
      // Evidence round/source refs belong to the per-run proposal/audit, not the
      // durable semantic identity. A later run that proves the same fact merely
      // acquires another owner of the existing truth row.
      const identity = canonicalMemoryFactIdentity(fact);
      const factDigest = digest(identity);
      const code = `MEM:${factDigest.slice('sha256:'.length)}`;
      const description = renderMemoryFact(identity);
      const characters = JSON.stringify([identity.subject]);
      const proposedRefs = JSON.stringify(fact.sourceRefs);
      let factMarker = readFactMarker(this.binding.memory, pending.sessionId, factDigest);
      if (factMarker) {
        if (factMarker.code !== code || factMarker.description !== description
          || factMarker.characters !== characters
          || !exactFactRow(this.binding.memory, factMarker)) {
          throw new Error('maintenance-memory-fact-ledger-conflict');
        }
        if (!factMarker.owners.includes(pending.jobRunId)) {
          factMarker = Object.freeze({
            ...factMarker,
            owners: Object.freeze([...factMarker.owners, pending.jobRunId].sort()),
          });
          writeFactMarker(this.binding.memory, pending.sessionId, factMarker, createdAt);
        }
        reused += 1;
      } else {
        const existing = this.binding.memory.db.prepare(
          `SELECT id,code,description,characters,refs,resolved FROM memory_event
           WHERE code=? AND description=? AND characters=? AND resolved=0 AND typeof(refs)='text'
           ORDER BY id LIMIT 1`,
        ).get(code, description, characters) as Record<string, unknown> | undefined;
        let createdByMaintenance = false;
        let rowId: number;
        let storedRefs: string;
        if (existing && Number.isSafeInteger(existing.id)) {
          rowId = Number(existing.id);
          storedRefs = String(existing.refs);
          reused += 1;
        } else {
          rowId = Number(this.binding.memory.db.prepare(
            `INSERT INTO memory_event(code,description,characters,refs,resolved,last_access_ms)
             VALUES(?,?,?,?,0,?)`,
          ).run(code, description, characters, proposedRefs,
            Date.parse(createdAt) || Date.now()).lastInsertRowid);
          // A deleted tail row may have left an active embedding under this
          // reused row id.  It cannot represent the newly inserted fact.
          clearEventVectors(this.binding.memory, rowId);
          storedRefs = proposedRefs;
          createdByMaintenance = true;
          writes += 1;
        }
        factMarker = Object.freeze({
          version: 'maintenance-memory-fact-v1', factDigest, rowId, code, description,
          characters, refs: storedRefs, resolved: 0 as const, createdByMaintenance,
          owners: Object.freeze([pending.jobRunId]),
        });
        if (!exactFactRow(this.binding.memory, factMarker)) {
          throw new Error('maintenance-memory-readback-failed');
        }
        writeFactMarker(this.binding.memory, pending.sessionId, factMarker, createdAt);
      }
      if (!exactFactRow(this.binding.memory, factMarker)) {
        throw new Error('maintenance-memory-readback-failed');
      }
      factAnchors.push(Object.freeze({
        index, factDigest, rowId: factMarker.rowId,
        effectiveRound: fact.effectiveRound,
        sourceRefs: Object.freeze([...fact.sourceRefs]),
        sourceEvidence: Object.freeze(context.sourceEvidence
          .filter((row) => fact.sourceRefs.includes(row.ref))
          .map((row) => Object.freeze({ ...row }))),
      }));
    });
    const rollbackAnchor = Object.freeze({
      version: 'memory-summary-maintenance-rollback-v1',
      taskKind: 'memory_consolidation', runId: pending.jobRunId,
      sessionId: pending.sessionId, proposalDigest,
      historyEpoch: context.historyEpoch,
      facts: Object.freeze(factAnchors.map((row) => Object.freeze({ ...row }))),
    });
    const receipt = Object.freeze({
      status: 'committed', taskKind: 'memory_consolidation', runId: pending.jobRunId,
      sessionId: pending.sessionId, sourceRevision: pending.sourceRevision,
      proposalDigest, writes, reusedFacts: reused,
      deferredFacts: proposal.facts.length - eligibleFacts.length,
      writeDigest: digest(factAnchors), deduped: writes === 0, committedAt: createdAt,
    });
    const marker: OperationMarker = Object.freeze({
      version: 'memory-summary-maintenance-operation-v1', status: 'applied',
      taskKind: 'memory_consolidation', runId: pending.jobRunId,
      sessionId: pending.sessionId, sourceRevision: pending.sourceRevision,
      proposalDigest, receipt, rollbackAnchor, updatedAt: createdAt,
    });
    writeMarker(this.binding.memory, marker);
    const truthVersion = bumpTruthVersion(this.binding.memory, pending.sessionId, createdAt);
    const result = Object.freeze({ status: 'committed' as const, receipt, rollbackAnchor });
    try {
      const expected = this.#writeReceipts.stage({
        intentVersion: 'maintenance-memory-write-intent-v1', runId: pending.jobRunId,
        sessionId: pending.sessionId, sourceRevision: pending.sourceRevision, proposalDigest,
        committedAt: createdAt, operationDigest: digest(marker), truthVersion, historyEpoch: context.historyEpoch,
        facts: this.#factWriteProjection(pending.jobRunId, factAnchors.map((fact) => ({
          factDigest: String(fact.factDigest), rowId: Number(fact.rowId),
        }))),
      });
      if (expected) this.#freshReadbacks.set(result, expected);
    } catch { /* Explicit unavailable readback is returned; the mandatory business ledger remains authoritative. */ }
    return result;
  }

  #commitSummary(
    pending: MaintenancePendingProposalRecordLike,
    proposalDigest: string,
    agentLoopOrigin?: AgentLoopSummaryWriteOrigin,
  ): MemorySummaryCommitResult {
    if (!isRollingSummaryApplyContext(pending.context)) {
      throw new Error('maintenance-summary-context-invalid');
    }
    const context = pending.context;
    const validated = validateMaintenanceProposal('rolling_summary', pending.proposal.payload, context);
    const summary = String(validated.payload.summary);
    const throughRound = Number(validated.payload.throughRound);
    if (context.sessionId !== pending.sessionId || context.sourceRevision !== pending.sourceRevision) {
      throw new Error('maintenance-summary-context-mismatch');
    }
    if (historyEpoch(this.binding.memory, pending.sessionId) !== context.historyEpoch
      || !evidenceSetMatches(this.binding.memory, context.sourceEvidence)
      || maintenanceSummaryInputDigest({
        historyEpoch: context.historyEpoch,
        expectedSummaryRound: context.expectedSummaryRound,
        targetRound: context.targetRound,
        baseSummaryDigest: context.baseSummaryDigest,
        sourceEvidence: context.sourceEvidence,
      }) !== context.inputDigest) {
      return stale(this.currentRevision(pending.sessionId));
    }
    const before = this.binding.memory.db.prepare(
      'SELECT COALESCE(longterm,\'\') longterm,COALESCE(summary_round,0) summaryRound,COALESCE(plot_round,0) plotRound FROM memory_meta WHERE id=1',
    ).get() as { longterm: string; summaryRound: number; plotRound: number } | undefined;
    if (!before || before.summaryRound !== context.expectedSummaryRound
      || maintenanceValueDigest(before.longterm) !== context.baseSummaryDigest
      || before.summaryRound >= throughRound || before.plotRound < throughRound) {
      return stale(this.currentRevision(pending.sessionId));
    }
    const changed = this.binding.memory.db.prepare(
      `UPDATE memory_meta SET longterm=?,summary_round=?
       WHERE id=1 AND COALESCE(summary_round,0)=? AND COALESCE(longterm,'')=?
         AND COALESCE(plot_round,0)>=?`,
    ).run(summary, throughRound, before.summaryRound, before.longterm, throughRound);
    if (changed.changes !== 1) {
      return stale(this.currentRevision(pending.sessionId));
    }
    const after = this.binding.memory.db.prepare(
      'SELECT COALESCE(longterm,\'\') longterm,COALESCE(summary_round,0) summaryRound FROM memory_meta WHERE id=1',
    ).get() as { longterm: string; summaryRound: number } | undefined;
    if (!after || after.longterm !== summary || after.summaryRound !== throughRound) {
      throw new Error('maintenance-summary-readback-failed');
    }
    const rollbackAnchor = Object.freeze({
      version: 'memory-summary-maintenance-rollback-v1',
      taskKind: 'rolling_summary', runId: pending.jobRunId,
      sessionId: pending.sessionId, proposalDigest,
      historyEpoch: context.historyEpoch,
      baseSummaryDigest: context.baseSummaryDigest,
      inputDigest: context.inputDigest,
      sourceEvidence: Object.freeze(context.sourceEvidence.map((row) => Object.freeze({ ...row }))),
      before: Object.freeze({ longterm: before.longterm, summaryRound: before.summaryRound }),
      after: Object.freeze({ longterm: summary, summaryRound: throughRound }),
    });
    const committedAt = this.now();
    const receipt = Object.freeze({
      status: 'committed', taskKind: 'rolling_summary', runId: pending.jobRunId,
      sessionId: pending.sessionId, sourceRevision: pending.sourceRevision,
      proposalDigest, writes: 1, throughRound,
      writeDigest: digest(after), deduped: false, committedAt,
      ...(agentLoopOrigin ? { agentLoopOriginDigest: agentLoopOrigin.originDigest } : {}),
    });
    const marker: OperationMarker = Object.freeze({
      version: 'memory-summary-maintenance-operation-v1', status: 'applied',
      taskKind: 'rolling_summary', runId: pending.jobRunId,
      sessionId: pending.sessionId, sourceRevision: pending.sourceRevision,
      proposalDigest, receipt, rollbackAnchor, updatedAt: committedAt,
    });
    writeMarker(this.binding.memory, marker);
    const truthVersion = bumpTruthVersion(this.binding.memory, pending.sessionId, committedAt);
    const result = Object.freeze({ status: 'committed' as const, receipt, rollbackAnchor });
    this.#setSummaryCurrentOwner(null, agentLoopOrigin !== undefined);
    try {
      const input = {
        intentVersion: 'maintenance-summary-write-intent-v1', runId: pending.jobRunId,
        sessionId: pending.sessionId, sourceRevision: pending.sourceRevision, proposalDigest, committedAt,
        operationDigest: digest(marker), throughRound, summaryDigest: digest(summary), truthVersion,
        historyEpoch: context.historyEpoch,
      } as const;
      const expected = agentLoopOrigin ? this.#summaryWriteReceipts.stageAgentLoop(input, agentLoopOrigin)
        : this.#summaryWriteReceipts.stage(input);
      if (expected) {
        this.#setSummaryCurrentOwner(expected, agentLoopOrigin !== undefined);
        this.#freshSummaryReadbacks.set(result, expected);
      }
    } catch (error) {
      if (this.binding.memory.db.isTransaction !== true) throw error;
      if (agentLoopOrigin) throw error;
      // Optional evidence cannot undo the existing Summary business transaction.
    }
    return result;
  }

  #rollbackMemory(anchor: Readonly<Record<string, unknown>>): void {
    const facts = anchor.facts;
    const runId = String(anchor.runId ?? '');
    const sessionId = String(anchor.sessionId ?? '');
    if (!Array.isArray(facts) || !/^mjob_[a-f0-9]{32}$/u.test(runId)
      || sessionId !== this.binding.sessionId) {
      throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
    }
    const markers: MemoryFactMarker[] = [];
    for (const candidate of facts) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
      }
      const row = candidate as Record<string, unknown>;
      if (!Number.isSafeInteger(row.rowId) || typeof row.factDigest !== 'string') {
        throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
      }
      const marker = readFactMarker(this.binding.memory, sessionId, row.factDigest);
      if (!marker || marker.rowId !== Number(row.rowId) || !marker.owners.includes(runId)
        || !exactFactRow(this.binding.memory, marker)) {
        throw new Error('maintenance-memory-summary-rollback-conflict');
      }
      markers.push(marker);
    }
    for (const marker of markers) {
      const owners = marker.owners.filter((owner) => owner !== runId);
      if (owners.length > 0) {
        writeFactMarker(this.binding.memory, sessionId, Object.freeze({
          ...marker,
          owners: Object.freeze(owners),
        }), this.now());
        continue;
      }
      if (marker.createdByMaintenance) {
        // Remove the derived vector before removing its source row.  Both
        // statements share the enclosing transaction, so a later conflict
        // restores them together.
        clearEventVectors(this.binding.memory, marker.rowId);
        const deleted = this.binding.memory.db.prepare(
          `DELETE FROM memory_event WHERE id=? AND code=? AND description=?
           AND characters=? AND refs=? AND resolved=0`,
        ).run(marker.rowId, marker.code, marker.description, marker.characters, marker.refs);
        if (deleted.changes !== 1) throw new Error('maintenance-memory-summary-rollback-conflict');
      }
      const ledgerDeleted = this.binding.memory.db.prepare(
        'DELETE FROM session_control WHERE session_key=? AND control_key=?',
      ).run(sessionId, factKey(marker.factDigest));
      if (ledgerDeleted.changes !== 1) throw new Error('maintenance-memory-summary-rollback-conflict');
    }
  }

  #rollbackSummary(anchor: Readonly<Record<string, unknown>>): void {
    const before = anchor.before;
    const after = anchor.after;
    if (!before || typeof before !== 'object' || Array.isArray(before)
      || !after || typeof after !== 'object' || Array.isArray(after)) {
      throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
    }
    const beforeRow = before as Record<string, unknown>;
    const afterRow = after as Record<string, unknown>;
    if (typeof beforeRow.longterm !== 'string' || !Number.isSafeInteger(beforeRow.summaryRound)
      || typeof afterRow.longterm !== 'string' || !Number.isSafeInteger(afterRow.summaryRound)) {
      throw new Error('maintenance-memory-summary-rollback-anchor-invalid');
    }
    const current = this.binding.memory.db.prepare(
      'SELECT COALESCE(longterm,\'\') longterm,COALESCE(summary_round,0) summaryRound FROM memory_meta WHERE id=1',
    ).get() as { longterm: string; summaryRound: number } | undefined;
    if (!current || current.longterm !== afterRow.longterm || current.summaryRound !== afterRow.summaryRound) {
      throw new Error('maintenance-memory-summary-rollback-conflict');
    }
    const changed = this.binding.memory.db.prepare(
      'UPDATE memory_meta SET longterm=?,summary_round=? WHERE id=1 AND longterm=? AND summary_round=?',
    ).run(
      beforeRow.longterm,
      Number(beforeRow.summaryRound),
      afterRow.longterm,
      Number(afterRow.summaryRound),
    );
    if (changed.changes !== 1) throw new Error('maintenance-memory-summary-rollback-conflict');
    const readback = this.binding.memory.db.prepare(
      'SELECT COALESCE(longterm,\'\') longterm,COALESCE(summary_round,0) summaryRound FROM memory_meta WHERE id=1',
    ).get() as { longterm: string; summaryRound: number } | undefined;
    if (!readback || readback.longterm !== beforeRow.longterm
      || readback.summaryRound !== beforeRow.summaryRound) {
      throw new Error('maintenance-summary-rollback-readback-failed');
    }
    this.#setSummaryCurrentOwner(null);
  }
}
