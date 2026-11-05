/** @author Codex @date 2026-10-27 @version 1.0
 * Body-free observations of an applied interactive variable patch. A row proves "this exact patch
 * committed against this exact declaration/snapshot generation"; it never stores patch values,
 * never authorizes execution and never claims Skill provenance it does not own.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const VARIABLE_PATCH_APPLY_EVIDENCE_PREFIX = 'variable_patch_apply_evidence:';
export const VARIABLE_PATCH_APPLY_EVIDENCE_VERSION = 'variable-patch-apply-evidence-v1' as const;
export const VARIABLE_PATCH_APPLY_RECORD_VERSION = 'variable-patch-apply-record-v1' as const;
export const MAX_VARIABLE_PATCH_APPLY_RECORD_CHARS = 4_096;
export const MAX_VARIABLE_PATCH_APPLY_SCAN_LIMIT = 256;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^(?:sha256:)?[a-f0-9]{64}$/u;
const SESSION_DIGEST = /^session:sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/u;
const RECEIPT_FIELDS = ['version', 'state', 'sessionDigest', 'runId', 'round', 'patchDigest',
    'operationKeyDigest', 'specDigest', 'preApplyDigest', 'postApplyDigest', 'touchedPathCount',
    'stagedAgainstRevision', 'skillRequestBound', 'authorizesExecution', 'authorizesPromotion',
    'occurredAt'] as const;

export type VariablePatchApplyEvidenceOrigin = 'interactive-turn-commit';

export interface VariablePatchApplyEvidenceInput {
    readonly runId: string;
    readonly round: number;
    /** sha256 of the staged patch body; identical to the closure artifact/readback digest. */
    readonly patchDigest: string;
    /** sha256 of `operationKey` only — the key itself is a model string and stays out of storage. */
    readonly operationKeyDigest: string | null;
    /** sha256 of the declared variable specs (paths/types/ranges) in force at apply time. */
    readonly specDigest: string;
    /** Whole-literal-snapshot digest before / after the patch was applied. */
    readonly preApplyDigest: string;
    readonly postApplyDigest: string;
    readonly touchedPathCount: number;
    /** Interactive revision the patch was staged against (`stagedAgainstRevision`). */
    readonly stagedAgainstRevision: string;
    readonly occurredAt?: string;
}

export interface VariablePatchApplyEvidenceReceipt {
    readonly version: 'variable-patch-apply-record-v1';
    readonly state: 'apply-committed';
    readonly sessionDigest: string;
    readonly runId: string;
    readonly round: number;
    readonly patchDigest: string;
    readonly operationKeyDigest: string | null;
    readonly specDigest: string;
    readonly preApplyDigest: string;
    readonly postApplyDigest: string;
    readonly touchedPathCount: number;
    readonly stagedAgainstRevision: string;
    readonly skillRequestBound: false;
    readonly authorizesExecution: false;
    readonly authorizesPromotion: false;
    readonly occurredAt: string;
}

export interface VariablePatchApplyEvidenceEntry extends VariablePatchApplyEvidenceReceipt {
    readonly controlKey: string;
    readonly receiptDigest: string;
}

export interface VariablePatchApplyEvidenceScan {
    readonly entries: readonly VariablePatchApplyEvidenceEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

export function variablePatchApplyEvidenceDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

/** Canonical whole-literal-snapshot digest shared by apply time and read-only recovery. */
export function literalVariableSnapshotDigest(
    entries: Iterable<readonly [string, string | number | boolean]>,
): string {
    const pairs: [string, string | number | boolean][] = [];
    for (const [name, value] of entries) {
        if (typeof name !== 'string' || !name) throw new Error('variable-patch-snapshot-name-invalid');
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            throw new Error('variable-patch-snapshot-value-invalid');
        }
        pairs.push([name, value]);
    }
    pairs.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    return variablePatchApplyEvidenceDigest(['variable-literal-snapshot-v1', pairs]);
}

export function variablePatchApplyEvidenceKey(runId: string): string {
    return VARIABLE_PATCH_APPLY_EVIDENCE_PREFIX + variablePatchApplyEvidenceDigest([runId]).slice(7);
}

function invalid(): never { throw new Error('variable-patch-apply-evidence-invalid'); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    return value as Record<string, unknown>;
}
function digest(value: unknown, label: string): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`variable-patch-${label}-invalid`);
    return value;
}
function revision(value: unknown, label: string): string {
    if (typeof value !== 'string' || !REVISION.test(value)) throw new Error(`variable-patch-${label}-invalid`);
    return value;
}
function integer(value: unknown, label: string, minimum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`variable-patch-${label}-invalid`);
    }
    return value;
}
function timestamp(value: unknown, label: string): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error(`variable-patch-${label}-invalid`);
    return value;
}
function sessionDigest(rawSessionId: string): string {
    if (typeof rawSessionId !== 'string' || !rawSessionId) throw new Error('variable-patch-session-invalid');
    return `session:${variablePatchApplyEvidenceDigest(['variable-patch-apply-session', rawSessionId])}`;
}

/** Opened session identity for cross-surface correlation; it never exposes the raw session id. */
export function variablePatchApplySessionDigest(rawSessionId: string): string {
    return sessionDigest(rawSessionId);
}

/** Strict shape check used by both the writer and the read-only recovery path. */
export function normalizeVariablePatchApplyEvidence(value: unknown,
    rawSessionId: string): VariablePatchApplyEvidenceEntry {
    const row = record(value);
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...RECEIPT_FIELDS].sort())) invalid();
    const expected = sessionDigest(rawSessionId);
    if (row.version !== VARIABLE_PATCH_APPLY_RECORD_VERSION || row.state !== 'apply-committed'
        || row.sessionDigest !== expected || row.skillRequestBound !== false
        || row.authorizesExecution !== false || row.authorizesPromotion !== false) invalid();
    if (typeof row.runId !== 'string' || !TOKEN.test(row.runId)) invalid();
    if (row.operationKeyDigest !== null) digest(row.operationKeyDigest, 'operation-key');
    const base = Object.freeze({
        version: VARIABLE_PATCH_APPLY_RECORD_VERSION, state: 'apply-committed' as const,
        sessionDigest: expected, runId: row.runId,
        round: integer(row.round, 'round', 1),
        patchDigest: digest(row.patchDigest, 'patch-digest'),
        operationKeyDigest: row.operationKeyDigest as string | null,
        specDigest: digest(row.specDigest, 'spec-digest'),
        preApplyDigest: digest(row.preApplyDigest, 'pre-apply-digest'),
        postApplyDigest: digest(row.postApplyDigest, 'post-apply-digest'),
        touchedPathCount: integer(row.touchedPathCount, 'touched-count', 1),
        stagedAgainstRevision: revision(row.stagedAgainstRevision, 'staged-revision'),
        skillRequestBound: false as const, authorizesExecution: false as const,
        authorizesPromotion: false as const,
        occurredAt: timestamp(row.occurredAt, 'occurred-at'),
    });
    return Object.freeze({ ...base, controlKey: variablePatchApplyEvidenceKey(base.runId),
        receiptDigest: variablePatchApplyEvidenceDigest(base) });
}

/** Receipt projection without the row-locator/digest envelope. */
function receiptOf(entry: VariablePatchApplyEvidenceEntry): VariablePatchApplyEvidenceReceipt {
    return Object.freeze({
        version: entry.version, state: entry.state, sessionDigest: entry.sessionDigest, runId: entry.runId,
        round: entry.round, patchDigest: entry.patchDigest, operationKeyDigest: entry.operationKeyDigest,
        specDigest: entry.specDigest, preApplyDigest: entry.preApplyDigest,
        postApplyDigest: entry.postApplyDigest, touchedPathCount: entry.touchedPathCount,
        stagedAgainstRevision: entry.stagedAgainstRevision, skillRequestBound: false as const,
        authorizesExecution: false as const, authorizesPromotion: false as const, occurredAt: entry.occurredAt,
    });
}

/**
 * Session-owned ledger row. The write must happen inside the same SQLite transaction that applies
 * the patch, so a committed patch can never exist without its observation (and vice versa).
 */
export class VariablePatchApplyEvidenceStore {
    readonly #db: DatabaseSync;
    readonly #rawSessionId: string;

    constructor(db: DatabaseSync, rawSessionId: string) {
        this.#db = db;
        this.#rawSessionId = rawSessionId;
        sessionDigest(rawSessionId);
    }

    get #sessionDigest(): string { return sessionDigest(this.#rawSessionId); }

    #read(runId: string): VariablePatchApplyEvidenceEntry | null {
        const row = this.#db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.#rawSessionId, variablePatchApplyEvidenceKey(runId)) as { value: string } | undefined;
        if (!row) return null;
        if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PATCH_APPLY_RECORD_CHARS) invalid();
        const entry = normalizeVariablePatchApplyEvidence(JSON.parse(row.value) as unknown, this.#rawSessionId);
        if (entry.runId !== runId) invalid();
        return entry;
    }

    get(runId: string): VariablePatchApplyEvidenceEntry | null {
        if (typeof runId !== 'string' || !TOKEN.test(runId)) invalid();
        return this.#read(runId);
    }

    /** Idempotent by runId + patch digest; a second different patch for one run is a conflict. */
    record(input: VariablePatchApplyEvidenceInput): VariablePatchApplyEvidenceReceipt {
        if (this.#db.isTransaction !== true) throw new Error('variable-patch-apply-evidence-transaction-required');
        const base = Object.freeze({
            version: VARIABLE_PATCH_APPLY_RECORD_VERSION, state: 'apply-committed' as const,
            sessionDigest: this.#sessionDigest, runId: input.runId,
            round: integer(input.round, 'round', 1),
            patchDigest: digest(input.patchDigest, 'patch-digest'),
            operationKeyDigest: input.operationKeyDigest === null || input.operationKeyDigest === undefined
                ? null : digest(input.operationKeyDigest, 'operation-key'),
            specDigest: digest(input.specDigest, 'spec-digest'),
            preApplyDigest: digest(input.preApplyDigest, 'pre-apply-digest'),
            postApplyDigest: digest(input.postApplyDigest, 'post-apply-digest'),
            touchedPathCount: integer(input.touchedPathCount, 'touched-count', 1),
            stagedAgainstRevision: revision(input.stagedAgainstRevision, 'staged-revision'),
            skillRequestBound: false as const, authorizesExecution: false as const,
            authorizesPromotion: false as const,
            occurredAt: timestamp(input.occurredAt ?? new Date().toISOString(), 'occurred-at'),
        });
        const receipt = normalizeVariablePatchApplyEvidence(base, this.#rawSessionId);
        const json = JSON.stringify(receiptOf(receipt));
        if (json.length > MAX_VARIABLE_PATCH_APPLY_RECORD_CHARS) invalid();
        const previous = this.#read(receipt.runId);
        if (previous) {
            if (previous.receiptDigest !== receipt.receiptDigest) {
                throw new Error('variable-patch-apply-evidence-conflict');
            }
            return receiptOf(previous);
        }
        this.#db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.#rawSessionId, receipt.controlKey, json, receipt.occurredAt);
        const written = this.#read(receipt.runId);
        if (!written || written.receiptDigest !== receipt.receiptDigest) {
            throw new Error('variable-patch-apply-evidence-readback-failed');
        }
        return receiptOf(written);
    }

    /** Rowid cursor advances past corrupt rows; valid for readOnly/query_only recovery handles. */
    scan(input: Readonly<{ limit?: number; cursor?: number }> = {}): VariablePatchApplyEvidenceScan {
        const limit = integer(input.limit ?? 64, 'scan-limit', 1);
        const cursor = integer(input.cursor ?? 0, 'scan-cursor', 0);
        if (limit > MAX_VARIABLE_PATCH_APPLY_SCAN_LIMIT) throw new Error('variable-patch-scan-limit-invalid');
        const rows = this.#db.prepare(`SELECT rowid,control_key,value FROM session_control WHERE session_key=?
            AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.#rawSessionId, `${VARIABLE_PATCH_APPLY_EVIDENCE_PREFIX}*`, cursor, limit + 1) as
            { rowid: number; control_key: string; value: string }[];
        const page = rows.slice(0, limit), entries: VariablePatchApplyEvidenceEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PATCH_APPLY_RECORD_CHARS) invalid();
                const entry = normalizeVariablePatchApplyEvidence(JSON.parse(row.value) as unknown, this.#rawSessionId);
                if (entry.controlKey !== row.control_key) invalid();
                entries.push(entry);
            } catch { failed += 1; }
        }
        return Object.freeze({ entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit });
    }
}

/** Whole-literal-snapshot digest read straight from the authoritative `memory_state` row. */
export function readLiteralVariableSnapshotDigest(db: DatabaseSync): string | null {
    const row = db.prepare("SELECT state_json FROM memory_state WHERE entity_type='variable' AND entity_id='vms'")
        .get() as { state_json: string } | undefined;
    if (!row || typeof row.state_json !== 'string') return null;
    let parsed: unknown;
    try { parsed = JSON.parse(row.state_json); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries: [string, string | number | boolean][] = [];
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
        entries.push([name, value]);
    }
    return literalVariableSnapshotDigest(entries);
}

export const VARIABLE_PATCH_APPLY_INVALIDATION_PREFIX = 'variable_patch_apply_invalidation:';
export const VARIABLE_PATCH_APPLY_INVALIDATION_VERSION = 'variable-patch-apply-invalidation-v1' as const;
export const MAX_VARIABLE_PATCH_APPLY_INVALIDATION_CHARS = 2_048;

/** Which original rollback the Session actually executed; never inferred from current values. */
export type VariablePatchApplyRollbackKind = 'round-delete' | 'regenerate-state-only';
export const VARIABLE_PATCH_APPLY_ROLLBACK_KINDS: readonly VariablePatchApplyRollbackKind[] =
    Object.freeze(['round-delete', 'regenerate-state-only']);
const INVALIDATION_FIELDS = ['version', 'state', 'sessionDigest', 'evidenceReceiptDigest', 'runId',
    'round', 'rollbackKind', 'occurredAt'] as const;

export interface VariablePatchApplyInvalidationReceipt {
    readonly version: 'variable-patch-apply-invalidation-v1';
    readonly state: 'invalidated';
    readonly sessionDigest: string;
    /** Receipt digest of the exact apply observation this rollback invalidated. */
    readonly evidenceReceiptDigest: string;
    readonly runId: string;
    readonly round: number;
    readonly rollbackKind: VariablePatchApplyRollbackKind;
    readonly occurredAt: string;
}

export interface VariablePatchApplyInvalidationEntry extends VariablePatchApplyInvalidationReceipt {
    readonly controlKey: string;
    readonly invalidationDigest: string;
}

export interface VariablePatchApplyInvalidationScan {
    readonly entries: readonly VariablePatchApplyInvalidationEntry[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

export function variablePatchApplyInvalidationKey(evidenceReceiptDigest: string,
    kind: VariablePatchApplyRollbackKind): string {
    return VARIABLE_PATCH_APPLY_INVALIDATION_PREFIX
        + variablePatchApplyEvidenceDigest(['variable-patch-apply-invalidation', evidenceReceiptDigest, kind]).slice(7);
}

export function normalizeVariablePatchApplyInvalidation(value: unknown,
    rawSessionId: string): VariablePatchApplyInvalidationEntry {
    const row = record(value);
    if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...INVALIDATION_FIELDS].sort())) invalid();
    if (row.version !== VARIABLE_PATCH_APPLY_INVALIDATION_VERSION || row.state !== 'invalidated'
        || row.sessionDigest !== sessionDigest(rawSessionId)) invalid();
    if (typeof row.runId !== 'string' || !TOKEN.test(row.runId)) invalid();
    const evidenceReceiptDigest = digest(row.evidenceReceiptDigest, 'evidence-receipt-digest');
    const kind = row.rollbackKind as VariablePatchApplyRollbackKind;
    if (!VARIABLE_PATCH_APPLY_ROLLBACK_KINDS.includes(kind)) invalid();
    const base = Object.freeze({
        version: VARIABLE_PATCH_APPLY_INVALIDATION_VERSION, state: 'invalidated' as const,
        sessionDigest: sessionDigest(rawSessionId), evidenceReceiptDigest, runId: row.runId,
        round: integer(row.round, 'round', 1), rollbackKind: kind,
        occurredAt: timestamp(row.occurredAt, 'occurred-at'),
    });
    return Object.freeze({ ...base, controlKey: variablePatchApplyInvalidationKey(evidenceReceiptDigest, kind),
        invalidationDigest: variablePatchApplyEvidenceDigest(base) });
}

/** Session-owned rollback markers: INSERT-only, so a later revert can never erase "was rolled back". */
export class VariablePatchApplyInvalidationStore {
    readonly #db: DatabaseSync;
    readonly #rawSessionId: string;

    constructor(db: DatabaseSync, rawSessionId: string) {
        this.#db = db;
        this.#rawSessionId = rawSessionId;
        sessionDigest(rawSessionId);
    }

    #read(controlKey: string): VariablePatchApplyInvalidationEntry | null {
        const row = this.#db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
            .get(this.#rawSessionId, controlKey) as { value: string } | undefined;
        if (!row) return null;
        return normalizeVariablePatchApplyInvalidation(JSON.parse(String(row.value)) as unknown, this.#rawSessionId);
    }

    /** Idempotent per (evidence receipt, rollback kind); different evidence never overwrites a marker. */
    record(input: Readonly<{
        evidenceReceiptDigest: string; runId: string; round: number;
        rollbackKind: VariablePatchApplyRollbackKind; occurredAt?: string;
    }>): VariablePatchApplyInvalidationReceipt {
        if (this.#db.isTransaction !== true) {
            throw new Error('variable-patch-apply-invalidation-transaction-required');
        }
        const base = Object.freeze({
            version: VARIABLE_PATCH_APPLY_INVALIDATION_VERSION, state: 'invalidated' as const,
            sessionDigest: sessionDigest(this.#rawSessionId),
            evidenceReceiptDigest: digest(input.evidenceReceiptDigest, 'evidence-receipt-digest'),
            runId: input.runId, round: integer(input.round, 'round', 1),
            rollbackKind: input.rollbackKind,
            occurredAt: timestamp(input.occurredAt ?? new Date().toISOString(), 'occurred-at'),
        });
        const entry = normalizeVariablePatchApplyInvalidation(base, this.#rawSessionId);
        const json = JSON.stringify(receiptOfInvalidation(entry));
        if (json.length > MAX_VARIABLE_PATCH_APPLY_INVALIDATION_CHARS) invalid();
        const previous = this.#read(entry.controlKey);
        if (previous) {
            // A repeated rollback (idempotent delete / re-regenerate) keeps the first marker as-is;
            // only a different evidence identity under the same key is a conflict.
            if (previous.evidenceReceiptDigest !== entry.evidenceReceiptDigest
                || previous.runId !== entry.runId || previous.round !== entry.round
                || previous.rollbackKind !== entry.rollbackKind) {
                throw new Error('variable-patch-apply-invalidation-conflict');
            }
            return receiptOfInvalidation(previous);
        }
        this.#db.prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(this.#rawSessionId, entry.controlKey, json, entry.occurredAt);
        const written = this.#read(entry.controlKey);
        if (!written || written.invalidationDigest !== entry.invalidationDigest) {
            throw new Error('variable-patch-apply-invalidation-readback-failed');
        }
        return receiptOfInvalidation(written);
    }

    /** Exact lookup cannot miss an older receipt's marker behind unrelated pagination. */
    findAllForEvidence(evidence: VariablePatchApplyEvidenceEntry): readonly VariablePatchApplyInvalidationEntry[] {
        const expected = normalizeVariablePatchApplyEvidence(receiptOf(evidence), this.#rawSessionId);
        if (expected.receiptDigest !== evidence.receiptDigest || expected.controlKey !== evidence.controlKey)
            throw new Error('variable-patch-invalidation-evidence-invalid');
        const keys = VARIABLE_PATCH_APPLY_ROLLBACK_KINDS.map((kind) => variablePatchApplyInvalidationKey(expected.receiptDigest, kind));
        const rows = this.#db.prepare(`SELECT control_key,value,updated_at FROM session_control
            WHERE session_key=? AND control_key IN (${keys.map(() => '?').join(',')}) ORDER BY rowid`)
            .all(this.#rawSessionId, ...keys) as { control_key: string; value: string; updated_at: string | null }[];
        const entries: VariablePatchApplyInvalidationEntry[] = [];
        for (const row of rows) {
            if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PATCH_APPLY_INVALIDATION_CHARS) invalid();
            const marker = normalizeVariablePatchApplyInvalidation(JSON.parse(row.value), this.#rawSessionId);
            if (marker.controlKey !== row.control_key || marker.evidenceReceiptDigest !== expected.receiptDigest
                || marker.runId !== expected.runId || marker.round !== expected.round || row.updated_at !== marker.occurredAt)
                throw new Error('variable-patch-invalidation-evidence-mismatch');
            entries.push(marker);
        }
        return Object.freeze(entries);
    }

    findForEvidence(evidence: VariablePatchApplyEvidenceEntry): VariablePatchApplyInvalidationEntry | null {
        return this.findAllForEvidence(evidence).at(-1) ?? null;
    }

    scan(input: Readonly<{ limit?: number; cursor?: number }> = {}): VariablePatchApplyInvalidationScan {
        const limit = integer(input.limit ?? 64, 'scan-limit', 1);
        const cursor = integer(input.cursor ?? 0, 'scan-cursor', 0);
        if (limit > MAX_VARIABLE_PATCH_APPLY_SCAN_LIMIT) throw new Error('variable-patch-scan-limit-invalid');
        const rows = this.#db.prepare(`SELECT rowid,control_key,value,updated_at FROM session_control WHERE session_key=?
            AND control_key GLOB ? AND rowid>? ORDER BY rowid LIMIT ?`)
            .all(this.#rawSessionId, `${VARIABLE_PATCH_APPLY_INVALIDATION_PREFIX}*`, cursor, limit + 1) as
            { rowid: number; control_key: string; value: string; updated_at: string | null }[];
        const page = rows.slice(0, limit), entries: VariablePatchApplyInvalidationEntry[] = [];
        let failed = 0;
        for (const row of page) {
            try {
                if (typeof row.value !== 'string' || row.value.length > MAX_VARIABLE_PATCH_APPLY_INVALIDATION_CHARS) invalid();
                const entry = normalizeVariablePatchApplyInvalidation(JSON.parse(row.value) as unknown, this.#rawSessionId);
                if (entry.controlKey !== row.control_key || row.updated_at !== entry.occurredAt) invalid();
                entries.push(entry);
            } catch { failed += 1; }
        }
        return Object.freeze({ entries: Object.freeze(entries), attempted: page.length, failed,
            nextCursor: page.length ? Number(page.at(-1)!.rowid) : cursor, hasMore: rows.length > limit });
    }
}

function receiptOfInvalidation(
    entry: VariablePatchApplyInvalidationEntry,
): VariablePatchApplyInvalidationReceipt {
    return Object.freeze({
        version: entry.version, state: entry.state, sessionDigest: entry.sessionDigest,
        evidenceReceiptDigest: entry.evidenceReceiptDigest, runId: entry.runId, round: entry.round,
        rollbackKind: entry.rollbackKind, occurredAt: entry.occurredAt,
    });
}

/**
 * Marks every apply observation that the executed rollback actually undid. Called inside the
 * Session rollback transaction; it never rewrites the observation itself.
 */
export function invalidateAppliedVariablePatches(db: DatabaseSync, rawSessionId: string, input: Readonly<{
    readonly round: number;
    readonly fromRound?: boolean;
    readonly rollbackKind: VariablePatchApplyRollbackKind;
    readonly occurredAt?: string;
}>): number {
    const round = integer(input.round, 'round', 1);
    if (!VARIABLE_PATCH_APPLY_ROLLBACK_KINDS.includes(input.rollbackKind)) invalid();
    const evidence = new VariablePatchApplyEvidenceStore(db, rawSessionId);
    const invalidations = new VariablePatchApplyInvalidationStore(db, rawSessionId);
    let cursor = 0, marked = 0;
    while (true) {
        const page = evidence.scan({ limit: MAX_VARIABLE_PATCH_APPLY_SCAN_LIMIT, cursor });
        for (const entry of page.entries) {
            if (input.fromRound === true ? entry.round < round : entry.round !== round) continue;
            invalidations.record({ evidenceReceiptDigest: entry.receiptDigest, runId: entry.runId,
                round: entry.round, rollbackKind: input.rollbackKind, occurredAt: input.occurredAt });
            marked += 1;
        }
        if (!page.hasMore || page.nextCursor <= cursor) return marked;
        cursor = page.nextCursor;
    }
}
