/** @author Codex @date 2026-10-16 @version 1.0
 * At-most-once fixture conformance evaluation; negative receipts are valid results, never promotion authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import {
    normalizeSkillEvaluatePlan, skillEvaluatePlanDigest, skillEvaluateClaimDigest,
    normalizeSkillEvaluatePacket, readSkillEvaluateProof,
} from './skill-evaluate-model.ts';
export const SKILL_EVALUATE_DB_FILE = 'agent-skill-evaluations.sqlite';
export const SKILL_EVALUATE_SCHEMA_VERSION = 1;
export const SKILL_EVALUATE_APPLICATION_ID = 0x4a475345;
export const SKILL_EVALUATE_FAILURE_REASONS = Object.freeze([
    'skill-evaluate-model-failed', 'skill-evaluate-admission-denied',
    'skill-evaluate-result-invalid', 'skill-evaluate-source-invalidated', 'skill-evaluate-persistence-unconfirmed',
] as const);
export type SkillEvaluateFailureReason = typeof SKILL_EVALUATE_FAILURE_REASONS[number];
type SkillEvaluatePlan = ReturnType<typeof normalizeSkillEvaluatePlan>;
export type SkillEvaluatePacket = ReturnType<typeof normalizeSkillEvaluatePacket>;

export interface SkillEvaluateClaimV1 {
    readonly claimVersion: 'skill-evaluate-claim-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly plan: SkillEvaluatePlan;
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

export interface SkillEvaluateJobV1 {
    readonly jobVersion: 'skill-evaluate-job-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly plan: SkillEvaluatePlan;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
    readonly revision: number;
    readonly attempt: 0 | 1;
    readonly claimRevision: number | null;
    readonly ownerId: string | null;
    readonly ownerToken: string | null;
    readonly claimedAt: string | null;
    readonly leaseExpiresAt: string | null;
    readonly receiptDigest: string | null;
    readonly reasonCode: SkillEvaluateFailureReason | 'skill-evaluate-restart-uncertain' | null;
}

export interface SkillEvaluateStoredJob {
    readonly job: SkillEvaluateJobV1;
    readonly receipt: SkillEvaluatePacket | null;
}

type SqlRow = Record<string, unknown>;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_JOB_CHARS = 65_536;
const MAX_PACKET_CHARS = 262_144;
const SCHEMA = Object.freeze([
    `CREATE TABLE skill_evaluate_job (
        job_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE CHECK(length(job_id)=71),
        session_key TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=71),
        job_json TEXT NOT NULL CHECK(json_valid(job_json) AND length(job_json)<=65536),
        job_digest TEXT NOT NULL CHECK(length(job_digest)=71),
        state TEXT NOT NULL
            CHECK(state IN ('queued','running','succeeded','failed','uncertain')),
        revision INTEGER NOT NULL CHECK(revision>=0),
        lease_until TEXT
    )`,
    `CREATE TABLE skill_evaluate_intent (
        idempotency_key TEXT NOT NULL PRIMARY KEY,
        intent_digest TEXT NOT NULL CHECK(length(intent_digest)=71),
        job_id TEXT NOT NULL UNIQUE REFERENCES skill_evaluate_job(job_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_evaluate_receipt (
        packet_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE REFERENCES skill_evaluate_job(job_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        packet_json TEXT NOT NULL CHECK(json_valid(packet_json) AND length(packet_json)<=262144),
        packet_digest TEXT NOT NULL CHECK(length(packet_digest)=71)
    )`,
    `CREATE TABLE skill_evaluate_quarantine (
        job_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_evaluate_job(job_id) ON DELETE CASCADE,
        quarantined_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK(reason_code='skill-evaluate-storage-invalid')
    )`,
    `CREATE TABLE skill_evaluate_session_tombstone (
        session_key TEXT NOT NULL PRIMARY KEY,
        redacted_at TEXT NOT NULL
    )`,
    'CREATE INDEX skill_evaluate_job_state ON skill_evaluate_job(state,job_row_id)',
    'CREATE INDEX skill_evaluate_job_session ON skill_evaluate_job(session_key)',
    ...['intent', 'receipt', 'quarantine', 'session_tombstone'].map((name) =>
        `CREATE TRIGGER skill_evaluate_${name}_no_update BEFORE UPDATE ON skill_evaluate_${name}
            BEGIN SELECT RAISE(ABORT,'skill compile immutable packet'); END`),
    `CREATE TRIGGER skill_evaluate_session_tombstone_no_delete BEFORE DELETE ON skill_evaluate_session_tombstone
        BEGIN SELECT RAISE(ABORT,'skill compile permanent deletion fence'); END`,
]);


function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}


function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('skill-evaluate-time-invalid');
    return value;
}


function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new Error('skill-evaluate-count-invalid');
    }
    return Number(value);
}


function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('skill-evaluate-token-invalid');
    return value;
}


function session(value: unknown): string {
    if (typeof value !== 'string' || !SESSION.test(value)) throw new Error('skill-evaluate-session-invalid');
    return value;
}


function digest(value: unknown): string {
    if (typeof value !== 'string' || !HASH.test(value)) throw new Error('skill-evaluate-digest-invalid');
    return value;
}


function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('skill-evaluate-data-invalid');
    }
    if (Reflect.ownKeys(input).length !== Object.keys(input).length) throw new Error('skill-evaluate-fields-invalid');
    for (const key of Object.keys(input)) {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) {
            throw new Error('skill-evaluate-fields-invalid');
        }
    }
    return input as Record<string, unknown>;
}


function exact(value: Record<string, unknown>, keys: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new Error('skill-evaluate-fields-invalid');
    }
}


function json(value: unknown, maximum: number): string {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > maximum) throw new Error('skill-evaluate-packet-too-large');
    return text;
}


function requestDigest(input: {
    rawSessionId: string; plan: SkillEvaluatePlan; modelId: string;
    modelBindingDigest: string; createdAt: string
}): string {
    return hash({
        requestVersion: 'skill-evaluate-request-v1', rawSessionId: input.rawSessionId,
        planDigest: skillEvaluatePlanDigest(input.plan), modelId: input.modelId,
        modelBindingDigest: input.modelBindingDigest, createdAt: input.createdAt
    });
}


function normalizeJob(input: unknown): SkillEvaluateJobV1 {
    const value = record(input);
    exact(value, ['jobVersion', 'jobId', 'rawSessionId', 'requestDigest', 'plan', 'modelId', 'modelBindingDigest',
        'createdAt', 'updatedAt', 'state', 'revision', 'attempt', 'claimRevision', 'ownerId', 'ownerToken',
        'claimedAt', 'leaseExpiresAt', 'receiptDigest', 'reasonCode']);
    const job: SkillEvaluateJobV1 = Object.freeze({
        jobVersion: 'skill-evaluate-job-v1', jobId: digest(value.jobId), rawSessionId: session(value.rawSessionId),
        requestDigest: digest(value.requestDigest), plan: normalizeSkillEvaluatePlan(value.plan),
        modelId: token(value.modelId), modelBindingDigest: digest(value.modelBindingDigest),
        createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt),
        state: value.state as SkillEvaluateJobV1['state'], revision: count(value.revision),
        attempt: count(value.attempt, 0, 1) as 0 | 1,
        claimRevision: value.claimRevision === null ? null : count(value.claimRevision, 1),
        ownerId: value.ownerId === null ? null : token(value.ownerId),
        ownerToken: value.ownerToken === null ? null : token(value.ownerToken),
        claimedAt: value.claimedAt === null ? null : timestamp(value.claimedAt),
        leaseExpiresAt: value.leaseExpiresAt === null ? null : timestamp(value.leaseExpiresAt),
        receiptDigest: value.receiptDigest === null ? null : digest(value.receiptDigest),
        reasonCode: value.reasonCode as SkillEvaluateJobV1['reasonCode'],
    });
    if (value.jobVersion !== job.jobVersion || job.requestDigest !== requestDigest(job)
        || job.rawSessionId !== job.plan.compilePacket.rawSessionId || job.updatedAt < job.createdAt
        || !['queued', 'running', 'succeeded', 'failed', 'uncertain'].includes(job.state)
        || job.reasonCode !== null && ![...SKILL_EVALUATE_FAILURE_REASONS, 'skill-evaluate-restart-uncertain']
            .includes(job.reasonCode)) throw new Error('skill-evaluate-job-invalid');
    const emptyOwner = job.ownerId === null && job.ownerToken === null && job.claimedAt === null
        && job.leaseExpiresAt === null && job.claimRevision === null;
    if (job.attempt === 0) {
        if (!emptyOwner || job.receiptDigest !== null || !(job.state === 'queued' && job.revision === 0
            && job.reasonCode === null || job.state === 'failed' && job.revision === 1
            && job.reasonCode === 'skill-evaluate-source-invalidated')) throw new Error('skill-evaluate-job-invalid');
        return job;
    }
    if (emptyOwner || job.ownerId === null || job.ownerToken === null || job.claimedAt === null
        || job.leaseExpiresAt === null || job.claimRevision !== 1 || job.claimedAt < job.createdAt
        || job.updatedAt < job.claimedAt || job.leaseExpiresAt <= job.claimedAt
        || job.state === 'running' && (job.revision !== 1 || job.updatedAt !== job.claimedAt || job.reasonCode !== null)
        || job.state !== 'running' && (job.revision !== 2 || job.state === 'queued')
        || job.state === 'succeeded' && (job.receiptDigest === null || job.reasonCode !== null)
        || job.state !== 'succeeded' && job.receiptDigest !== null
        || job.state === 'uncertain' && job.reasonCode !== 'skill-evaluate-restart-uncertain'
        || job.state === 'failed' && !SKILL_EVALUATE_FAILURE_REASONS.includes(
            job.reasonCode as SkillEvaluateFailureReason)) throw new Error('skill-evaluate-job-state-invalid');
    return job;
}


function parseJob(row: SqlRow): SkillEvaluateJobV1 {
    if (typeof row.job_json !== 'string' || row.job_json.length > MAX_JOB_CHARS) {
        throw new Error('skill-evaluate-job-packet-invalid');
    }
    const job = normalizeJob(JSON.parse(row.job_json));
    if (JSON.stringify(job) !== row.job_json || hash(job) !== row.job_digest || job.jobId !== row.job_id
        || job.rawSessionId !== row.session_key || job.requestDigest !== row.request_digest
        || job.state !== row.state || job.revision !== row.revision || job.leaseExpiresAt !== row.lease_until) {
        throw new Error('skill-evaluate-job-corrupt');
    }
    return job;
}


function claimOf(job: SkillEvaluateJobV1): SkillEvaluateClaimV1 {
    if (job.attempt !== 1 || job.ownerId === null || job.ownerToken === null || job.claimedAt === null
        || job.leaseExpiresAt === null || job.claimRevision === null) throw new Error('skill-evaluate-claim-missing');
    return Object.freeze({
        claimVersion: 'skill-evaluate-claim-v1', jobId: job.jobId, rawSessionId: job.rawSessionId,
        requestDigest: job.requestDigest, plan: job.plan, modelId: job.modelId,
        modelBindingDigest: job.modelBindingDigest,
        createdAt: job.createdAt, ownerId: job.ownerId, ownerToken: job.ownerToken, attempt: 1,
        revision: job.claimRevision, claimedAt: job.claimedAt, leaseExpiresAt: job.leaseExpiresAt
    });
}


function schemaSql(db: DatabaseSync): string[] {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SqlRow[])
        .map((row) => {
            if (typeof row.sql !== 'string') throw new Error('skill-evaluate-schema-invalid');
            return row.sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
        }).sort();
}


function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
    return count((db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key]);
}


export function inspectSkillEvaluateSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== SKILL_EVALUATE_APPLICATION_ID
        || pragma(db, 'user_version') !== SKILL_EVALUATE_SCHEMA_VERSION) {
        throw new Error('skill-evaluate-metadata-mismatch');
    }
    const expected = SCHEMA.map((item) => item.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(expected)) throw new Error('skill-evaluate-schema-mismatch');
}


function initialize(db: DatabaseSync): void {
    if (pragma(db, 'application_id') || pragma(db, 'user_version')) { inspectSkillEvaluateSchema(db); return; }
    if (schemaSql(db).length) throw new Error('skill-evaluate-uninitialized-not-empty');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${SKILL_EVALUATE_APPLICATION_ID}`);
        for (const statement of SCHEMA) db.exec(statement);
        db.exec(`PRAGMA user_version=${SKILL_EVALUATE_SCHEMA_VERSION}`);
        inspectSkillEvaluateSchema(db);
        db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}


function stat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}


function directory(path: string): void {
    if (path === parse(path).root) throw new Error('skill-evaluate-directory-invalid');
    for (let current = path; current !== dirname(current); current = dirname(current)) {
        const entry = stat(current);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            throw new Error('skill-evaluate-directory-invalid');
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}


function regular(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('skill-evaluate-file-invalid');
}


/** Paid evaluation and immutable fixture receipts remain outside Candidate lifecycle and publication. */
export class SkillEvaluateStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #isSessionDeleted: (raw: string) => boolean;
    readonly #sourceCurrent: (plan: SkillEvaluatePlan) => boolean;
    readonly #claims = new WeakSet<object>();
    #closed = false;

    constructor(options: {
        readonly dataDir: string; readonly now?: () => string;
        readonly isSessionDeleted?: (raw: string) => boolean;
        readonly sourceCurrent: (plan: SkillEvaluatePlan) => boolean;
    }) {
        if (typeof options.sourceCurrent !== 'function') throw new Error('skill-evaluate-source-hook-required');
        if (typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
            throw new Error('skill-evaluate-directory-invalid');
        }
        const dataDir = resolve(options.dataDir);
        directory(dataDir);
        const file = join(dataDir, SKILL_EVALUATE_DB_FILE);
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
        this.#sourceCurrent = options.sourceCurrent;
    }

    #open(): void { if (this.#closed) throw new Error('skill-evaluate-store-closed'); }

    #transaction<T>(work: () => T, write = true): T {
        this.#open();
        if (this.#db.isTransaction) throw new Error('skill-evaluate-nested-transaction');
        this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            const result = work();
            if (!this.#db.isTransaction) throw new Error('skill-evaluate-transaction-lost');
            this.#db.exec('COMMIT');
            return result;
        } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    }

    #deleted(raw: string): boolean {
        if (this.#db.prepare('SELECT 1 FROM skill_evaluate_session_tombstone WHERE session_key=?').get(raw)) {
            return true;
        }
        try { return this.#isSessionDeleted(raw) === true; }
        catch { throw new Error('skill-evaluate-source-status-unavailable'); }
    }

    #current(plan: SkillEvaluatePlan): boolean {
        try { return this.#sourceCurrent(plan) === true; } catch { return false; }
    }

    #source(raw: string, plan: SkillEvaluatePlan, current = true): void {
        if (this.#deleted(raw)) throw new Error('skill-evaluate-session-deleted');
        if (current && !this.#current(plan)) throw new Error('skill-evaluate-source-invalidated');
    }

    #quarantined(jobId: string): boolean {
        return !!this.#db.prepare('SELECT 1 FROM skill_evaluate_quarantine WHERE job_id=?').get(jobId);
    }

    #raw(jobId: string): SqlRow | undefined {
        return this.#db.prepare('SELECT * FROM skill_evaluate_job WHERE job_id=?').get(jobId) as SqlRow | undefined;
    }

    #read(jobId: string): SkillEvaluateStoredJob | null {
        const row = this.#raw(jobId);
        if (!row) return null;
        const job = parseJob(row);
        if (this.#deleted(job.rawSessionId)) return null;
        const intent = this.#db.prepare('SELECT * FROM skill_evaluate_intent WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        if (!intent || intent.intent_digest !== job.requestDigest || intent.session_key !== job.rawSessionId
            || intent.created_at !== job.createdAt
            || job.jobId !== hash(['skill-evaluate-job-v1', token(intent.idempotency_key)])) {
            throw new Error('skill-evaluate-intent-corrupt');
        }
        const rowReceipt = this.#db.prepare('SELECT * FROM skill_evaluate_receipt WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        if (!rowReceipt) {
            if (job.receiptDigest !== null || job.state === 'succeeded') {
                throw new Error('skill-evaluate-receipt-missing');
            }
            return Object.freeze({ job, receipt: null });
        }
        if (typeof rowReceipt.packet_json !== 'string' || rowReceipt.packet_json.length > MAX_PACKET_CHARS) {
            throw new Error('skill-evaluate-receipt-invalid');
        }
        const packet = normalizeSkillEvaluatePacket(JSON.parse(rowReceipt.packet_json));
        if (JSON.stringify(packet) !== rowReceipt.packet_json || packet.packetDigest !== rowReceipt.packet_digest
            || packet.packetDigest !== job.receiptDigest || rowReceipt.session_key !== job.rawSessionId
            || packet.jobId !== job.jobId || packet.rawSessionId !== job.rawSessionId
            || packet.jobRequestDigest !== job.requestDigest || packet.planDigest !== skillEvaluatePlanDigest(job.plan)
            || JSON.stringify(packet.plan) !== JSON.stringify(job.plan)
            || packet.modelId !== job.modelId || packet.modelBindingDigest !== job.modelBindingDigest
            || packet.claimDigest !== skillEvaluateClaimDigest(claimOf(job))
            || packet.completedAt < job.claimedAt! || packet.completedAt >= job.leaseExpiresAt!
            || packet.completedAt !== job.updatedAt || job.state !== 'succeeded'
            || packet.receipt.candidateId !== job.plan.candidate.candidateId
            || packet.receipt.bundleDigest !== job.plan.candidate.bundleDigest
            || packet.receipt.expectedCandidateRevision !== job.plan.candidate.revision
            || packet.receipt.promotionEligible !== false || packet.receipt.executionClass !== 'fixture') {
            throw new Error('skill-evaluate-receipt-binding-invalid');
        }
        return Object.freeze({ job, receipt: packet });
    }

    #writeJob(previous: SkillEvaluateJobV1, next: SkillEvaluateJobV1): void {
        const job = normalizeJob(next);
        const changed = this.#db.prepare(`UPDATE skill_evaluate_job
            SET job_json=?,job_digest=?,state=?,revision=?,lease_until=?
            WHERE job_id=? AND revision=? AND job_digest=?`)
            .run(json(job, MAX_JOB_CHARS), hash(job), job.state, job.revision, job.leaseExpiresAt,
                previous.jobId, previous.revision, hash(previous));
        const retained = this.#raw(job.jobId);
        if (Number(changed.changes) !== 1 || !retained || JSON.stringify(parseJob(retained)) !== JSON.stringify(job)) {
            throw new Error('skill-evaluate-job-revision-conflict');
        }
    }

    #quarantine(row: SqlRow, now: string): void {
        if (typeof row.job_id !== 'string' || row.job_id.length > 240) {
            throw new Error('skill-evaluate-quarantine-key-invalid');
        }
        this.#db.prepare(`INSERT INTO skill_evaluate_quarantine(job_id,quarantined_at,reason_code)
            VALUES(?,?,'skill-evaluate-storage-invalid')`).run(row.job_id, now);
        const retained = this.#db.prepare('SELECT * FROM skill_evaluate_quarantine WHERE job_id=?')
            .get(row.job_id) as SqlRow | undefined;
        if (retained?.quarantined_at !== now || retained.reason_code !== 'skill-evaluate-storage-invalid') {
            throw new Error('skill-evaluate-quarantine-storage-mismatch');
        }
    }

    #redact(rawSessionId: string, now: string): void {
        const existing = this.#db.prepare('SELECT * FROM skill_evaluate_session_tombstone WHERE session_key=?')
            .get(rawSessionId) as SqlRow | undefined;
        if (existing) timestamp(existing.redacted_at);
        else this.#db.prepare('INSERT INTO skill_evaluate_session_tombstone(session_key,redacted_at) VALUES(?,?)')
            .run(rawSessionId, now);
        const fence = this.#db.prepare('SELECT * FROM skill_evaluate_session_tombstone WHERE session_key=?')
            .get(rawSessionId) as SqlRow | undefined;
        if (!fence || fence.redacted_at !== (existing?.redacted_at ?? now)) {
            throw new Error('skill-evaluate-redaction-fence-storage-mismatch');
        }
        this.#db.prepare('DELETE FROM skill_evaluate_job WHERE session_key=?').run(rawSessionId);
        for (const table of ['job', 'intent', 'receipt']) {
            if (this.#db.prepare(`SELECT 1 FROM skill_evaluate_${table} WHERE session_key=?`).get(rawSessionId)) {
                throw new Error('skill-evaluate-redaction-storage-mismatch');
            }
        }
    }

    #owned(claim: SkillEvaluateClaimV1, current = true): SkillEvaluateJobV1 {
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-evaluate-claim-brand-invalid');
        const row = this.#raw(claim.jobId);
        if (!row) throw new Error('skill-evaluate-job-missing');
        const job = parseJob(row);
        this.#source(job.rawSessionId, job.plan, current);
        if (this.#quarantined(job.jobId)) throw new Error('skill-evaluate-job-quarantined');
        if (skillEvaluateClaimDigest(claim) !== skillEvaluateClaimDigest(claimOf(job))) {
            throw new Error('skill-evaluate-claim-stale');
        }
        return job;
    }

    enqueue(input: {
        readonly rawSessionId: string; readonly plan: SkillEvaluatePlan; readonly modelId: string;
        readonly modelBindingDigest: string; readonly createdAt: string
    }, idempotencyKey: string): SkillEvaluateJobV1 {
        this.#open();
        const value = record(input);
        exact(value, ['rawSessionId', 'plan', 'modelId', 'modelBindingDigest', 'createdAt']);
        const rawSessionId = session(value.rawSessionId);
        const plan = normalizeSkillEvaluatePlan(value.plan);
        if (plan.compilePacket.rawSessionId !== rawSessionId) throw new Error('skill-evaluate-owner-mismatch');
        const modelId = token(value.modelId);
        const modelBindingDigest = digest(value.modelBindingDigest);
        const createdAt = timestamp(value.createdAt);
        if (createdAt < plan.candidate.updatedAt) throw new Error('skill-evaluate-created-before-candidate');
        const key = token(idempotencyKey);
        const jobId = hash(['skill-evaluate-job-v1', key]);
        const source = { rawSessionId, plan, modelId, modelBindingDigest, createdAt };
        const intentDigest = requestDigest(source);
        if (createdAt > timestamp(this.#now())) throw new Error('skill-evaluate-created-in-future');
        return this.#transaction(() => {
            this.#source(rawSessionId, plan);
            const intent = this.#db.prepare('SELECT * FROM skill_evaluate_intent WHERE idempotency_key=?')
                .get(key) as SqlRow | undefined;
            if (intent) {
                const retained = this.#read(jobId);
                if (!retained) throw new Error('skill-evaluate-intent-source-missing');
                const originalDigest = requestDigest({ ...source, createdAt: retained.job.createdAt });
                if (intent.intent_digest !== originalDigest || intent.job_id !== jobId
                    || intent.session_key !== rawSessionId || intent.created_at !== retained.job.createdAt) {
                    throw new Error('skill-evaluate-idempotency-conflict');
                }
                this.#source(rawSessionId, plan);
                return retained.job;
            }
            const job = normalizeJob({
                jobVersion: 'skill-evaluate-job-v1', jobId, ...source,
                requestDigest: intentDigest, updatedAt: createdAt, state: 'queued', revision: 0, attempt: 0,
                claimRevision: null, ownerId: null, ownerToken: null, claimedAt: null, leaseExpiresAt: null,
                receiptDigest: null, reasonCode: null
            });
            this.#db.prepare(`INSERT INTO skill_evaluate_job
                (job_id,session_key,request_digest,job_json,job_digest,state,revision,lease_until)
                VALUES(?,?,?,?,?,?,?,?)`).run(jobId, rawSessionId, job.requestDigest, json(job, MAX_JOB_CHARS),
                hash(job), job.state, job.revision, null);
            this.#db.prepare(`INSERT INTO skill_evaluate_intent
                (idempotency_key,intent_digest,job_id,session_key,created_at) VALUES(?,?,?,?,?)`)
                .run(key, intentDigest, jobId, rawSessionId, createdAt);
            const retained = this.#read(jobId);
            if (!retained || JSON.stringify(retained.job) !== JSON.stringify(job)) {
                throw new Error('skill-evaluate-enqueue-storage-mismatch');
            }
            this.#source(rawSessionId, plan);
            return retained.job;
        });
    }

    read(jobId: string): SkillEvaluateStoredJob | null {
        digest(jobId);
        return this.#transaction(() => this.#read(jobId), false);
    }

    claimNext(ownerId: string, leaseMs = 30_000): SkillEvaluateClaimV1 | null {
        token(ownerId);
        count(leaseMs, 1, 300_000);
        const now = timestamp(this.#now());
        const claim = this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_evaluate_job WHERE state='queued'
                AND NOT EXISTS(SELECT 1 FROM skill_evaluate_quarantine AS quarantine
                    WHERE quarantine.job_id=skill_evaluate_job.job_id) ORDER BY job_row_id LIMIT 64`).all() as SqlRow[];
            for (const row of rows) {
                if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                    this.#redact(session(row.session_key), now);
                    continue;
                }
                let job: SkillEvaluateJobV1;
                try {
                    job = parseJob(row);
                    if (!this.#read(job.jobId)) throw new Error('skill-evaluate-source-missing');
                } catch { this.#quarantine(row, now); continue; }
                if (now < job.updatedAt) throw new Error('skill-evaluate-clock-regressed');
                if (!this.#current(job.plan)) {
                    this.#writeJob(job, normalizeJob({
                        ...job, state: 'failed', revision: 1, updatedAt: now,
                        reasonCode: 'skill-evaluate-source-invalidated'
                    }));
                    continue;
                }
                this.#source(job.rawSessionId, job.plan);
                const next = normalizeJob({
                    ...job, state: 'running', revision: 1, attempt: 1, claimRevision: 1,
                    ownerId, ownerToken: `evaluate-owner:${randomUUID()}`, claimedAt: now, updatedAt: now,
                    leaseExpiresAt: timestamp(new Date(Date.parse(now) + leaseMs).toISOString())
                });
                this.#writeJob(job, next);
                this.#source(job.rawSessionId, job.plan);
                return claimOf(next);
            }
            return null;
        });
        if (claim) this.#claims.add(claim);
        return claim;
    }

    finish(claim: SkillEvaluateClaimV1, proof: unknown): SkillEvaluateStoredJob {
        this.#open();
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-evaluate-claim-brand-invalid');
        const packet = readSkillEvaluateProof(proof);
        if (packet.jobId !== claim.jobId || packet.rawSessionId !== claim.rawSessionId
            || packet.jobRequestDigest !== claim.requestDigest || packet.claimDigest !== skillEvaluateClaimDigest(claim)
            || packet.modelId !== claim.modelId || packet.modelBindingDigest !== claim.modelBindingDigest
            || packet.planDigest !== skillEvaluatePlanDigest(claim.plan)
            || JSON.stringify(packet.plan) !== JSON.stringify(claim.plan)
            || packet.completedAt < claim.claimedAt || packet.completedAt >= claim.leaseExpiresAt
            || packet.receipt.promotionEligible !== false || packet.receipt.executionClass !== 'fixture') {
            throw new Error('skill-evaluate-proof-binding-mismatch');
        }
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const job = this.#owned(claim);
            const source = this.#read(job.jobId);
            if (!source) throw new Error('skill-evaluate-source-missing');
            if (source.receipt) {
                if (JSON.stringify(source.receipt) !== JSON.stringify(packet)) {
                    throw new Error('skill-evaluate-receipt-conflict');
                }
                this.#source(job.rawSessionId, job.plan);
                return source;
            }
            if (job.state !== 'running' || job.revision !== claim.revision
                || now >= claim.leaseExpiresAt || now < packet.completedAt) {
                throw new Error('skill-evaluate-claim-stale');
            }
            this.#db.prepare(`INSERT INTO skill_evaluate_receipt(job_id,session_key,packet_json,packet_digest)
                VALUES(?,?,?,?)`).run(job.jobId, job.rawSessionId, json(packet, MAX_PACKET_CHARS), packet.packetDigest);
            this.#writeJob(job, normalizeJob({
                ...job, state: 'succeeded', revision: job.revision + 1,
                updatedAt: packet.completedAt, receiptDigest: packet.packetDigest
            }));
            const retained = this.#read(job.jobId);
            if (!retained || JSON.stringify(retained.receipt) !== JSON.stringify(packet)) {
                throw new Error('skill-evaluate-finish-storage-mismatch');
            }
            this.#source(job.rawSessionId, job.plan);
            return retained;
        });
    }

    markFailed(claim: SkillEvaluateClaimV1, reason: SkillEvaluateFailureReason): SkillEvaluateJobV1 {
        if (!SKILL_EVALUATE_FAILURE_REASONS.includes(reason)) throw new Error('skill-evaluate-failure-reason-invalid');
        return this.#transaction(() => {
            const job = this.#owned(claim, false);
            if (job.state === 'failed' && job.reasonCode === reason) return job;
            if (job.state !== 'running' || job.revision !== claim.revision) {
                throw new Error('skill-evaluate-claim-stale');
            }
            const now = timestamp(this.#now());
            if (now < job.updatedAt) throw new Error('skill-evaluate-clock-regressed');
            const next = normalizeJob({
                ...job, state: 'failed', revision: job.revision + 1, updatedAt: now,
                reasonCode: reason
            });
            this.#writeJob(job, next);
            this.#source(job.rawSessionId, job.plan, false);
            return next;
        });
    }

    /** Startup-only conservative recovery. An unrecorded model result is never permission to dispatch again. */
    recoverUncertain(): number {
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_evaluate_job WHERE state='running'
                AND NOT EXISTS(SELECT 1 FROM skill_evaluate_quarantine AS quarantine
                    WHERE quarantine.job_id=skill_evaluate_job.job_id) ORDER BY job_row_id LIMIT 64`).all() as SqlRow[];
            let recovered = 0;
            for (const row of rows) {
                if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                    this.#redact(session(row.session_key), now);
                    continue;
                }
                let job: SkillEvaluateJobV1;
                try {
                    job = parseJob(row);
                    if (!this.#read(job.jobId)) throw new Error('skill-evaluate-source-missing');
                } catch {
                    this.#quarantine(row, now);
                    continue;
                }
                this.#source(job.rawSessionId, job.plan, false);
                if (now < job.updatedAt) throw new Error('skill-evaluate-clock-regressed');
                this.#writeJob(job, normalizeJob({
                    ...job, state: 'uncertain', revision: job.revision + 1,
                    updatedAt: now, reasonCode: 'skill-evaluate-restart-uncertain'
                }));
                recovered += 1;
            }
            return recovered;
        });
    }

    status(): Readonly<{ queued: number; running: number }> {
        this.#open();
        const row = this.#db.prepare(`SELECT COALESCE(SUM(state='queued'),0) AS queued,
            COALESCE(SUM(state='running'),0) AS running FROM skill_evaluate_job
            WHERE NOT EXISTS(SELECT 1 FROM skill_evaluate_quarantine AS quarantine
                WHERE quarantine.job_id=skill_evaluate_job.job_id)
                AND NOT EXISTS(SELECT 1 FROM skill_evaluate_session_tombstone AS tombstone
                    WHERE tombstone.session_key=skill_evaluate_job.session_key)`).get() as SqlRow;
        return Object.freeze({ queued: count(row.queued), running: count(row.running) });
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
