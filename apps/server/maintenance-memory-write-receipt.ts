/** @author Codex @date 2026-10-14 @version 1.0
 * Session-owned write intent and genuinely post-business-COMMIT readback receipts.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';

export const MEMORY_WRITE_RECEIPT_PREFIX = 'maintenance_memory_write_receipt:';
export const MEMORY_WRITE_READBACK_VERSION = 'maintenance-memory-readback-v1';
const MAX_FACTS = 128;
const MAX_RECORD_CHARS = 65_536;
const FRESH = new WeakMap<object, object>();

export interface MemoryWriteFactProjection {
    readonly factDigest: string;
    readonly rowId: number;
    readonly rowDigest: string;
    readonly ledgerDigest: string;
}

export interface MemoryWriteProjection {
    readonly operationDigest: string;
    readonly truthVersion: number;
    readonly historyEpoch: number;
    readonly facts: readonly MemoryWriteFactProjection[];
}

export interface MemoryWriteIntent extends MemoryWriteProjection {
    readonly intentVersion: 'maintenance-memory-write-intent-v1';
    readonly runId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly proposalDigest: string;
    readonly committedAt: string;
    readonly targetRevision: string;
    readonly intentDigest: string;
}

export interface MemoryWriteVerifiedReadback {
    readonly status: 'verified';
    readonly version: typeof MEMORY_WRITE_READBACK_VERSION;
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
    readonly factCount: number;
    readonly projectionDigest: string;
    readonly readbackDigest: string;
}

export type MemoryWriteReadback = MemoryWriteVerifiedReadback | Readonly<{
    status: 'unavailable'; reasonCode: string;
}>;

interface JournalRecord {
    readonly journalVersion: 'maintenance-memory-write-journal-v1';
    readonly intent: MemoryWriteIntent;
    readonly state: 'pending' | 'verified' | 'invalidated';
    readonly readback: MemoryWriteVerifiedReadback | null;
    readonly recordDigest: string;
}

export type MemoryWriteStoredHistory = Readonly<Pick<JournalRecord, 'intent' | 'state' | 'readback'>>;

export function memoryWriteDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const unavailable = (reasonCode: string): MemoryWriteReadback => Object.freeze({ status: 'unavailable', reasonCode });

function positive(value: number, minimum = 1): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error('memory-write-version-invalid');
    return value;
}

function projection(input: MemoryWriteProjection): MemoryWriteProjection {
    if (!Array.isArray(input.facts) || input.facts.length < 1 || input.facts.length > MAX_FACTS) {
        throw new Error('memory-write-facts-invalid');
    }
    const facts = input.facts.map((fact) => Object.freeze({
        factDigest: agentClosureDigest(fact.factDigest, 'fact-digest'), rowId: positive(fact.rowId),
        rowDigest: agentClosureDigest(fact.rowDigest, 'row-digest'),
        ledgerDigest: agentClosureDigest(fact.ledgerDigest, 'ledger-digest'),
    })).sort((left, right) => left.factDigest < right.factDigest ? -1 : left.factDigest > right.factDigest ? 1 : 0);
    if (new Set(facts.map((fact) => fact.factDigest)).size !== facts.length
        || new Set(facts.map((fact) => fact.rowId)).size !== facts.length) {
        throw new Error('memory-write-facts-duplicate');
    }
    return Object.freeze({
        operationDigest: agentClosureDigest(input.operationDigest, 'operation-digest'),
        truthVersion: positive(input.truthVersion), historyEpoch: positive(input.historyEpoch, 0),
        facts: Object.freeze(facts),
    });
}

function intent(input: Omit<MemoryWriteIntent, 'targetRevision' | 'intentDigest'>): MemoryWriteIntent {
    if (input.intentVersion !== 'maintenance-memory-write-intent-v1'
        || !/^mjob_[a-f0-9]{32}$/u.test(input.runId)) throw new Error('memory-write-intent-invalid');
    const metadata = {
        intentVersion: input.intentVersion, runId: input.runId,
        sessionId: agentClosureToken(input.sessionId, 'session-id'),
        sourceRevision: agentClosureToken(input.sourceRevision, 'source-revision'),
        proposalDigest: agentClosureDigest(input.proposalDigest, 'proposal-digest'),
        committedAt: agentClosureTimestamp(input.committedAt, 'committed-at'), ...projection(input),
    };
    const targetRevision = memoryWriteDigest({ version: 'memory-write-target-v1', ...metadata });
    const result = { ...metadata, targetRevision };
    return Object.freeze({ ...result, intentDigest: memoryWriteDigest(result) });
}

export function parseMemoryWriteIntent(value: unknown): MemoryWriteIntent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('memory-write-intent-invalid');
    const result = intent(value as MemoryWriteIntent);
    if (JSON.stringify(result) !== JSON.stringify(value)) throw new Error('memory-write-intent-corrupt');
    return result;
}

export function parseMemoryWriteReadback(value: unknown): MemoryWriteVerifiedReadback {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('memory-readback-invalid');
    const row = value as MemoryWriteVerifiedReadback;
    if (row.status !== 'verified' || row.version !== MEMORY_WRITE_READBACK_VERSION) {
        throw new Error('memory-readback-version-invalid');
    }
    const metadata = {
        status: row.status, version: row.version,
        runId: agentClosureToken(row.runId, 'run-id'), sessionId: agentClosureToken(row.sessionId, 'session-id'),
        sourceRevision: agentClosureToken(row.sourceRevision, 'source-revision'),
        proposalDigest: agentClosureDigest(row.proposalDigest, 'proposal-digest'),
        targetRevision: agentClosureDigest(row.targetRevision, 'target-revision'),
        intentDigest: agentClosureDigest(row.intentDigest, 'intent-digest'),
        committedAt: agentClosureTimestamp(row.committedAt, 'committed-at'),
        verifiedAt: agentClosureTimestamp(row.verifiedAt, 'verified-at'),
        truthVersion: positive(row.truthVersion), historyEpoch: positive(row.historyEpoch, 0),
        factCount: positive(row.factCount),
        projectionDigest: agentClosureDigest(row.projectionDigest, 'projection-digest'),
    };
    const result = Object.freeze({ ...metadata, readbackDigest: memoryWriteDigest(metadata) });
    if (metadata.factCount > MAX_FACTS || metadata.verifiedAt < metadata.committedAt
        || JSON.stringify(result) !== JSON.stringify(value)) throw new Error('memory-readback-corrupt');
    return result;
}

/** Validation of a stored domain receipt, never a replacement for the producer's authoritative reads. */
export function memoryWriteReadbackForIdentity(value: unknown, identity: {
    runId: string; sessionId: string; sourceRevision: string; proposalDigest: string;
}): MemoryWriteVerifiedReadback | null {
    try {
        const result = parseMemoryWriteReadback(value);
        return result.runId === identity.runId && result.sessionId === identity.sessionId
            && result.sourceRevision === identity.sourceRevision && result.proposalDigest === identity.proposalDigest
            ? result : null;
    } catch { return null; }
}

function journalRecord(intentValue: MemoryWriteIntent, state: JournalRecord['state'],
    readback: MemoryWriteVerifiedReadback | null): JournalRecord {
    const metadata = { journalVersion: 'maintenance-memory-write-journal-v1' as const,
        intent: intentValue, state, readback };
    return Object.freeze({ ...metadata, recordDigest: memoryWriteDigest(metadata) });
}

/** No new tables or schema migration. All ports are fixed, synchronous trusted host readers. */
export class MaintenanceMemoryWriteReceipts {
    constructor(private readonly memory: { db: DatabaseSync; transaction<T>(work: () => T): T },
        private readonly ports: {
            readonly sessionId: string;
            readonly readOperation: (runId: string) => { status: string; operationDigest: string } | null;
            readonly readProjection: (expected: MemoryWriteIntent) => MemoryWriteProjection | null;
            readonly now: () => string;
        }) { }

    #key(runId: string): string {
        if (!/^mjob_[a-f0-9]{32}$/u.test(runId)) throw new Error('memory-write-run-id-invalid');
        return `${MEMORY_WRITE_RECEIPT_PREFIX}${runId}`;
    }

    #read(runId: string): JournalRecord | null {
        const stored = this.memory.db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.ports.sessionId, this.#key(runId)) as { value: string } | undefined;
        if (!stored) return null;
        if (stored.value.length > MAX_RECORD_CHARS) throw new Error('memory-write-record-too-large');
        const row = JSON.parse(stored.value) as JournalRecord;
        if (row.journalVersion !== 'maintenance-memory-write-journal-v1'
            || !['pending', 'verified', 'invalidated'].includes(row.state)) {
            throw new Error('memory-write-record-invalid');
        }
        const normalizedIntent = intent(row.intent);
        const readback = row.readback === null ? null : parseMemoryWriteReadback(row.readback);
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
                || readback.factCount !== normalizedIntent.facts.length
                || readback.projectionDigest !== memoryWriteDigest(projection(normalizedIntent))))
            || JSON.stringify(normalized) !== stored.value) throw new Error('memory-write-record-corrupt');
        return normalized;
    }

    #write(record: JournalRecord): void {
        const json = JSON.stringify(record);
        if (json.length > MAX_RECORD_CHARS) throw new Error('memory-write-record-too-large');
        this.memory.db.prepare(`INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(session_key,control_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .run(this.ports.sessionId, this.#key(record.intent.runId), json, this.ports.now());
        if (this.#read(record.intent.runId)?.recordDigest !== record.recordDigest) {
            throw new Error('memory-write-record-storage-mismatch');
        }
    }

    /** Optional source evidence is savepoint-isolated from the existing mandatory business operation ledger. */
    stage(input: Omit<MemoryWriteIntent, 'targetRevision' | 'intentDigest'>): MemoryWriteIntent | null {
        if (this.memory.db.isTransaction !== true) throw new Error('memory-write-business-transaction-required');
        this.memory.db.exec('SAVEPOINT memory_write_receipt;');
        try {
            const expected = intent(input);
            if (expected.sessionId !== this.ports.sessionId || this.#read(expected.runId)) {
                throw new Error('memory-write-intent-conflict');
            }
            this.#write(journalRecord(expected, 'pending', null));
            this.memory.db.exec('RELEASE memory_write_receipt;');
            FRESH.set(expected, this);
            return expected;
        } catch {
            this.memory.db.exec('ROLLBACK TO memory_write_receipt; RELEASE memory_write_receipt;');
            return null;
        }
    }

    verifyFresh(expected: MemoryWriteIntent): MemoryWriteReadback {
        if (FRESH.get(expected) !== this) return unavailable('memory-readback-not-fresh');
        FRESH.delete(expected);
        if (this.memory.db.isTransaction !== false) return unavailable('memory-readback-outer-transaction-open');
        try {
            const result = this.memory.transaction(() => {
                if (this.memory.db.isTransaction !== true) throw new Error('memory-readback-transaction-required');
                const record = this.#read(expected.runId);
                if (!record || record.state !== 'pending' || record.intent.intentDigest !== expected.intentDigest) {
                    return unavailable('memory-readback-intent-unavailable');
                }
                const current = this.ports.readProjection(expected);
                if (!current || memoryWriteDigest(projection(current)) !== memoryWriteDigest(projection(expected))) {
                    return unavailable('memory-readback-projection-drift');
                }
                const metadata = {
                    status: 'verified' as const, version: MEMORY_WRITE_READBACK_VERSION,
                    runId: expected.runId, sessionId: expected.sessionId, sourceRevision: expected.sourceRevision,
                    proposalDigest: expected.proposalDigest, targetRevision: expected.targetRevision,
                    intentDigest: expected.intentDigest, committedAt: expected.committedAt,
                    verifiedAt: this.ports.now(), truthVersion: expected.truthVersion,
                    historyEpoch: expected.historyEpoch, factCount: expected.facts.length,
                    projectionDigest: memoryWriteDigest(projection(current)),
                };
                const readback = parseMemoryWriteReadback({ ...metadata, readbackDigest: memoryWriteDigest(metadata) });
                this.#write(journalRecord(expected, 'verified', readback));
                return readback;
            });
            return this.memory.db.isTransaction === false
                ? result : unavailable('memory-readback-outer-transaction-open');
        } catch { return unavailable('memory-readback-verification-unavailable'); }
    }

    /** Recovery replays only an already committed receipt; it never queries current fact rows to invent history. */
    recorded(runId: string): MemoryWriteReadback {
        if (this.memory.db.isTransaction !== false) return unavailable('memory-readback-outer-transaction-open');
        try {
            const result = this.memory.transaction(() => {
                if (this.memory.db.isTransaction !== true) throw new Error('memory-readback-transaction-required');
                const record = this.#read(runId);
                const operation = this.ports.readOperation(runId);
                if (!record || record.state !== 'verified' || !record.readback) {
                    return unavailable('memory-readback-not-recorded');
                }
                if (!operation || operation.status !== 'applied'
                    || operation.operationDigest !== record.intent.operationDigest) {
                    return unavailable('memory-readback-operation-drift');
                }
                return record.readback;
            });
            return this.memory.db.isTransaction === false
                ? result : unavailable('memory-readback-outer-transaction-open');
        } catch { return unavailable('memory-readback-record-unavailable'); }
    }

    /** Stable business target metadata is not, by itself, a verified readback. */
    targetRevision(runId: string): string | null {
        try { return this.#read(runId)?.intent.targetRevision ?? null; }
        catch { return null; }
    }

    /** Trusted operation adapter only; callers must also verify the mandatory business marker. */
    readHistoryInTransaction(runId: string): MemoryWriteStoredHistory | null {
        if (this.memory.db.isTransaction !== true) throw new Error('memory-readback-transaction-required');
        const record = this.#read(runId);
        return record ? Object.freeze({ intent: record.intent, state: record.state, readback: record.readback }) : null;
    }

    invalidate(runId: string): boolean {
        if (this.memory.db.isTransaction !== true) throw new Error('memory-write-business-transaction-required');
        this.memory.db.exec('SAVEPOINT memory_write_receipt;');
        try {
            const record = this.#read(runId);
            if (record) this.#write(journalRecord(record.intent, 'invalidated', record.readback));
            this.memory.db.exec('RELEASE memory_write_receipt;');
            return true;
        } catch {
            this.memory.db.exec('ROLLBACK TO memory_write_receipt; RELEASE memory_write_receipt;');
            return false;
        }
    }
}
