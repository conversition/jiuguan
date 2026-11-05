/** @author Codex @date 2026-10-14 @version 1.0
 * Immutable direct Memory proposal authority, separate from the operator approval queue.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureDigest, agentClosureTimestamp, agentClosureToken,
} from '../../packages/agent-closure/index.ts';
import { maintenanceProposalAutoApplyEligible } from './maintenance-auto-apply-policy.ts';
import { shadowDiff } from './maintenance-proposal-committer.ts';
import {
    isMemoryConsolidationApplyContext, isMaintenanceTrigger, validateMaintenanceProposal,
    type MaintenanceProposal, type MaintenanceStrictProposalContext, type MaintenanceTrigger,
    type PublicMaintenanceJob,
} from './maintenance-types.ts';
import {
    maintenanceMemorySkillDigest,
    type MaintenanceMemorySkillProposalProof
} from './skill-hub/maintenance-memory-proposal-proof.ts';

export const MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE = 'maintenance_memory_direct_proposal';
export const MAINTENANCE_MEMORY_DIRECT_PROPOSAL_COLUMNS = Object.freeze([
    'run_id', 'session_id', 'preparation_digest', 'record_json',
]);
const MAX_RECORD_BYTES = 262_144;
const MAX_PROPOSAL_BYTES = 65_536;
const MAX_CONTEXT_BYTES = 131_072;
declare const DIRECT_PREPARATION: unique symbol;

/** Only the owning Manager's WeakMap can authorize this otherwise empty handle. */
export interface MaintenanceMemoryDirectPreparation {
    readonly [DIRECT_PREPARATION]: true;
}

export interface MaintenanceMemoryDirectProposalRecord {
    readonly version: 'maintenance-memory-direct-proposal-v1';
    readonly proposalId: string;
    readonly jobRunId: string;
    readonly sessionId: string;
    readonly taskKind: 'memory_consolidation';
    readonly sourceRevision: string;
    readonly proposalDigest: string;
    readonly proposal: MaintenanceProposal;
    readonly context: MaintenanceStrictProposalContext;
    readonly diff: Readonly<Record<string, unknown>>;
    readonly status: 'prepared';
    readonly createdAt: string;
    readonly jobCreatedAt: string;
    readonly proofDigest: string;
    readonly attempt: number;
    readonly policyVersion: string;
    readonly parentRunId: string;
    readonly trigger: MaintenanceTrigger;
    readonly preparationDigest: string;
}

function boundedClone<T>(value: T, maxBytes: number): T {
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > maxBytes) {
        throw new Error('memory-direct-proposal-too-large');
    }
    return JSON.parse(json) as T;
}

/** Disk normalization validates content, but never creates a live authorization handle. */
export function parseMaintenanceMemoryDirectProposal(value: unknown): MaintenanceMemoryDirectProposalRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('memory-direct-proposal-invalid');
    }
    const row = value as MaintenanceMemoryDirectProposalRecord;
    const runId = agentClosureToken(row.jobRunId, 'direct-run-id');
    const context = boundedClone(row.context, MAX_CONTEXT_BYTES);
    const proposal = boundedClone(row.proposal, MAX_PROPOSAL_BYTES);
    if (row.version !== 'maintenance-memory-direct-proposal-v1' || !/^mjob_[a-f0-9]{32}$/u.test(runId)
        || row.proposalId !== `mdprop_${runId.slice(5)}` || row.taskKind !== 'memory_consolidation'
        || row.status !== 'prepared' || !Number.isSafeInteger(row.attempt) || row.attempt < 1
        || !isMaintenanceTrigger(row.trigger) || !isMemoryConsolidationApplyContext(context)
        || context.sessionId !== row.sessionId || context.sourceRevision !== row.sourceRevision
        || proposal.taskKind !== 'memory_consolidation' || !maintenanceProposalAutoApplyEligible(proposal)
        || JSON.stringify(validateMaintenanceProposal('memory_consolidation', proposal.payload, context))
        !== JSON.stringify(proposal)) {
        throw new Error('memory-direct-proposal-invalid');
    }
    const metadata = {
        version: row.version, proposalId: row.proposalId, jobRunId: runId,
        sessionId: agentClosureToken(row.sessionId, 'direct-session-id'), taskKind: row.taskKind,
        sourceRevision: agentClosureDigest(row.sourceRevision, 'direct-source-revision'),
        proposalDigest: agentClosureDigest(row.proposalDigest, 'direct-proposal-digest'),
        proposal, context, diff: shadowDiff(proposal), status: row.status,
        createdAt: agentClosureTimestamp(row.createdAt, 'direct-created-at'),
        jobCreatedAt: agentClosureTimestamp(row.jobCreatedAt, 'direct-job-created-at'),
        proofDigest: agentClosureDigest(row.proofDigest, 'direct-proof-digest'), attempt: row.attempt,
        policyVersion: agentClosureToken(row.policyVersion, 'direct-policy-version'),
        parentRunId: agentClosureToken(row.parentRunId, 'direct-parent-run-id'), trigger: row.trigger,
    };
    const normalized = { ...metadata, preparationDigest: maintenanceMemorySkillDigest(metadata) };
    if (metadata.createdAt < metadata.jobCreatedAt || metadata.proposalDigest !== maintenanceMemorySkillDigest(proposal)
        || JSON.stringify(normalized) !== JSON.stringify(value)) {
        throw new Error('memory-direct-proposal-corrupt');
    }
    return Object.freeze(normalized);
}

export function createMaintenanceMemoryDirectProposal(job: PublicMaintenanceJob, proposal: MaintenanceProposal,
    context: MaintenanceStrictProposalContext, proof: MaintenanceMemorySkillProposalProof,
    preparedAt: string): MaintenanceMemoryDirectProposalRecord {
    const metadata = {
        version: 'maintenance-memory-direct-proposal-v1' as const,
        proposalId: `mdprop_${job.runId.slice(5)}`, jobRunId: job.runId, sessionId: job.sessionId,
        taskKind: 'memory_consolidation' as const, sourceRevision: job.sourceRevision,
        proposalDigest: maintenanceMemorySkillDigest(proposal), proposal: boundedClone(proposal, MAX_PROPOSAL_BYTES),
        context: boundedClone(context, MAX_CONTEXT_BYTES), diff: shadowDiff(proposal), status: 'prepared' as const,
        createdAt: preparedAt, jobCreatedAt: job.createdAt, proofDigest: proof.proofDigest, attempt: job.attempt,
        policyVersion: job.policyVersion, parentRunId: job.parentRunId ?? job.runId, trigger: job.trigger,
    };
    return parseMaintenanceMemoryDirectProposal({
        ...metadata, preparationDigest: maintenanceMemorySkillDigest(metadata),
    });
}

/** Exact optional-table contract is shared with snapshot validation. */
export function inspectMaintenanceMemoryDirectProposalSchema(db: DatabaseSync): void {
    const columns = db.prepare(`PRAGMA table_info(${MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE})`).all() as {
        name: string; type: string; notnull: number; pk: number;
    }[];
    const expected = [
        ['run_id', 'TEXT', 0, 1], ['session_id', 'TEXT', 1, 0],
        ['preparation_digest', 'TEXT', 1, 0], ['record_json', 'TEXT', 1, 0],
    ];
    const keys = db.prepare(`PRAGMA foreign_key_list(${MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE})`).all() as {
        table: string; from: string; to: string; on_delete: string;
    }[];
    if (JSON.stringify(columns.map((row) => [row.name, row.type, row.notnull, row.pk])) !== JSON.stringify(expected)
        || keys.length !== 1 || keys[0].table !== 'maintenance_job' || keys[0].from !== 'run_id'
        || keys[0].to !== 'run_id' || keys[0].on_delete !== 'CASCADE') {
        throw new Error('memory-direct-proposal-schema-invalid');
    }
}

/** Reads only its immutable proposal record and the job's immutable admitted identity. */
export class MaintenanceMemoryDirectProposalStore {
    static openExisting(db: DatabaseSync, readJob: (runId: string) => PublicMaintenanceJob):
        MaintenanceMemoryDirectProposalStore | null {
        return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE)
            ? new MaintenanceMemoryDirectProposalStore(db, readJob, false) : null;
    }

    constructor(private readonly db: DatabaseSync,
        private readonly readJob: (runId: string) => PublicMaintenanceJob, create = true) {
        if (create) {
            if (db.isTransaction !== false) throw new Error('memory-direct-proposal-schema-in-transaction');
            db.exec(`CREATE TABLE IF NOT EXISTS ${MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE} (
                run_id TEXT PRIMARY KEY REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
                session_id TEXT NOT NULL, preparation_digest TEXT NOT NULL,
                record_json TEXT NOT NULL CHECK(length(record_json)<=${MAX_RECORD_BYTES})
            );`);
        }
        inspectMaintenanceMemoryDirectProposalSchema(db);
    }

    read(runId: string): MaintenanceMemoryDirectProposalRecord | null {
        const row = this.db.prepare(`SELECT run_id,session_id,preparation_digest,record_json
            FROM ${MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE} WHERE run_id=?`).get(runId) as {
            run_id: string; session_id: string; preparation_digest: string; record_json: string;
        } | undefined;
        if (!row) return null;
        if (typeof row.record_json !== 'string' || Buffer.byteLength(row.record_json, 'utf8') > MAX_RECORD_BYTES) {
            throw new Error('memory-direct-proposal-record-too-large');
        }
        const record = parseMaintenanceMemoryDirectProposal(JSON.parse(row.record_json));
        const job = this.readJob(runId);
        if (row.record_json !== JSON.stringify(record) || row.run_id !== record.jobRunId
            || row.session_id !== record.sessionId || row.preparation_digest !== record.preparationDigest
            || job.runId !== record.jobRunId || job.sessionId !== record.sessionId
            || job.taskKind !== record.taskKind || job.sourceRevision !== record.sourceRevision
            || job.policyVersion !== record.policyVersion || job.attempt !== record.attempt || job.mode !== 'apply'
            || job.createdAt !== record.jobCreatedAt || (job.parentRunId ?? job.runId) !== record.parentRunId
            || job.trigger !== record.trigger) throw new Error('memory-direct-proposal-job-mismatch');
        return record;
    }

    insert(value: MaintenanceMemoryDirectProposalRecord): void {
        if (this.db.isTransaction !== true) throw new Error('memory-direct-proposal-transaction-required');
        const record = parseMaintenanceMemoryDirectProposal(value);
        const json = JSON.stringify(record);
        if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) throw new Error('memory-direct-proposal-too-large');
        if (this.read(record.jobRunId)) throw new Error('memory-direct-proposal-already-prepared');
        this.db.prepare(`INSERT INTO ${MAINTENANCE_MEMORY_DIRECT_PROPOSAL_TABLE}
            (run_id,session_id,preparation_digest,record_json) VALUES(?,?,?,?)`)
            .run(record.jobRunId, record.sessionId, record.preparationDigest, json);
        if (this.read(record.jobRunId)?.preparationDigest !== record.preparationDigest) {
            throw new Error('memory-direct-proposal-storage-mismatch');
        }
    }
}
