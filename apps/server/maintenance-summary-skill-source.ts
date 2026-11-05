/** @author Codex @date 2026-10-14 @version 1.0
 * Immutable Summary proposal/source intent. Parsing disk evidence never grants live write authority.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureOperationId, agentClosureTimestamp, agentClosureToken,
    executionClassForMaintenanceTrigger, normalizeAgentClosureEvent, normalizeAgentClosureRun,
    type AgentClosureEventInput, type AgentClosureRunInput,
} from '../../packages/agent-closure/index.ts';
import { shadowDiff } from './maintenance-proposal-committer.ts';
import {
    isMaintenanceTrigger, isRollingSummaryApplyContext, validateMaintenanceProposal,
    type MaintenanceProposal, type MaintenanceStrictProposalContext, type MaintenanceTrigger,
    type PublicMaintenanceJob,
} from './maintenance-types.ts';
import {
    isMaintenanceSummarySkillProposalProof, maintenanceSummarySkillDigest,
    parseMaintenanceSummarySkillProposalProof, type MaintenanceSummarySkillProposalProof,
} from './skill-hub/maintenance-summary-proposal-proof.ts';

export const MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE = 'maintenance_summary_skill_source';
export const MAINTENANCE_SUMMARY_SKILL_SOURCE_COLUMNS = Object.freeze([
    'run_id', 'session_id', 'record_digest', 'record_json', 'payload_digest', 'payload_json', 'delivered_at',
]);
const MAX_RECORD_BYTES = 262_144;
const MAX_PAYLOAD_BYTES = 32_768;
declare const DIRECT_PREPARATION: unique symbol;

/** Only the owning Manager's WeakMap can authorize this empty one-shot handle. */
export interface MaintenanceSummaryDirectPreparation {
    readonly [DIRECT_PREPARATION]: true;
}

export interface MaintenanceSummarySkillProposalRecord {
    readonly version: 'maintenance-summary-skill-proposal-record-v1';
    readonly proposalId: string;
    readonly jobRunId: string;
    readonly sessionId: string;
    readonly taskKind: 'rolling_summary';
    readonly sourceRevision: string;
    readonly proposalDigest: string;
    readonly proposal: MaintenanceProposal;
    readonly context: MaintenanceStrictProposalContext;
    readonly diff: Readonly<Record<string, unknown>>;
    readonly status: 'prepared' | 'pending';
    readonly createdAt: string;
    readonly jobCreatedAt: string;
    readonly proofDigest: string;
    readonly attempt: number;
    readonly policyVersion: string;
    readonly parentRunId: string;
    readonly trigger: MaintenanceTrigger;
    readonly recordDigest: string;
}

export interface MaintenanceSummarySkillSourceEntry {
    readonly payloadVersion: 'maintenance-summary-skill-source-v1';
    readonly run: AgentClosureRunInput;
    readonly proof: MaintenanceSummarySkillProposalProof;
    readonly events: readonly AgentClosureEventInput[];
    readonly recordDigest: string;
    readonly payloadDigest: string;
}

export interface MaintenanceSummarySkillSourceScan {
    readonly entries: readonly MaintenanceSummarySkillSourceEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

interface StoredRow {
    rowid: number;
    run_id: string;
    session_id: string;
    record_digest: string;
    record_json: string;
    payload_digest: string;
    payload_json: string;
}

function boundedClone<T>(value: T, maxBytes: number): T {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error('summary-skill-source-too-large');
    }
    return JSON.parse(text) as T;
}

/** Full formal Summary validation is required even when reading a durable sidecar. */
export function parseMaintenanceSummarySkillProposalRecord(value: unknown): MaintenanceSummarySkillProposalRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('summary-skill-proposal-invalid');
    }
    const row = boundedClone(value, MAX_RECORD_BYTES) as MaintenanceSummarySkillProposalRecord;
    const runId = agentClosureToken(row.jobRunId, 'summary-run-id');
    const context = boundedClone(row.context, 131_072);
    const proposal = boundedClone(row.proposal, 65_536);
    if (row.version !== 'maintenance-summary-skill-proposal-record-v1' || !/^mjob_[a-f0-9]{32}$/u.test(runId)
        || row.taskKind !== 'rolling_summary' || !['prepared', 'pending'].includes(row.status)
        || row.proposalId !== `${row.status === 'prepared' ? 'sdprop' : 'mprop'}_${runId.slice(5)}`
        || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || !isMaintenanceTrigger(row.trigger)
        || !isRollingSummaryApplyContext(context) || context.sessionId !== row.sessionId
        || context.sourceRevision !== row.sourceRevision || proposal.taskKind !== 'rolling_summary'
        || JSON.stringify(validateMaintenanceProposal('rolling_summary', proposal.payload, context))
        !== JSON.stringify(proposal)) throw new Error('summary-skill-proposal-invalid');
    const metadata = {
        version: row.version, proposalId: row.proposalId, jobRunId: runId,
        sessionId: agentClosureToken(row.sessionId, 'summary-session-id'), taskKind: row.taskKind,
        sourceRevision: agentClosureDigest(row.sourceRevision, 'summary-source-revision'),
        proposalDigest: agentClosureDigest(row.proposalDigest, 'summary-proposal-digest'),
        proposal, context, diff: shadowDiff(proposal), status: row.status,
        createdAt: agentClosureTimestamp(row.createdAt, 'summary-created-at'),
        jobCreatedAt: agentClosureTimestamp(row.jobCreatedAt, 'summary-job-created-at'),
        proofDigest: agentClosureDigest(row.proofDigest, 'summary-proof-digest'), attempt: row.attempt,
        policyVersion: agentClosureToken(row.policyVersion, 'summary-policy-version'),
        parentRunId: agentClosureToken(row.parentRunId, 'summary-parent-run-id'), trigger: row.trigger,
    };
    const normalized = { ...metadata, recordDigest: maintenanceSummarySkillDigest(metadata) };
    if (metadata.createdAt < metadata.jobCreatedAt
        || metadata.proposalDigest !== maintenanceSummarySkillDigest(proposal)
        || JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('summary-skill-proposal-corrupt');
    return Object.freeze(normalized);
}

export function createMaintenanceSummarySkillProposalRecord(job: PublicMaintenanceJob, proposal: MaintenanceProposal,
    context: MaintenanceStrictProposalContext, proof: MaintenanceSummarySkillProposalProof,
    status: 'prepared' | 'pending', createdAt: string): MaintenanceSummarySkillProposalRecord {
    const metadata = {
        version: 'maintenance-summary-skill-proposal-record-v1' as const,
        proposalId: `${status === 'prepared' ? 'sdprop' : 'mprop'}_${job.runId.slice(5)}`,
        jobRunId: job.runId, sessionId: job.sessionId, taskKind: 'rolling_summary' as const,
        sourceRevision: job.sourceRevision, proposalDigest: maintenanceSummarySkillDigest(proposal),
        proposal: boundedClone(proposal, 65_536), context: boundedClone(context, 131_072), diff: shadowDiff(proposal),
        status, createdAt, jobCreatedAt: job.createdAt, proofDigest: proof.proofDigest, attempt: job.attempt,
        policyVersion: job.policyVersion, parentRunId: job.parentRunId ?? job.runId, trigger: job.trigger,
    };
    return parseMaintenanceSummarySkillProposalRecord({
        ...metadata, recordDigest: maintenanceSummarySkillDigest(metadata),
    });
}

function sourcePacket(job: PublicMaintenanceJob, proofValue: MaintenanceSummarySkillProposalProof,
    recordValue: MaintenanceSummarySkillProposalRecord): MaintenanceSummarySkillSourceEntry {
    const proof = parseMaintenanceSummarySkillProposalProof(proofValue);
    const record = parseMaintenanceSummarySkillProposalRecord(recordValue);
    if (job.taskKind !== 'rolling_summary' || record.jobRunId !== job.runId || record.sessionId !== job.sessionId
        || record.sourceRevision !== job.sourceRevision || record.policyVersion !== job.policyVersion
        || record.parentRunId !== (job.parentRunId ?? job.runId) || record.trigger !== job.trigger
        || record.jobCreatedAt !== job.createdAt || record.attempt !== job.attempt
        || (record.status === 'prepared' && job.mode !== 'apply')
        || proof.runId !== record.jobRunId || proof.sessionId !== record.sessionId
        || proof.sourceRevision !== record.sourceRevision || proof.parentRunId !== record.parentRunId
        || proof.policyVersion !== record.policyVersion || proof.attempt !== record.attempt
        || proof.proposalDigest !== record.proposalDigest || proof.proofDigest !== record.proofDigest
        || proof.proposalContextDigest !== maintenanceSummarySkillDigest(record.context)
        || proof.admittedAt < record.jobCreatedAt || proof.validatedAt > record.createdAt) {
        throw new Error('summary-skill-source-binding-invalid');
    }
    const run = normalizeAgentClosureRun({
        operationId: agentClosureOperationId('maintenance', job.runId, 'rolling_summary'),
        runId: job.runId, ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}), sessionId: job.sessionId,
        capability: 'maintenance.memory', lane: 'maintenance', kind: 'proposal',
        executionClass: executionClassForMaintenanceTrigger(job.trigger), sourceRevision: job.sourceRevision,
        policyVersion: job.policyVersion, admittedAt: job.createdAt,
    });
    const events = [
        {
            type: 'execution-completed', idempotencyKey: 'execution-completed',
            occurredAt: record.status === 'pending' ? record.createdAt : proof.executedAt,
            sourceRevision: job.sourceRevision
        },
        {
            type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: record.createdAt,
            artifactDigest: record.proposalDigest, evidenceRef: record.proposalId, sourceRevision: job.sourceRevision
        },
        {
            type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: record.createdAt,
            artifactDigest: record.proposalDigest, sourceRevision: job.sourceRevision,
            itemCount: Number(record.diff.itemCount)
        },
    ].map((event) => normalizeAgentClosureEvent(event as AgentClosureEventInput));
    const metadata = {
        payloadVersion: 'maintenance-summary-skill-source-v1' as const, run, proof,
        events: Object.freeze(events), recordDigest: record.recordDigest,
    };
    return Object.freeze({ ...metadata, payloadDigest: maintenanceSummarySkillDigest(metadata) });
}

/** A standalone canonical validator; the Store additionally binds the original real record and job identity. */
export function parseMaintenanceSummarySkillSourceEntry(value: unknown): MaintenanceSummarySkillSourceEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('summary-skill-source-invalid');
    const row = boundedClone(value, MAX_PAYLOAD_BYTES) as MaintenanceSummarySkillSourceEntry;
    if (row.payloadVersion !== 'maintenance-summary-skill-source-v1' || !Array.isArray(row.events)
        || row.events.length !== 3) throw new Error('summary-skill-source-invalid');
    const run = normalizeAgentClosureRun(row.run);
    const proof = parseMaintenanceSummarySkillProposalProof(row.proof);
    const events = Object.freeze(row.events.map(normalizeAgentClosureEvent));
    if (run.operationId !== agentClosureOperationId('maintenance', proof.runId, 'rolling_summary')
        || run.runId !== proof.runId || run.sessionId !== proof.sessionId || run.sourceRevision !== proof.sourceRevision
        || run.policyVersion !== proof.policyVersion || (run.parentRunId ?? run.runId) !== proof.parentRunId
        || run.capability !== 'maintenance.memory' || run.kind !== 'proposal' || run.lane !== 'maintenance'
        || run.admittedAt > proof.admittedAt || events[0].type !== 'execution-completed'
        || events[1].type !== 'proposal-persisted' || events[2].type !== 'artifact-validated'
        || events.some((event) => event.idempotencyKey !== event.type || event.sourceRevision !== run.sourceRevision)
        || events[0].occurredAt !== (events[1].evidenceRef === `mprop_${proof.runId.slice(5)}`
            ? events[1].occurredAt : proof.executedAt) || events[1].occurredAt !== events[2].occurredAt
        || events[1].occurredAt < proof.validatedAt || events[1].artifactDigest !== proof.proposalDigest
        || events[2].artifactDigest !== proof.proposalDigest || typeof events[1].evidenceRef !== 'string'
        || !/^mjob_[a-f0-9]{32}$/u.test(proof.runId)
        || ![`sdprop_${proof.runId.slice(5)}`, `mprop_${proof.runId.slice(5)}`].includes(events[1].evidenceRef)) {
        throw new Error('summary-skill-source-invalid');
    }
    const metadata = {
        payloadVersion: row.payloadVersion, run, proof, events,
        recordDigest: agentClosureDigest(row.recordDigest, 'summary-record-digest'),
    };
    const normalized = Object.freeze({ ...metadata, payloadDigest: maintenanceSummarySkillDigest(metadata) });
    if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error('summary-skill-source-corrupt');
    return normalized;
}

export function inspectMaintenanceSummarySkillSourceSchema(db: DatabaseSync): void {
    const columns = db.prepare(`PRAGMA table_info(${MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE})`).all() as {
        name: string; type: string; notnull: number; pk: number;
    }[];
    const expected = [
        ['run_id', 'TEXT', 0, 1], ['session_id', 'TEXT', 1, 0], ['record_digest', 'TEXT', 1, 0],
        ['record_json', 'TEXT', 1, 0], ['payload_digest', 'TEXT', 1, 0], ['payload_json', 'TEXT', 1, 0],
        ['delivered_at', 'TEXT', 0, 0],
    ];
    const keys = db.prepare(`PRAGMA foreign_key_list(${MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE})`).all() as {
        table: string; from: string; to: string; on_delete: string;
    }[];
    if (JSON.stringify(columns.map((row) => [row.name, row.type, row.notnull, row.pk])) !== JSON.stringify(expected)
        || keys.length !== 1 || keys[0].table !== 'maintenance_job' || keys[0].from !== 'run_id'
        || keys[0].to !== 'run_id' || keys[0].on_delete !== 'CASCADE') {
        throw new Error('summary-skill-source-schema-invalid');
    }
}

/** Optional single-table intent: real bounded proposal stays private, recovery payload is body-free. */
export class MaintenanceSummarySkillSourceStore {
    static openExisting(db: DatabaseSync, readJob: (runId: string) => PublicMaintenanceJob):
        MaintenanceSummarySkillSourceStore | null {
        return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE)
            ? new MaintenanceSummarySkillSourceStore(db, readJob, false) : null;
    }

    constructor(private readonly db: DatabaseSync,
        private readonly readJob: (runId: string) => PublicMaintenanceJob, create = true) {
        if (create) {
            if (db.isTransaction !== false) throw new Error('summary-skill-source-schema-in-transaction');
            db.exec(`CREATE TABLE IF NOT EXISTS ${MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE} (
                run_id TEXT PRIMARY KEY REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
                session_id TEXT NOT NULL, record_digest TEXT NOT NULL,
                record_json TEXT NOT NULL CHECK(length(record_json)<=${MAX_RECORD_BYTES}),
                payload_digest TEXT NOT NULL,
                payload_json TEXT NOT NULL CHECK(length(payload_json)<=${MAX_PAYLOAD_BYTES}),
                delivered_at TEXT
            );`);
        }
        inspectMaintenanceSummarySkillSourceSchema(db);
    }

    insert(job: PublicMaintenanceJob, proof: MaintenanceSummarySkillProposalProof,
        record: MaintenanceSummarySkillProposalRecord): void {
        if (this.db.isTransaction !== true) throw new Error('summary-skill-source-transaction-required');
        if (!isMaintenanceSummarySkillProposalProof(proof)) throw new Error('summary-skill-source-live-proof-required');
        if (JSON.stringify(this.readJob(job.runId)) !== JSON.stringify(job)) {
            throw new Error('summary-skill-source-current-job-mismatch');
        }
        if (record.status === 'prepared' && job.status !== 'running'
            || record.status === 'pending' && (job.status !== 'succeeded' || job.finishedAt !== record.createdAt
                || job.proposal?.disposition !== 'shadow'
                || `sha256:${job.proposal.digest}` !== proof.proposalDigest)) {
            throw new Error('summary-skill-source-insertion-phase-invalid');
        }
        const payload = sourcePacket(job, proof, record);
        const prior = this.read(job.runId);
        if (prior) {
            if (prior.source.proof.proofDigest !== proof.proofDigest || prior.record.status !== 'prepared'
                || job.proposal?.disposition !== 'committed'
                || `sha256:${job.proposal.digest}` !== proof.proposalDigest) {
                throw new Error('summary-skill-source-intent-conflict');
            }
            return;
        }
        const recordJson = JSON.stringify(record);
        const payloadJson = JSON.stringify(payload);
        if (Buffer.byteLength(recordJson, 'utf8') > MAX_RECORD_BYTES
            || Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
            throw new Error('summary-skill-source-too-large');
        }
        this.db.prepare(`INSERT INTO ${MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE}
            (run_id,session_id,record_digest,record_json,payload_digest,payload_json) VALUES(?,?,?,?,?,?)`)
            .run(job.runId, job.sessionId, record.recordDigest, recordJson, payload.payloadDigest, payloadJson);
        if (this.read(job.runId)?.source.payloadDigest !== payload.payloadDigest) {
            throw new Error('summary-skill-source-storage-mismatch');
        }
    }

    read(runId: string): {
        record: MaintenanceSummarySkillProposalRecord; source: MaintenanceSummarySkillSourceEntry;
    } | null {
        const row = this.db.prepare(`SELECT rowid,* FROM ${MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE} WHERE run_id=?`)
            .get(runId) as unknown as StoredRow | undefined;
        return row ? this.parseRow(row) : null;
    }

    scanAll(limit = 64, cursor = 0): MaintenanceSummarySkillSourceScan {
        if (this.db.isTransaction !== false) throw new Error('summary-skill-source-uncommitted-read');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
            throw new Error('summary-skill-source-limit-invalid');
        }
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('summary-skill-source-cursor-invalid');
        const rows = this.db.prepare(`SELECT rowid,* FROM ${MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE}
            WHERE rowid>? ORDER BY rowid LIMIT ?`).all(cursor, limit) as unknown as StoredRow[];
        const entries: MaintenanceSummarySkillSourceEntry[] = [];
        let failed = 0;
        for (const row of rows) {
            try { entries.push(this.parseRow(row).source); } catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: rows.length, failed,
            nextCursor: rows.length === limit ? Number(rows.at(-1)!.rowid) : 0, hasMore: rows.length === limit
        });
    }

    acknowledge(entry: MaintenanceSummarySkillSourceEntry, at: string): void {
        if (this.db.isTransaction !== false) throw new Error('summary-skill-source-uncommitted-ack');
        const canonical = parseMaintenanceSummarySkillSourceEntry(entry);
        if (this.read(canonical.run.runId)?.source.payloadDigest !== canonical.payloadDigest) {
            throw new Error('summary-skill-source-ack-conflict');
        }
        const result = this.db.prepare(`UPDATE ${MAINTENANCE_SUMMARY_SKILL_SOURCE_TABLE}
            SET delivered_at=COALESCE(delivered_at,?) WHERE run_id=? AND payload_digest=?`)
            .run(agentClosureTimestamp(at, 'summary-ack-at'), canonical.run.runId, canonical.payloadDigest);
        if (Number(result.changes) !== 1) throw new Error('summary-skill-source-ack-conflict');
    }

    private parseRow(row: StoredRow) {
        if (typeof row.record_json !== 'string' || Buffer.byteLength(row.record_json, 'utf8') > MAX_RECORD_BYTES
            || typeof row.payload_json !== 'string'
            || Buffer.byteLength(row.payload_json, 'utf8') > MAX_PAYLOAD_BYTES) {
            throw new Error('summary-skill-source-row-invalid');
        }
        const record = parseMaintenanceSummarySkillProposalRecord(JSON.parse(row.record_json));
        const source = parseMaintenanceSummarySkillSourceEntry(JSON.parse(row.payload_json));
        const job = this.readJob(row.run_id);
        const expected = sourcePacket(job, source.proof, record);
        const pending = this.db.prepare(`SELECT proposal_id,session_id,task_kind,source_revision,proposal_digest,
            proposal_json,context_json,created_at FROM maintenance_pending_proposal WHERE job_run_id=?`)
            .get(row.run_id) as Record<string, unknown> | undefined;
        if (row.run_id !== record.jobRunId || row.session_id !== record.sessionId
            || row.record_digest !== record.recordDigest || row.payload_digest !== source.payloadDigest
            || row.record_json !== JSON.stringify(record) || row.payload_json !== JSON.stringify(expected)
            || (record.status === 'prepared' && pending !== undefined)
            || (record.status === 'pending' && (!pending || pending.proposal_id !== record.proposalId
                || pending.session_id !== record.sessionId || pending.task_kind !== record.taskKind
                || pending.source_revision !== record.sourceRevision
                || pending.proposal_digest !== record.proposalDigest
                || pending.proposal_json !== JSON.stringify(record.proposal)
                || pending.context_json !== JSON.stringify(record.context)
                || pending.created_at !== record.createdAt))) {
            throw new Error('summary-skill-source-row-binding-invalid');
        }
        return { record, source: expected };
    }
}
