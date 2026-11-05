/** @author Codex @date 2026-10-26 @version 1.0
 * Bounded Session-owned RP task artifacts; not world facts or Provider authority.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import type { MemoryDb } from './db.ts';
import { RP_CHILD_ANALYSIS_SQL, SCHEMA_VERSION } from './schema.ts';
import { validateSessionAuthorityForOwnedAdapter } from './session-authority.ts';

export const RP_CHILD_ANALYSIS_VERSION = 'rp-child-analysis-v1' as const;
export const RP_CHILD_ANALYSIS_MAX_TTL_MS = 3_600_000;
export const RP_CHILD_ANALYSIS_MAX_SESSION_RESULTS = 1_024;
const MARKER_SESSION = '__rp_child_analysis_owner__';
const MARKER_KEY = 'rp-child-analysis-owner-v1';
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PAYLOAD_REF_PATTERN = /^rp-child-analysis:[a-f0-9]{64}$/u;

export interface RpChildAnalysisResultV1 {
    readonly version: typeof RP_CHILD_ANALYSIS_VERSION;
    readonly templateId: string;
    readonly completeness: 'complete' | 'partial' | 'unknown';
    readonly conclusions: readonly Readonly<{
        claim: string;
        epistemicStatus: 'fact' | 'hypothesis' | 'disputed';
        evidenceRefs: readonly string[];
    }>[];
    readonly sourceWatermarks: readonly Readonly<{ sourceRef: string; revision: string; digest: string }>[];
    readonly truncated: boolean;
}

export interface RpChildAnalysisBindingV1 {
    readonly sessionId: string;
    readonly contentMode: 'nsf';
    readonly historyEpoch: number;
    readonly sourceRevision: string;
    readonly parentTaskId: string;
    readonly parentAttemptId: string;
    readonly childTaskId: string;
    readonly childAttemptId: string;
    readonly templateId: string;
    readonly templateVersion: string;
    readonly templateDigest: string;
    readonly sourceDigest: string;
}

export interface RpChildAnalysisArtifactV1 {
    readonly payloadRef: string;
    readonly payloadDigest: string;
    readonly binding: RpChildAnalysisBindingV1;
    readonly result: RpChildAnalysisResultV1;
    readonly createdAtMs: number;
    readonly expiresAtMs: number;
}

export type RpChildAnalysisReadResult =
    | Readonly<{ status: 'found'; artifact: RpChildAnalysisArtifactV1 }>
    | Readonly<{ status: 'missing' | 'forbidden' | 'stale' | 'expired' | 'digest-mismatch' }>;

export interface RpChildAnalysisStoreOptions {
    readonly memoryDb: MemoryDb;
    readonly sessionId: string;
    readonly contentMode: 'nsf';
    readonly readCurrentAuthority: () => Readonly<{ historyEpoch: number; sourceRevision: string }> | null;
    readonly clock: () => number;
}

function reject(): never {
    throw new TypeError('rp-child-analysis-input-invalid');
}

function freezeData<T>(input: T): Readonly<T> {
    if (input && typeof input === 'object') {
        for (const value of Object.values(input)) freezeData(value);
        Object.freeze(input);
    }
    return input;
}

/** Own-data copying prevents caller getters or serialization hooks from running. */
function copyData(input: unknown, depth = 0, nodes = { count: 0 }): unknown {
    if (++nodes.count > 4_096 || depth > 8 || types.isProxy(input)) reject();
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string' && input.length <= 32_768) return input;
    if (typeof input === 'number' && Number.isSafeInteger(input)) return input;
    if (!input || typeof input !== 'object') reject();
    if (Array.isArray(input)) {
        const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (!Number.isSafeInteger(length) || length > 64 || Reflect.ownKeys(input).length !== length + 1) reject();
        return Array.from({ length }, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
            return copyData(descriptor.value, depth + 1, nodes);
        });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject();
    return Object.fromEntries(
        Reflect.ownKeys(input).map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
            return [key, copyData(descriptor.value, depth + 1, nodes)];
        }),
    );
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject();
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) reject();
    return value;
}

function reference(input: unknown): string {
    if (typeof input !== 'string' || !REF_PATTERN.test(input)) reject();
    return input;
}

function digestValue(input: unknown): string {
    if (typeof input !== 'string' || !DIGEST_PATTERN.test(input)) reject();
    return input;
}

function integer(input: unknown): number {
    if (!Number.isSafeInteger(input) || Number(input) < 0) reject();
    return Number(input);
}

function canonicalJson(input: unknown): string {
    if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
    if (input && typeof input === 'object') {
        const value = input as Record<string, unknown>;
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(input);
}

/** Stable source-watermark/artifact digest; accepted data only, never caller toJSON. */
export function rpChildAnalysisDigest(input: unknown): string {
    return `sha256:${createHash('sha256')
        .update(canonicalJson(copyData(input)))
        .digest('hex')}`;
}

export function normalizeRpChildAnalysisBinding(input: unknown): RpChildAnalysisBindingV1 {
    const value = record(copyData(input), [
        'sessionId',
        'contentMode',
        'historyEpoch',
        'sourceRevision',
        'parentTaskId',
        'parentAttemptId',
        'childTaskId',
        'childAttemptId',
        'templateId',
        'templateVersion',
        'templateDigest',
        'sourceDigest',
    ]);
    if (
        value.contentMode !== 'nsf' ||
        typeof value.templateId !== 'string' ||
        !/^rp\.[a-z][a-z0-9-]{0,95}$/u.test(value.templateId) ||
        typeof value.templateVersion !== 'string' ||
        !/^\d+\.\d+\.\d+$/u.test(value.templateVersion)
    )
        reject();
    return freezeData({
        sessionId: reference(value.sessionId),
        contentMode: 'nsf',
        historyEpoch: integer(value.historyEpoch),
        sourceRevision: digestValue(value.sourceRevision),
        parentTaskId: reference(value.parentTaskId),
        parentAttemptId: reference(value.parentAttemptId),
        childTaskId: reference(value.childTaskId),
        childAttemptId: reference(value.childAttemptId),
        templateId: value.templateId,
        templateVersion: value.templateVersion,
        templateDigest: digestValue(value.templateDigest),
        sourceDigest: digestValue(value.sourceDigest),
    });
}

export function normalizeRpChildAnalysisResult(input: unknown): RpChildAnalysisResultV1 {
    const value = record(copyData(input), [
        'version',
        'templateId',
        'completeness',
        'conclusions',
        'sourceWatermarks',
        'truncated',
    ]);
    if (
        value.version !== RP_CHILD_ANALYSIS_VERSION ||
        typeof value.templateId !== 'string' ||
        !/^rp\.[a-z][a-z0-9-]{0,95}$/u.test(value.templateId) ||
        typeof value.completeness !== 'string' ||
        !['complete', 'partial', 'unknown'].includes(value.completeness) ||
        typeof value.truncated !== 'boolean' ||
        !Array.isArray(value.conclusions) ||
        value.conclusions.length > 8 ||
        !Array.isArray(value.sourceWatermarks) ||
        value.sourceWatermarks.length < 1 ||
        value.sourceWatermarks.length > 8
    )
        reject();
    const conclusions = value.conclusions.map((item) => {
        const conclusion = record(item, ['claim', 'epistemicStatus', 'evidenceRefs']);
        if (
            typeof conclusion.claim !== 'string' ||
            conclusion.claim.length < 1 ||
            conclusion.claim.length > 512 ||
            typeof conclusion.epistemicStatus !== 'string' ||
            !['fact', 'hypothesis', 'disputed'].includes(conclusion.epistemicStatus) ||
            !Array.isArray(conclusion.evidenceRefs) ||
            conclusion.evidenceRefs.length < 1 ||
            conclusion.evidenceRefs.length > 8
        )
            reject();
        const evidenceRefs = conclusion.evidenceRefs.map(reference);
        if (new Set(evidenceRefs).size !== evidenceRefs.length) reject();
        return { claim: conclusion.claim, epistemicStatus: conclusion.epistemicStatus, evidenceRefs };
    });
    const sourceWatermarks = value.sourceWatermarks.map((item) => {
        const watermark = record(item, ['sourceRef', 'revision', 'digest']);
        return {
            sourceRef: reference(watermark.sourceRef),
            revision: reference(watermark.revision),
            digest: digestValue(watermark.digest),
        };
    });
    return freezeData({ ...value, conclusions, sourceWatermarks }) as unknown as RpChildAnalysisResultV1;
}

function normalizedSql(input: string): string {
    return input.trim().replace(/;$/u, '');
}

const SCHEMA_DEFINITIONS = RP_CHILD_ANALYSIS_SQL.trim()
    .split(/;\s*(?=CREATE|$)/u)
    .filter(Boolean);
const SCHEMA_OBJECTS = SCHEMA_DEFINITIONS.map((sql) => {
    const match = /^CREATE (TABLE|INDEX|TRIGGER) (\w+)/u.exec(sql.trim());
    if (!match) throw new Error('rp-child-analysis-schema-contract-invalid');
    return { name: match[2]!, type: match[1]!.toLowerCase(), sql: normalizedSql(sql) };
});
const MARKER_VALUE = rpChildAnalysisDigest({ version: 1, ddl: RP_CHILD_ANALYSIS_SQL });

/** Optional legacy absence is allowed; installed-but-missing storage is never recreated. */
export function inspectRpChildAnalysisStorage(db: DatabaseSync): boolean {
    const controlExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_control'").get();
    if (!controlExists) return false;
    const marker = db
        .prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
        .get(MARKER_SESSION, MARKER_KEY) as { value?: unknown } | undefined;
    const objects = db
        .prepare(
            "SELECT name,type,sql FROM sqlite_master WHERE name GLOB '*rp_child_analysis*' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string; type: string; sql: string }>;
    const temporary = db
        .prepare(
            "SELECT name FROM sqlite_temp_master WHERE name GLOB '*rp_child_analysis*' OR tbl_name='rp_child_analysis'",
        )
        .all();
    if (!marker && objects.length === 0 && temporary.length === 0) return false;
    const version = db.prepare('PRAGMA user_version').get() as { user_version?: unknown };
    if (version.user_version !== SCHEMA_VERSION) throw new Error('rp-child-analysis-storage-version-invalid');
    if (marker?.value !== MARKER_VALUE || temporary.length > 0 || objects.length !== SCHEMA_OBJECTS.length) {
        throw new Error('rp-child-analysis-storage-invalid');
    }
    for (const expected of SCHEMA_OBJECTS) {
        const actual = objects.find((item) => item.name === expected.name);
        if (actual?.type !== expected.type || normalizedSql(actual.sql) !== expected.sql) {
            throw new Error('rp-child-analysis-storage-invalid');
        }
    }
    const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='rp_child_analysis'")
        .all() as Array<{ name: string }>;
    if (triggers.length !== 2) throw new Error('rp-child-analysis-storage-invalid');
    return true;
}

function ensureStorage(memory: MemoryDb): void {
    if (inspectRpChildAnalysisStorage(memory.db)) return;
    memory.transaction(() => {
        if (inspectRpChildAnalysisStorage(memory.db)) return;
        if (!validateSessionAuthorityForOwnedAdapter(memory.db)) throw new Error('rp-child-analysis-owner-required');
        memory.db.exec(RP_CHILD_ANALYSIS_SQL);
        memory.db
            .prepare('INSERT INTO session_control(session_key,control_key,value,updated_at) VALUES(?,?,?,?)')
            .run(MARKER_SESSION, MARKER_KEY, MARKER_VALUE, '1970-01-01T00:00:00.000Z');
        inspectRpChildAnalysisStorage(memory.db);
    });
}

function artifactReference(artifact: Omit<RpChildAnalysisArtifactV1, 'payloadRef'>): string {
    return `rp-child-analysis:${rpChildAnalysisDigest(artifact).slice(7)}`;
}

/** Host-only result owner. This store never grants a child business-write permission. */
export class RpChildAnalysisStore {
    readonly #options: RpChildAnalysisStoreOptions;

    constructor(options: RpChildAnalysisStoreOptions) {
        reference(options.sessionId);
        if (
            options.contentMode !== 'nsf' ||
            typeof options.clock !== 'function' ||
            typeof options.readCurrentAuthority !== 'function'
        )
            reject();
        this.#options = Object.freeze({ ...options });
        ensureStorage(options.memoryDb);
    }

    #authorize(binding: RpChildAnalysisBindingV1): 'current' | 'forbidden' | 'stale' {
        if (!validateSessionAuthorityForOwnedAdapter(this.#options.memoryDb.db)) return 'forbidden';
        if (binding.sessionId !== this.#options.sessionId || binding.contentMode !== this.#options.contentMode) {
            return 'forbidden';
        }
        const raw = this.#options.readCurrentAuthority();
        if (!raw) return 'forbidden';
        const current = record(copyData(raw), ['historyEpoch', 'sourceRevision']);
        return integer(current.historyEpoch) === binding.historyEpoch &&
            digestValue(current.sourceRevision) === binding.sourceRevision
            ? 'current'
            : 'stale';
    }

    append(
        input: Readonly<{
            binding: RpChildAnalysisBindingV1;
            result: RpChildAnalysisResultV1;
            createdAtMs: number;
            expiresAtMs: number;
        }>,
    ): RpChildAnalysisArtifactV1 {
        const safe = record(copyData(input), ['binding', 'result', 'createdAtMs', 'expiresAtMs']);
        const binding = normalizeRpChildAnalysisBinding(safe.binding);
        const result = normalizeRpChildAnalysisResult(safe.result);
        const createdAtMs = integer(safe.createdAtMs);
        const expiresAtMs = integer(safe.expiresAtMs);
        if (
            result.templateId !== binding.templateId ||
            rpChildAnalysisDigest(result.sourceWatermarks) !== binding.sourceDigest ||
            expiresAtMs <= createdAtMs ||
            expiresAtMs - createdAtMs > RP_CHILD_ANALYSIS_MAX_TTL_MS
        )
            reject();
        const payloadDigest = rpChildAnalysisDigest(result);
        const partial = { binding, result, payloadDigest, createdAtMs, expiresAtMs };
        const artifact = freezeData({ payloadRef: artifactReference(partial), ...partial });
        const payloadJson = canonicalJson(result);
        if (Buffer.byteLength(payloadJson, 'utf8') > 32_768) reject();
        return this.#options.memoryDb.transaction(() => {
            inspectRpChildAnalysisStorage(this.#options.memoryDb.db);
            const now = integer(this.#options.clock());
            const authorization = this.#authorize(binding);
            if (authorization !== 'current') throw new Error(`rp-child-analysis-${authorization}`);
            if (createdAtMs > now || expiresAtMs <= now) throw new Error('rp-child-analysis-expired');
            const existing = this.#options.memoryDb.db
                .prepare(
                    'SELECT * FROM rp_child_analysis WHERE session_id=? AND child_task_id=? AND child_attempt_id=?',
                )
                .get(binding.sessionId, binding.childTaskId, binding.childAttemptId) as
                | Record<string, unknown>
                | undefined;
            if (existing) {
                const restored = this.#parse(existing);
                if (
                    canonicalJson(restored.binding) !== canonicalJson(binding) ||
                    canonicalJson(restored.result) !== canonicalJson(result) ||
                    restored.payloadDigest !== payloadDigest
                )
                    throw new Error('rp-child-analysis-conflict');
                // A replay recovers the original immutable receipt; it never extends its lifetime.
                const replayNow = integer(this.#options.clock());
                if (replayNow < restored.createdAtMs || replayNow >= restored.expiresAtMs) {
                    throw new Error('rp-child-analysis-expired');
                }
                if (this.#authorize(binding) !== 'current') throw new Error('rp-child-analysis-stale');
                return restored;
            }
            const count = this.#options.memoryDb.db
                .prepare('SELECT COUNT(*) AS count FROM rp_child_analysis WHERE session_id=?')
                .get(binding.sessionId) as { count: number };
            if (count.count >= RP_CHILD_ANALYSIS_MAX_SESSION_RESULTS) throw new Error('rp-child-analysis-capacity');
            this.#options.memoryDb.db
                .prepare(
                    `INSERT INTO rp_child_analysis(
                payload_ref,payload_digest,binding_json,session_id,child_task_id,child_attempt_id,
                payload_json,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                    artifact.payloadRef,
                    payloadDigest,
                    canonicalJson(binding),
                    binding.sessionId,
                    binding.childTaskId,
                    binding.childAttemptId,
                    payloadJson,
                    createdAtMs,
                    expiresAtMs,
                );
            const committedNow = integer(this.#options.clock());
            if (this.#authorize(binding) !== 'current' || committedNow >= expiresAtMs) {
                throw new Error('rp-child-analysis-stale');
            }
            const readback = this.#options.memoryDb.db
                .prepare('SELECT * FROM rp_child_analysis WHERE payload_ref=?')
                .get(artifact.payloadRef) as Record<string, unknown>;
            return this.#parse(readback);
        });
    }

    #parse(row: Record<string, unknown>): RpChildAnalysisArtifactV1 {
        const binding = normalizeRpChildAnalysisBinding(JSON.parse(String(row.binding_json)));
        const result = normalizeRpChildAnalysisResult(JSON.parse(String(row.payload_json)));
        const partial = {
            binding,
            result,
            payloadDigest: digestValue(row.payload_digest),
            createdAtMs: integer(row.created_at_ms),
            expiresAtMs: integer(row.expires_at_ms),
        };
        if (
            row.session_id !== binding.sessionId ||
            row.child_task_id !== binding.childTaskId ||
            row.child_attempt_id !== binding.childAttemptId ||
            result.templateId !== binding.templateId ||
            rpChildAnalysisDigest(result) !== partial.payloadDigest ||
            rpChildAnalysisDigest(result.sourceWatermarks) !== binding.sourceDigest ||
            artifactReference(partial) !== row.payload_ref ||
            partial.expiresAtMs <= partial.createdAtMs ||
            partial.expiresAtMs - partial.createdAtMs > RP_CHILD_ANALYSIS_MAX_TTL_MS
        ) {
            throw new Error('rp-child-analysis-digest-mismatch');
        }
        return freezeData({ payloadRef: String(row.payload_ref), ...partial });
    }

    read(
        input: Readonly<{
            payloadRef: string;
            payloadDigest: string;
            binding: RpChildAnalysisBindingV1;
        }>,
    ): RpChildAnalysisReadResult {
        const safe = record(copyData(input), ['payloadRef', 'payloadDigest', 'binding']);
        if (typeof safe.payloadRef !== 'string' || !PAYLOAD_REF_PATTERN.test(safe.payloadRef)) reject();
        const payloadDigest = digestValue(safe.payloadDigest);
        const binding = normalizeRpChildAnalysisBinding(safe.binding);
        const db = this.#options.memoryDb.db;
        const ownTransaction = !db.isTransaction;
        if (ownTransaction) db.exec('BEGIN DEFERRED');
        try {
            inspectRpChildAnalysisStorage(db);
            const authorization = this.#authorize(binding);
            if (authorization !== 'current') return freezeData({ status: authorization });
            const row = db.prepare('SELECT * FROM rp_child_analysis WHERE payload_ref=?').get(safe.payloadRef) as
                | Record<string, unknown>
                | undefined;
            if (!row) return freezeData({ status: 'missing' });
            let artifact: RpChildAnalysisArtifactV1;
            try {
                artifact = this.#parse(row);
            } catch {
                return freezeData({ status: 'digest-mismatch' });
            }
            if (
                artifact.binding.sessionId !== this.#options.sessionId ||
                canonicalJson(artifact.binding) !== canonicalJson(binding)
            )
                return freezeData({ status: 'forbidden' });
            if (payloadDigest !== artifact.payloadDigest) return freezeData({ status: 'digest-mismatch' });
            const now = integer(this.#options.clock());
            if (now < artifact.createdAtMs || now >= artifact.expiresAtMs) return freezeData({ status: 'expired' });
            const finalAuthorization = this.#authorize(binding);
            if (finalAuthorization !== 'current') return freezeData({ status: finalAuthorization });
            return freezeData({ status: 'found', artifact });
        } finally {
            if (ownTransaction && db.isTransaction) db.exec('ROLLBACK');
        }
    }
}
