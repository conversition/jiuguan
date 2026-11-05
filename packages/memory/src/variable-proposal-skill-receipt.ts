/** @author Codex @date 2026-10-27 @version 1.0
 * Body-free receipts for proposal-only variable proposal Skill requests. A receipt proves that one
 * exact request reached the model and produced one valid candidate; it never applies or adopts it.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const VARIABLE_PROPOSAL_SKILL_RECEIPT_PREFIX = 'variable_proposal_skill_request:';
export const VARIABLE_PROPOSAL_SKILL_RECEIPT_VERSION = 'variable-proposal-skill-receipt-v1' as const;
export const MAX_VARIABLE_PROPOSAL_SKILL_RECEIPT_CHARS = 2_048;
export const MAX_VARIABLE_PROPOSAL_SKILL_SCAN_LIMIT = 256;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SESSION_DIGEST = /^session:sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/u;
const RECEIPT_FIELDS = ['version', 'state', 'sessionDigest', 'runId', 'round', 'sourceDigest',
    'requestDigest', 'outputDigest', 'candidateDigest', 'candidateCount', 'skillRequestBound',
    'applied', 'adoption', 'authorizesExecution', 'authorizesPromotion', 'occurredAt'] as const;

export interface VariableProposalSkillReceipt {
    readonly version: typeof VARIABLE_PROPOSAL_SKILL_RECEIPT_VERSION;
    readonly state: 'request-accepted';
    readonly sessionDigest: string;
    readonly runId: string;
    readonly round: number;
    readonly sourceDigest: string;
    readonly requestDigest: string;
    readonly outputDigest: string;
    readonly candidateDigest: string;
    readonly candidateCount: number;
    readonly skillRequestBound: true;
    readonly applied: false;
    readonly adoption: 'not-attempted';
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
    readonly occurredAt: string;
}

export interface VariableProposalSkillReceiptEntry extends VariableProposalSkillReceipt {
    readonly controlKey: string;
    readonly receiptDigest: string;
}

export interface VariableProposalSkillReceiptScan {
    readonly entries: readonly VariableProposalSkillReceiptEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

export function variableProposalSkillReceiptDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
export function variableProposalSkillReceiptKey(runId: string): string {
    return VARIABLE_PROPOSAL_SKILL_RECEIPT_PREFIX + variableProposalSkillReceiptDigest([runId]).slice(7);
}

function invalid(): never { throw new Error('variable-proposal-skill-receipt-invalid'); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    return value as Record<string, unknown>;
}
function digest(value: unknown, label: string): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`variable-proposal-${label}-invalid`);
    return value;
}
function integer(value: unknown, label: string, minimum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`variable-proposal-${label}-invalid`);
    }
    return value;
}
function timestamp(value: unknown, label: string): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error(`variable-proposal-${label}-invalid`);
    return value;
}

/** Strict shape check shared by the writer and the read-only recovery path. */
export function normalizeVariableProposalSkillReceipt(value: unknown): VariableProposalSkillReceiptEntry {
    const row = record(value);
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...RECEIPT_FIELDS].sort())) invalid();
    if (row.version !== VARIABLE_PROPOSAL_SKILL_RECEIPT_VERSION || row.state !== 'request-accepted'
        || row.skillRequestBound !== true || row.applied !== false || row.adoption !== 'not-attempted'
        || row.authorizesExecution !== false || row.authorizesPromotion !== false) invalid();
    if (typeof row.sessionDigest !== 'string' || !SESSION_DIGEST.test(row.sessionDigest)) invalid();
    if (typeof row.runId !== 'string' || !TOKEN.test(row.runId)) invalid();
    const base = Object.freeze({
        version: VARIABLE_PROPOSAL_SKILL_RECEIPT_VERSION, state: 'request-accepted' as const,
        sessionDigest: row.sessionDigest as string, runId: row.runId,
        round: integer(row.round, 'round', 1),
        sourceDigest: digest(row.sourceDigest, 'source-digest'),
        requestDigest: digest(row.requestDigest, 'request-digest'),
        outputDigest: digest(row.outputDigest, 'output-digest'),
        candidateDigest: digest(row.candidateDigest, 'candidate-digest'),
        candidateCount: integer(row.candidateCount, 'candidate-count', 1),
        skillRequestBound: true as const, applied: false as const,
        adoption: 'not-attempted' as const,
        authorizesExecution: false as const, authorizesPromotion: false as const,
        occurredAt: timestamp(row.occurredAt, 'occurred-at'),
    });
    return Object.freeze({ ...base, controlKey: variableProposalSkillReceiptKey(base.runId),
        receiptDigest: variableProposalSkillReceiptDigest(base) });
}

export class VariableProposalSkillReceiptStore {
    readonly #db: DatabaseSync;
    readonly #rawSessionId: string;

    constructor(db: DatabaseSync, rawSessionId: string) {
        this.#db = db;
        this.#rawSessionId = rawSessionId;
        if (typeof rawSessionId !== 'string' || !rawSessionId) {
            throw new Error('variable-proposal-session-invalid');
        }
    }

    #read(runId: string): VariableProposalSkillReceiptEntry | null {
        const row = this.#db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.#rawSessionId, variableProposalSkillReceiptKey(runId)) as { value: string } | undefined;
        if (!row) return null;
        if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PROPOSAL_SKILL_RECEIPT_CHARS) invalid();
        const entry = normalizeVariableProposalSkillReceipt(JSON.parse(row.value) as unknown);
        if (entry.runId !== runId) invalid();
        return entry;
    }

    get(runId: string): VariableProposalSkillReceiptEntry | null {
        if (typeof runId !== 'string' || !TOKEN.test(runId)) invalid();
        return this.#read(runId);
    }

    /** One receipt per run; an identical replay is a no-op, a different candidate is a conflict. */
    record(input: Omit<VariableProposalSkillReceipt, 'version' | 'state' | 'skillRequestBound'
        | 'applied' | 'adoption' | 'authorizesExecution' | 'authorizesPromotion' | 'occurredAt'>
        & { readonly occurredAt?: string }): VariableProposalSkillReceipt {
        if (this.#db.isTransaction !== true) {
            throw new Error('variable-proposal-skill-receipt-transaction-required');
        }
        const base = Object.freeze({
            version: VARIABLE_PROPOSAL_SKILL_RECEIPT_VERSION, state: 'request-accepted' as const,
            sessionDigest: input.sessionDigest, runId: input.runId,
            round: integer(input.round, 'round', 1),
            sourceDigest: digest(input.sourceDigest, 'source-digest'),
            requestDigest: digest(input.requestDigest, 'request-digest'),
            outputDigest: digest(input.outputDigest, 'output-digest'),
            candidateDigest: digest(input.candidateDigest, 'candidate-digest'),
            candidateCount: integer(input.candidateCount, 'candidate-count', 1),
            skillRequestBound: true as const, applied: false as const,
            adoption: 'not-attempted' as const,
            authorizesExecution: false as const, authorizesPromotion: false as const,
            occurredAt: timestamp(input.occurredAt ?? new Date().toISOString(), 'occurred-at'),
        });
        const entry = normalizeVariableProposalSkillReceipt(base);
        const json = JSON.stringify(receiptOf(entry));
        if (json.length > MAX_VARIABLE_PROPOSAL_SKILL_RECEIPT_CHARS) invalid();
        const previous = this.#read(entry.runId);
        if (previous) {
            if (previous.candidateDigest !== entry.candidateDigest
                || previous.requestDigest !== entry.requestDigest) {
                throw new Error('variable-proposal-skill-receipt-conflict');
            }
            return receiptOf(previous);
        }
        this.#db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.#rawSessionId, entry.controlKey, json, entry.occurredAt);
        const written = this.#read(entry.runId);
        if (!written || written.receiptDigest !== entry.receiptDigest) {
            throw new Error('variable-proposal-skill-receipt-readback-failed');
        }
        return receiptOf(written);
    }

    /** Rowid cursor advances past corrupt rows; valid for readOnly/query_only recovery handles. */
    scan(input: Readonly<{ limit?: number; cursor?: number }> = {}): VariableProposalSkillReceiptScan {
        const limit = integer(input.limit ?? 64, 'scan-limit', 1);
        const cursor = integer(input.cursor ?? 0, 'scan-cursor', 0);
        if (limit > MAX_VARIABLE_PROPOSAL_SKILL_SCAN_LIMIT) throw new Error('variable-proposal-scan-limit-invalid');
        const rows = this.#db.prepare(`SELECT rowid,control_key,value FROM session_control WHERE session_key=?
            AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.#rawSessionId, `${VARIABLE_PROPOSAL_SKILL_RECEIPT_PREFIX}*`, cursor, limit + 1) as
            { rowid: number; control_key: string; value: string }[];
        const page = rows.slice(0, limit), entries: VariableProposalSkillReceiptEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PROPOSAL_SKILL_RECEIPT_CHARS) invalid();
                const entry = normalizeVariableProposalSkillReceipt(JSON.parse(row.value) as unknown);
                if (entry.controlKey !== row.control_key) invalid();
                entries.push(entry);
            } catch { failed += 1; }
        }
        return Object.freeze({ entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit });
    }
}

function receiptOf(entry: VariableProposalSkillReceiptEntry): VariableProposalSkillReceipt {
    return Object.freeze({
        version: entry.version, state: entry.state, sessionDigest: entry.sessionDigest, runId: entry.runId,
        round: entry.round, sourceDigest: entry.sourceDigest, requestDigest: entry.requestDigest,
        outputDigest: entry.outputDigest, candidateDigest: entry.candidateDigest,
        candidateCount: entry.candidateCount, skillRequestBound: true as const, applied: false as const,
        adoption: 'not-attempted' as const, authorizesExecution: false as const,
        authorizesPromotion: false as const, occurredAt: entry.occurredAt,
    });
}
