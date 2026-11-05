/** @author Codex @date 2026-10-16 @version 1.0
 * At-most-once model work and immutable prepared handoffs; restart never replays an uncertain model attempt.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import {
    AGENT_SKILL_CANDIDATE_CREATE_VERSION, createAgentSkillCandidate,
} from '@jiuguan/skill-hub';
import {
    normalizeSkillCompileSpec, skillCompileSpecDigest, skillCompileClaimDigest,
    normalizeSkillCompilePacket, readSkillCompileProof,
} from './skill-compile-model.ts';
import { agentSkillCandidateValidationJobId } from './agent-skill-candidate-store.ts';

export const SKILL_COMPILE_DB_FILE = 'agent-skill-compile.sqlite';
export const SKILL_COMPILE_SCHEMA_VERSION = 1;
export const SKILL_COMPILE_APPLICATION_ID = 0x4a47534d;
export const SKILL_COMPILE_FAILURE_REASONS = Object.freeze([
    'skill-compile-model-failed', 'skill-compile-admission-denied',
    'skill-compile-result-invalid', 'skill-compile-source-invalidated',
] as const);
export type SkillCompileFailureReason = typeof SKILL_COMPILE_FAILURE_REASONS[number];
type SkillCompileSpec = ReturnType<typeof normalizeSkillCompileSpec>;
export type SkillCompilePacket = ReturnType<typeof normalizeSkillCompilePacket>;

export interface SkillCompileClaimV1 {
    readonly claimVersion: 'skill-compile-claim-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly spec: SkillCompileSpec;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly createdAt: string;
    readonly ownerId: string;
    readonly ownerToken: string;
    readonly attempt: 1;
    readonly revision: number;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
}

export interface SkillCompileJobV1 {
    readonly jobVersion: 'skill-compile-job-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly spec: SkillCompileSpec;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly state: 'queued' | 'running' | 'prepared' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
    readonly revision: number;
    readonly attempt: 0 | 1;
    readonly claimRevision: number | null;
    readonly ownerId: string | null;
    readonly ownerToken: string | null;
    readonly claimedAt: string | null;
    readonly leaseExpiresAt: string | null;
    readonly packetDigest: string | null;
    readonly candidateId: string | null;
    readonly validationJobId: string | null;
    readonly reasonCode: SkillCompileFailureReason | 'skill-compile-restart-uncertain' | null;
}

export interface SkillCompileStoredJob {
    readonly job: SkillCompileJobV1;
    readonly preparedPacket: SkillCompilePacket | null;
}

export interface SkillCompilePreparedPage {
    readonly entries: readonly Readonly<{ job: SkillCompileJobV1; packet: SkillCompilePacket }>[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

type SqlRow = Record<string, unknown>;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_JOB_CHARS = 65_536;
const MAX_PACKET_CHARS = 262_144;
const SCHEMA = Object.freeze([
    `CREATE TABLE skill_compile_job (
        job_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE CHECK(length(job_id)=71),
        session_key TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=71),
        job_json TEXT NOT NULL CHECK(json_valid(job_json) AND length(job_json)<=65536),
        job_digest TEXT NOT NULL CHECK(length(job_digest)=71),
        state TEXT NOT NULL
            CHECK(state IN ('queued','running','prepared','succeeded','failed','uncertain','cancelled')),
        revision INTEGER NOT NULL CHECK(revision>=0),
        lease_until TEXT
    )`,
    `CREATE TABLE skill_compile_intent (
        idempotency_key TEXT NOT NULL PRIMARY KEY,
        intent_digest TEXT NOT NULL CHECK(length(intent_digest)=71),
        job_id TEXT NOT NULL UNIQUE REFERENCES skill_compile_job(job_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_compile_prepared (
        packet_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE REFERENCES skill_compile_job(job_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        packet_json TEXT NOT NULL CHECK(json_valid(packet_json) AND length(packet_json)<=262144),
        packet_digest TEXT NOT NULL CHECK(length(packet_digest)=71)
    )`,
    `CREATE TABLE skill_compile_quarantine (
        job_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_compile_job(job_id) ON DELETE CASCADE,
        quarantined_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK(reason_code='skill-compile-storage-invalid')
    )`,
    `CREATE TABLE skill_compile_session_tombstone (
        session_key TEXT NOT NULL PRIMARY KEY,
        redacted_at TEXT NOT NULL
    )`,
    'CREATE INDEX skill_compile_job_state ON skill_compile_job(state,job_row_id)',
    'CREATE INDEX skill_compile_job_session ON skill_compile_job(session_key)',
    ...['intent', 'prepared', 'quarantine', 'session_tombstone'].map((name) =>
        `CREATE TRIGGER skill_compile_${name}_no_update BEFORE UPDATE ON skill_compile_${name}
            BEGIN SELECT RAISE(ABORT,'skill compile immutable packet'); END`),
    `CREATE TRIGGER skill_compile_session_tombstone_no_delete BEFORE DELETE ON skill_compile_session_tombstone
        BEGIN SELECT RAISE(ABORT,'skill compile permanent deletion fence'); END`,
]);


function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}


function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('skill-compile-time-invalid');
    return value;
}


function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new Error('skill-compile-count-invalid');
    }
    return Number(value);
}


function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('skill-compile-token-invalid');
    return value;
}


function session(value: unknown): string {
    if (typeof value !== 'string' || !SESSION.test(value)) throw new Error('skill-compile-session-invalid');
    return value;
}


function digest(value: unknown): string {
    if (typeof value !== 'string' || !HASH.test(value)) throw new Error('skill-compile-digest-invalid');
    return value;
}


function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('skill-compile-data-invalid');
    }
    if (Reflect.ownKeys(input).length !== Object.keys(input).length) throw new Error('skill-compile-fields-invalid');
    for (const key of Object.keys(input)) {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) {
            throw new Error('skill-compile-fields-invalid');
        }
    }
    return input as Record<string, unknown>;
}


function exact(value: Record<string, unknown>, keys: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new Error('skill-compile-fields-invalid');
    }
}


function json(value: unknown, maximum: number): string {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > maximum) throw new Error('skill-compile-packet-too-large');
    return text;
}


function requestDigest(input: {
    rawSessionId: string; spec: SkillCompileSpec; modelId: string;
    modelBindingDigest: string; createdAt: string
}): string {
    return hash({
        requestVersion: 'skill-compile-request-v1', rawSessionId: input.rawSessionId,
        specDigest: skillCompileSpecDigest(input.spec), modelId: input.modelId,
        modelBindingDigest: input.modelBindingDigest, createdAt: input.createdAt
    });
}


function normalizeJob(input: unknown): SkillCompileJobV1 {
    const value = record(input);
    exact(value, ['jobVersion', 'jobId', 'rawSessionId', 'requestDigest', 'spec', 'modelId', 'modelBindingDigest',
        'createdAt', 'updatedAt', 'state', 'revision', 'attempt', 'claimRevision', 'ownerId', 'ownerToken',
        'claimedAt', 'leaseExpiresAt', 'packetDigest', 'candidateId', 'validationJobId', 'reasonCode']);
    const job: SkillCompileJobV1 = Object.freeze({
        jobVersion: 'skill-compile-job-v1', jobId: digest(value.jobId),
        rawSessionId: session(value.rawSessionId), requestDigest: digest(value.requestDigest),
        spec: normalizeSkillCompileSpec(value.spec), modelId: token(value.modelId),
        modelBindingDigest: digest(value.modelBindingDigest), createdAt: timestamp(value.createdAt),
        updatedAt: timestamp(value.updatedAt), state: value.state as SkillCompileJobV1['state'],
        revision: count(value.revision), attempt: count(value.attempt, 0, 1) as 0 | 1,
        claimRevision: value.claimRevision === null ? null : count(value.claimRevision, 1),
        ownerId: value.ownerId === null ? null : token(value.ownerId),
        ownerToken: value.ownerToken === null ? null : token(value.ownerToken),
        claimedAt: value.claimedAt === null ? null : timestamp(value.claimedAt),
        leaseExpiresAt: value.leaseExpiresAt === null ? null : timestamp(value.leaseExpiresAt),
        packetDigest: value.packetDigest === null ? null : digest(value.packetDigest),
        candidateId: value.candidateId === null ? null : digest(value.candidateId),
        validationJobId: value.validationJobId === null ? null : digest(value.validationJobId),
        reasonCode: value.reasonCode as SkillCompileJobV1['reasonCode'],
    });
    if (value.jobVersion !== job.jobVersion || job.requestDigest !== requestDigest(job)
        || job.updatedAt < job.createdAt
        || !['queued', 'running', 'prepared', 'succeeded', 'failed', 'uncertain', 'cancelled']
            .includes(job.state) || job.reasonCode !== null
        && ![...SKILL_COMPILE_FAILURE_REASONS, 'skill-compile-restart-uncertain'].includes(job.reasonCode)) {
        throw new Error('skill-compile-job-invalid');
    }
    const owned = job.ownerId !== null && job.ownerToken !== null && job.claimedAt !== null
        && job.leaseExpiresAt !== null && job.claimRevision === 1 && job.attempt === 1;
    if (job.state === 'queued' && (job.attempt !== 0 || job.revision !== 0 || job.claimRevision !== null
        || job.ownerId !== null || job.ownerToken !== null || job.claimedAt !== null || job.leaseExpiresAt !== null)
        || job.state !== 'queued' && (!owned || job.claimedAt! < job.createdAt
            || job.leaseExpiresAt! <= job.claimedAt! || job.updatedAt < job.claimedAt!)
        || job.state === 'running' && (job.revision !== job.claimRevision || job.updatedAt !== job.claimedAt)
        || job.state === 'prepared' && job.revision !== 2
        || job.state === 'succeeded' && job.revision !== 3
        || ['failed', 'uncertain', 'cancelled'].includes(job.state) && job.revision !== 2
        || ['queued', 'running', 'prepared', 'succeeded'].includes(job.state) && job.reasonCode !== null
        || ['queued', 'running', 'failed', 'uncertain', 'cancelled'].includes(job.state) && job.packetDigest !== null
        || ['prepared', 'succeeded'].includes(job.state) && job.packetDigest === null
        || job.state === 'succeeded' && (job.candidateId === null || job.validationJobId === null)
        || job.state !== 'succeeded' && (job.candidateId !== null || job.validationJobId !== null)
        || job.state === 'uncertain' && job.reasonCode !== 'skill-compile-restart-uncertain'
        || ['failed', 'cancelled'].includes(job.state) && !SKILL_COMPILE_FAILURE_REASONS.includes(
            job.reasonCode as SkillCompileFailureReason)) throw new Error('skill-compile-job-state-invalid');
    return job;
}


function parseJob(row: SqlRow): SkillCompileJobV1 {
    if (typeof row.job_json !== 'string' || row.job_json.length > MAX_JOB_CHARS) {
        throw new Error('skill-compile-job-packet-invalid');
    }
    const job = normalizeJob(JSON.parse(row.job_json));
    if (JSON.stringify(job) !== row.job_json || hash(job) !== row.job_digest || job.jobId !== row.job_id
        || job.rawSessionId !== row.session_key || job.requestDigest !== row.request_digest
        || job.state !== row.state || job.revision !== row.revision || job.leaseExpiresAt !== row.lease_until) {
        throw new Error('skill-compile-job-corrupt');
    }
    return job;
}


function claimOf(job: SkillCompileJobV1): SkillCompileClaimV1 {
    if (job.attempt !== 1 || job.ownerId === null || job.ownerToken === null || job.claimedAt === null
        || job.leaseExpiresAt === null || job.claimRevision === null) throw new Error('skill-compile-claim-missing');
    return Object.freeze({
        claimVersion: 'skill-compile-claim-v1', jobId: job.jobId, rawSessionId: job.rawSessionId,
        requestDigest: job.requestDigest, spec: job.spec, modelId: job.modelId,
        modelBindingDigest: job.modelBindingDigest,
        createdAt: job.createdAt, ownerId: job.ownerId, ownerToken: job.ownerToken, attempt: 1,
        revision: job.claimRevision, claimedAt: job.claimedAt, leaseExpiresAt: job.leaseExpiresAt
    });
}


function schemaSql(db: DatabaseSync): string[] {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SqlRow[])
        .map((row) => {
            if (typeof row.sql !== 'string') throw new Error('skill-compile-schema-invalid');
            return row.sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
        }).sort();
}


function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
    return count((db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key]);
}


export function inspectSkillCompileSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== SKILL_COMPILE_APPLICATION_ID
        || pragma(db, 'user_version') !== SKILL_COMPILE_SCHEMA_VERSION) {
        throw new Error('skill-compile-metadata-mismatch');
    }
    const expected = SCHEMA.map((item) => item.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(expected)) throw new Error('skill-compile-schema-mismatch');
}


function initialize(db: DatabaseSync): void {
    if (pragma(db, 'application_id') || pragma(db, 'user_version')) { inspectSkillCompileSchema(db); return; }
    if (schemaSql(db).length) throw new Error('skill-compile-uninitialized-not-empty');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${SKILL_COMPILE_APPLICATION_ID}`);
        for (const statement of SCHEMA) db.exec(statement);
        db.exec(`PRAGMA user_version=${SKILL_COMPILE_SCHEMA_VERSION}`);
        inspectSkillCompileSchema(db);
        db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}


function stat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}


function directory(path: string): void {
    if (path === parse(path).root) throw new Error('skill-compile-directory-invalid');
    for (let current = path; current !== dirname(current); current = dirname(current)) {
        const entry = stat(current);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            throw new Error('skill-compile-directory-invalid');
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}


function regular(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('skill-compile-file-invalid');
}


/** Durable model work is not the safe-to-replay static validator queue. */
export class SkillCompileStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #isSessionDeleted: (raw: string) => boolean;
    readonly #claims = new WeakSet<object>();
    #closed = false;

    constructor(options: {
        readonly dataDir: string; readonly now?: () => string;
        readonly isSessionDeleted?: (raw: string) => boolean
    }) {
        if (typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
            throw new Error('skill-compile-directory-invalid');
        }
        const dataDir = resolve(options.dataDir);
        directory(dataDir);
        const file = join(dataDir, SKILL_COMPILE_DB_FILE);
        for (const suffix of ['', '-wal', '-shm', '-journal']) regular(`${file}${suffix}`);
        this.#db = new DatabaseSync(file);
        try {
            this.#db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON');
            initialize(this.#db);
            this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
            for (const suffix of ['', '-wal', '-shm']) {
                const path = `${file}${suffix}`;
                regular(path);
                if (stat(path)) {
                    try { chmodSync(path, 0o600); }
                    catch (error) { if (process.platform !== 'win32') throw error; }
                }
            }
        } catch (error) { this.#db.close(); throw error; }
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#isSessionDeleted = options.isSessionDeleted ?? (() => false);
    }

    #open(): void { if (this.#closed) throw new Error('skill-compile-store-closed'); }

    #transaction<T>(work: () => T, write = true): T {
        this.#open();
        if (this.#db.isTransaction) throw new Error('skill-compile-nested-transaction');
        this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            const result = work();
            if (!this.#db.isTransaction) throw new Error('skill-compile-transaction-lost');
            this.#db.exec('COMMIT');
            return result;
        } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    }

    #deleted(raw: string): boolean {
        if (this.#db.prepare('SELECT 1 FROM skill_compile_session_tombstone WHERE session_key=?').get(raw)) return true;
        try { return this.#isSessionDeleted(raw) === true; }
        catch { throw new Error('skill-compile-source-status-unavailable'); }
    }

    #source(raw: string): void { if (this.#deleted(raw)) throw new Error('skill-compile-session-deleted'); }

    #quarantined(jobId: string): boolean {
        return !!this.#db.prepare('SELECT 1 FROM skill_compile_quarantine WHERE job_id=?').get(jobId);
    }

    #raw(jobId: string): SqlRow | undefined {
        return this.#db.prepare('SELECT * FROM skill_compile_job WHERE job_id=?').get(jobId) as SqlRow | undefined;
    }

    #read(jobId: string): SkillCompileStoredJob | null {
        const row = this.#raw(jobId);
        if (!row) return null;
        const job = parseJob(row);
        if (this.#deleted(job.rawSessionId)) return null;
        const intent = this.#db.prepare('SELECT * FROM skill_compile_intent WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        if (!intent || intent.intent_digest !== job.requestDigest || intent.session_key !== job.rawSessionId
            || intent.created_at !== job.createdAt
            || job.jobId !== hash(['skill-compile-job-v1', token(intent.idempotency_key)])) {
            throw new Error('skill-compile-intent-corrupt');
        }
        const prepared = this.#db.prepare('SELECT * FROM skill_compile_prepared WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        if (!prepared) {
            if (job.packetDigest !== null || ['prepared', 'succeeded'].includes(job.state)) {
                throw new Error('skill-compile-prepared-missing');
            }
            return Object.freeze({ job, preparedPacket: null });
        }
        if (typeof prepared.packet_json !== 'string' || prepared.packet_json.length > MAX_PACKET_CHARS) {
            throw new Error('skill-compile-prepared-invalid');
        }
        const packet = normalizeSkillCompilePacket(JSON.parse(prepared.packet_json));
        if (JSON.stringify(packet) !== prepared.packet_json || packet.packetDigest !== prepared.packet_digest
            || packet.packetDigest !== job.packetDigest || prepared.session_key !== job.rawSessionId
            || packet.jobId !== job.jobId || packet.rawSessionId !== job.rawSessionId
            || packet.jobRequestDigest !== job.requestDigest || packet.specDigest !== skillCompileSpecDigest(job.spec)
            || JSON.stringify(packet.spec) !== JSON.stringify(job.spec)
            || packet.modelId !== job.modelId || packet.modelBindingDigest !== job.modelBindingDigest
            || packet.claimDigest !== skillCompileClaimDigest(claimOf(job))
            || packet.completedAt < job.claimedAt! || packet.completedAt >= job.leaseExpiresAt!
            || !['prepared', 'succeeded'].includes(job.state)) {
            throw new Error('skill-compile-prepared-binding-invalid');
        }
        if (job.state === 'prepared' && job.updatedAt !== packet.completedAt) {
            throw new Error('skill-compile-prepared-time-invalid');
        }
        if (job.state === 'succeeded') {
            const candidate = createAgentSkillCandidate({
                createVersion: AGENT_SKILL_CANDIDATE_CREATE_VERSION,
                header: packet.submission.bundle.header, bundleDigest: packet.submission.bundle.bundleDigest,
                parentBundleDigest: packet.submission.parentBundleDigest, createdAt: packet.submission.createdAt
            });
            if (job.candidateId !== candidate.candidateId || job.updatedAt < packet.completedAt
                || job.validationJobId !== agentSkillCandidateValidationJobId(candidate.candidateId,
                    candidate.bundleDigest)) throw new Error('skill-compile-delivered-binding-invalid');
        }
        return Object.freeze({ job, preparedPacket: packet });
    }

    #writeJob(previous: SkillCompileJobV1, next: SkillCompileJobV1): void {
        const job = normalizeJob(next);
        const changed = this.#db.prepare(`UPDATE skill_compile_job
            SET job_json=?,job_digest=?,state=?,revision=?,lease_until=?
            WHERE job_id=? AND revision=? AND job_digest=?`)
            .run(json(job, MAX_JOB_CHARS), hash(job), job.state, job.revision, job.leaseExpiresAt,
                previous.jobId, previous.revision, hash(previous));
        const retained = this.#raw(job.jobId);
        if (Number(changed.changes) !== 1 || !retained || JSON.stringify(parseJob(retained)) !== JSON.stringify(job)) {
            throw new Error('skill-compile-job-revision-conflict');
        }
    }

    #quarantine(row: SqlRow, now: string): void {
        if (typeof row.job_id !== 'string' || row.job_id.length > 240) {
            throw new Error('skill-compile-quarantine-key-invalid');
        }
        this.#db.prepare(`INSERT INTO skill_compile_quarantine(job_id,quarantined_at,reason_code)
            VALUES(?,?,'skill-compile-storage-invalid')`).run(row.job_id, now);
        const retained = this.#db.prepare('SELECT * FROM skill_compile_quarantine WHERE job_id=?')
            .get(row.job_id) as SqlRow | undefined;
        if (retained?.quarantined_at !== now || retained.reason_code !== 'skill-compile-storage-invalid') {
            throw new Error('skill-compile-quarantine-storage-mismatch');
        }
    }

    #redact(rawSessionId: string, now: string): void {
        const existing = this.#db.prepare('SELECT * FROM skill_compile_session_tombstone WHERE session_key=?')
            .get(rawSessionId) as SqlRow | undefined;
        if (existing) timestamp(existing.redacted_at);
        else this.#db.prepare('INSERT INTO skill_compile_session_tombstone(session_key,redacted_at) VALUES(?,?)')
            .run(rawSessionId, now);
        const fence = this.#db.prepare('SELECT * FROM skill_compile_session_tombstone WHERE session_key=?')
            .get(rawSessionId) as SqlRow | undefined;
        if (!fence || fence.redacted_at !== (existing?.redacted_at ?? now)) {
            throw new Error('skill-compile-redaction-fence-storage-mismatch');
        }
        this.#db.prepare('DELETE FROM skill_compile_job WHERE session_key=?').run(rawSessionId);
        for (const table of ['job', 'intent', 'prepared']) {
            if (this.#db.prepare(`SELECT 1 FROM skill_compile_${table} WHERE session_key=?`).get(rawSessionId)) {
                throw new Error('skill-compile-redaction-storage-mismatch');
            }
        }
    }

    #owned(claim: SkillCompileClaimV1): SkillCompileJobV1 {
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-compile-claim-brand-invalid');
        const row = this.#raw(claim.jobId);
        if (!row) throw new Error('skill-compile-job-missing');
        const job = parseJob(row);
        this.#source(job.rawSessionId);
        if (this.#quarantined(job.jobId)) throw new Error('skill-compile-job-quarantined');
        if (skillCompileClaimDigest(claim) !== skillCompileClaimDigest(claimOf(job))) {
            throw new Error('skill-compile-claim-stale');
        }
        return job;
    }

    enqueue(input: {
        readonly rawSessionId: string; readonly spec: SkillCompileSpec; readonly modelId: string;
        readonly modelBindingDigest: string; readonly createdAt: string
    }, idempotencyKey: string): SkillCompileJobV1 {
        this.#open();
        const value = record(input);
        exact(value, ['rawSessionId', 'spec', 'modelId', 'modelBindingDigest', 'createdAt']);
        const rawSessionId = session(value.rawSessionId);
        const spec = normalizeSkillCompileSpec(value.spec);
        const modelId = token(value.modelId);
        const modelBindingDigest = digest(value.modelBindingDigest);
        const createdAt = timestamp(value.createdAt);
        const key = token(idempotencyKey);
        const jobId = hash(['skill-compile-job-v1', key]);
        const source = { rawSessionId, spec, modelId, modelBindingDigest, createdAt };
        const intentDigest = requestDigest(source);
        if (createdAt > timestamp(this.#now())) throw new Error('skill-compile-created-in-future');
        return this.#transaction(() => {
            this.#source(rawSessionId);
            const intent = this.#db.prepare('SELECT * FROM skill_compile_intent WHERE idempotency_key=?')
                .get(key) as SqlRow | undefined;
            if (intent) {
                const retained = this.#read(jobId);
                if (!retained) throw new Error('skill-compile-intent-source-missing');
                const originalDigest = requestDigest({ ...source, createdAt: retained.job.createdAt });
                if (intent.intent_digest !== originalDigest || intent.job_id !== jobId
                    || intent.session_key !== rawSessionId || intent.created_at !== retained.job.createdAt) {
                    throw new Error('skill-compile-idempotency-conflict');
                }
                return retained.job;
            }
            const job = normalizeJob({
                jobVersion: 'skill-compile-job-v1', jobId, ...source,
                requestDigest: intentDigest, updatedAt: createdAt, state: 'queued', revision: 0, attempt: 0,
                claimRevision: null, ownerId: null, ownerToken: null, claimedAt: null, leaseExpiresAt: null,
                packetDigest: null, candidateId: null, validationJobId: null, reasonCode: null
            });
            this.#db.prepare(`INSERT INTO skill_compile_job
                (job_id,session_key,request_digest,job_json,job_digest,state,revision,lease_until)
                VALUES(?,?,?,?,?,?,?,?)`).run(jobId, rawSessionId, job.requestDigest, json(job, MAX_JOB_CHARS),
                hash(job), job.state, job.revision, null);
            this.#db.prepare(`INSERT INTO skill_compile_intent
                (idempotency_key,intent_digest,job_id,session_key,created_at) VALUES(?,?,?,?,?)`)
                .run(key, intentDigest, jobId, rawSessionId, createdAt);
            const retained = this.#read(jobId);
            if (!retained || JSON.stringify(retained.job) !== JSON.stringify(job)) {
                throw new Error('skill-compile-enqueue-storage-mismatch');
            }
            this.#source(rawSessionId);
            return retained.job;
        });
    }

    read(jobId: string): SkillCompileStoredJob | null {
        digest(jobId);
        return this.#transaction(() => this.#read(jobId), false);
    }

    claimNext(ownerId: string, leaseMs = 30_000): SkillCompileClaimV1 | null {
        token(ownerId);
        count(leaseMs, 1, 300_000);
        const now = timestamp(this.#now());
        const claim = this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_compile_job WHERE state='queued'
                AND NOT EXISTS(SELECT 1 FROM skill_compile_quarantine AS quarantine
                    WHERE quarantine.job_id=skill_compile_job.job_id) ORDER BY job_row_id LIMIT 64`).all() as SqlRow[];
            for (const row of rows) {
                let job: SkillCompileJobV1;
                try {
                    job = parseJob(row);
                    if (!this.#read(job.jobId)) throw new Error('skill-compile-source-missing');
                } catch (error) {
                    if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                        throw new Error('skill-compile-session-deleted');
                    }
                    this.#quarantine(row, now);
                    continue;
                }
                this.#source(job.rawSessionId);
                if (now < job.updatedAt) throw new Error('skill-compile-clock-regressed');
                const next = normalizeJob({
                    ...job, state: 'running', revision: 1, attempt: 1, claimRevision: 1,
                    ownerId, ownerToken: `compile-owner:${randomUUID()}`, claimedAt: now, updatedAt: now,
                    leaseExpiresAt: timestamp(new Date(Date.parse(now) + leaseMs).toISOString())
                });
                this.#writeJob(job, next);
                this.#source(job.rawSessionId);
                return claimOf(next);
            }
            return null;
        });
        if (claim) this.#claims.add(claim);
        return claim;
    }

    prepare(claim: SkillCompileClaimV1, proof: unknown): SkillCompileStoredJob {
        this.#open();
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-compile-claim-brand-invalid');
        const packet = readSkillCompileProof(proof);
        if (packet.jobId !== claim.jobId || packet.rawSessionId !== claim.rawSessionId
            || packet.jobRequestDigest !== claim.requestDigest || packet.claimDigest !== skillCompileClaimDigest(claim)
            || packet.modelId !== claim.modelId || packet.modelBindingDigest !== claim.modelBindingDigest
            || packet.specDigest !== skillCompileSpecDigest(claim.spec)
            || JSON.stringify(packet.spec) !== JSON.stringify(claim.spec)
            || packet.completedAt < claim.claimedAt || packet.completedAt >= claim.leaseExpiresAt) {
            throw new Error('skill-compile-proof-binding-mismatch');
        }
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const job = this.#owned(claim);
            const source = this.#read(job.jobId);
            if (!source) throw new Error('skill-compile-source-missing');
            if (source.preparedPacket) {
                if (JSON.stringify(source.preparedPacket) !== JSON.stringify(packet)) {
                    throw new Error('skill-compile-prepared-conflict');
                }
                return source;
            }
            if (job.state !== 'running' || job.revision !== claim.revision
                || now >= claim.leaseExpiresAt || now < packet.completedAt) {
                throw new Error('skill-compile-claim-stale');
            }
            this.#db.prepare(`INSERT INTO skill_compile_prepared(job_id,session_key,packet_json,packet_digest)
                VALUES(?,?,?,?)`).run(job.jobId, job.rawSessionId, json(packet, MAX_PACKET_CHARS), packet.packetDigest);
            this.#writeJob(job, normalizeJob({
                ...job, state: 'prepared', revision: job.revision + 1,
                updatedAt: packet.completedAt, packetDigest: packet.packetDigest
            }));
            const retained = this.#read(job.jobId);
            if (!retained || JSON.stringify(retained.preparedPacket) !== JSON.stringify(packet)) {
                throw new Error('skill-compile-prepare-storage-mismatch');
            }
            this.#source(job.rawSessionId);
            return retained;
        });
    }

    markDelivered(jobId: string, packetDigest: string, candidateId: string,
        validationJobId: string): SkillCompileStoredJob {
        for (const value of [jobId, packetDigest, candidateId, validationJobId]) digest(value);
        return this.#transaction(() => {
            const source = this.#read(jobId);
            if (!source?.preparedPacket) throw new Error('skill-compile-prepared-missing');
            const { job, preparedPacket: packet } = source;
            this.#source(job.rawSessionId);
            if (this.#quarantined(jobId)) throw new Error('skill-compile-job-quarantined');
            const candidate = createAgentSkillCandidate({
                createVersion: AGENT_SKILL_CANDIDATE_CREATE_VERSION,
                header: packet.submission.bundle.header, bundleDigest: packet.submission.bundle.bundleDigest,
                parentBundleDigest: packet.submission.parentBundleDigest, createdAt: packet.submission.createdAt
            });
            if (packet.packetDigest !== packetDigest || candidate.candidateId !== candidateId
                || agentSkillCandidateValidationJobId(candidateId, candidate.bundleDigest) !== validationJobId) {
                throw new Error('skill-compile-delivery-binding-mismatch');
            }
            if (job.state === 'succeeded') {
                if (job.candidateId !== candidateId || job.validationJobId !== validationJobId) {
                    throw new Error('skill-compile-delivery-conflict');
                }
                return source;
            }
            if (job.state !== 'prepared') throw new Error('skill-compile-delivery-state-invalid');
            const now = timestamp(this.#now());
            if (now < job.updatedAt) throw new Error('skill-compile-clock-regressed');
            this.#writeJob(job, normalizeJob({
                ...job, state: 'succeeded', revision: job.revision + 1,
                updatedAt: now, candidateId, validationJobId
            }));
            const retained = this.#read(jobId);
            if (!retained || retained.job.state !== 'succeeded') {
                throw new Error('skill-compile-delivery-storage-mismatch');
            }
            this.#source(job.rawSessionId);
            return retained;
        });
    }

    markFailed(claim: SkillCompileClaimV1, reason: SkillCompileFailureReason): SkillCompileJobV1 {
        if (!SKILL_COMPILE_FAILURE_REASONS.includes(reason)) throw new Error('skill-compile-failure-reason-invalid');
        return this.#transaction(() => {
            const job = this.#owned(claim);
            if (job.state === 'failed' && job.reasonCode === reason) return job;
            if (job.state !== 'running' || job.revision !== claim.revision) {
                throw new Error('skill-compile-claim-stale');
            }
            const now = timestamp(this.#now());
            if (now < job.updatedAt) throw new Error('skill-compile-clock-regressed');
            const next = normalizeJob({
                ...job, state: 'failed', revision: job.revision + 1, updatedAt: now,
                reasonCode: reason
            });
            this.#writeJob(job, next);
            this.#source(job.rawSessionId);
            return next;
        });
    }

    /** Startup-only conservative recovery. A model may have run even when no prepared packet exists. */
    recoverUncertain(): number {
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_compile_job WHERE state='running'
                AND NOT EXISTS(SELECT 1 FROM skill_compile_quarantine AS quarantine
                    WHERE quarantine.job_id=skill_compile_job.job_id) ORDER BY job_row_id LIMIT 64`).all() as SqlRow[];
            let recovered = 0;
            for (const row of rows) {
                if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                    this.#redact(session(row.session_key), now);
                    continue;
                }
                let job: SkillCompileJobV1;
                try {
                    job = parseJob(row);
                    if (!this.#read(job.jobId)) throw new Error('skill-compile-source-missing');
                } catch {
                    this.#quarantine(row, now);
                    continue;
                }
                this.#source(job.rawSessionId);
                if (now < job.updatedAt) throw new Error('skill-compile-clock-regressed');
                this.#writeJob(job, normalizeJob({
                    ...job, state: 'uncertain', revision: job.revision + 1,
                    updatedAt: now, reasonCode: 'skill-compile-restart-uncertain'
                }));
                recovered += 1;
            }
            return recovered;
        });
    }

    scanPrepared(limit = 64, cursor = 0): SkillCompilePreparedPage {
        count(limit, 1, 256);
        count(cursor);
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_compile_prepared
                WHERE packet_row_id>? ORDER BY packet_row_id LIMIT ?`).all(cursor, limit + 1) as SqlRow[];
            const page = rows.slice(0, limit);
            const entries: { job: SkillCompileJobV1; packet: SkillCompilePacket }[] = [];
            let failed = 0;
            for (const row of page) {
                try {
                    const source = this.#read(digest(row.job_id));
                    if (!source?.preparedPacket || this.#quarantined(source.job.jobId)) {
                        throw new Error('skill-compile-prepared-source-invalid');
                    }
                    entries.push(Object.freeze({ job: source.job, packet: source.preparedPacket }));
                } catch { failed += 1; }
            }
            return Object.freeze({
                entries: Object.freeze(entries), attempted: page.length, failed,
                nextCursor: page.length ? count(page.at(-1)!.packet_row_id, 1) : cursor, hasMore: rows.length > limit
            });
        }, false);
    }

    /** Explicit worker maintenance; ordinary retained reads remain read-only and preserve the corrupt bytes. */
    quarantineInvalidPrepared(limit = 64, cursor = 0): Readonly<{
        attempted: number; quarantined: number; nextCursor: number; hasMore: boolean;
    }> {
        count(limit, 1, 256);
        count(cursor);
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_compile_prepared
                WHERE packet_row_id>? ORDER BY packet_row_id LIMIT ?`).all(cursor, limit + 1) as SqlRow[];
            const page = rows.slice(0, limit);
            let quarantined = 0;
            for (const row of page) {
                if (typeof row.job_id !== 'string' || row.job_id.length > 240) {
                    throw new Error('skill-compile-quarantine-key-invalid');
                }
                if (this.#quarantined(row.job_id)) continue;
                const job = this.#raw(row.job_id);
                if (!job) throw new Error('skill-compile-prepared-job-missing');
                if (typeof job.session_key === 'string' && this.#deleted(job.session_key)) continue;
                try {
                    const retained = this.#read(row.job_id);
                    if (retained?.preparedPacket) continue;
                } catch { /* Only a fresh failed verification may add the metadata fence. */ }
                this.#quarantine(job, now);
                quarantined += 1;
            }
            return Object.freeze({
                attempted: page.length, quarantined,
                nextCursor: page.length ? count(page.at(-1)!.packet_row_id, 1) : cursor, hasMore: rows.length > limit
            });
        });
    }

    status(): Readonly<{ queued: number; running: number; prepared: number }> {
        this.#open();
        const row = this.#db.prepare(`SELECT COALESCE(SUM(state='queued'),0) AS queued,
            COALESCE(SUM(state='running'),0) AS running,COALESCE(SUM(state='prepared'),0) AS prepared
            FROM skill_compile_job WHERE NOT EXISTS(SELECT 1 FROM skill_compile_quarantine AS quarantine
                WHERE quarantine.job_id=skill_compile_job.job_id)
                AND NOT EXISTS(SELECT 1 FROM skill_compile_session_tombstone AS tombstone
                    WHERE tombstone.session_key=skill_compile_job.session_key)`).get() as SqlRow;
        return Object.freeze({ queued: count(row.queued), running: count(row.running), prepared: count(row.prepared) });
    }

    redactSession(rawSessionId: string): void {
        session(rawSessionId);
        const now = timestamp(this.#now());
        this.#transaction(() => this.#redact(rawSessionId, now));
    }

    close(): void {
        if (this.#closed) return;
        this.#db.close();
        this.#closed = true;
    }
}
