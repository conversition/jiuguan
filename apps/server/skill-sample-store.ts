/** @author Codex @date 2026-10-16 @version 1.0
 * One paid two-arm sampling attempt and reproducible offline observations, never quality or promotion authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteTransaction } from './sqlite-transaction.ts';
import { types as nodeTypes } from 'node:util';
import {
    normalizeSkillSampleExecutionPlan, skillSampleExecutionPlanDigest, skillSampleClaimDigest,
    normalizeSkillSamplePacket, readSkillSampleExecution, readSkillSampleProof,
} from './skill-sample-model.ts';
import {
    normalizeSkillSampleExecution, verifySkillSampleExecution, type SkillSampleExecution,
} from './skill-sample-execution.ts';
import { evaluateSkillSampleOffline, type SkillSampleOfflineReceipt } from './skill-sample-offline.ts';
import {
    normalizeSkillSamplePlan, normalizeSkillSampleSuitePlans, SKILL_SAMPLE_SUITE_PAIR_COUNT,
    SKILL_SAMPLE_SUITE_REPEAT_COUNT, SKILL_SAMPLE_SUITE_PLAN_VERSION, SKILL_SAMPLE_SUITE_SCENARIO_COUNT,
    type SkillSamplePlan as SkillSampleBasePlan, type SkillSampleSuitePlan,
} from './skill-sample-registry.ts';
import {
    evaluateSkillSampleSuiteOffline, type SkillSampleSuiteOfflineReceipt,
} from './skill-sample-suite-offline.ts';
export const SKILL_SAMPLE_DB_FILE = 'agent-skill-samples.sqlite';
export const SKILL_SAMPLE_SCHEMA_VERSION = 2;
export const SKILL_SAMPLE_APPLICATION_ID = 0x4a475350;
export const SKILL_SAMPLE_FAILURE_REASONS = Object.freeze([
    'skill-sample-model-failed', 'skill-sample-admission-denied',
    'skill-sample-result-invalid', 'skill-sample-source-invalidated', 'skill-sample-persistence-unconfirmed',
    'skill-sample-suite-incomplete', 'skill-sample-dispatch-evidence-unavailable',
] as const);
export type SkillSampleFailureReason = typeof SKILL_SAMPLE_FAILURE_REASONS[number];
type SkillSamplePlan = ReturnType<typeof normalizeSkillSampleExecutionPlan>;
export type SkillSamplePacket = ReturnType<typeof normalizeSkillSamplePacket>;

export interface SkillSampleClaimV1 {
    readonly claimVersion: 'skill-sample-claim-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly plan: SkillSamplePlan;
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

export interface SkillSampleJobV1 {
    readonly jobVersion: 'skill-sample-job-v1';
    readonly jobId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly plan: SkillSamplePlan;
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
    readonly reasonCode: SkillSampleFailureReason | 'skill-sample-restart-uncertain' | null;
}

export interface SkillSampleStoredJob {
    readonly job: SkillSampleJobV1;
    readonly packet: SkillSamplePacket | null;
    readonly evaluation: SkillSampleOfflineReceipt | null;
    /** D-Q3a2b2b：品牌 dispatch 路径的 24 坐标执行证据；非品牌路径为 null。 */
    readonly execution: SkillSampleExecution | null;
}

export interface SkillSampleStoredSuite {
    readonly suiteId: string;
    readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
    readonly plans: readonly SkillSampleSuitePlan[];
    readonly jobs: readonly SkillSampleStoredJob[];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly evaluation: SkillSampleSuiteOfflineReceipt | null;
}

type SqlRow = Record<string, unknown>;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_JOB_CHARS = 65_536;
const MAX_PACKET_CHARS = 262_144;
const MAX_EXECUTION_CHARS = 262_144;
/** v1：单臂正文 packet 与离线观测；升级到 v2 只追加执行证据表，不改既有行。 */
const SCHEMA_V1 = Object.freeze([
    `CREATE TABLE skill_sample_job (
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
    `CREATE TABLE skill_sample_intent (
        idempotency_key TEXT NOT NULL PRIMARY KEY,
        intent_digest TEXT NOT NULL CHECK(length(intent_digest)=71),
        job_id TEXT NOT NULL UNIQUE REFERENCES skill_sample_job(job_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_sample_receipt (
        packet_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE REFERENCES skill_sample_job(job_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        packet_json TEXT NOT NULL CHECK(json_valid(packet_json) AND length(packet_json)<=262144),
        packet_digest TEXT NOT NULL CHECK(length(packet_digest)=71),
        evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json) AND length(evaluation_json)<=65536),
        evaluation_digest TEXT NOT NULL CHECK(length(evaluation_digest)=71)
    )`,
    `CREATE TABLE skill_sample_quarantine (
        job_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_sample_job(job_id) ON DELETE CASCADE,
        quarantined_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK(reason_code='skill-sample-storage-invalid')
    )`,
    `CREATE TABLE skill_sample_session_tombstone (
        session_key TEXT NOT NULL PRIMARY KEY,
        redacted_at TEXT NOT NULL
    )`,
    'CREATE INDEX skill_sample_job_state ON skill_sample_job(state,job_row_id)',
    'CREATE INDEX skill_sample_job_session ON skill_sample_job(session_key)',
    ...['intent', 'receipt', 'quarantine', 'session_tombstone'].map((name) =>
        `CREATE TRIGGER skill_sample_${name}_no_update BEFORE UPDATE ON skill_sample_${name}
            BEGIN SELECT RAISE(ABORT,'skill sample immutable packet'); END`),
    `CREATE TRIGGER skill_sample_session_tombstone_no_delete BEFORE DELETE ON skill_sample_session_tombstone
        BEGIN SELECT RAISE(ABORT,'skill sample permanent deletion fence'); END`,
]);
/**
 * v2（D-Q3a2b2b）：每个 Sample 坐标一条执行证据，显式绑定 Sample/Candidate 两种
 * response 摘要与 Gateway lease audit。只追加、不改写；随 job 删除级联清除。
 */
const SCHEMA_V2_ADDITIONS = Object.freeze([
    `CREATE TABLE skill_sample_execution (
        job_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_sample_job(job_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        execution_json TEXT NOT NULL CHECK(json_valid(execution_json) AND length(execution_json)<=262144),
        execution_digest TEXT NOT NULL CHECK(length(execution_digest)=71)
    )`,
    `CREATE TRIGGER skill_sample_execution_no_update BEFORE UPDATE ON skill_sample_execution
        BEGIN SELECT RAISE(ABORT,'skill sample immutable packet'); END`,
]);
const SCHEMA = Object.freeze([...SCHEMA_V1, ...SCHEMA_V2_ADDITIONS]);


function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}


function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('skill-sample-time-invalid');
    return value;
}


function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new Error('skill-sample-count-invalid');
    }
    return Number(value);
}


function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('skill-sample-token-invalid');
    return value;
}


/** Public instance identity is derived from the root idempotency key; the key itself is never exposed. */
export function skillSampleSuiteId(idempotencyKey: string): string {
    return hash(['skill-sample-suite-run-v1', token(idempotencyKey)]);
}


function skillSampleSuiteChildKey(suiteId: string, scenarioOrdinal: number, repeatIndex: number): string {
    return `sample-suite:${digest(suiteId).slice('sha256:'.length)}:${count(scenarioOrdinal)}:${count(repeatIndex)}`;
}


export function skillSampleSuiteChildJobId(
    suiteId: string,
    scenarioOrdinal: number,
    repeatIndex: number,
): string {
    if (scenarioOrdinal >= SKILL_SAMPLE_SUITE_SCENARIO_COUNT
        || repeatIndex >= SKILL_SAMPLE_SUITE_REPEAT_COUNT) {
        throw new Error('skill-sample-suite-coordinate-invalid');
    }
    return hash(['skill-sample-job-v1', skillSampleSuiteChildKey(suiteId, scenarioOrdinal, repeatIndex)]);
}


function session(value: unknown): string {
    if (typeof value !== 'string' || !SESSION.test(value)) throw new Error('skill-sample-session-invalid');
    return value;
}


function digest(value: unknown): string {
    if (typeof value !== 'string' || !HASH.test(value)) throw new Error('skill-sample-digest-invalid');
    return value;
}


function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('skill-sample-data-invalid');
    }
    if (Reflect.ownKeys(input).length !== Object.keys(input).length) throw new Error('skill-sample-fields-invalid');
    for (const key of Object.keys(input)) {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) {
            throw new Error('skill-sample-fields-invalid');
        }
    }
    return input as Record<string, unknown>;
}


function exact(value: Record<string, unknown>, keys: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new Error('skill-sample-fields-invalid');
    }
}


function json(value: unknown, maximum: number): string {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > maximum) throw new Error('skill-sample-packet-too-large');
    return text;
}


function requestDigest(input: {
    rawSessionId: string; plan: SkillSamplePlan; modelId: string;
    modelBindingDigest: string; createdAt: string
}): string {
    return hash({
        requestVersion: 'skill-sample-request-v1', rawSessionId: input.rawSessionId,
        planDigest: skillSampleExecutionPlanDigest(input.plan), modelId: input.modelId,
        modelBindingDigest: input.modelBindingDigest, createdAt: input.createdAt
    });
}


function normalizeJob(input: unknown): SkillSampleJobV1 {
    const value = record(input);
    exact(value, ['jobVersion', 'jobId', 'rawSessionId', 'requestDigest', 'plan', 'modelId', 'modelBindingDigest',
        'createdAt', 'updatedAt', 'state', 'revision', 'attempt', 'claimRevision', 'ownerId', 'ownerToken',
        'claimedAt', 'leaseExpiresAt', 'receiptDigest', 'reasonCode']);
    const job: SkillSampleJobV1 = Object.freeze({
        jobVersion: 'skill-sample-job-v1', jobId: digest(value.jobId), rawSessionId: session(value.rawSessionId),
        requestDigest: digest(value.requestDigest), plan: normalizeSkillSampleExecutionPlan(value.plan),
        modelId: token(value.modelId), modelBindingDigest: digest(value.modelBindingDigest),
        createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt),
        state: value.state as SkillSampleJobV1['state'], revision: count(value.revision),
        attempt: count(value.attempt, 0, 1) as 0 | 1,
        claimRevision: value.claimRevision === null ? null : count(value.claimRevision, 1),
        ownerId: value.ownerId === null ? null : token(value.ownerId),
        ownerToken: value.ownerToken === null ? null : token(value.ownerToken),
        claimedAt: value.claimedAt === null ? null : timestamp(value.claimedAt),
        leaseExpiresAt: value.leaseExpiresAt === null ? null : timestamp(value.leaseExpiresAt),
        receiptDigest: value.receiptDigest === null ? null : digest(value.receiptDigest),
        reasonCode: value.reasonCode as SkillSampleJobV1['reasonCode'],
    });
    if (value.jobVersion !== job.jobVersion || job.requestDigest !== requestDigest(job)
        || job.rawSessionId !== job.plan.source.compilePacket.rawSessionId || job.updatedAt < job.createdAt
        || !['queued', 'running', 'succeeded', 'failed', 'uncertain'].includes(job.state)
        || job.reasonCode !== null && ![...SKILL_SAMPLE_FAILURE_REASONS, 'skill-sample-restart-uncertain']
            .includes(job.reasonCode)) throw new Error('skill-sample-job-invalid');
    const emptyOwner = job.ownerId === null && job.ownerToken === null && job.claimedAt === null
        && job.leaseExpiresAt === null && job.claimRevision === null;
    if (job.attempt === 0) {
        if (!emptyOwner || job.receiptDigest !== null || !(job.state === 'queued' && job.revision === 0
            && job.reasonCode === null || job.state === 'failed' && job.revision === 1
            && ['skill-sample-source-invalidated', 'skill-sample-suite-incomplete']
                .includes(job.reasonCode ?? ''))) throw new Error('skill-sample-job-invalid');
        return job;
    }
    if (emptyOwner || job.ownerId === null || job.ownerToken === null || job.claimedAt === null
        || job.leaseExpiresAt === null || job.claimRevision !== 1 || job.claimedAt < job.createdAt
        || job.updatedAt < job.claimedAt || job.leaseExpiresAt <= job.claimedAt
        || job.state === 'running' && (job.revision !== 1 || job.updatedAt !== job.claimedAt || job.reasonCode !== null)
        || job.state !== 'running' && (job.revision !== 2 || job.state === 'queued')
        || job.state === 'succeeded' && (job.receiptDigest === null || job.reasonCode !== null)
        || job.state !== 'succeeded' && job.receiptDigest !== null
        || job.state === 'uncertain' && job.reasonCode !== 'skill-sample-restart-uncertain'
        || job.state === 'failed' && !SKILL_SAMPLE_FAILURE_REASONS.includes(
            job.reasonCode as SkillSampleFailureReason)) throw new Error('skill-sample-job-state-invalid');
    return job;
}


function parseJob(row: SqlRow): SkillSampleJobV1 {
    if (typeof row.job_json !== 'string' || row.job_json.length > MAX_JOB_CHARS) {
        throw new Error('skill-sample-job-packet-invalid');
    }
    const job = normalizeJob(JSON.parse(row.job_json));
    if (JSON.stringify(job) !== row.job_json || hash(job) !== row.job_digest || job.jobId !== row.job_id
        || job.rawSessionId !== row.session_key || job.requestDigest !== row.request_digest
        || job.state !== row.state || job.revision !== row.revision || job.leaseExpiresAt !== row.lease_until) {
        throw new Error('skill-sample-job-corrupt');
    }
    return job;
}


function claimOf(job: SkillSampleJobV1): SkillSampleClaimV1 {
    if (job.attempt !== 1 || job.ownerId === null || job.ownerToken === null || job.claimedAt === null
        || job.leaseExpiresAt === null || job.claimRevision === null) throw new Error('skill-sample-claim-missing');
    return Object.freeze({
        claimVersion: 'skill-sample-claim-v1', jobId: job.jobId, rawSessionId: job.rawSessionId,
        requestDigest: job.requestDigest, plan: job.plan, modelId: job.modelId,
        modelBindingDigest: job.modelBindingDigest,
        createdAt: job.createdAt, ownerId: job.ownerId, ownerToken: job.ownerToken, attempt: 1,
        revision: job.claimRevision, claimedAt: job.claimedAt, leaseExpiresAt: job.leaseExpiresAt
    });
}


function schemaSql(db: DatabaseSync): string[] {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SqlRow[])
        .map((row) => {
            if (typeof row.sql !== 'string') throw new Error('skill-sample-schema-invalid');
            return row.sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
        }).sort();
}


function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
    return count((db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key]);
}


function normalizeSchema(statements: readonly string[]): string[] {
    return statements.map((item) => item.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
}


export function inspectSkillSampleSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== SKILL_SAMPLE_APPLICATION_ID
        || pragma(db, 'user_version') !== SKILL_SAMPLE_SCHEMA_VERSION) {
        throw new Error('skill-sample-metadata-mismatch');
    }
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(normalizeSchema(SCHEMA))) {
        throw new Error('skill-sample-schema-mismatch');
    }
}


/** v1 → v2：只追加执行证据表与不可变触发器，既有行一个字节都不改。 */
function migrateV1ToV2(db: DatabaseSync): void {
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(normalizeSchema(SCHEMA_V1))) {
        throw new Error('skill-sample-schema-mismatch');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const statement of SCHEMA_V2_ADDITIONS) db.exec(statement);
        db.exec(`PRAGMA user_version=${SKILL_SAMPLE_SCHEMA_VERSION}`);
        inspectSkillSampleSchema(db);
        db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}


function initialize(db: DatabaseSync): void {
    const applicationId = pragma(db, 'application_id');
    const version = pragma(db, 'user_version');
    if (applicationId || version) {
        if (applicationId !== SKILL_SAMPLE_APPLICATION_ID) throw new Error('skill-sample-metadata-mismatch');
        if (version === 1) migrateV1ToV2(db);
        inspectSkillSampleSchema(db);
        return;
    }
    if (schemaSql(db).length) throw new Error('skill-sample-uninitialized-not-empty');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${SKILL_SAMPLE_APPLICATION_ID}`);
        for (const statement of SCHEMA) db.exec(statement);
        db.exec(`PRAGMA user_version=${SKILL_SAMPLE_SCHEMA_VERSION}`);
        inspectSkillSampleSchema(db);
        db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}


function stat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}


function directory(path: string): void {
    if (path === parse(path).root) throw new Error('skill-sample-directory-invalid');
    for (let current = path; current !== dirname(current); current = dirname(current)) {
        const entry = stat(current);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            throw new Error('skill-sample-directory-invalid');
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}


function regular(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('skill-sample-file-invalid');
}


/** Complete dual-arm samples and body-free offline observations stay outside Candidate lifecycle and publication. */
export class SkillSampleStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #isSessionDeleted: (raw: string) => boolean;
    readonly #sourceCurrent: (plan: SkillSamplePlan) => boolean;
    readonly #claims = new WeakSet<object>();
    #claimScanAfter = 0;
    #claimScanHorizon = 0;
    #claimScanDeferred = false;
    #closed = false;

    constructor(options: {
        readonly dataDir: string; readonly now?: () => string;
        readonly isSessionDeleted?: (raw: string) => boolean;
        readonly sourceCurrent: (plan: SkillSamplePlan) => boolean;
    }) {
        if (typeof options.sourceCurrent !== 'function') throw new Error('skill-sample-source-hook-required');
        if (typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
            throw new Error('skill-sample-directory-invalid');
        }
        const dataDir = resolve(options.dataDir);
        directory(dataDir);
        const file = join(dataDir, SKILL_SAMPLE_DB_FILE);
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

    #open(): void { if (this.#closed) throw new Error('skill-sample-store-closed'); }

    #transaction<T>(work: () => T, write = true): T {
        this.#open();
        return sqliteTransaction(this.#db, work, write, 'skill-sample');
    }

    #deleted(raw: string): boolean {
        if (this.#db.prepare('SELECT 1 FROM skill_sample_session_tombstone WHERE session_key=?').get(raw)) {
            return true;
        }
        try { return this.#isSessionDeleted(raw) === true; }
        catch { throw new Error('skill-sample-source-status-unavailable'); }
    }

    #current(plan: SkillSamplePlan): boolean {
        try { return this.#sourceCurrent(plan) === true; } catch { return false; }
    }

    #source(raw: string, plan: SkillSamplePlan, current = true): void {
        if (this.#deleted(raw)) throw new Error('skill-sample-session-deleted');
        if (current && !this.#current(plan)) throw new Error('skill-sample-source-invalidated');
    }

    #quarantined(jobId: string): boolean {
        return !!this.#db.prepare('SELECT 1 FROM skill_sample_quarantine WHERE job_id=?').get(jobId);
    }

    #raw(jobId: string): SqlRow | undefined {
        return this.#db.prepare('SELECT * FROM skill_sample_job WHERE job_id=?').get(jobId) as SqlRow | undefined;
    }

    #read(jobId: string): SkillSampleStoredJob | null {
        const row = this.#raw(jobId);
        if (!row) return null;
        const job = parseJob(row);
        if (this.#deleted(job.rawSessionId)) return null;
        const intent = this.#db.prepare('SELECT * FROM skill_sample_intent WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        if (!intent || intent.intent_digest !== job.requestDigest || intent.session_key !== job.rawSessionId
            || intent.created_at !== job.createdAt
            || job.jobId !== hash(['skill-sample-job-v1', token(intent.idempotency_key)])) {
            throw new Error('skill-sample-intent-corrupt');
        }
        const rowReceipt = this.#db.prepare('SELECT * FROM skill_sample_receipt WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        if (!rowReceipt) {
            if (job.receiptDigest !== null || job.state === 'succeeded') {
                throw new Error('skill-sample-receipt-missing');
            }
            return Object.freeze({ job, packet: null, evaluation: null, execution: null });
        }
        if (typeof rowReceipt.packet_json !== 'string' || rowReceipt.packet_json.length > MAX_PACKET_CHARS) {
            throw new Error('skill-sample-receipt-invalid');
        }
        const packet = normalizeSkillSamplePacket(JSON.parse(rowReceipt.packet_json));
        if (JSON.stringify(packet) !== rowReceipt.packet_json || packet.packetDigest !== rowReceipt.packet_digest
            || packet.packetDigest !== job.receiptDigest || rowReceipt.session_key !== job.rawSessionId
            || packet.jobId !== job.jobId || packet.rawSessionId !== job.rawSessionId
            || packet.jobRequestDigest !== job.requestDigest
            || packet.planDigest !== skillSampleExecutionPlanDigest(job.plan)
            || JSON.stringify(packet.plan) !== JSON.stringify(job.plan)
            || packet.modelId !== job.modelId || packet.modelBindingDigest !== job.modelBindingDigest
            || packet.claimDigest !== skillSampleClaimDigest(claimOf(job))
            || packet.completedAt < job.claimedAt! || packet.completedAt >= job.leaseExpiresAt!
            || packet.completedAt !== job.updatedAt || job.state !== 'succeeded'
            || packet.arms.length !== 2 || packet.arms[0]?.variant !== 'baseline'
            || packet.arms[1]?.variant !== 'candidate') {
            throw new Error('skill-sample-receipt-binding-invalid');
        }
        if (typeof rowReceipt.evaluation_json !== 'string' || rowReceipt.evaluation_json.length > 65_536) {
            throw new Error('skill-sample-offline-packet-invalid');
        }
        const evaluation = evaluateSkillSampleOffline(packet);
        if (JSON.stringify(evaluation) !== rowReceipt.evaluation_json
            || evaluation.evidenceDigest !== rowReceipt.evaluation_digest
            || evaluation.sourcePacketDigest !== packet.packetDigest) {
            throw new Error('skill-sample-offline-packet-mismatch');
        }
        const rowExecution = this.#db.prepare('SELECT * FROM skill_sample_execution WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        let execution: SkillSampleExecution | null = null;
        if (rowExecution) {
            if (typeof rowExecution.execution_json !== 'string'
                || rowExecution.execution_json.length > MAX_EXECUTION_CHARS
                || rowExecution.session_key !== job.rawSessionId) {
                throw new Error('skill-sample-execution-invalid');
            }
            execution = normalizeSkillSampleExecution(JSON.parse(rowExecution.execution_json));
            if (JSON.stringify(execution) !== rowExecution.execution_json
                || execution.executionDigest !== rowExecution.execution_digest) {
                throw new Error('skill-sample-execution-mismatch');
            }
            try { verifySkillSampleExecution(execution, packet); }
            catch { throw new Error('skill-sample-execution-binding-invalid'); }
        }
        return Object.freeze({ job, packet, evaluation, execution });
    }

    #readSuite(suiteId: string): SkillSampleStoredSuite | null {
        const retained: Array<SkillSampleStoredJob | null> = [];
        for (let scenarioOrdinal = 0; scenarioOrdinal < SKILL_SAMPLE_SUITE_SCENARIO_COUNT; scenarioOrdinal += 1) {
            for (let repeatIndex = 0; repeatIndex < SKILL_SAMPLE_SUITE_REPEAT_COUNT; repeatIndex += 1) {
                retained.push(this.#read(skillSampleSuiteChildJobId(suiteId, scenarioOrdinal, repeatIndex)));
            }
        }
        if (retained.every((item) => item === null)) return null;
        if (retained.some((item) => item === null)) throw new Error('skill-sample-suite-matrix-missing');
        const jobs = retained as SkillSampleStoredJob[];
        const plans = normalizeSkillSampleSuitePlans(jobs.map((item) => item.job.plan));
        const first = jobs[0]!.job;
        if (plans[0]!.suite.suiteId !== suiteId || jobs.length !== SKILL_SAMPLE_SUITE_PAIR_COUNT
            || jobs.some((item, index) =>
                item.job.jobId !== skillSampleSuiteChildJobId(
                    suiteId,
                    plans[index]!.suite.scenarioOrdinal,
                    plans[index]!.suite.repeatIndex,
                )
                || item.job.rawSessionId !== first.rawSessionId
                || item.job.modelId !== first.modelId
                || item.job.modelBindingDigest !== first.modelBindingDigest
                || item.job.createdAt !== first.createdAt)) {
            throw new Error('skill-sample-suite-binding-invalid');
        }
        const states = jobs.map((item) => item.job.state);
        const succeeded = states.every((state) => state === 'succeeded');
        const state: SkillSampleStoredSuite['state'] = succeeded ? 'succeeded'
            : states.some((item) => item === 'uncertain') ? 'uncertain'
                : states.some((item) => item === 'failed') ? 'failed'
                    : states.some((item) => item === 'running' || item === 'succeeded') ? 'running' : 'queued';
        const packets = succeeded ? jobs.map((item) => {
            if (!item.packet) throw new Error('skill-sample-suite-packet-missing');
            return item.packet;
        }) : [];
        const evaluation = succeeded ? evaluateSkillSampleSuiteOffline(packets) : null;
        return Object.freeze({
            suiteId, state, plans, jobs: Object.freeze(jobs),
            createdAt: first.createdAt,
            updatedAt: [...jobs.map((item) => item.job.updatedAt)].sort().at(-1)!,
            evaluation,
        });
    }

    #closeSuiteQueued(suiteId: string, now: string): number {
        const stored = this.#readSuite(suiteId);
        if (!stored || !['failed', 'uncertain'].includes(stored.state)) return 0;
        let closed = 0;
        for (const item of stored.jobs) {
            const job = item.job;
            if (job.state !== 'queued') continue;
            if (now < job.updatedAt) throw new Error('skill-sample-clock-regressed');
            const next = normalizeJob({
                ...job, state: 'failed', revision: 1, updatedAt: now,
                reasonCode: 'skill-sample-suite-incomplete'
            });
            this.#writeJob(job, next);
            closed += 1;
        }
        return closed;
    }

    #writeJob(previous: SkillSampleJobV1, next: SkillSampleJobV1): void {
        const job = normalizeJob(next);
        const changed = this.#db.prepare(`UPDATE skill_sample_job
            SET job_json=?,job_digest=?,state=?,revision=?,lease_until=?
            WHERE job_id=? AND revision=? AND job_digest=?`)
            .run(json(job, MAX_JOB_CHARS), hash(job), job.state, job.revision, job.leaseExpiresAt,
                previous.jobId, previous.revision, hash(previous));
        const retained = this.#raw(job.jobId);
        if (Number(changed.changes) !== 1 || !retained || JSON.stringify(parseJob(retained)) !== JSON.stringify(job)) {
            throw new Error('skill-sample-job-revision-conflict');
        }
    }

    #quarantine(row: SqlRow, now: string): void {
        if (typeof row.job_id !== 'string' || row.job_id.length > 240) {
            throw new Error('skill-sample-quarantine-key-invalid');
        }
        this.#db.prepare(`INSERT INTO skill_sample_quarantine(job_id,quarantined_at,reason_code)
            VALUES(?,?,'skill-sample-storage-invalid')`).run(row.job_id, now);
        const retained = this.#db.prepare('SELECT * FROM skill_sample_quarantine WHERE job_id=?')
            .get(row.job_id) as SqlRow | undefined;
        if (retained?.quarantined_at !== now || retained.reason_code !== 'skill-sample-storage-invalid') {
            throw new Error('skill-sample-quarantine-storage-mismatch');
        }
    }

    #redact(rawSessionId: string, now: string): void {
        const existing = this.#db.prepare('SELECT * FROM skill_sample_session_tombstone WHERE session_key=?')
            .get(rawSessionId) as SqlRow | undefined;
        if (existing) timestamp(existing.redacted_at);
        else this.#db.prepare('INSERT INTO skill_sample_session_tombstone(session_key,redacted_at) VALUES(?,?)')
            .run(rawSessionId, now);
        const fence = this.#db.prepare('SELECT * FROM skill_sample_session_tombstone WHERE session_key=?')
            .get(rawSessionId) as SqlRow | undefined;
        if (!fence || fence.redacted_at !== (existing?.redacted_at ?? now)) {
            throw new Error('skill-sample-redaction-fence-storage-mismatch');
        }
        this.#db.prepare('DELETE FROM skill_sample_job WHERE session_key=?').run(rawSessionId);
        for (const table of ['job', 'intent', 'receipt', 'execution']) {
            if (this.#db.prepare(`SELECT 1 FROM skill_sample_${table} WHERE session_key=?`).get(rawSessionId)) {
                throw new Error('skill-sample-redaction-storage-mismatch');
            }
        }
    }

    #owned(claim: SkillSampleClaimV1, current = true): SkillSampleJobV1 {
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-sample-claim-brand-invalid');
        const row = this.#raw(claim.jobId);
        if (!row) throw new Error('skill-sample-job-missing');
        const job = parseJob(row);
        this.#source(job.rawSessionId, job.plan, current);
        if (this.#quarantined(job.jobId)) throw new Error('skill-sample-job-quarantined');
        if (skillSampleClaimDigest(claim) !== skillSampleClaimDigest(claimOf(job))) {
            throw new Error('skill-sample-claim-stale');
        }
        return job;
    }

    #enqueuePrepared(source: {
        readonly rawSessionId: string; readonly plan: SkillSamplePlan; readonly modelId: string;
        readonly modelBindingDigest: string; readonly createdAt: string;
    }, key: string): SkillSampleJobV1 {
        const { rawSessionId, plan, modelId, modelBindingDigest, createdAt } = source;
        this.#source(rawSessionId, plan);
        const jobId = hash(['skill-sample-job-v1', key]);
        const intentDigest = requestDigest(source);
        const intent = this.#db.prepare('SELECT * FROM skill_sample_intent WHERE idempotency_key=?')
            .get(key) as SqlRow | undefined;
        if (intent) {
            const retained = this.#read(jobId);
            if (!retained) throw new Error('skill-sample-intent-source-missing');
            const originalDigest = requestDigest({ ...source, createdAt: retained.job.createdAt });
            if (intent.intent_digest !== originalDigest || intent.job_id !== jobId
                || intent.session_key !== rawSessionId || intent.created_at !== retained.job.createdAt) {
                throw new Error('skill-sample-idempotency-conflict');
            }
            this.#source(rawSessionId, plan);
            return retained.job;
        }
        const job = normalizeJob({
            jobVersion: 'skill-sample-job-v1', jobId, ...source,
            requestDigest: intentDigest, updatedAt: createdAt, state: 'queued', revision: 0, attempt: 0,
            claimRevision: null, ownerId: null, ownerToken: null, claimedAt: null, leaseExpiresAt: null,
            receiptDigest: null, reasonCode: null
        });
        this.#db.prepare(`INSERT INTO skill_sample_job
            (job_id,session_key,request_digest,job_json,job_digest,state,revision,lease_until)
            VALUES(?,?,?,?,?,?,?,?)`).run(jobId, rawSessionId, job.requestDigest, json(job, MAX_JOB_CHARS),
            hash(job), job.state, job.revision, null);
        this.#db.prepare(`INSERT INTO skill_sample_intent
            (idempotency_key,intent_digest,job_id,session_key,created_at) VALUES(?,?,?,?,?)`)
            .run(key, intentDigest, jobId, rawSessionId, createdAt);
        const retained = this.#read(jobId);
        if (!retained || JSON.stringify(retained.job) !== JSON.stringify(job)) {
            throw new Error('skill-sample-enqueue-storage-mismatch');
        }
        this.#source(rawSessionId, plan);
        return retained.job;
    }

    enqueue(input: {
        readonly rawSessionId: string; readonly plan: SkillSampleBasePlan; readonly modelId: string;
        readonly modelBindingDigest: string; readonly createdAt: string
    }, idempotencyKey: string): SkillSampleJobV1 {
        this.#open();
        const value = record(input);
        exact(value, ['rawSessionId', 'plan', 'modelId', 'modelBindingDigest', 'createdAt']);
        const rawSessionId = session(value.rawSessionId);
        const plan = normalizeSkillSamplePlan(value.plan);
        if (plan.source.compilePacket.rawSessionId !== rawSessionId) throw new Error('skill-sample-owner-mismatch');
        const modelId = token(value.modelId);
        const modelBindingDigest = digest(value.modelBindingDigest);
        const createdAt = timestamp(value.createdAt);
        if (createdAt < plan.source.candidate.updatedAt) throw new Error('skill-sample-created-before-candidate');
        const key = token(idempotencyKey);
        const source = { rawSessionId, plan, modelId, modelBindingDigest, createdAt };
        if (createdAt > timestamp(this.#now())) throw new Error('skill-sample-created-in-future');
        return this.#transaction(() => this.#enqueuePrepared(source, key));
    }

    /** One transaction creates the complete fixed matrix; partial suite queues cannot escape a failed submit. */
    enqueueSuite(input: {
        readonly rawSessionId: string; readonly plans: readonly SkillSampleSuitePlan[];
        readonly modelId: string; readonly modelBindingDigest: string; readonly createdAt: string;
    }, idempotencyKey: string): SkillSampleStoredSuite {
        this.#open();
        const value = record(input);
        exact(value, ['rawSessionId', 'plans', 'modelId', 'modelBindingDigest', 'createdAt']);
        const rawSessionId = session(value.rawSessionId);
        const plans = normalizeSkillSampleSuitePlans(value.plans);
        const first = plans[0]!;
        if (plans.some((plan) => plan.source.compilePacket.rawSessionId !== rawSessionId)) {
            throw new Error('skill-sample-suite-owner-mismatch');
        }
        const modelId = token(value.modelId);
        const modelBindingDigest = digest(value.modelBindingDigest);
        const createdAt = timestamp(value.createdAt);
        if (createdAt < first.source.candidate.updatedAt) {
            throw new Error('skill-sample-suite-created-before-candidate');
        }
        const key = token(idempotencyKey);
        const suiteId = skillSampleSuiteId(key);
        if (plans.some((plan) => plan.suite.suiteId !== suiteId)) {
            throw new Error('skill-sample-suite-idempotency-conflict');
        }
        if (createdAt > timestamp(this.#now())) throw new Error('skill-sample-suite-created-in-future');
        return this.#transaction(() => {
            for (const plan of plans) {
                const childKey = skillSampleSuiteChildKey(
                    suiteId,
                    plan.suite.scenarioOrdinal,
                    plan.suite.repeatIndex,
                );
                this.#enqueuePrepared({
                    rawSessionId, plan, modelId, modelBindingDigest, createdAt,
                }, childKey);
            }
            const retained = this.#readSuite(suiteId);
            if (!retained || retained.jobs.length !== SKILL_SAMPLE_SUITE_PAIR_COUNT
                || retained.plans.some((plan, index) => plan.planDigest !== plans[index]!.planDigest)) {
                throw new Error('skill-sample-suite-enqueue-storage-mismatch');
            }
            for (const plan of plans) this.#source(rawSessionId, plan);
            return retained;
        });
    }

    read(jobId: string): SkillSampleStoredJob | null {
        digest(jobId);
        return this.#transaction(() => this.#read(jobId), false);
    }

    readSuite(suiteId: string): SkillSampleStoredSuite | null {
        digest(suiteId);
        return this.#transaction(() => this.#readSuite(suiteId), false);
    }

    claimNext(
        ownerId: string,
        leaseMs = 47_000,
        planAllowed: (plan: SkillSamplePlan) => boolean = () => true,
    ): SkillSampleClaimV1 | null {
        token(ownerId);
        count(leaseMs, 1, 300_000);
        if (typeof planAllowed !== 'function') throw new Error('skill-sample-plan-filter-invalid');
        const now = timestamp(this.#now());
        const claim = this.#transaction(() => {
            if (this.#claimScanHorizon === 0) {
                const boundary = this.#db.prepare(`SELECT MAX(job_row_id) AS maximum FROM skill_sample_job
                    WHERE state='queued' AND NOT EXISTS(
                        SELECT 1 FROM skill_sample_quarantine AS quarantine
                        WHERE quarantine.job_id=skill_sample_job.job_id)`).get() as SqlRow;
                if (boundary.maximum === null || boundary.maximum === undefined) return null;
                this.#claimScanAfter = 0;
                this.#claimScanHorizon = count(boundary.maximum, 1);
                this.#claimScanDeferred = false;
            }
            const rows = this.#db.prepare(`SELECT * FROM skill_sample_job WHERE state='queued'
                AND NOT EXISTS(SELECT 1 FROM skill_sample_quarantine AS quarantine
                    WHERE quarantine.job_id=skill_sample_job.job_id)
                AND job_row_id>? AND job_row_id<=? ORDER BY job_row_id LIMIT 64`)
                .all(this.#claimScanAfter, this.#claimScanHorizon) as SqlRow[];
            if (rows.length === 0) {
                this.#claimScanAfter = 0;
                this.#claimScanHorizon = 0;
                this.#claimScanDeferred = false;
                return null;
            }
            for (const row of rows) {
                this.#claimScanAfter = count(row.job_row_id, 1);
                if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                    this.#redact(session(row.session_key), now);
                    continue;
                }
                let job: SkillSampleJobV1;
                try {
                    job = parseJob(row);
                    if (!this.#read(job.jobId)) throw new Error('skill-sample-source-missing');
                } catch { this.#quarantine(row, now); continue; }
                let executable = false;
                try { executable = planAllowed(job.plan) === true; }
                catch { /* Runtime feature selectors fail closed without mutating queued work. */ }
                if (!executable) {
                    this.#claimScanDeferred = true;
                    continue;
                }
                if (now < job.updatedAt) throw new Error('skill-sample-clock-regressed');
                if (job.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION) {
                    const suite = this.#readSuite(job.plan.suite.suiteId);
                    if (suite && ['failed', 'uncertain'].includes(suite.state)) {
                        this.#closeSuiteQueued(job.plan.suite.suiteId, now);
                        continue;
                    }
                }
                if (!this.#current(job.plan)) {
                    this.#writeJob(job, normalizeJob({
                        ...job, state: 'failed', revision: 1, updatedAt: now,
                        reasonCode: 'skill-sample-source-invalidated'
                    }));
                    continue;
                }
                this.#source(job.rawSessionId, job.plan);
                const next = normalizeJob({
                    ...job, state: 'running', revision: 1, attempt: 1, claimRevision: 1,
                    ownerId, ownerToken: `sample-owner:${randomUUID()}`, claimedAt: now, updatedAt: now,
                    leaseExpiresAt: timestamp(new Date(Date.parse(now) + leaseMs).toISOString())
                });
                this.#writeJob(job, next);
                this.#source(job.rawSessionId, job.plan);
                if (this.#claimScanAfter >= this.#claimScanHorizon && !this.#claimScanDeferred) {
                    this.#claimScanAfter = 0;
                    this.#claimScanHorizon = 0;
                    this.#claimScanDeferred = false;
                }
                return claimOf(next);
            }
            if (this.#claimScanAfter >= this.#claimScanHorizon) {
                this.#claimScanAfter = 0;
                this.#claimScanHorizon = 0;
                this.#claimScanDeferred = false;
            }
            return null;
        });
        if (claim) this.#claims.add(claim);
        return claim;
    }

    finish(claim: SkillSampleClaimV1, proof: unknown): SkillSampleStoredJob {
        this.#open();
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-sample-claim-brand-invalid');
        const packet = readSkillSampleProof(proof);
        if (packet.jobId !== claim.jobId || packet.rawSessionId !== claim.rawSessionId
            || packet.jobRequestDigest !== claim.requestDigest || packet.claimDigest !== skillSampleClaimDigest(claim)
            || packet.modelId !== claim.modelId || packet.modelBindingDigest !== claim.modelBindingDigest
            || packet.planDigest !== skillSampleExecutionPlanDigest(claim.plan)
            || JSON.stringify(packet.plan) !== JSON.stringify(claim.plan)
            || packet.completedAt < claim.claimedAt || packet.completedAt >= claim.leaseExpiresAt
            || packet.arms.length !== 2 || packet.arms[0]?.variant !== 'baseline'
            || packet.arms[1]?.variant !== 'candidate') throw new Error('skill-sample-proof-binding-mismatch');
        const evaluation = evaluateSkillSampleOffline(packet);
        if (evaluation.sourcePacketDigest !== packet.packetDigest) {
            throw new Error('skill-sample-offline-source-mismatch');
        }
        const execution = readSkillSampleExecution(proof);
        if (execution) verifySkillSampleExecution(execution, packet);
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const job = this.#owned(claim);
            const retained = this.#read(job.jobId);
            if (!retained) throw new Error('skill-sample-source-missing');
            if (retained.packet) {
                if (JSON.stringify(retained.packet) !== JSON.stringify(packet)
                    || JSON.stringify(retained.evaluation) !== JSON.stringify(evaluation)
                    || JSON.stringify(retained.execution) !== JSON.stringify(execution)) {
                    throw new Error('skill-sample-result-conflict');
                }
                this.#source(job.rawSessionId, job.plan);
                return retained;
            }
            if (job.state !== 'running' || job.revision !== claim.revision
                || now >= claim.leaseExpiresAt || now < packet.completedAt) throw new Error('skill-sample-claim-stale');
            this.#db.prepare(`INSERT INTO skill_sample_receipt
                (job_id,session_key,packet_json,packet_digest,evaluation_json,evaluation_digest) VALUES(?,?,?,?,?,?)`)
                .run(job.jobId, job.rawSessionId, json(packet, MAX_PACKET_CHARS), packet.packetDigest,
                    json(evaluation, 65_536), evaluation.evidenceDigest);
            // D-Q3a2b2b：执行证据与 packet 同一个事务写入；缺一不可回读成功。
            if (execution) {
                this.#db.prepare(`INSERT INTO skill_sample_execution
                    (job_id,session_key,execution_json,execution_digest) VALUES(?,?,?,?)`)
                    .run(job.jobId, job.rawSessionId, json(execution, MAX_EXECUTION_CHARS),
                        execution.executionDigest);
            }
            this.#writeJob(job, normalizeJob({
                ...job, state: 'succeeded', revision: job.revision + 1,
                updatedAt: packet.completedAt, receiptDigest: packet.packetDigest
            }));
            const stored = this.#read(job.jobId);
            if (!stored || JSON.stringify(stored.packet) !== JSON.stringify(packet)
                || JSON.stringify(stored.evaluation) !== JSON.stringify(evaluation)
                || JSON.stringify(stored.execution) !== JSON.stringify(execution)) {
                throw new Error('skill-sample-finish-storage-mismatch');
            }
            this.#source(job.rawSessionId, job.plan);
            return stored;
        });
    }

    markFailed(claim: SkillSampleClaimV1, reason: SkillSampleFailureReason): SkillSampleJobV1 {
        if (!SKILL_SAMPLE_FAILURE_REASONS.includes(reason)) throw new Error('skill-sample-failure-reason-invalid');
        return this.#transaction(() => {
            const job = this.#owned(claim, false);
            if (job.state === 'failed' && job.reasonCode === reason) return job;
            if (job.state !== 'running' || job.revision !== claim.revision) {
                throw new Error('skill-sample-claim-stale');
            }
            const now = timestamp(this.#now());
            if (now < job.updatedAt) throw new Error('skill-sample-clock-regressed');
            const next = normalizeJob({
                ...job, state: 'failed', revision: job.revision + 1, updatedAt: now,
                reasonCode: reason
            });
            this.#writeJob(job, next);
            this.#source(job.rawSessionId, job.plan, false);
            return next;
        });
    }

    /** Terminal suite siblings close only untouched queue entries; completed evidence is retained. */
    closeSuiteQueued(suiteId: string): number {
        digest(suiteId);
        const now = timestamp(this.#now());
        return this.#transaction(() => this.#closeSuiteQueued(suiteId, now));
    }

    /** Startup-only conservative recovery. An unrecorded model result is never permission to dispatch again. */
    recoverUncertain(): number {
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_sample_job WHERE state='running'
                AND NOT EXISTS(SELECT 1 FROM skill_sample_quarantine AS quarantine
                    WHERE quarantine.job_id=skill_sample_job.job_id) ORDER BY job_row_id LIMIT 64`).all() as SqlRow[];
            let recovered = 0;
            const incompleteSuites = new Set<string>();
            for (const row of rows) {
                if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                    this.#redact(session(row.session_key), now);
                    continue;
                }
                let job: SkillSampleJobV1;
                try {
                    job = parseJob(row);
                    if (!this.#read(job.jobId)) throw new Error('skill-sample-source-missing');
                } catch {
                    this.#quarantine(row, now);
                    continue;
                }
                this.#source(job.rawSessionId, job.plan, false);
                if (now < job.updatedAt) throw new Error('skill-sample-clock-regressed');
                this.#writeJob(job, normalizeJob({
                    ...job, state: 'uncertain', revision: job.revision + 1,
                    updatedAt: now, reasonCode: 'skill-sample-restart-uncertain'
                }));
                if (job.plan.planVersion === SKILL_SAMPLE_SUITE_PLAN_VERSION) {
                    incompleteSuites.add(job.plan.suite.suiteId);
                }
                recovered += 1;
            }
            for (const suiteId of incompleteSuites) this.#closeSuiteQueued(suiteId, now);
            return recovered;
        });
    }

    status(): Readonly<{ queued: number; running: number }> {
        this.#open();
        const row = this.#db.prepare(`SELECT COALESCE(SUM(state='queued'),0) AS queued,
            COALESCE(SUM(state='running'),0) AS running FROM skill_sample_job
            WHERE NOT EXISTS(SELECT 1 FROM skill_sample_quarantine AS quarantine
                WHERE quarantine.job_id=skill_sample_job.job_id)
                AND NOT EXISTS(SELECT 1 FROM skill_sample_session_tombstone AS tombstone
                    WHERE tombstone.session_key=skill_sample_job.session_key)`).get() as SqlRow;
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
