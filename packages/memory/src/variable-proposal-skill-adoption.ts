/** @author Codex @date 2026-10-28 @version 1.0
 * Insert-only, body-free links between exact Skill requests and committed variable patches.
 * Existing request/apply receipts retain their original meaning and immutable bytes.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
    VariablePatchApplyEvidenceStore, variablePatchApplyEvidenceDigest, variablePatchApplySessionDigest,
    type VariablePatchApplyEvidenceEntry,
} from './variable-patch-apply-evidence.ts';
import {
    VariableProposalSkillReceiptStore, variableProposalSkillReceiptDigest,
    type VariableProposalSkillReceiptEntry,
} from './variable-proposal-skill-receipt.ts';

export const VARIABLE_PROPOSAL_SKILL_ADOPTION_PREFIX = 'variable_proposal_skill_adoption:';
export const VARIABLE_PROPOSAL_SKILL_ADOPTION_VERSION = 'variable-proposal-skill-adoption-v1' as const;
export const MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_CHARS = 2_048;
export const MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_SCAN_LIMIT = 256;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/u;
const MAX_PATCHES = 8;
const FIELDS = ['version', 'state', 'sessionDigest', 'runId', 'round', 'requestReceiptDigest',
    'applyReceiptDigest', 'candidateDigest', 'patchDigest', 'candidateCount', 'skillRequestBound',
    'applied', 'authorizesExecution', 'authorizesPromotion', 'occurredAt'] as const;

export interface VariableProposalAdoptionPatch {
    readonly operationKey: string;
    readonly patches: readonly { readonly path: string; readonly value: string | number | boolean }[];
}

export interface VariableProposalSkillAdoption {
    readonly version: typeof VARIABLE_PROPOSAL_SKILL_ADOPTION_VERSION;
    readonly state: 'apply-linked';
    readonly sessionDigest: string;
    readonly runId: string;
    readonly round: number;
    readonly requestReceiptDigest: string;
    readonly applyReceiptDigest: string;
    readonly candidateDigest: string;
    readonly patchDigest: string;
    readonly candidateCount: number;
    readonly skillRequestBound: true;
    readonly applied: true;
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
    readonly occurredAt: string;
}

export interface VariableProposalSkillAdoptionEntry extends VariableProposalSkillAdoption {
    readonly controlKey: string;
    readonly receiptDigest: string;
}

export interface VariableProposalSkillAdoptionScan {
    readonly entries: readonly VariableProposalSkillAdoptionEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

function invalid(): never { throw new Error('variable-proposal-skill-adoption-invalid'); }
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    return value as Record<string, unknown>;
}
function runToken(runId: unknown): string {
    if (typeof runId !== 'string' || !TOKEN.test(runId)) invalid();
    return runId;
}
function integer(value: unknown, minimum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid();
    return value;
}
function digest(value: unknown): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) invalid();
    return value;
}
function operationKey(runId: string): string {
    return `variable-proposal:${variableProposalSkillReceiptDigest([runToken(runId)]).slice(7)}`;
}

/** Canonical frozen patch shared by the live capture and its adoption receipt. */
export function createVariableProposalAdoptionPatch(runId: string,
    patches: VariableProposalAdoptionPatch['patches']): VariableProposalAdoptionPatch {
    const key = operationKey(runId);
    if (!Array.isArray(patches) || patches.length < 1 || patches.length > MAX_PATCHES) invalid();
    const seen = new Set<string>();
    const checked = patches.map((item) => {
        const row = object(item);
        if (Object.keys(row).sort().join(',') !== 'path,value' || typeof row.path !== 'string'
            || row.path.length < 1 || row.path.length > 512 || seen.has(row.path)) invalid();
        if (!['string', 'number', 'boolean'].includes(typeof row.value)
            || (typeof row.value === 'number' && !Number.isFinite(row.value))) invalid();
        seen.add(row.path);
        return Object.freeze({ path: row.path, value: row.value as string | number | boolean });
    });
    return Object.freeze({ operationKey: key, patches: Object.freeze(checked) });
}

export function variableProposalSkillAdoptionKey(runId: string): string {
    return VARIABLE_PROPOSAL_SKILL_ADOPTION_PREFIX + variableProposalSkillReceiptDigest([runToken(runId)]).slice(7);
}

/** Strict metadata shape for write and read-only recovery paths. */
export function normalizeVariableProposalSkillAdoption(value: unknown,
    rawSessionId: string): VariableProposalSkillAdoptionEntry {
    const row = object(value);
    const sessionDigest = variablePatchApplySessionDigest(rawSessionId);
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...FIELDS].sort())
        || row.version !== VARIABLE_PROPOSAL_SKILL_ADOPTION_VERSION || row.state !== 'apply-linked'
        || row.sessionDigest !== sessionDigest || row.skillRequestBound !== true || row.applied !== true
        || row.authorizesExecution !== false || row.authorizesPromotion !== false) invalid();
    if (typeof row.occurredAt !== 'string' || !Number.isFinite(Date.parse(row.occurredAt))
        || new Date(row.occurredAt).toISOString() !== row.occurredAt) invalid();
    const base = Object.freeze({
        version: VARIABLE_PROPOSAL_SKILL_ADOPTION_VERSION, state: 'apply-linked' as const,
        sessionDigest, runId: runToken(row.runId), round: integer(row.round, 1),
        requestReceiptDigest: digest(row.requestReceiptDigest), applyReceiptDigest: digest(row.applyReceiptDigest),
        candidateDigest: digest(row.candidateDigest), patchDigest: digest(row.patchDigest),
        candidateCount: integer(row.candidateCount, 1), skillRequestBound: true as const, applied: true as const,
        authorizesExecution: false as const, authorizesPromotion: false as const, occurredAt: row.occurredAt,
    });
    if (base.candidateCount > MAX_PATCHES) invalid();
    return Object.freeze({ ...base, controlKey: variableProposalSkillAdoptionKey(base.runId),
        receiptDigest: variableProposalSkillReceiptDigest(base) });
}

function receiptOf(entry: VariableProposalSkillAdoptionEntry): VariableProposalSkillAdoption {
    const { controlKey, receiptDigest, ...receipt } = entry;
    return Object.freeze(receipt);
}

/** Session-owned link. Every read revalidates both immutable receipts, including query_only handles. */
export class VariableProposalSkillAdoptionStore {
    readonly #db: DatabaseSync;
    readonly #rawSessionId: string;

    constructor(db: DatabaseSync, rawSessionId: string) {
        this.#db = db;
        this.#rawSessionId = rawSessionId;
        variablePatchApplySessionDigest(rawSessionId);
    }

    #receipts(runId: string): {
        request: VariableProposalSkillReceiptEntry; apply: VariablePatchApplyEvidenceEntry;
    } {
        const request = new VariableProposalSkillReceiptStore(this.#db, this.#rawSessionId).get(runId);
        const apply = new VariablePatchApplyEvidenceStore(this.#db, this.#rawSessionId).get(runId);
        const session = `session:${variableProposalSkillReceiptDigest([
            'variable-proposal-skill-session', this.#rawSessionId,
        ])}`;
        if (!request || !apply || request.sessionDigest !== session || request.runId !== apply.runId
            || request.round !== apply.round || request.candidateCount !== apply.touchedPathCount
            || apply.operationKeyDigest !== variablePatchApplyEvidenceDigest([
                'interactive-variable-operation-key-v1', operationKey(runId),
            ])) throw new Error('variable-proposal-skill-adoption-receipt-mismatch');
        return { request, apply };
    }

    #verify(entry: VariableProposalSkillAdoptionEntry): VariableProposalSkillAdoptionEntry {
        const { request, apply } = this.#receipts(entry.runId);
        if (entry.round !== apply.round || entry.requestReceiptDigest !== request.receiptDigest
            || entry.applyReceiptDigest !== apply.receiptDigest || entry.candidateDigest !== request.candidateDigest
            || entry.patchDigest !== apply.patchDigest || entry.candidateCount !== request.candidateCount
            || entry.occurredAt !== apply.occurredAt) {
            throw new Error('variable-proposal-skill-adoption-link-mismatch');
        }
        return entry;
    }

    #read(runId: string): VariableProposalSkillAdoptionEntry | null {
        const row = this.#db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.#rawSessionId, variableProposalSkillAdoptionKey(runId)) as { value: string } | undefined;
        if (!row) return null;
        if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_CHARS) invalid();
        const entry = normalizeVariableProposalSkillAdoption(JSON.parse(row.value) as unknown, this.#rawSessionId);
        if (entry.runId !== runId) invalid();
        return this.#verify(entry);
    }

    get(runId: string): VariableProposalSkillAdoptionEntry | null {
        return this.#read(runToken(runId));
    }

    /** Call after request receipt + actual apply in their shared Session commit transaction. */
    record(input: Readonly<{ runId: string; patch: VariableProposalAdoptionPatch }>): VariableProposalSkillAdoption {
        if (this.#db.isTransaction !== true) throw new Error('variable-proposal-skill-adoption-transaction-required');
        const runId = runToken(input.runId), supplied = object(input.patch);
        if (Object.keys(supplied).sort().join(',') !== 'operationKey,patches') invalid();
        const patch = createVariableProposalAdoptionPatch(runId, input.patch.patches);
        if (supplied.operationKey !== patch.operationKey || JSON.stringify(input.patch) !== JSON.stringify(patch)) {
            throw new Error('variable-proposal-skill-adoption-patch-mismatch');
        }
        const { request, apply } = this.#receipts(runId);
        const candidateDigest = variableProposalSkillReceiptDigest(['variable-proposal-candidate-v1', patch.patches]);
        if (request.candidateDigest !== candidateDigest || request.candidateCount !== patch.patches.length
            || apply.patchDigest !== variablePatchApplyEvidenceDigest(patch)) {
            throw new Error('variable-proposal-skill-adoption-patch-mismatch');
        }
        const entry = normalizeVariableProposalSkillAdoption({
            version: VARIABLE_PROPOSAL_SKILL_ADOPTION_VERSION, state: 'apply-linked',
            sessionDigest: variablePatchApplySessionDigest(this.#rawSessionId), runId, round: apply.round,
            requestReceiptDigest: request.receiptDigest, applyReceiptDigest: apply.receiptDigest,
            candidateDigest, patchDigest: apply.patchDigest, candidateCount: patch.patches.length,
            skillRequestBound: true, applied: true, authorizesExecution: false, authorizesPromotion: false,
            occurredAt: apply.occurredAt,
        }, this.#rawSessionId);
        const previous = this.#read(runId);
        if (previous) {
            if (previous.receiptDigest !== entry.receiptDigest) {
                throw new Error('variable-proposal-skill-adoption-conflict');
            }
            return receiptOf(previous);
        }
        const json = JSON.stringify(receiptOf(entry));
        if (json.length > MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_CHARS) invalid();
        this.#db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.#rawSessionId, entry.controlKey, json, entry.occurredAt);
        if (this.#read(runId)?.receiptDigest !== entry.receiptDigest) {
            throw new Error('variable-proposal-skill-adoption-readback-failed');
        }
        return receiptOf(entry);
    }

    /** Rowid pages advance past rejected links without disclosing their untrusted values. */
    scan(input: Readonly<{ limit?: number; cursor?: number }> = {}): VariableProposalSkillAdoptionScan {
        const limit = integer(input.limit ?? 64, 1), cursor = integer(input.cursor ?? 0, 0);
        if (limit > MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_SCAN_LIMIT) {
            throw new Error('variable-proposal-skill-adoption-scan-limit-invalid');
        }
        const rows = this.#db.prepare(`SELECT rowid,control_key,value FROM session_control WHERE session_key=?
            AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.#rawSessionId, `${VARIABLE_PROPOSAL_SKILL_ADOPTION_PREFIX}*`, cursor, limit + 1) as
            { rowid: number; control_key: string; value: string }[];
        const page = rows.slice(0, limit), entries: VariableProposalSkillAdoptionEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PROPOSAL_SKILL_ADOPTION_CHARS) {
                    invalid();
                }
                const entry = normalizeVariableProposalSkillAdoption(
                    JSON.parse(row.value) as unknown, this.#rawSessionId);
                if (entry.controlKey !== row.control_key) invalid();
                entries.push(this.#verify(entry));
            } catch { failed += 1; }
        }
        return Object.freeze({ entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit });
    }
}
