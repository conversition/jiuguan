/** @author Codex @date 2026-10-17 @version 1.0
 * Durable fail-stop queue for one complete blinded quality suite.
 * Source bodies are server-runtime data and must never be serialized by API adapters.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import {
    normalizeSkillQualityExecutionPacket, normalizeSkillQualityPacket,
    readSkillQualityProof, skillQualityClaimDigest,
    type SkillQualityClaim, type SkillQualityExecutionPacket, type SkillQualityPacket,
} from './skill-quality-model.ts';
import { evaluateSkillQualityOffline, type SkillQualityOfflineReceipt } from './skill-quality-offline.ts';
import {
    assertCurrentSkillQualityPlans, assertSkillQualityPlanSource, normalizeSkillQualityPlan,
    normalizeSkillQualityPlans, SKILL_QUALITY_PLAN_COUNT, type SkillQualityPlan,
} from './skill-quality-registry.ts';
import { normalizeSkillSamplePacket, type SkillSamplePacket } from './skill-sample-model.ts';
import { evaluateSkillSampleSuiteOffline } from './skill-sample-suite-offline.ts';

export const SKILL_QUALITY_DB_FILE = 'agent-skill-quality.sqlite';
export const SKILL_QUALITY_SCHEMA_VERSION = 1;
export const SKILL_QUALITY_APPLICATION_ID = 0x4a475151;
export const SKILL_QUALITY_FAILURE_REASONS = Object.freeze([
    'skill-quality-model-failed', 'skill-quality-admission-denied', 'skill-quality-result-invalid',
    'skill-quality-source-invalidated', 'skill-quality-persistence-unconfirmed',
    'skill-quality-suite-incomplete',
] as const);
export type SkillQualityFailureReason = typeof SKILL_QUALITY_FAILURE_REASONS[number];
export type SkillQualityJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';

export interface SkillQualityJobV1 {
    readonly jobVersion: 'skill-quality-job-v1';
    readonly jobId: string;
    readonly qualitySuiteId: string;
    readonly rawSessionId: string;
    readonly requestDigest: string;
    readonly plan: SkillQualityPlan;
    readonly samplePacketDigest: string;
    readonly modelId: string;
    readonly modelBindingDigest: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly state: SkillQualityJobState;
    readonly revision: number;
    readonly attempt: 0 | 1;
    readonly claimRevision: number | null;
    readonly ownerId: string | null;
    readonly ownerToken: string | null;
    readonly claimedAt: string | null;
    readonly leaseExpiresAt: string | null;
    readonly receiptDigest: string | null;
    readonly reasonCode: SkillQualityFailureReason | 'skill-quality-restart-uncertain' | null;
}

export type SkillQualityExecutionReceipt = SkillQualityExecutionPacket;

/** Runtime-only view: samplePacket contains raw bodies. */
export interface SkillQualityStoredJob {
    readonly job: SkillQualityJobV1;
    readonly samplePacket: SkillSamplePacket;
    readonly packet: SkillQualityPacket | null;
    readonly execution: SkillQualityExecutionReceipt | null;
}

/** Runtime-only view: samplePackets contains raw bodies. */
export interface SkillQualityStoredSuite {
    readonly suiteId: string;
    readonly state: SkillQualityJobState;
    readonly plans: readonly SkillQualityPlan[];
    readonly samplePackets: readonly SkillSamplePacket[];
    readonly jobs: readonly SkillQualityStoredJob[];
    readonly createdAt: string;
    readonly updatedAt: string;
    /** Rechecked on every read; historical receipts remain readable after upstream drift. */
    readonly sourceCurrent: boolean;
    readonly evaluation: SkillQualityOfflineReceipt | null;
    /** This never changes the offline receipt's providerExecution=unverified statement. */
    readonly execution: Readonly<{
        completedJobCount: number;
        expectedJobCount: typeof SKILL_QUALITY_PLAN_COUNT;
        gatewayProofStatus: 'incomplete' | 'complete';
    }>;
}

type SqlRow = Record<string, unknown>;
export type SkillQualitySourceCurrentInput = Readonly<{
    rawSessionId: string;
    plans: readonly SkillQualityPlan[];
    samplePackets: readonly SkillSamplePacket[];
}>;
type SourceInput = SkillQualitySourceCurrentInput;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SESSION = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_JOB_CHARS = 65_536;
const MAX_PLANS_CHARS = 1_048_576;
const MAX_SOURCE_CHARS = 524_288;
const MAX_PACKET_CHARS = 262_144;
const MAX_EXECUTION_CHARS = 524_288;
const MAX_EVALUATION_CHARS = 524_288;

const SCHEMA = Object.freeze([
    `CREATE TABLE skill_quality_suite (
        suite_id TEXT NOT NULL PRIMARY KEY CHECK(length(suite_id)=71),
        session_key TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=71),
        plans_json TEXT NOT NULL CHECK(json_valid(plans_json) AND length(plans_json)<=1048576),
        plans_digest TEXT NOT NULL CHECK(length(plans_digest)=71),
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_quality_source (
        source_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        suite_id TEXT NOT NULL REFERENCES skill_quality_suite(suite_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        scenario_ordinal INTEGER NOT NULL CHECK(scenario_ordinal>=0),
        repeat_index INTEGER NOT NULL CHECK(repeat_index>=0),
        packet_digest TEXT NOT NULL CHECK(length(packet_digest)=71),
        packet_json TEXT NOT NULL CHECK(json_valid(packet_json) AND length(packet_json)<=524288),
        UNIQUE(suite_id,scenario_ordinal,repeat_index),
        UNIQUE(suite_id,packet_digest)
    )`,
    `CREATE TABLE skill_quality_job (
        job_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE CHECK(length(job_id)=71),
        suite_id TEXT NOT NULL REFERENCES skill_quality_suite(suite_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        scenario_ordinal INTEGER NOT NULL CHECK(scenario_ordinal>=0),
        repeat_index INTEGER NOT NULL CHECK(repeat_index>=0),
        judge_ordinal INTEGER NOT NULL CHECK(judge_ordinal IN (0,1)),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=71),
        job_json TEXT NOT NULL CHECK(json_valid(job_json) AND length(job_json)<=65536),
        job_digest TEXT NOT NULL CHECK(length(job_digest)=71),
        state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','uncertain')),
        revision INTEGER NOT NULL CHECK(revision>=0),
        lease_until TEXT,
        UNIQUE(suite_id,scenario_ordinal,repeat_index,judge_ordinal)
    )`,
    `CREATE TABLE skill_quality_receipt (
        receipt_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE REFERENCES skill_quality_job(job_id) ON DELETE CASCADE,
        suite_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        packet_json TEXT NOT NULL CHECK(json_valid(packet_json) AND length(packet_json)<=262144),
        packet_digest TEXT NOT NULL CHECK(length(packet_digest)=71),
        execution_json TEXT NOT NULL CHECK(json_valid(execution_json) AND length(execution_json)<=524288),
        execution_packet_digest TEXT NOT NULL CHECK(length(execution_packet_digest)=71),
        claim_digest TEXT NOT NULL CHECK(length(claim_digest)=71),
        lease_audit_digest TEXT NOT NULL CHECK(length(lease_audit_digest)=71),
        completed_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_quality_suite_receipt (
        suite_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_quality_suite(suite_id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=524288),
        evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=71)
    )`,
    `CREATE TABLE skill_quality_quarantine (
        job_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_quality_job(job_id) ON DELETE CASCADE,
        quarantined_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK(reason_code='skill-quality-storage-invalid')
    )`,
    `CREATE TABLE skill_quality_session_tombstone (
        session_key TEXT NOT NULL PRIMARY KEY,
        redacted_at TEXT NOT NULL
    )`,
    'CREATE INDEX skill_quality_job_state ON skill_quality_job(state,job_row_id)',
    'CREATE INDEX skill_quality_job_suite ON skill_quality_job(suite_id,job_row_id)',
    'CREATE INDEX skill_quality_suite_session ON skill_quality_suite(session_key)',
    `CREATE UNIQUE INDEX skill_quality_one_running_per_suite
        ON skill_quality_job(suite_id) WHERE state='running'`,
    ...['suite', 'source', 'receipt', 'suite_receipt', 'quarantine', 'session_tombstone'].map((name) =>
        `CREATE TRIGGER skill_quality_${name}_no_update BEFORE UPDATE ON skill_quality_${name}
            BEGIN SELECT RAISE(ABORT,'skill quality immutable record'); END`),
    `CREATE TRIGGER skill_quality_session_tombstone_no_delete
        BEFORE DELETE ON skill_quality_session_tombstone
        BEGIN SELECT RAISE(ABORT,'skill quality permanent deletion fence'); END`,
]);

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
function digest(value: unknown): string {
    if (typeof value !== 'string' || !HASH.test(value)) throw new Error('skill-quality-digest-invalid');
    return value;
}
function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('skill-quality-token-invalid');
    return value;
}
function session(value: unknown): string {
    if (typeof value !== 'string' || !SESSION.test(value)) throw new Error('skill-quality-session-invalid');
    return value;
}
function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('skill-quality-time-invalid');
    return value;
}
function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new Error('skill-quality-count-invalid');
    }
    return Number(value);
}
function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('skill-quality-data-invalid');
    }
    if (Reflect.ownKeys(input).length !== Object.keys(input).length) {
        throw new Error('skill-quality-fields-invalid');
    }
    for (const key of Object.keys(input)) {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) {
            throw new Error('skill-quality-fields-invalid');
        }
    }
    return input as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw new Error('skill-quality-fields-invalid');
    }
}
function json(value: unknown, maximum: number): string {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > maximum) throw new Error('skill-quality-packet-too-large');
    return text;
}

/** Stable public identity; the root idempotency key itself is not persisted. */
export function skillQualitySuiteId(rootIdempotencyKey: string): string {
    return hash(['skill-quality-suite-run-v1', token(rootIdempotencyKey)]);
}
export function skillQualitySuiteChildJobId(
    suiteId: string, scenarioOrdinal: number, repeatIndex: number, judgeOrdinal: number,
): string {
    return hash(['skill-quality-job-v1', digest(suiteId), count(scenarioOrdinal),
        count(repeatIndex), count(judgeOrdinal, 0, 1)]);
}

function plansDigest(plans: readonly SkillQualityPlan[]): string {
    return hash({ version: 'skill-quality-stored-plans-v1',
        planDigests: plans.map((plan) => plan.planDigest) });
}
function suiteRequestDigest(input: SourceInput & { createdAt: string }): string {
    return hash({
        requestVersion: 'skill-quality-suite-request-v1', rawSessionId: input.rawSessionId,
        plansDigest: plansDigest(input.plans),
        sourcePacketDigests: input.samplePackets.map((packet) => packet.packetDigest),
        createdAt: input.createdAt,
    });
}
function jobRequestDigest(input: {
    rawSessionId: string; qualitySuiteId: string; plan: SkillQualityPlan;
    samplePacketDigest: string; createdAt: string;
}): string {
    return hash({
        requestVersion: 'skill-quality-job-request-v1', rawSessionId: input.rawSessionId,
        qualitySuiteId: input.qualitySuiteId, planDigest: input.plan.planDigest,
        samplePacketDigest: input.samplePacketDigest, createdAt: input.createdAt,
        modelId: input.plan.suite.judgeModelId,
        modelBindingDigest: input.plan.suite.judgeModelBindingDigest,
    });
}

function normalizeJob(input: unknown): SkillQualityJobV1 {
    const value = record(input);
    exact(value, ['jobVersion', 'jobId', 'qualitySuiteId', 'rawSessionId', 'requestDigest', 'plan',
        'samplePacketDigest', 'modelId', 'modelBindingDigest', 'createdAt', 'updatedAt', 'state',
        'revision', 'attempt', 'claimRevision', 'ownerId', 'ownerToken', 'claimedAt', 'leaseExpiresAt',
        'receiptDigest', 'reasonCode']);
    const plan = normalizeSkillQualityPlan(value.plan);
    const job: SkillQualityJobV1 = Object.freeze({
        jobVersion: 'skill-quality-job-v1', jobId: digest(value.jobId),
        qualitySuiteId: digest(value.qualitySuiteId), rawSessionId: session(value.rawSessionId),
        requestDigest: digest(value.requestDigest), plan,
        samplePacketDigest: digest(value.samplePacketDigest), modelId: token(value.modelId),
        modelBindingDigest: digest(value.modelBindingDigest), createdAt: timestamp(value.createdAt),
        updatedAt: timestamp(value.updatedAt), state: value.state as SkillQualityJobState,
        revision: count(value.revision), attempt: count(value.attempt, 0, 1) as 0 | 1,
        claimRevision: value.claimRevision === null ? null : count(value.claimRevision, 1),
        ownerId: value.ownerId === null ? null : token(value.ownerId),
        ownerToken: value.ownerToken === null ? null : token(value.ownerToken),
        claimedAt: value.claimedAt === null ? null : timestamp(value.claimedAt),
        leaseExpiresAt: value.leaseExpiresAt === null ? null : timestamp(value.leaseExpiresAt),
        receiptDigest: value.receiptDigest === null ? null : digest(value.receiptDigest),
        reasonCode: value.reasonCode as SkillQualityJobV1['reasonCode'],
    });
    const expectedRequest = jobRequestDigest({
        rawSessionId: job.rawSessionId, qualitySuiteId: job.qualitySuiteId, plan: job.plan,
        samplePacketDigest: job.samplePacketDigest, createdAt: job.createdAt,
    });
    if (value.jobVersion !== job.jobVersion || job.qualitySuiteId !== plan.suite.qualitySuiteId
        || job.requestDigest !== expectedRequest || job.samplePacketDigest !== plan.source.samplePacketDigest
        || job.modelId !== plan.suite.judgeModelId
        || job.modelBindingDigest !== plan.suite.judgeModelBindingDigest
        || job.updatedAt < job.createdAt
        || !['queued', 'running', 'succeeded', 'failed', 'uncertain'].includes(job.state)
        || job.reasonCode !== null && ![...SKILL_QUALITY_FAILURE_REASONS, 'skill-quality-restart-uncertain']
            .includes(job.reasonCode)) throw new Error('skill-quality-job-invalid');
    const emptyOwner = job.ownerId === null && job.ownerToken === null && job.claimedAt === null
        && job.leaseExpiresAt === null && job.claimRevision === null;
    if (job.attempt === 0) {
        if (!emptyOwner || job.receiptDigest !== null || !(job.state === 'queued' && job.revision === 0
            && job.reasonCode === null || job.state === 'failed' && job.revision === 1
            && ['skill-quality-source-invalidated', 'skill-quality-suite-incomplete']
                .includes(job.reasonCode ?? ''))) throw new Error('skill-quality-job-state-invalid');
        return job;
    }
    if (emptyOwner || job.ownerId === null || job.ownerToken === null || job.claimedAt === null
        || job.leaseExpiresAt === null || job.claimRevision !== 1 || job.claimedAt < job.createdAt
        || job.updatedAt < job.claimedAt || job.leaseExpiresAt <= job.claimedAt
        || job.state === 'running' && (job.revision !== 1 || job.updatedAt !== job.claimedAt
            || job.reasonCode !== null)
        || job.state !== 'running' && (job.revision !== 2 || job.state === 'queued')
        || job.state === 'succeeded' && (job.receiptDigest === null || job.reasonCode !== null)
        || job.state !== 'succeeded' && job.receiptDigest !== null
        || job.state === 'uncertain' && job.reasonCode !== 'skill-quality-restart-uncertain'
        || job.state === 'failed' && !SKILL_QUALITY_FAILURE_REASONS.includes(
            job.reasonCode as SkillQualityFailureReason)) throw new Error('skill-quality-job-state-invalid');
    return job;
}

function parseJob(row: SqlRow): SkillQualityJobV1 {
    if (typeof row.job_json !== 'string' || row.job_json.length > MAX_JOB_CHARS) {
        throw new Error('skill-quality-job-packet-invalid');
    }
    const job = normalizeJob(JSON.parse(row.job_json));
    if (JSON.stringify(job) !== row.job_json || hash(job) !== row.job_digest || job.jobId !== row.job_id
        || job.qualitySuiteId !== row.suite_id || job.rawSessionId !== row.session_key
        || job.plan.source.scenarioOrdinal !== row.scenario_ordinal
        || job.plan.source.repeatIndex !== row.repeat_index
        || job.plan.suite.judgeOrdinal !== row.judge_ordinal || job.requestDigest !== row.request_digest
        || job.state !== row.state || job.revision !== row.revision
        || job.leaseExpiresAt !== row.lease_until) throw new Error('skill-quality-job-corrupt');
    return job;
}

function schemaSql(db: DatabaseSync): string[] {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SqlRow[])
        .map((row) => {
            if (typeof row.sql !== 'string') throw new Error('skill-quality-schema-invalid');
            return row.sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
        }).sort();
}
function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
    return count((db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key]);
}
export function inspectSkillQualitySchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== SKILL_QUALITY_APPLICATION_ID
        || pragma(db, 'user_version') !== SKILL_QUALITY_SCHEMA_VERSION) {
        throw new Error('skill-quality-metadata-mismatch');
    }
    const expected = SCHEMA.map((item) => item.trim().replace(/;$/u, '').replace(/\s+/gu, ' ')
        .toLowerCase()).sort();
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(expected)) {
        throw new Error('skill-quality-schema-mismatch');
    }
}
function initialize(db: DatabaseSync): void {
    if (pragma(db, 'application_id') || pragma(db, 'user_version')) {
        inspectSkillQualitySchema(db); return;
    }
    if (schemaSql(db).length) throw new Error('skill-quality-uninitialized-not-empty');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${SKILL_QUALITY_APPLICATION_ID}`);
        for (const statement of SCHEMA) db.exec(statement);
        db.exec(`PRAGMA user_version=${SKILL_QUALITY_SCHEMA_VERSION}`);
        inspectSkillQualitySchema(db);
        db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
function stat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function directory(path: string): void {
    if (path === parse(path).root) throw new Error('skill-quality-directory-invalid');
    for (let current = path; current !== dirname(current); current = dirname(current)) {
        const entry = stat(current);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            throw new Error('skill-quality-directory-invalid');
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}
function regular(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('skill-quality-file-invalid');
}

interface LoadedSuite {
    readonly suiteId: string;
    readonly rawSessionId: string;
    readonly plans: readonly SkillQualityPlan[];
    readonly samplePackets: readonly SkillSamplePacket[];
    readonly createdAt: string;
    readonly jobs: readonly SkillQualityJobV1[];
}

export class SkillQualityStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #isSessionDeleted: (raw: string) => boolean;
    readonly #sourceCurrent: (source: SourceInput) => boolean;
    readonly #claims = new WeakSet<object>();
    #claimScanAfter = 0;
    #claimScanHorizon = 0;
    #claimScanDeferred = false;
    #closed = false;

    constructor(options: {
        readonly dataDir: string;
        readonly now?: () => string;
        readonly isSessionDeleted?: (rawSessionId: string) => boolean;
        readonly sourceCurrent: (source: SourceInput) => boolean;
    }) {
        if (typeof options.sourceCurrent !== 'function') throw new Error('skill-quality-source-hook-required');
        if (typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
            throw new Error('skill-quality-directory-invalid');
        }
        const dataDir = resolve(options.dataDir);
        directory(dataDir);
        const file = join(dataDir, SKILL_QUALITY_DB_FILE);
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

    #open(): void { if (this.#closed) throw new Error('skill-quality-store-closed'); }
    #transaction<T>(work: () => T, write = true): T {
        this.#open();
        if (this.#db.isTransaction) throw new Error('skill-quality-nested-transaction');
        this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            const result = work();
            if (!this.#db.isTransaction) throw new Error('skill-quality-transaction-lost');
            this.#db.exec('COMMIT');
            return result;
        } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    }
    #deleted(raw: string): boolean {
        if (this.#db.prepare('SELECT 1 FROM skill_quality_session_tombstone WHERE session_key=?').get(raw)) {
            return true;
        }
        try { return this.#isSessionDeleted(raw) === true; }
        catch { throw new Error('skill-quality-source-status-unavailable'); }
    }
    #current(source: SourceInput): boolean {
        const view = Object.freeze({
            rawSessionId: source.rawSessionId,
            plans: source.plans,
            samplePackets: source.samplePackets,
        });
        try { return this.#sourceCurrent(view) === true; } catch { return false; }
    }
    #source(source: SourceInput, current = true): void {
        if (this.#deleted(source.rawSessionId)) throw new Error('skill-quality-session-deleted');
        if (current && !this.#current(source)) throw new Error('skill-quality-source-invalidated');
    }
    #rawJob(jobId: string): SqlRow | undefined {
        return this.#db.prepare('SELECT * FROM skill_quality_job WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
    }
    #writeJob(previous: SkillQualityJobV1, nextInput: SkillQualityJobV1): void {
        const next = normalizeJob(nextInput);
        const result = this.#db.prepare(`UPDATE skill_quality_job
            SET job_json=?,job_digest=?,state=?,revision=?,lease_until=?
            WHERE job_id=? AND revision=? AND job_digest=?`)
            .run(json(next, MAX_JOB_CHARS), hash(next), next.state, next.revision, next.leaseExpiresAt,
                previous.jobId, previous.revision, hash(previous));
        const retained = this.#rawJob(next.jobId);
        if (Number(result.changes) !== 1 || !retained
            || JSON.stringify(parseJob(retained)) !== JSON.stringify(next)) {
            throw new Error('skill-quality-job-revision-conflict');
        }
    }
    #quarantined(jobId: string): boolean {
        return !!this.#db.prepare('SELECT 1 FROM skill_quality_quarantine WHERE job_id=?').get(jobId);
    }
    #quarantine(row: SqlRow, now: string): void {
        if (typeof row.job_id !== 'string' || row.job_id.length > 240) {
            throw new Error('skill-quality-quarantine-key-invalid');
        }
        this.#db.prepare(`INSERT INTO skill_quality_quarantine(job_id,quarantined_at,reason_code)
            VALUES(?,?,'skill-quality-storage-invalid')`).run(row.job_id, now);
        const retained = this.#db.prepare('SELECT * FROM skill_quality_quarantine WHERE job_id=?')
            .get(row.job_id) as SqlRow | undefined;
        if (retained?.quarantined_at !== now || retained.reason_code !== 'skill-quality-storage-invalid') {
            throw new Error('skill-quality-quarantine-storage-mismatch');
        }
    }

    #loadSuite(suiteId: string): LoadedSuite | null {
        const header = this.#db.prepare('SELECT * FROM skill_quality_suite WHERE suite_id=?')
            .get(suiteId) as SqlRow | undefined;
        if (!header) return null;
        if (typeof header.plans_json !== 'string' || header.plans_json.length > MAX_PLANS_CHARS) {
            throw new Error('skill-quality-suite-plans-invalid');
        }
        const plans = normalizeSkillQualityPlans(JSON.parse(header.plans_json));
        const rawSessionId = session(header.session_key);
        const createdAt = timestamp(header.created_at);
        if (JSON.stringify(plans) !== header.plans_json || plansDigest(plans) !== header.plans_digest
            || plans[0]!.suite.qualitySuiteId !== suiteId) {
            throw new Error('skill-quality-suite-plans-corrupt');
        }
        const sourceRows = this.#db.prepare(`SELECT * FROM skill_quality_source
            WHERE suite_id=? ORDER BY scenario_ordinal,repeat_index`).all(suiteId) as SqlRow[];
        if (sourceRows.length * 2 !== SKILL_QUALITY_PLAN_COUNT) {
            throw new Error('skill-quality-source-matrix-missing');
        }
        const samplePackets = sourceRows.map((row) => {
            if (typeof row.packet_json !== 'string' || row.packet_json.length > MAX_SOURCE_CHARS) {
                throw new Error('skill-quality-source-packet-invalid');
            }
            const packet = normalizeSkillSamplePacket(JSON.parse(row.packet_json));
            if (JSON.stringify(packet) !== row.packet_json || packet.packetDigest !== row.packet_digest
                || row.session_key !== rawSessionId) throw new Error('skill-quality-source-packet-corrupt');
            return packet;
        });
        evaluateSkillSampleSuiteOffline(samplePackets);
        for (const plan of plans) {
            const pairIndex = plan.source.scenarioOrdinal * 3 + plan.source.repeatIndex;
            const packet = samplePackets[pairIndex];
            if (!packet) throw new Error('skill-quality-source-packet-missing');
            assertSkillQualityPlanSource(plan, packet);
        }
        const rows = this.#db.prepare(`SELECT * FROM skill_quality_job
            WHERE suite_id=? ORDER BY scenario_ordinal,repeat_index,judge_ordinal`)
            .all(suiteId) as SqlRow[];
        if (rows.length !== SKILL_QUALITY_PLAN_COUNT) throw new Error('skill-quality-suite-matrix-missing');
        const jobs = rows.map(parseJob);
        if (jobs.some((job, index) => job.plan.planDigest !== plans[index]!.planDigest
            || job.rawSessionId !== rawSessionId || job.createdAt !== createdAt
            || job.jobId !== skillQualitySuiteChildJobId(suiteId, job.plan.source.scenarioOrdinal,
                job.plan.source.repeatIndex, job.plan.suite.judgeOrdinal))) {
            throw new Error('skill-quality-suite-binding-invalid');
        }
        const expectedRequest = suiteRequestDigest({ rawSessionId, plans, samplePackets, createdAt });
        if (header.request_digest !== expectedRequest) throw new Error('skill-quality-suite-request-corrupt');
        return Object.freeze({
            suiteId, rawSessionId, plans, samplePackets: Object.freeze(samplePackets),
            createdAt, jobs: Object.freeze(jobs),
        });
    }

    #claimFor(job: SkillQualityJobV1, loaded: LoadedSuite): SkillQualityClaim {
        if (job.attempt !== 1 || job.ownerId === null || job.ownerToken === null
            || job.claimedAt === null || job.leaseExpiresAt === null || job.claimRevision === null) {
            throw new Error('skill-quality-claim-missing');
        }
        const packet = loaded.samplePackets[
            job.plan.source.scenarioOrdinal * 3 + job.plan.source.repeatIndex];
        if (!packet) throw new Error('skill-quality-source-packet-missing');
        return Object.freeze({
            claimVersion: 'skill-quality-claim-v1', jobId: job.jobId, rawSessionId: job.rawSessionId,
            requestDigest: job.requestDigest, plans: loaded.plans,
            selectedPlan: job.plan, selectedPlanDigest: job.plan.planDigest, samplePacket: packet,
            modelId: job.modelId, modelBindingDigest: job.modelBindingDigest,
            createdAt: job.createdAt, ownerId: job.ownerId, ownerToken: job.ownerToken,
            attempt: 1, revision: job.claimRevision, claimedAt: job.claimedAt,
            leaseExpiresAt: job.leaseExpiresAt,
        });
    }

    #readStoredJob(job: SkillQualityJobV1, loaded: LoadedSuite): SkillQualityStoredJob {
        const samplePacket = loaded.samplePackets[
            job.plan.source.scenarioOrdinal * 3 + job.plan.source.repeatIndex];
        if (!samplePacket) throw new Error('skill-quality-source-packet-missing');
        const row = this.#db.prepare('SELECT * FROM skill_quality_receipt WHERE job_id=?')
            .get(job.jobId) as SqlRow | undefined;
        if (!row) {
            if (job.receiptDigest !== null || job.state === 'succeeded') {
                throw new Error('skill-quality-receipt-missing');
            }
            return Object.freeze({ job, samplePacket, packet: null, execution: null });
        }
        if (typeof row.packet_json !== 'string' || row.packet_json.length > MAX_PACKET_CHARS) {
            throw new Error('skill-quality-receipt-invalid');
        }
        const packet = normalizeSkillQualityPacket(JSON.parse(row.packet_json));
        if (typeof row.execution_json !== 'string' || row.execution_json.length > MAX_EXECUTION_CHARS) {
            throw new Error('skill-quality-execution-receipt-invalid');
        }
        const execution = normalizeSkillQualityExecutionPacket(JSON.parse(row.execution_json));
        const claim = this.#claimFor(job, loaded);
        if (JSON.stringify(packet) !== row.packet_json
            || JSON.stringify(execution) !== row.execution_json
            || packet.packetDigest !== row.packet_digest
            || packet.packetDigest !== job.receiptDigest || row.suite_id !== job.qualitySuiteId
            || row.session_key !== job.rawSessionId
            || execution.packetDigest !== row.execution_packet_digest
            || execution.jobId !== job.jobId
            || execution.rawSessionId !== job.rawSessionId
            || execution.jobRequestDigest !== job.requestDigest
            || execution.claimDigest !== row.claim_digest
            || execution.leaseAuditDigest !== row.lease_audit_digest
            || execution.completedAt !== row.completed_at
            || execution.claimDigest !== skillQualityClaimDigest(claim)
            || execution.qualityPacket.packetDigest !== packet.packetDigest
            || JSON.stringify(execution.qualityPacket) !== JSON.stringify(packet)
            || packet.planDigest !== job.plan.planDigest
            || packet.samplePacketDigest !== job.samplePacketDigest
            || packet.modelId !== job.modelId || packet.modelBindingDigest !== job.modelBindingDigest
            || packet.completedAt !== execution.completedAt || packet.completedAt < job.claimedAt!
            || packet.completedAt >= job.leaseExpiresAt! || packet.completedAt !== job.updatedAt
            || job.state !== 'succeeded') throw new Error('skill-quality-receipt-binding-invalid');
        return Object.freeze({ job, samplePacket, packet, execution });
    }

    #readSuite(suiteId: string): SkillQualityStoredSuite | null {
        const loaded = this.#loadSuite(suiteId);
        if (!loaded) return null;
        if (this.#deleted(loaded.rawSessionId)) return null;
        const sourceCurrent = this.#current(loaded);
        const jobs = loaded.jobs.map((job) => this.#readStoredJob(job, loaded));
        const states = jobs.map((item) => item.job.state);
        const succeeded = states.every((state) => state === 'succeeded');
        const state: SkillQualityJobState = succeeded ? 'succeeded'
            : states.some((item) => item === 'uncertain') ? 'uncertain'
                : states.some((item) => item === 'failed') ? 'failed'
                    : states.some((item) => item === 'running' || item === 'succeeded') ? 'running' : 'queued';
        const aggregateRow = this.#db.prepare(
            'SELECT * FROM skill_quality_suite_receipt WHERE suite_id=?',
        ).get(suiteId) as SqlRow | undefined;
        let evaluation: SkillQualityOfflineReceipt | null = null;
        if (succeeded) {
            if (!aggregateRow || typeof aggregateRow.receipt_json !== 'string'
                || aggregateRow.receipt_json.length > MAX_EVALUATION_CHARS) {
                throw new Error('skill-quality-suite-receipt-missing');
            }
            const packets = jobs.map((item) => {
                if (!item.packet) throw new Error('skill-quality-suite-packet-missing');
                return item.packet;
            });
            evaluation = evaluateSkillQualityOffline(packets);
            if (JSON.stringify(evaluation) !== aggregateRow.receipt_json
                || evaluation.evidenceDigest !== aggregateRow.evidence_digest
                || aggregateRow.session_key !== loaded.rawSessionId) {
                throw new Error('skill-quality-suite-receipt-mismatch');
            }
        } else if (aggregateRow) throw new Error('skill-quality-suite-receipt-premature');
        const completedJobCount = jobs.filter((item) => item.execution !== null).length;
        return Object.freeze({
            suiteId, state, plans: loaded.plans, samplePackets: loaded.samplePackets,
            jobs: Object.freeze(jobs), createdAt: loaded.createdAt,
            updatedAt: [...loaded.jobs.map((job) => job.updatedAt)].sort().at(-1)!,
            sourceCurrent, evaluation,
            execution: Object.freeze({
                completedJobCount, expectedJobCount: SKILL_QUALITY_PLAN_COUNT,
                gatewayProofStatus: completedJobCount === SKILL_QUALITY_PLAN_COUNT
                    ? 'complete' as const : 'incomplete' as const,
            }),
        });
    }

    #closeSuiteQueued(suiteId: string, now: string): number {
        const loaded = this.#loadSuite(suiteId);
        if (!loaded) return 0;
        const states = loaded.jobs.map((job) => job.state);
        if (!states.some((state) => state === 'failed' || state === 'uncertain')) return 0;
        let closed = 0;
        for (const job of loaded.jobs) {
            if (job.state !== 'queued') continue;
            if (now < job.updatedAt) throw new Error('skill-quality-clock-regressed');
            this.#writeJob(job, normalizeJob({
                ...job, state: 'failed', revision: 1, updatedAt: now,
                reasonCode: 'skill-quality-suite-incomplete',
            }));
            closed += 1;
        }
        return closed;
    }

    enqueueSuite(input: {
        readonly rawSessionId: string;
        readonly plans: readonly SkillQualityPlan[];
        readonly samplePackets: readonly SkillSamplePacket[];
        readonly createdAt: string;
    }, rootIdempotencyKey: string): SkillQualityStoredSuite {
        this.#open();
        const value = record(input);
        exact(value, ['rawSessionId', 'plans', 'samplePackets', 'createdAt']);
        const rawSessionId = session(value.rawSessionId);
        const plans = assertCurrentSkillQualityPlans(value.plans);
        if (!Array.isArray(value.samplePackets)) throw new Error('skill-quality-source-packets-invalid');
        const samplePackets = value.samplePackets.map(normalizeSkillSamplePacket);
        evaluateSkillSampleSuiteOffline(samplePackets);
        const createdAt = timestamp(value.createdAt);
        if (createdAt > timestamp(this.#now())) throw new Error('skill-quality-created-in-future');
        if (samplePackets.some((packet) => packet.rawSessionId !== rawSessionId)) {
            throw new Error('skill-quality-suite-owner-mismatch');
        }
        const latestSourceCompletion = [...samplePackets.map((packet) => packet.completedAt)].sort().at(-1)!;
        if (createdAt < latestSourceCompletion) {
            throw new Error('skill-quality-created-before-source');
        }
        const suiteId = skillQualitySuiteId(rootIdempotencyKey);
        if (plans.some((plan) => plan.suite.qualitySuiteId !== suiteId)) {
            throw new Error('skill-quality-suite-idempotency-conflict');
        }
        for (const plan of plans) {
            const packet = samplePackets[plan.source.scenarioOrdinal * 3 + plan.source.repeatIndex];
            if (!packet) throw new Error('skill-quality-source-packet-missing');
            assertSkillQualityPlanSource(plan, packet);
        }
        const source = Object.freeze({
            rawSessionId, plans, samplePackets: Object.freeze(samplePackets),
        });
        this.#source(source);
        return this.#transaction(() => {
            const existing = this.#db.prepare('SELECT * FROM skill_quality_suite WHERE suite_id=?')
                .get(suiteId) as SqlRow | undefined;
            if (existing) {
                const retained = this.#readSuite(suiteId);
                if (!retained) throw new Error('skill-quality-idempotency-source-missing');
                const expected = suiteRequestDigest({ ...source, createdAt: retained.createdAt });
                if (existing.request_digest !== expected || existing.session_key !== rawSessionId) {
                    throw new Error('skill-quality-idempotency-conflict');
                }
                return retained;
            }
            const requestDigest = suiteRequestDigest({ ...source, createdAt });
            this.#db.prepare(`INSERT INTO skill_quality_suite
                (suite_id,session_key,request_digest,plans_json,plans_digest,created_at)
                VALUES(?,?,?,?,?,?)`).run(suiteId, rawSessionId, requestDigest,
                    json(plans, MAX_PLANS_CHARS), plansDigest(plans), createdAt);
            for (const packet of samplePackets) {
                const samplePlan = packet.plan as {
                    suite: { scenarioOrdinal: number; repeatIndex: number };
                };
                this.#db.prepare(`INSERT INTO skill_quality_source
                    (suite_id,session_key,scenario_ordinal,repeat_index,packet_digest,packet_json)
                    VALUES(?,?,?,?,?,?)`).run(suiteId, rawSessionId,
                        samplePlan.suite.scenarioOrdinal, samplePlan.suite.repeatIndex,
                        packet.packetDigest, json(packet, MAX_SOURCE_CHARS));
            }
            for (const plan of plans) {
                const jobId = skillQualitySuiteChildJobId(
                    suiteId, plan.source.scenarioOrdinal,
                    plan.source.repeatIndex, plan.suite.judgeOrdinal,
                );
                const request = jobRequestDigest({
                    rawSessionId, qualitySuiteId: suiteId, plan,
                    samplePacketDigest: plan.source.samplePacketDigest, createdAt,
                });
                const job = normalizeJob({
                    jobVersion: 'skill-quality-job-v1', jobId, qualitySuiteId: suiteId,
                    rawSessionId, requestDigest: request, plan,
                    samplePacketDigest: plan.source.samplePacketDigest,
                    modelId: plan.suite.judgeModelId,
                    modelBindingDigest: plan.suite.judgeModelBindingDigest,
                    createdAt, updatedAt: createdAt, state: 'queued', revision: 0, attempt: 0,
                    claimRevision: null, ownerId: null, ownerToken: null, claimedAt: null,
                    leaseExpiresAt: null, receiptDigest: null, reasonCode: null,
                });
                this.#db.prepare(`INSERT INTO skill_quality_job
                    (job_id,suite_id,session_key,scenario_ordinal,repeat_index,judge_ordinal,
                    request_digest,job_json,job_digest,state,revision,lease_until)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
                        jobId, suiteId, rawSessionId, plan.source.scenarioOrdinal,
                        plan.source.repeatIndex, plan.suite.judgeOrdinal, request,
                        json(job, MAX_JOB_CHARS), hash(job), job.state, job.revision, null,
                    );
            }
            const retained = this.#readSuite(suiteId);
            if (!retained || retained.jobs.length !== SKILL_QUALITY_PLAN_COUNT) {
                throw new Error('skill-quality-suite-enqueue-storage-mismatch');
            }
            this.#source(source);
            return retained;
        });
    }

    read(jobId: string): SkillQualityStoredJob | null {
        digest(jobId);
        return this.#transaction(() => {
            const row = this.#rawJob(jobId);
            if (!row) return null;
            const job = parseJob(row);
            const suite = this.#readSuite(job.qualitySuiteId);
            return suite?.jobs.find((item) => item.job.jobId === jobId) ?? null;
        }, false);
    }

    /**
     * Narrow gateway fence: proves this exact in-memory claim still owns its running row.
     * It deliberately does not load source packets, the full suite, receipts, or currentness hooks.
     */
    ownsClaim(claim: SkillQualityClaim): boolean {
        if (!claim || !this.#claims.has(claim)) return false;
        try {
            return this.#transaction(() => {
                const now = timestamp(this.#now());
                const row = this.#rawJob(claim.jobId);
                if (!row) return false;
                const job = parseJob(row);
                if (this.#quarantined(job.jobId) || job.state !== 'running'
                    || job.attempt !== 1 || job.jobId !== claim.jobId
                    || job.rawSessionId !== claim.rawSessionId
                    || job.requestDigest !== claim.requestDigest
                    || job.plan.planDigest !== claim.selectedPlanDigest
                    || job.samplePacketDigest !== claim.samplePacket.packetDigest
                    || job.modelId !== claim.modelId
                    || job.modelBindingDigest !== claim.modelBindingDigest
                    || job.ownerId !== claim.ownerId || job.ownerToken !== claim.ownerToken
                    || job.revision !== claim.revision || job.claimRevision !== claim.revision
                    || job.createdAt !== claim.createdAt || job.claimedAt !== claim.claimedAt
                    || job.leaseExpiresAt !== claim.leaseExpiresAt
                    || job.leaseExpiresAt === null || now >= job.leaseExpiresAt) return false;
                return true;
            }, false);
        } catch { return false; }
    }

    readSuite(suiteId: string): SkillQualityStoredSuite | null {
        digest(suiteId);
        return this.#transaction(() => this.#readSuite(suiteId), false);
    }

    /** Bounded discovery of completed suites; source currentness is checked by the caller. */
    listCompletedForSample(sampleSuiteId: string, cursor = ''): Readonly<{
        suiteIds: readonly string[]; hasMore: boolean; nextCursor: string | null; unavailable: boolean;
    }> {
        digest(sampleSuiteId);
        if (cursor) digest(cursor);
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT s.suite_id FROM skill_quality_suite s
                WHERE json_extract(s.plans_json, '$[0].source.sampleSuiteId')=? AND s.suite_id>?
                  AND EXISTS(SELECT 1 FROM skill_quality_suite_receipt r WHERE r.suite_id=s.suite_id)
                ORDER BY s.suite_id LIMIT 11`).all(sampleSuiteId, cursor) as SqlRow[];
            const suiteIds: string[] = [];
            let unavailable = false;
            for (const row of rows.slice(0, 10)) {
                const stored = this.#readSuite(digest(row.suite_id));
                if (!stored) { unavailable = true; continue; }
                if (stored.plans[0]?.source.sampleSuiteId !== sampleSuiteId) throw new Error('skill-quality-source-invalid');
                if (stored.state === 'succeeded' && stored.evaluation && stored.execution.gatewayProofStatus === 'complete') {
                    suiteIds.push(stored.suiteId);
                } else unavailable = true;
            }
            return Object.freeze({ suiteIds: Object.freeze(suiteIds), hasMore: rows.length > 10,
                nextCursor: rows.length ? digest(rows[Math.min(rows.length, 10) - 1]!.suite_id) : null, unavailable });
        }, false);
    }

    claimNext(
        ownerId: string,
        leaseMs = 47_000,
        planAllowed: (plan: SkillQualityPlan) => boolean = () => true,
    ): SkillQualityClaim | null {
        token(ownerId); count(leaseMs, 1, 300_000);
        if (typeof planAllowed !== 'function') throw new Error('skill-quality-plan-filter-invalid');
        const now = timestamp(this.#now());
        const claim = this.#transaction(() => {
            if (this.#claimScanHorizon === 0) {
                const boundary = this.#db.prepare(`SELECT MAX(job_row_id) AS maximum
                    FROM skill_quality_job WHERE state='queued'
                    AND NOT EXISTS(SELECT 1 FROM skill_quality_quarantine q
                        WHERE q.job_id=skill_quality_job.job_id)`).get() as SqlRow;
                if (boundary.maximum === null || boundary.maximum === undefined) return null;
                this.#claimScanAfter = 0;
                this.#claimScanHorizon = count(boundary.maximum, 1);
                this.#claimScanDeferred = false;
            }
            const rows = this.#db.prepare(`SELECT * FROM skill_quality_job
                WHERE state='queued' AND job_row_id>? AND job_row_id<=?
                AND NOT EXISTS(SELECT 1 FROM skill_quality_quarantine q
                    WHERE q.job_id=skill_quality_job.job_id)
                AND NOT EXISTS(SELECT 1 FROM skill_quality_job running
                    WHERE running.suite_id=skill_quality_job.suite_id AND running.state='running')
                ORDER BY job_row_id LIMIT 64`)
                .all(this.#claimScanAfter, this.#claimScanHorizon) as SqlRow[];
            if (rows.length === 0) {
                this.#claimScanAfter = 0; this.#claimScanHorizon = 0;
                this.#claimScanDeferred = false;
                return null;
            }
            for (const row of rows) {
                this.#claimScanAfter = count(row.job_row_id, 1);
                if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                    this.#redact(session(row.session_key), now); continue;
                }
                let job: SkillQualityJobV1;
                let loaded: LoadedSuite;
                try {
                    job = parseJob(row);
                    const found = this.#loadSuite(job.qualitySuiteId);
                    if (!found) throw new Error('skill-quality-suite-missing');
                    loaded = found;
                } catch { this.#quarantine(row, now); continue; }
                if (loaded.jobs.some((item) => item.state === 'failed' || item.state === 'uncertain')) {
                    this.#closeSuiteQueued(loaded.suiteId, now); continue;
                }
                let allowed = false;
                try { allowed = planAllowed(job.plan) === true; }
                catch { /* fail closed and keep queued */ }
                if (!allowed) { this.#claimScanDeferred = true; continue; }
                if (now < job.updatedAt) throw new Error('skill-quality-clock-regressed');
                if (!this.#current(loaded)) {
                    this.#writeJob(job, normalizeJob({
                        ...job, state: 'failed', revision: 1, updatedAt: now,
                        reasonCode: 'skill-quality-source-invalidated',
                    }));
                    this.#closeSuiteQueued(job.qualitySuiteId, now);
                    continue;
                }
                this.#source(loaded);
                const next = normalizeJob({
                    ...job, state: 'running', revision: 1, attempt: 1, claimRevision: 1,
                    ownerId, ownerToken: `quality-owner:${randomUUID()}`,
                    claimedAt: now, updatedAt: now,
                    leaseExpiresAt: timestamp(new Date(Date.parse(now) + leaseMs).toISOString()),
                });
                this.#writeJob(job, next);
                const result = this.#claimFor(next, loaded);
                if (this.#claimScanAfter >= this.#claimScanHorizon && !this.#claimScanDeferred) {
                    this.#claimScanAfter = 0; this.#claimScanHorizon = 0;
                    this.#claimScanDeferred = false;
                }
                return result;
            }
            if (this.#claimScanAfter >= this.#claimScanHorizon) {
                this.#claimScanAfter = 0; this.#claimScanHorizon = 0;
                this.#claimScanDeferred = false;
            }
            return null;
        });
        if (claim) this.#claims.add(claim);
        return claim;
    }

    #owned(claim: SkillQualityClaim, current = true): {
        job: SkillQualityJobV1; loaded: LoadedSuite;
    } {
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-quality-claim-brand-invalid');
        const row = this.#rawJob(claim.jobId);
        if (!row) throw new Error('skill-quality-job-missing');
        const job = parseJob(row);
        const loaded = this.#loadSuite(job.qualitySuiteId);
        if (!loaded) throw new Error('skill-quality-suite-missing');
        this.#source(loaded, current);
        if (this.#quarantined(job.jobId)) throw new Error('skill-quality-job-quarantined');
        if (skillQualityClaimDigest(claim) !== skillQualityClaimDigest(this.#claimFor(job, loaded))) {
            throw new Error('skill-quality-claim-stale');
        }
        return { job, loaded };
    }

    finish(claim: SkillQualityClaim, proof: unknown): SkillQualityStoredJob {
        if (!claim || !this.#claims.has(claim)) throw new Error('skill-quality-claim-brand-invalid');
        const execution: SkillQualityExecutionPacket = readSkillQualityProof(proof);
        const packet = normalizeSkillQualityPacket(execution.qualityPacket);
        const audit = execution.leaseAudit;
        if (execution.jobId !== claim.jobId || execution.rawSessionId !== claim.rawSessionId
            || execution.jobRequestDigest !== claim.requestDigest
            || execution.claimDigest !== skillQualityClaimDigest(claim)
            || packet.planDigest !== claim.selectedPlanDigest
            || packet.samplePacketDigest !== claim.samplePacket.packetDigest
            || packet.modelId !== claim.modelId || packet.modelBindingDigest !== claim.modelBindingDigest
            || execution.completedAt !== packet.completedAt
            || audit.status !== 'closed' || audit.outcome !== 'completed'
            || audit.modelId !== claim.modelId || audit.sessionId !== claim.rawSessionId
            || audit.runId !== claim.jobId
            || audit.parentRunId !== packet.plan.suite.qualitySuiteId
            || audit.sourceRevision !== packet.planDigest
            || audit.startedAt < claim.claimedAt || audit.finishedAt < audit.startedAt
            || audit.finishedAt > execution.completedAt
            || execution.completedAt < claim.claimedAt
            || execution.completedAt >= claim.leaseExpiresAt) {
            throw new Error('skill-quality-proof-binding-mismatch');
        }
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const { job, loaded } = this.#owned(claim);
            const existing = this.#db.prepare(
                'SELECT * FROM skill_quality_receipt WHERE job_id=?',
            ).get(job.jobId) as SqlRow | undefined;
            if (existing) {
                const stored = this.#readStoredJob(job, loaded);
                if (!stored.packet || !stored.execution
                    || stored.packet.packetDigest !== packet.packetDigest
                    || stored.execution.packetDigest !== execution.packetDigest) {
                    throw new Error('skill-quality-result-conflict');
                }
                return stored;
            }
            if (job.state !== 'running' || job.revision !== claim.revision
                || now >= claim.leaseExpiresAt || now < execution.completedAt) {
                throw new Error('skill-quality-claim-stale');
            }
            this.#source(loaded);
            this.#db.prepare(`INSERT INTO skill_quality_receipt
                (job_id,suite_id,session_key,packet_json,packet_digest,execution_json,
                execution_packet_digest,claim_digest,lease_audit_digest,completed_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
                    job.jobId, job.qualitySuiteId, job.rawSessionId,
                    json(packet, MAX_PACKET_CHARS), packet.packetDigest,
                    json(execution, MAX_EXECUTION_CHARS), execution.packetDigest,
                    execution.claimDigest, execution.leaseAuditDigest, execution.completedAt,
                );
            this.#writeJob(job, normalizeJob({
                ...job, state: 'succeeded', revision: 2,
                updatedAt: execution.completedAt, receiptDigest: packet.packetDigest,
            }));
            const refreshed = this.#loadSuite(job.qualitySuiteId);
            if (!refreshed) throw new Error('skill-quality-suite-missing');
            if (refreshed.jobs.every((item) => item.state === 'succeeded')) {
                const packets = refreshed.jobs.map((item) => {
                    const row = this.#db.prepare(
                        'SELECT packet_json FROM skill_quality_receipt WHERE job_id=?',
                    ).get(item.jobId) as SqlRow | undefined;
                    if (typeof row?.packet_json !== 'string') {
                        throw new Error('skill-quality-suite-packet-missing');
                    }
                    return normalizeSkillQualityPacket(JSON.parse(row.packet_json));
                });
                const evaluation = evaluateSkillQualityOffline(packets);
                this.#db.prepare(`INSERT INTO skill_quality_suite_receipt
                    (suite_id,session_key,receipt_json,evidence_digest) VALUES(?,?,?,?)`)
                    .run(job.qualitySuiteId, job.rawSessionId,
                        json(evaluation, MAX_EVALUATION_CHARS), evaluation.evidenceDigest);
            }
            const storedSuite = this.#readSuite(job.qualitySuiteId);
            const stored = storedSuite?.jobs.find((item) => item.job.jobId === job.jobId);
            if (!stored?.packet || stored.packet.packetDigest !== packet.packetDigest
                || stored.execution?.packetDigest !== execution.packetDigest) {
                throw new Error('skill-quality-finish-storage-mismatch');
            }
            return stored;
        });
    }

    markFailed(claim: SkillQualityClaim, reason: SkillQualityFailureReason): SkillQualityJobV1 {
        if (!SKILL_QUALITY_FAILURE_REASONS.includes(reason)) {
            throw new Error('skill-quality-failure-reason-invalid');
        }
        return this.#transaction(() => {
            const { job, loaded } = this.#owned(claim, false);
            if (job.state === 'failed' && job.reasonCode === reason) return job;
            if (job.state !== 'running' || job.revision !== claim.revision) {
                throw new Error('skill-quality-claim-stale');
            }
            const now = timestamp(this.#now());
            if (now < job.updatedAt) throw new Error('skill-quality-clock-regressed');
            const next = normalizeJob({
                ...job, state: 'failed', revision: 2, updatedAt: now, reasonCode: reason,
            });
            this.#writeJob(job, next);
            this.#closeSuiteQueued(job.qualitySuiteId, now);
            this.#source(loaded, false);
            return next;
        });
    }

    recoverUncertain(): number {
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_quality_job WHERE state='running'
                AND NOT EXISTS(SELECT 1 FROM skill_quality_quarantine q
                    WHERE q.job_id=skill_quality_job.job_id)
                ORDER BY job_row_id LIMIT 64`).all() as SqlRow[];
            let recovered = 0;
            const suites = new Set<string>();
            for (const row of rows) {
                if (typeof row.session_key === 'string' && this.#deleted(row.session_key)) {
                    this.#redact(session(row.session_key), now); continue;
                }
                let job: SkillQualityJobV1;
                let loaded: LoadedSuite;
                try {
                    job = parseJob(row);
                    const found = this.#loadSuite(job.qualitySuiteId);
                    if (!found) throw new Error('skill-quality-suite-missing');
                    loaded = found;
                } catch { this.#quarantine(row, now); continue; }
                this.#source(loaded, false);
                if (now < job.updatedAt) throw new Error('skill-quality-clock-regressed');
                this.#writeJob(job, normalizeJob({
                    ...job, state: 'uncertain', revision: 2, updatedAt: now,
                    reasonCode: 'skill-quality-restart-uncertain',
                }));
                suites.add(job.qualitySuiteId);
                recovered += 1;
            }
            for (const suiteId of suites) this.#closeSuiteQueued(suiteId, now);
            return recovered;
        });
    }

    status(): Readonly<{ queued: number; running: number }> {
        this.#open();
        const row = this.#db.prepare(`SELECT COALESCE(SUM(state='queued'),0) AS queued,
            COALESCE(SUM(state='running'),0) AS running FROM skill_quality_job
            WHERE NOT EXISTS(SELECT 1 FROM skill_quality_quarantine q
                WHERE q.job_id=skill_quality_job.job_id)
            AND NOT EXISTS(SELECT 1 FROM skill_quality_session_tombstone t
                WHERE t.session_key=skill_quality_job.session_key)`).get() as SqlRow;
        return Object.freeze({ queued: count(row.queued), running: count(row.running) });
    }

    #redact(rawSessionId: string, now: string): void {
        const existing = this.#db.prepare(
            'SELECT * FROM skill_quality_session_tombstone WHERE session_key=?',
        ).get(rawSessionId) as SqlRow | undefined;
        if (existing) timestamp(existing.redacted_at);
        else this.#db.prepare(
            'INSERT INTO skill_quality_session_tombstone(session_key,redacted_at) VALUES(?,?)',
        ).run(rawSessionId, now);
        this.#db.prepare('DELETE FROM skill_quality_suite WHERE session_key=?').run(rawSessionId);
        for (const table of ['suite', 'source', 'job', 'receipt', 'suite_receipt']) {
            if (this.#db.prepare(
                `SELECT 1 FROM skill_quality_${table} WHERE session_key=?`,
            ).get(rawSessionId)) throw new Error('skill-quality-redaction-storage-mismatch');
        }
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
