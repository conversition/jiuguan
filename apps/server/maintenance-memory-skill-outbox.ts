/** @author Codex @date 2026-10-14 @version 1.0
 * Task-owned source evidence. It never attests business apply, readback or consumption.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
    agentClosureOperationId, agentClosureToken, executionClassForMaintenanceTrigger,
    normalizeAgentClosureEvent, normalizeAgentClosureRun,
    type AgentClosureEventInput, type AgentClosureRunInput,
} from '../../packages/agent-closure/index.ts';
import type { PublicMaintenanceJob } from './maintenance-types.ts';
import { MaintenanceMemoryDirectProposalStore,
    type MaintenanceMemoryDirectProposalRecord } from './maintenance-memory-direct-proposal.ts';
import {
    isMaintenanceMemorySkillProposalProof, maintenanceMemorySkillDigest,
    parseMaintenanceMemorySkillProposalProof, type MaintenanceMemorySkillProposalProof,
} from './skill-hub/maintenance-memory-proposal-proof.ts';

export const MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE = 'maintenance_memory_skill_outbox';
export const MAINTENANCE_MEMORY_SKILL_OUTBOX_COLUMNS = Object.freeze([
    'run_id', 'session_id', 'payload_digest', 'payload_json', 'delivered_at',
]);
const MAX_PAYLOAD_CHARS = 32_768;
interface StoredRow {
    rowid: number;
    run_id: string;
    session_id: string;
    payload_digest: string;
    payload_json: string;
}

export interface MaintenanceMemorySkillOutboxEntry {
    readonly payloadVersion: 'maintenance-memory-skill-outbox-v1' | 'maintenance-memory-skill-outbox-v2';
    readonly run: AgentClosureRunInput;
    readonly proof: MaintenanceMemorySkillProposalProof;
    readonly events: readonly AgentClosureEventInput[];
    readonly preparationDigest?: string;
    readonly payloadDigest: string;
}

export interface MaintenanceMemorySkillOutboxScan {
    readonly entries: readonly MaintenanceMemorySkillOutboxEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

function packet(job: PublicMaintenanceJob, proof: MaintenanceMemorySkillProposalProof, proposalId?: string) {
    if (job.taskKind !== 'memory_consolidation' || job.status !== 'succeeded' || !job.finishedAt || !job.proposal
        || !['shadow', 'committed'].includes(job.proposal.disposition)
        || proof.runId !== job.runId || proof.sessionId !== job.sessionId || proof.sourceRevision !== job.sourceRevision
        || proof.parentRunId !== (job.parentRunId ?? job.runId) || proof.policyVersion !== job.policyVersion
        || proof.attempt !== job.attempt || proof.proposalDigest !== `sha256:${job.proposal.digest}`
        || proof.admittedAt < job.createdAt || proof.validatedAt > job.finishedAt
        || (job.proposal.disposition === 'shadow') !== Boolean(proposalId)
        || (proposalId !== undefined && proposalId !== `mprop_${job.runId.slice('mjob_'.length)}`)) {
        throw new Error('memory-skill-outbox-job-binding-invalid');
    }
    const run = normalizeAgentClosureRun({
        operationId: agentClosureOperationId('maintenance', job.runId, job.taskKind),
        runId: job.runId, ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}), sessionId: job.sessionId,
        capability: 'maintenance.memory', lane: 'maintenance', kind: 'proposal',
        executionClass: executionClassForMaintenanceTrigger(job.trigger), sourceRevision: job.sourceRevision,
        policyVersion: job.policyVersion, admittedAt: job.createdAt,
    });
    // These are the original task-settlement intents, identical to the legacy observer, not proof phase times.
    const events: AgentClosureEventInput[] = [{
        type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: job.finishedAt,
        sourceRevision: job.sourceRevision,
    }];
    if (proposalId) events.push({
        type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: job.finishedAt,
        artifactDigest: proof.proposalDigest, evidenceRef: proposalId, sourceRevision: job.sourceRevision,
    });
    events.push({
        type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: job.finishedAt,
        artifactDigest: proof.proposalDigest, sourceRevision: job.sourceRevision,
        itemCount: Number.isSafeInteger(job.proposal.diff.itemCount) ? Number(job.proposal.diff.itemCount) : undefined,
    });
    return Object.freeze({
        payloadVersion: 'maintenance-memory-skill-outbox-v1' as const,
        run, proof, events: Object.freeze(events.map(normalizeAgentClosureEvent))
    });
}

/** The provider already finished and the canonical proposal exists before any direct business COMMIT. */
function directPacket(job: PublicMaintenanceJob, proof: MaintenanceMemorySkillProposalProof,
    direct: MaintenanceMemoryDirectProposalRecord) {
    if (job.taskKind !== 'memory_consolidation' || job.mode !== 'apply'
        || proof.runId !== direct.jobRunId || proof.sessionId !== direct.sessionId
        || proof.sourceRevision !== direct.sourceRevision || proof.proposalDigest !== direct.proposalDigest
        || proof.proofDigest !== direct.proofDigest || proof.attempt !== direct.attempt
        || proof.parentRunId !== direct.parentRunId || proof.policyVersion !== direct.policyVersion
        || proof.admittedAt < direct.jobCreatedAt || proof.validatedAt > direct.createdAt) {
        throw new Error('memory-skill-outbox-direct-binding-invalid');
    }
    const run = normalizeAgentClosureRun({
        operationId: agentClosureOperationId('maintenance', job.runId, job.taskKind),
        runId: job.runId, ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}), sessionId: job.sessionId,
        capability: 'maintenance.memory', lane: 'maintenance', kind: 'proposal',
        executionClass: executionClassForMaintenanceTrigger(job.trigger), sourceRevision: job.sourceRevision,
        policyVersion: job.policyVersion, admittedAt: job.createdAt,
    });
    const events: AgentClosureEventInput[] = [
        {
            type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: proof.executedAt,
            sourceRevision: job.sourceRevision,
        },
        {
            type: 'proposal-persisted', idempotencyKey: 'proposal-persisted', occurredAt: direct.createdAt,
            artifactDigest: direct.proposalDigest, evidenceRef: direct.proposalId,
            sourceRevision: job.sourceRevision,
        },
        {
            type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: direct.createdAt,
            artifactDigest: direct.proposalDigest, sourceRevision: job.sourceRevision,
            itemCount: Number(direct.diff.itemCount),
        },
    ];
    return Object.freeze({
        payloadVersion: 'maintenance-memory-skill-outbox-v2' as const, run, proof,
        events: Object.freeze(events.map(normalizeAgentClosureEvent)), preparationDigest: direct.preparationDigest,
    });
}

/** Original schema check, also safe inside the owning Manager's migration transaction. */
export function inspectMaintenanceMemorySkillOutboxSchema(db: DatabaseSync): void {
    const columnRows = db.prepare(`PRAGMA table_info(${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE})`).all();
    const columns = (columnRows as { name: string }[]).map((row) => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(MAINTENANCE_MEMORY_SKILL_OUTBOX_COLUMNS)) {
        throw new Error('memory-skill-outbox-schema-invalid');
    }
    const keyRows = db.prepare(`PRAGMA foreign_key_list(${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE})`).all();
    const keys = keyRows as { table: string; from: string; to: string; on_delete: string }[];
    if (keys.length !== 1 || keys[0].table !== 'maintenance_job' || keys[0].from !== 'run_id'
        || keys[0].to !== 'run_id' || keys[0].on_delete !== 'CASCADE') {
        throw new Error('memory-skill-outbox-schema-invalid');
    }
}

/** Optional table: disabled/legacy databases are never changed just to scan recovery. */
export class MaintenanceMemorySkillOutbox {
    static openExisting(db: DatabaseSync, readJob: (runId: string) => PublicMaintenanceJob):
        MaintenanceMemorySkillOutbox | null {
        if (db.isTransaction !== false) throw new Error('memory-skill-outbox-uncommitted-read');
        return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE) ? new MaintenanceMemorySkillOutbox(db, readJob, false) : null;
    }

    constructor(private readonly db: DatabaseSync,
        private readonly readJob: (runId: string) => PublicMaintenanceJob, create = true) {
        if (db.isTransaction !== false) throw new Error('memory-skill-outbox-schema-in-transaction');
        if (create) db.exec(`CREATE TABLE IF NOT EXISTS ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE} (
            run_id TEXT PRIMARY KEY REFERENCES maintenance_job(run_id) ON DELETE CASCADE,
            session_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
            payload_json TEXT NOT NULL CHECK(length(payload_json)<=${MAX_PAYLOAD_CHARS}), delivered_at TEXT
        );`);
        inspectMaintenanceMemorySkillOutboxSchema(db);
    }

    enqueue(job: PublicMaintenanceJob, proof: MaintenanceMemorySkillProposalProof, proposalId?: string): void {
        if (this.db.isTransaction !== true) throw new Error('memory-skill-outbox-transaction-required');
        if (!isMaintenanceMemorySkillProposalProof(proof)) throw new Error('memory-skill-outbox-live-proof-required');
        if (JSON.stringify(this.readJob(job.runId)) !== JSON.stringify(job)) {
            throw new Error('memory-skill-outbox-current-job-mismatch');
        }
        const prior = this.db.prepare(`SELECT rowid,run_id,session_id,payload_digest,payload_json
            FROM ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE} WHERE run_id=?`).get(job.runId) as StoredRow | undefined;
        if (prior && (typeof prior.payload_json !== 'string' || prior.payload_json.length > MAX_PAYLOAD_CHARS)) {
            throw new Error('memory-skill-outbox-payload-corrupt');
        }
        if (prior && JSON.parse(prior.payload_json)?.payloadVersion === 'maintenance-memory-skill-outbox-v2') {
            const original = this.#parseRow(prior);
            if (original.proof.proofDigest !== proof.proofDigest
                || job.proposal?.digest !== proof.proposalDigest.slice(7)
                || job.proposal.disposition !== 'committed' || proposalId !== undefined) {
                throw new Error('memory-skill-outbox-direct-completion-mismatch');
            }
            return;
        }
        if (this.#proposalId(job, proof) !== proposalId) {
            throw new Error('memory-skill-outbox-proposal-binding-invalid');
        }
        const payload = packet(job, parseMaintenanceMemorySkillProposalProof(proof), proposalId);
        const json = JSON.stringify(payload);
        if (json.length > MAX_PAYLOAD_CHARS) throw new Error('memory-skill-outbox-payload-too-large');
        const payloadDigest = maintenanceMemorySkillDigest(payload);
        const existing = this.db.prepare(`SELECT payload_digest
            FROM ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE} WHERE run_id=?`)
            .get(job.runId) as { payload_digest: string } | undefined;
        if (existing && existing.payload_digest !== payloadDigest) {
            throw new Error('memory-skill-outbox-intent-conflict');
        }
        if (!existing) this.db.prepare(`INSERT INTO ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE}
            (run_id,session_id,payload_digest,payload_json) VALUES(?,?,?,?)`)
            .run(job.runId, job.sessionId, payloadDigest, json);
    }

    enqueueDirect(job: PublicMaintenanceJob, proof: MaintenanceMemorySkillProposalProof,
        direct: MaintenanceMemoryDirectProposalRecord): void {
        if (this.db.isTransaction !== true) throw new Error('memory-skill-outbox-transaction-required');
        if (!isMaintenanceMemorySkillProposalProof(proof)) throw new Error('memory-skill-outbox-live-proof-required');
        if (job.status !== 'running' || JSON.stringify(this.readJob(job.runId)) !== JSON.stringify(job)
            || this.#directProposal(job.runId)?.preparationDigest !== direct.preparationDigest) {
            throw new Error('memory-skill-outbox-direct-storage-mismatch');
        }
        const payload = directPacket(job, parseMaintenanceMemorySkillProposalProof(proof), direct);
        const json = JSON.stringify(payload);
        if (json.length > MAX_PAYLOAD_CHARS) throw new Error('memory-skill-outbox-payload-too-large');
        this.db.prepare(`INSERT INTO ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE}
            (run_id,session_id,payload_digest,payload_json) VALUES(?,?,?,?)`)
            .run(job.runId, job.sessionId, maintenanceMemorySkillDigest(payload), json);
        const row = this.db.prepare(`SELECT rowid,run_id,session_id,payload_digest,payload_json
            FROM ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE} WHERE run_id=?`).get(job.runId) as unknown as StoredRow;
        if (this.#parseRow(row).preparationDigest !== direct.preparationDigest) {
            throw new Error('memory-skill-outbox-direct-storage-mismatch');
        }
    }

    pending(limit = 64): readonly MaintenanceMemorySkillOutboxEntry[] {
        return Object.freeze(this.#rows(limit, 0).map((row) => this.#parseRow(row)));
    }

    /** Initial delivery does not remove the durable source needed by a later business-write join. */
    read(runIdValue: string): MaintenanceMemorySkillOutboxEntry | null {
        if (this.db.isTransaction !== false) throw new Error('memory-skill-outbox-uncommitted-read');
        const runId = agentClosureToken(runIdValue, 'run-id');
        const row = this.db.prepare(`SELECT rowid,run_id,session_id,payload_digest,payload_json
            FROM ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE} WHERE run_id=?`)
            .get(runId) as StoredRow | undefined;
        return row ? this.#parseRow(row) : null;
    }

    /** Poison records remain unacknowledged, but do not starve independent sessions behind them. */
    scan(limit = 64, cursor = 0): MaintenanceMemorySkillOutboxScan {
        return this.#scan(limit, cursor, false);
    }

    /** Write recovery also needs sources whose initial lifecycle evidence was already delivered. */
    scanAll(limit = 64, cursor = 0): MaintenanceMemorySkillOutboxScan {
        return this.#scan(limit, cursor, true);
    }

    #scan(limit: number, cursor: number, includeDelivered: boolean): MaintenanceMemorySkillOutboxScan {
        const rows = this.#rows(limit, cursor, includeDelivered);
        const entries: MaintenanceMemorySkillOutboxEntry[] = [];
        let failed = 0;
        for (const row of rows) {
            try { entries.push(this.#parseRow(row)); }
            catch { failed += 1; }
        }
        return Object.freeze({
            entries: Object.freeze(entries), attempted: rows.length, failed,
            nextCursor: rows.length === limit ? Number(rows.at(-1)!.rowid) : 0, hasMore: rows.length === limit
        });
    }

    #rows(limit: number, cursor: number, includeDelivered = false): readonly StoredRow[] {
        if (this.db.isTransaction !== false) throw new Error('memory-skill-outbox-uncommitted-read');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
            throw new Error('memory-skill-outbox-limit-invalid');
        }
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('memory-skill-outbox-cursor-invalid');
        return this.db.prepare(`SELECT rowid,run_id,session_id,payload_digest,payload_json
            FROM ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE}
            WHERE rowid>? AND (?=1 OR delivered_at IS NULL) ORDER BY rowid LIMIT ?`)
            .all(cursor, Number(includeDelivered), limit) as unknown as StoredRow[];
    }

    #parseRow(row: StoredRow): MaintenanceMemorySkillOutboxEntry {
        if (typeof row.payload_json !== 'string' || row.payload_json.length > MAX_PAYLOAD_CHARS) {
            throw new Error('memory-skill-outbox-payload-corrupt');
        }
        const value = JSON.parse(row.payload_json) as MaintenanceMemorySkillOutboxEntry;
        if (!['maintenance-memory-skill-outbox-v1', 'maintenance-memory-skill-outbox-v2'].includes(value.payloadVersion)
            || maintenanceMemorySkillDigest(value) !== row.payload_digest
            || JSON.stringify(value) !== row.payload_json || value.run.runId !== row.run_id
            || value.run.sessionId !== row.session_id) throw new Error('memory-skill-outbox-binding-corrupt');
        const proof = parseMaintenanceMemorySkillProposalProof(value.proof);
        const job = this.readJob(row.run_id);
        const direct = value.payloadVersion === 'maintenance-memory-skill-outbox-v2'
            ? this.#directProposal(row.run_id) : null;
        if (value.payloadVersion === 'maintenance-memory-skill-outbox-v2' && !direct) {
            throw new Error('memory-skill-outbox-direct-proposal-missing');
        }
        const normalized = direct ? directPacket(job, proof, direct) : packet(job, proof, this.#proposalId(job, proof));
        if (JSON.stringify(normalized) !== row.payload_json) throw new Error('memory-skill-outbox-intent-corrupt');
        return Object.freeze({ ...normalized, payloadDigest: row.payload_digest });
    }

    #directProposal(runId: string): MaintenanceMemoryDirectProposalRecord | null {
        const direct = MaintenanceMemoryDirectProposalStore.openExisting(this.db, this.readJob)?.read(runId) ?? null;
        if (direct && this.db.prepare('SELECT 1 FROM maintenance_pending_proposal WHERE job_run_id=?').get(runId)) {
            throw new Error('memory-skill-outbox-proposal-kind-conflict');
        }
        return direct;
    }

    #proposalId(job: PublicMaintenanceJob, proof: MaintenanceMemorySkillProposalProof): string | undefined {
        const row = this.db.prepare(`SELECT proposal_id,session_id,task_kind,source_revision,
            proposal_digest,proposal_json,created_at
            FROM maintenance_pending_proposal WHERE job_run_id=?`).get(job.runId) as {
            proposal_id: string; session_id: string; task_kind: string; source_revision: string;
            proposal_digest: string; proposal_json: string; created_at: string;
        } | undefined;
        if (job.proposal?.disposition === 'committed' && !row) return undefined;
        if (!row || row.session_id !== job.sessionId || row.task_kind !== job.taskKind
            || row.source_revision !== job.sourceRevision || row.proposal_digest !== proof.proposalDigest
            || row.created_at !== job.finishedAt
            || typeof row.proposal_json !== 'string' || row.proposal_json.length > 65_536
            || maintenanceMemorySkillDigest(JSON.parse(row.proposal_json)) !== proof.proposalDigest) {
            throw new Error('memory-skill-outbox-proposal-binding-invalid');
        }
        return row.proposal_id;
    }

    acknowledge(entry: MaintenanceMemorySkillOutboxEntry, at: string): void {
        if (this.db.isTransaction !== false) throw new Error('memory-skill-outbox-uncommitted-ack');
        const changed = this.db.prepare(`UPDATE ${MAINTENANCE_MEMORY_SKILL_OUTBOX_TABLE}
            SET delivered_at=COALESCE(delivered_at,?)
            WHERE run_id=? AND session_id=? AND payload_digest=?`)
            .run(at, entry.run.runId, entry.run.sessionId, entry.payloadDigest);
        if (Number(changed.changes) !== 1) throw new Error('memory-skill-outbox-ack-conflict');
    }
}
