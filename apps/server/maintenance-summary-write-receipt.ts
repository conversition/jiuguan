/** @author Codex @date 2026-10-14 @version 1.0
 * Rolling Summary-specific write intent and post-business-COMMIT historical receipts.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';
import { normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import { AGENT_LOOP_SUMMARY_WRITE_ORIGIN_PREFIX, AGENT_LOOP_SUMMARY_WRITE_ORIGIN_RECORD_VERSION,
    createAgentLoopSummaryWriteOriginRecord, parseAgentLoopSummaryWriteOrigin, parseAgentLoopSummaryWriteOriginRecord,
    type AgentLoopSummaryWriteOrigin, type AgentLoopSummaryWriteOriginRecord } from './agent-loop-summary-write-origin.ts';
export { AGENT_LOOP_SUMMARY_WRITE_ORIGIN_PREFIX } from './agent-loop-summary-write-origin.ts';

export const SUMMARY_WRITE_RECEIPT_PREFIX = 'maintenance_summary_write_receipt:';
export const SUMMARY_WRITE_READBACK_VERSION = 'maintenance-summary-readback-v1';
const MAX_RECORD_CHARS = 16_384;
const FRESH = new WeakMap<object, object>();

export interface SummaryWriteProjection {
    readonly operationDigest: string;
    readonly throughRound: number;
    readonly summaryDigest: string;
    readonly truthVersion: number;
    readonly historyEpoch: number;
}

export interface SummaryWriteIntent extends SummaryWriteProjection {
    readonly intentVersion: 'maintenance-summary-write-intent-v1';
    readonly runId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly proposalDigest: string;
    readonly committedAt: string;
    readonly targetRevision: string;
    readonly intentDigest: string;
}

export interface SummaryWriteVerifiedReadback {
    readonly status: 'verified';
    readonly version: typeof SUMMARY_WRITE_READBACK_VERSION;
    readonly runId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly proposalDigest: string;
    readonly targetRevision: string;
    readonly intentDigest: string;
    readonly committedAt: string;
    readonly verifiedAt: string;
    readonly truthVersion: number;
    readonly historyEpoch: number;
    readonly throughRound: number;
    readonly summaryDigest: string;
    readonly projectionDigest: string;
    readonly readbackDigest: string;
}

export type SummaryWriteReadback = SummaryWriteVerifiedReadback | Readonly<{
    status: 'unavailable'; reasonCode: string;
}>;

interface JournalRecord {
    readonly journalVersion: 'maintenance-summary-write-journal-v1';
    readonly intent: SummaryWriteIntent;
    readonly state: 'pending' | 'verified' | 'invalidated';
    readonly readback: SummaryWriteVerifiedReadback | null;
    readonly recordDigest: string;
}

export type SummaryWriteStoredHistory = Readonly<Pick<JournalRecord, 'intent' | 'state' | 'readback'>>;

export function summaryWriteDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const unavailable = (reasonCode: string): SummaryWriteReadback => Object.freeze({ status: 'unavailable', reasonCode });

function positive(value: number, minimum = 1): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error('summary-write-version-invalid');
    return value;
}

function projection(input: SummaryWriteProjection): SummaryWriteProjection {
    return Object.freeze({
        operationDigest: agentClosureDigest(input.operationDigest, 'operation-digest'),
        throughRound: positive(input.throughRound),
        summaryDigest: agentClosureDigest(input.summaryDigest, 'summary-digest'),
        truthVersion: positive(input.truthVersion), historyEpoch: positive(input.historyEpoch, 0),
    });
}

function intent(input: Omit<SummaryWriteIntent, 'targetRevision' | 'intentDigest'>): SummaryWriteIntent {
    if (input.intentVersion !== 'maintenance-summary-write-intent-v1'
        || !/^mjob_[a-f0-9]{32}$/u.test(input.runId)) throw new Error('summary-write-intent-invalid');
    const metadata = {
        intentVersion: input.intentVersion, runId: input.runId,
        sessionId: agentClosureToken(input.sessionId, 'session-id'),
        sourceRevision: agentClosureToken(input.sourceRevision, 'source-revision'),
        proposalDigest: agentClosureDigest(input.proposalDigest, 'proposal-digest'),
        committedAt: agentClosureTimestamp(input.committedAt, 'committed-at'), ...projection(input),
    };
    const targetRevision = summaryWriteDigest({ version: 'summary-write-target-v1', ...metadata });
    const result = { ...metadata, targetRevision };
    return Object.freeze({ ...result, intentDigest: summaryWriteDigest(result) });
}

export function parseSummaryWriteIntent(value: unknown): SummaryWriteIntent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('summary-write-intent-invalid');
    const result = intent(value as SummaryWriteIntent);
    if (JSON.stringify(result) !== JSON.stringify(value)) throw new Error('summary-write-intent-corrupt');
    return result;
}

export function parseSummaryWriteReadback(value: unknown): SummaryWriteVerifiedReadback {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('summary-readback-invalid');
    const row = value as SummaryWriteVerifiedReadback;
    if (row.status !== 'verified' || row.version !== SUMMARY_WRITE_READBACK_VERSION
        || !/^mjob_[a-f0-9]{32}$/u.test(row.runId)) throw new Error('summary-readback-version-invalid');
    const metadata = {
        status: row.status, version: row.version,
        runId: row.runId, sessionId: agentClosureToken(row.sessionId, 'session-id'),
        sourceRevision: agentClosureToken(row.sourceRevision, 'source-revision'),
        proposalDigest: agentClosureDigest(row.proposalDigest, 'proposal-digest'),
        targetRevision: agentClosureDigest(row.targetRevision, 'target-revision'),
        intentDigest: agentClosureDigest(row.intentDigest, 'intent-digest'),
        committedAt: agentClosureTimestamp(row.committedAt, 'committed-at'),
        verifiedAt: agentClosureTimestamp(row.verifiedAt, 'verified-at'),
        truthVersion: positive(row.truthVersion), historyEpoch: positive(row.historyEpoch, 0),
        throughRound: positive(row.throughRound),
        summaryDigest: agentClosureDigest(row.summaryDigest, 'summary-digest'),
        projectionDigest: agentClosureDigest(row.projectionDigest, 'projection-digest'),
    };
    const result = Object.freeze({ ...metadata, readbackDigest: summaryWriteDigest(metadata) });
    if (metadata.verifiedAt < metadata.committedAt || JSON.stringify(result) !== JSON.stringify(value)) {
        throw new Error('summary-readback-corrupt');
    }
    return result;
}

/** Stored receipt validation cannot replace the producer's authoritative database reads. */
export function summaryWriteReadbackForIdentity(value: unknown, identity: {
    runId: string; sessionId: string; sourceRevision: string; proposalDigest: string;
}): SummaryWriteVerifiedReadback | null {
    try {
        const result = parseSummaryWriteReadback(value);
        return result.runId === identity.runId && result.sessionId === identity.sessionId
            && result.sourceRevision === identity.sourceRevision && result.proposalDigest === identity.proposalDigest
            ? result : null;
    } catch { return null; }
}

function journalRecord(intentValue: SummaryWriteIntent, state: JournalRecord['state'],
    readback: SummaryWriteVerifiedReadback | null): JournalRecord {
    const metadata = {
        journalVersion: 'maintenance-summary-write-journal-v1' as const,
        intent: intentValue, state, readback
    };
    return Object.freeze({ ...metadata, recordDigest: summaryWriteDigest(metadata) });
}

/** Existing Session control rows only; no schema migration and no dependency on the closure sidecar. */
export class MaintenanceSummaryWriteReceipts {
    constructor(private readonly memory: { db: DatabaseSync; transaction<T>(work: () => T): T },
        private readonly ports: {
            readonly sessionId: string;
            readonly readOperation: (runId: string) => { status: string; operationDigest: string; agentLoopOriginDigest?: string } | null;
            readonly readProjection: (expected: SummaryWriteIntent) => SummaryWriteProjection | null;
            readonly now: () => string;
        }) { }

    #key(runId: string): string {
        if (!/^mjob_[a-f0-9]{32}$/u.test(runId)) throw new Error('summary-write-run-id-invalid');
        return `${SUMMARY_WRITE_RECEIPT_PREFIX}${runId}`;
    }

    #originKey(runId: string): string {
        this.#key(runId);
        return `${AGENT_LOOP_SUMMARY_WRITE_ORIGIN_PREFIX}${runId}`;
    }

    #read(runId: string): JournalRecord | null {
        const stored = this.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.ports.sessionId, this.#key(runId)) as { value: string } | undefined;
        if (!stored) return null;
        if (stored.value.length > MAX_RECORD_CHARS) throw new Error('summary-write-record-too-large');
        const row = JSON.parse(stored.value) as JournalRecord;
        if (row.journalVersion !== 'maintenance-summary-write-journal-v1'
            || !['pending', 'verified', 'invalidated'].includes(row.state)) {
            throw new Error('summary-write-record-invalid');
        }
        const normalizedIntent = parseSummaryWriteIntent(row.intent);
        const readback = row.readback === null ? null : parseSummaryWriteReadback(row.readback);
        const normalized = journalRecord(normalizedIntent, row.state, readback);
        if (normalizedIntent.sessionId !== this.ports.sessionId || normalizedIntent.runId !== runId
            || (row.state === 'pending' && readback !== null) || (row.state === 'verified' && readback === null)
            || (readback && (readback.intentDigest !== normalizedIntent.intentDigest
                || readback.targetRevision !== normalizedIntent.targetRevision
                || readback.runId !== normalizedIntent.runId || readback.sessionId !== normalizedIntent.sessionId
                || readback.sourceRevision !== normalizedIntent.sourceRevision
                || readback.proposalDigest !== normalizedIntent.proposalDigest
                || readback.committedAt !== normalizedIntent.committedAt
                || readback.truthVersion !== normalizedIntent.truthVersion
                || readback.historyEpoch !== normalizedIntent.historyEpoch
                || readback.throughRound !== normalizedIntent.throughRound
                || readback.summaryDigest !== normalizedIntent.summaryDigest
                || readback.projectionDigest !== summaryWriteDigest(projection(normalizedIntent))))
            || JSON.stringify(normalized) !== stored.value) throw new Error('summary-write-record-corrupt');
        return normalized;
    }

    #write(record: JournalRecord): void {
        const json = JSON.stringify(record);
        if (json.length > MAX_RECORD_CHARS) throw new Error('summary-write-record-too-large');
        this.memory.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(this.ports.sessionId, this.#key(record.intent.runId), json, this.ports.now());
        if (this.#read(record.intent.runId)?.recordDigest !== record.recordDigest) {
            throw new Error('summary-write-record-storage-mismatch');
        }
    }

    /** Optional evidence cannot prevent an otherwise authorized Summary business write. */
    stage(input: Omit<SummaryWriteIntent, 'targetRevision' | 'intentDigest'>): SummaryWriteIntent | null {
        if (this.memory.db.isTransaction !== true) throw new Error('summary-write-business-transaction-required');
        this.memory.db.exec('SAVEPOINT summary_write_receipt;');
        try {
            const expected = intent(input);
            if (expected.sessionId !== this.ports.sessionId || this.#read(expected.runId)) {
                throw new Error('summary-write-intent-conflict');
            }
            this.#write(journalRecord(expected, 'pending', null));
            this.memory.db.exec('RELEASE summary_write_receipt;');
            FRESH.set(expected, this);
            return expected;
        } catch {
            this.memory.db.exec('ROLLBACK TO summary_write_receipt; RELEASE summary_write_receipt;');
            return null;
        }
    }

    /** Mandatory AL metadata, only inside the original Summary business TX.
     * No savepoint or swallowed failure: the original committer must propagate
     * rejection so the business write, marker and both metadata rows roll back.
     * This stores origin only; it neither issues an AL capability nor readback.
     */
    stageAgentLoop(input: Omit<SummaryWriteIntent, 'targetRevision' | 'intentDigest'>,
        originValue: AgentLoopSummaryWriteOrigin): SummaryWriteIntent {
        if (this.memory.db.isTransaction !== true) throw new Error('summary-write-business-transaction-required');
        const fields = normalizeAgentLoopActionObject(input, ['intentVersion', 'runId', 'sessionId', 'sourceRevision',
            'proposalDigest', 'committedAt', 'operationDigest', 'throughRound', 'summaryDigest', 'truthVersion', 'historyEpoch']);
        if (Reflect.ownKeys(fields).some(key => !Object.getOwnPropertyDescriptor(fields, key)?.enumerable)) {
            throw new Error('summary-write-agent-loop-input-invalid');
        }
        const origin = parseAgentLoopSummaryWriteOrigin(originValue), expected = intent(input);
        if (expected.sessionId !== this.ports.sessionId || origin.runId !== expected.runId || origin.sessionId !== expected.sessionId
            || origin.sourceRevision !== expected.sourceRevision || origin.proposalDigest !== expected.proposalDigest
            || this.#read(expected.runId) || this.memory.db.prepare('SELECT 1 FROM session_control WHERE session_key=? AND control_key=?')
                .get(this.ports.sessionId, this.#originKey(expected.runId))) throw new Error('summary-write-agent-loop-intent-conflict');
        const operation: unknown = this.ports.readOperation(expected.runId);
        if (operation !== null && typeof operation === 'object') {
            try { void Promise.prototype.then.call(operation, () => undefined, () => undefined); }
            catch { /* Never inspect or assimilate an arbitrary then property. */ }
        }
        const actual = normalizeAgentLoopActionObject(operation, ['status', 'operationDigest'], ['agentLoopOriginDigest']);
        if (actual.status !== 'applied' || actual.operationDigest !== expected.operationDigest
            || actual.agentLoopOriginDigest !== origin.originDigest) throw new Error('summary-write-agent-loop-operation-unbound');
        const record = createAgentLoopSummaryWriteOriginRecord({ version: AGENT_LOOP_SUMMARY_WRITE_ORIGIN_RECORD_VERSION,
            origin, intentDigest: expected.intentDigest, operationDigest: expected.operationDigest, committedAt: expected.committedAt });
        const originJson = JSON.stringify(record), journal = journalRecord(expected, 'pending', null), journalJson = JSON.stringify(journal);
        if (originJson.length > MAX_RECORD_CHARS || journalJson.length > MAX_RECORD_CHARS) throw new Error('summary-write-record-too-large');
        // Both inserts are strict: no UPSERT may retrofit or replace a legacy run.
        this.memory.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.ports.sessionId, this.#originKey(expected.runId), originJson, expected.committedAt);
        this.memory.db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.ports.sessionId, this.#key(expected.runId), journalJson, this.ports.now());
        if (this.#read(expected.runId)?.recordDigest !== journal.recordDigest
            || this.readAgentLoopOriginInTransaction(expected.runId)?.recordDigest !== record.recordDigest) {
            throw new Error('summary-write-agent-loop-storage-mismatch');
        }
        FRESH.set(expected, this);
        return expected;
    }

    /** Immutable origin read only. Rollback/invalidation remains authoritative
     * in the original operation/journal reader, not a mutable second state row.
     * Missing evidence is never reconstructed from current Summary or old JSON.
     */
    readAgentLoopOriginInTransaction(runId: string): AgentLoopSummaryWriteOriginRecord | null {
        if (this.memory.db.isTransaction !== true) throw new Error('summary-readback-transaction-required');
        const row = this.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.ports.sessionId, this.#originKey(runId)) as { value: string } | undefined;
        if (!row) return null;
        if (typeof row.value !== 'string' || row.value.length > MAX_RECORD_CHARS) throw new Error('summary-write-agent-loop-record-invalid');
        const record = parseAgentLoopSummaryWriteOriginRecord(JSON.parse(row.value)), journal = this.#read(runId);
        if (record.origin.runId !== runId || record.origin.sessionId !== this.ports.sessionId
            || JSON.stringify(record) !== row.value || !journal || record.intentDigest !== journal.intent.intentDigest
            || record.operationDigest !== journal.intent.operationDigest || record.committedAt !== journal.intent.committedAt
            || record.origin.sourceRevision !== journal.intent.sourceRevision || record.origin.proposalDigest !== journal.intent.proposalDigest) {
            throw new Error('summary-write-agent-loop-record-corrupt');
        }
        return record;
    }

    verifyFresh(expected: SummaryWriteIntent): SummaryWriteReadback {
        if (FRESH.get(expected) !== this) return unavailable('summary-readback-not-fresh');
        FRESH.delete(expected);
        if (this.memory.db.isTransaction !== false) return unavailable('summary-readback-outer-transaction-open');
        try {
            const result = this.memory.transaction(() => {
                if (this.memory.db.isTransaction !== true) throw new Error('summary-readback-transaction-required');
                const record = this.#read(expected.runId);
                if (!record || record.state !== 'pending' || record.intent.intentDigest !== expected.intentDigest) {
                    return unavailable('summary-readback-intent-unavailable');
                }
                const current = this.ports.readProjection(expected);
                if (!current || summaryWriteDigest(projection(current)) !== summaryWriteDigest(projection(expected))) {
                    return unavailable('summary-readback-projection-drift');
                }
                const metadata = {
                    status: 'verified' as const, version: SUMMARY_WRITE_READBACK_VERSION,
                    runId: expected.runId, sessionId: expected.sessionId, sourceRevision: expected.sourceRevision,
                    proposalDigest: expected.proposalDigest, targetRevision: expected.targetRevision,
                    intentDigest: expected.intentDigest, committedAt: expected.committedAt,
                    verifiedAt: this.ports.now(), truthVersion: expected.truthVersion,
                    historyEpoch: expected.historyEpoch, throughRound: expected.throughRound,
                    summaryDigest: expected.summaryDigest, projectionDigest: summaryWriteDigest(projection(current)),
                };
                const readback = parseSummaryWriteReadback({
                    ...metadata, readbackDigest: summaryWriteDigest(metadata),
                });
                this.#write(journalRecord(expected, 'verified', readback));
                return readback;
            });
            return this.memory.db.isTransaction === false
                ? result : unavailable('summary-readback-outer-transaction-open');
        } catch { return unavailable('summary-readback-verification-unavailable'); }
    }

    /** Only the original committed receipt is replayed; current summary text never reconstructs history. */
    recorded(runId: string): SummaryWriteReadback {
        if (this.memory.db.isTransaction !== false) return unavailable('summary-readback-outer-transaction-open');
        try {
            const result = this.memory.transaction(() => {
                if (this.memory.db.isTransaction !== true) throw new Error('summary-readback-transaction-required');
                const record = this.#read(runId);
                const operation = this.ports.readOperation(runId);
                if (!record || record.state !== 'verified' || !record.readback) {
                    return unavailable('summary-readback-not-recorded');
                }
                if (!operation || operation.status !== 'applied'
                    || operation.operationDigest !== record.intent.operationDigest) {
                    return unavailable('summary-readback-operation-drift');
                }
                return record.readback;
            });
            return this.memory.db.isTransaction === false
                ? result : unavailable('summary-readback-outer-transaction-open');
        } catch { return unavailable('summary-readback-record-unavailable'); }
    }

    targetRevision(runId: string): string | null {
        try { return this.#read(runId)?.intent.targetRevision ?? null; }
        catch { return null; }
    }

    readHistoryInTransaction(runId: string): SummaryWriteStoredHistory | null {
        if (this.memory.db.isTransaction !== true) throw new Error('summary-readback-transaction-required');
        const record = this.#read(runId);
        return record ? Object.freeze({ intent: record.intent, state: record.state, readback: record.readback }) : null;
    }

    invalidate(runId: string): boolean {
        if (this.memory.db.isTransaction !== true) throw new Error('summary-write-business-transaction-required');
        this.memory.db.exec('SAVEPOINT summary_write_receipt;');
        try {
            const record = this.#read(runId);
            if (record) this.#write(journalRecord(record.intent, 'invalidated', record.readback));
            this.memory.db.exec('RELEASE summary_write_receipt;');
            return true;
        } catch {
            this.memory.db.exec('ROLLBACK TO summary_write_receipt; RELEASE summary_write_receipt;');
            return false;
        }
    }
}
