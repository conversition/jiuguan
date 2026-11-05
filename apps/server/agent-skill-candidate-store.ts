/** @author Codex @date 2026-10-16 @version 1.0
 * Author-only SafeProgram drafts and static-validation leases; no execution or promotion authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types as nodeTypes } from 'node:util';
import {
    AGENT_SKILL_CANDIDATE_CREATE_VERSION, AGENT_SKILL_CANDIDATE_EVENT_VERSION,
    createAgentSkillCandidate, normalizeAgentSkillBundle, normalizeAgentSkillCandidate,
    parseAgentSkillProgramBody, transitionAgentSkillCandidate,
    type AgentSkillBundleV1, type AgentSkillCandidateRecordV1,
} from '@jiuguan/skill-hub';
import {
    candidateStaticValidationClaimDigest, normalizeCandidateStaticValidationReceipt,
    readCandidateStaticValidationProof, type CandidateStaticValidationReceipt,
} from './agent-skill-candidate-static-validator.ts';
import {
    readSkillCandidateAdoptionReceipt, type SkillCandidateAdoptionReceipt,
} from './skill-candidate-adoption-store.ts';

export const AGENT_SKILL_CANDIDATE_DB_FILE = 'agent-skill-candidates.sqlite';
export const AGENT_SKILL_CANDIDATE_SCHEMA_VERSION = 3;
export const AGENT_SKILL_CANDIDATE_APPLICATION_ID = 0x4a475343;

export interface AgentSkillCandidateClaimV1 {
    readonly claimVersion: 'agent-skill-candidate-claim-v1';
    readonly jobId: string;
    readonly candidateId: string;
    readonly bundleDigest: string;
    readonly ownerId: string;
    readonly ownerToken: string;
    readonly attempt: number;
    readonly jobRevision: number;
    readonly expectedCandidateRevision: number;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
}

export interface AgentSkillCandidateJobV1 {
    readonly jobVersion: 'agent-skill-candidate-job-v1';
    readonly jobId: string;
    readonly candidateId: string;
    readonly bundleDigest: string;
    readonly kind: 'static-validation';
    readonly state: 'queued' | 'running' | 'succeeded' | 'failed';
    readonly revision: number;
    readonly attempt: number;
    readonly expectedCandidateRevision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly ownerId: string | null;
    readonly ownerToken: string | null;
    readonly claimedAt: string | null;
    readonly leaseExpiresAt: string | null;
    readonly validationEvidenceDigest: string | null;
    readonly reasonCode: string | null;
}

export interface StoredAgentSkillCandidate {
    readonly candidate: AgentSkillCandidateRecordV1;
    readonly bundle: AgentSkillBundleV1;
    readonly validation: CandidateStaticValidationReceipt | null;
}

export interface AgentSkillCandidatePage {
    readonly records: readonly AgentSkillCandidateRecordV1[];
    readonly attempted: number;
    readonly failed: number;
    readonly nextCursor: number;
    readonly hasMore: boolean;
}

type SqlRow = Record<string, unknown>;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const MAX_BUNDLE_CHARS = 131_072;
const MAX_RECORD_CHARS = 65_536;
const MAX_ATTEMPTS = 3;
/** v1：提交/验证/保留历史；v2 只追加采用回执表，既有行不改。 */
const RECORD_STATES_V1 = "('candidate','validated','rejected')";
/** v3：kill 迁移把 `killed` 纳入记录状态闭集（表级 CHECK，必须是可达状态之一）。 */
const RECORD_STATES_V3 = "('candidate','validated','rejected','killed')";
function recordTableDdl(states: string): string {
    return `CREATE TABLE skill_candidate_record (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL UNIQUE CHECK(length(candidate_id)=71),
        bundle_digest TEXT NOT NULL UNIQUE REFERENCES skill_candidate_bundle(bundle_digest),
        record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(record_json)<=65536),
        record_digest TEXT NOT NULL CHECK(length(record_digest)=71),
        revision INTEGER NOT NULL CHECK(revision>=0),
        state TEXT NOT NULL CHECK(state IN ${states})
    )`;
}
const SCHEMA_STATEMENTS_V1 = Object.freeze([
    `CREATE TABLE skill_candidate_bundle (
        bundle_id INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_digest TEXT NOT NULL UNIQUE CHECK(length(bundle_digest)=71),
        skill_id TEXT NOT NULL,
        skill_version TEXT NOT NULL,
        bundle_json TEXT NOT NULL CHECK(json_valid(bundle_json) AND length(bundle_json)<=131072),
        UNIQUE(skill_id,skill_version)
    )`,
    recordTableDdl(RECORD_STATES_V1),
    `CREATE TABLE skill_candidate_job (
        job_id TEXT NOT NULL PRIMARY KEY CHECK(length(job_id)=71),
        candidate_id TEXT NOT NULL UNIQUE REFERENCES skill_candidate_record(candidate_id),
        job_json TEXT NOT NULL CHECK(json_valid(job_json) AND length(job_json)<=65536),
        job_digest TEXT NOT NULL CHECK(length(job_digest)=71),
        state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
        revision INTEGER NOT NULL CHECK(revision>=0),
        attempt INTEGER NOT NULL CHECK(attempt>=0 AND attempt<=3),
        lease_until TEXT
    )`,
    `CREATE TABLE skill_candidate_submit_intent (
        idempotency_key TEXT NOT NULL PRIMARY KEY,
        intent_digest TEXT NOT NULL CHECK(length(intent_digest)=71),
        candidate_id TEXT NOT NULL REFERENCES skill_candidate_record(candidate_id),
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_candidate_validation_receipt (
        job_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_candidate_job(job_id),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=65536),
        evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=71)
    )`,
    `CREATE TABLE skill_candidate_job_quarantine (
        job_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_candidate_job(job_id),
        quarantined_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK(reason_code='candidate-storage-invalid')
    )`,
    'CREATE INDEX skill_candidate_job_state ON skill_candidate_job(state,lease_until)',
    ...['bundle', 'submit_intent', 'validation_receipt', 'job_quarantine'].flatMap((name) => [
        `CREATE TRIGGER skill_candidate_${name}_no_update BEFORE UPDATE ON skill_candidate_${name}
            BEGIN SELECT RAISE(ABORT,'candidate immutable packet'); END`,
        `CREATE TRIGGER skill_candidate_${name}_no_delete BEFORE DELETE ON skill_candidate_${name}
            BEGIN SELECT RAISE(ABORT,'candidate immutable packet'); END`,
    ]),
    ...['record', 'job'].map((name) =>
        `CREATE TRIGGER skill_candidate_${name}_no_delete BEFORE DELETE ON skill_candidate_${name}
            BEGIN SELECT RAISE(ABORT,'candidate retained history'); END`),
]);
/** v2（D-Q3a2c）：采用回执与候选记录绑定的持久证明；append-only。 */
const SCHEMA_STATEMENTS_V2 = Object.freeze([
    `CREATE TABLE skill_candidate_adoption_receipt (
        candidate_id TEXT NOT NULL PRIMARY KEY REFERENCES skill_candidate_record(candidate_id),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=65536),
        receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=71),
        consumed_at TEXT NOT NULL
    )`,
    `CREATE TRIGGER skill_candidate_adoption_receipt_no_update BEFORE UPDATE ON skill_candidate_adoption_receipt
        BEGIN SELECT RAISE(ABORT,'candidate immutable packet'); END`,
    `CREATE TRIGGER skill_candidate_adoption_receipt_no_delete BEFORE DELETE ON skill_candidate_adoption_receipt
        BEGIN SELECT RAISE(ABORT,'candidate immutable packet'); END`,
]);
/** v2 全量 schema（用于 v2→v3 迁移前的一致性核对）。 */
const SCHEMA_STATEMENTS_V2_FULL = Object.freeze([...SCHEMA_STATEMENTS_V1, ...SCHEMA_STATEMENTS_V2]);
const SCHEMA_STATEMENTS = Object.freeze([
    ...SCHEMA_STATEMENTS_V1.map((statement) =>
        (statement.startsWith('CREATE TABLE skill_candidate_record (')
            ? recordTableDdl(RECORD_STATES_V3) : statement)),
    ...SCHEMA_STATEMENTS_V2,
]);


function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}


function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('candidate-timestamp-invalid');
    return value;
}


function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new Error('candidate-integer-invalid');
    }
    return Number(value);
}


function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('candidate-token-invalid');
    return value;
}


function digest(value: unknown): string {
    if (typeof value !== 'string' || !HASH.test(value)) throw new Error('candidate-digest-invalid');
    return value;
}


function record(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('candidate-record-invalid');
    }
    if (Reflect.ownKeys(input).length !== Object.keys(input).length) throw new Error('candidate-fields-invalid');
    for (const key of Object.keys(input)) {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) {
            throw new Error('candidate-fields-invalid');
        }
    }
    return input as Record<string, unknown>;
}


function passiveData(input: unknown, seen = new Set<object>(), depth = 0,
    budget = { nodes: 0, characters: 0 }): void {
    budget.nodes += 1;
    if (depth > 32 || budget.nodes > 20_000) throw new Error('candidate-packet-too-large');
    if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return;
    if (typeof input === 'string') {
        budget.characters += input.length;
        if (budget.characters > MAX_BUNDLE_CHARS) throw new Error('candidate-packet-too-large');
        return;
    }
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || seen.has(input)) {
        throw new Error('candidate-passive-data-required');
    }
    seen.add(input);
    try {
        if (Array.isArray(input)) {
            if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 20_000
                || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('candidate-fields-invalid');
            for (let index = 0; index < input.length; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
                    throw new Error('candidate-fields-invalid');
                }
                passiveData(descriptor.value, seen, depth + 1, budget);
            }
        } else {
            for (const value of Object.values(record(input))) passiveData(value, seen, depth + 1, budget);
        }
    } finally { seen.delete(input); }
}


function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
        throw new Error('candidate-fields-invalid');
    }
}


function boundedJson(value: unknown, maximum: number): string {
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || json.length > maximum) throw new Error('candidate-packet-too-large');
    return json;
}


function normalizeBundle(input: unknown): AgentSkillBundleV1 {
    passiveData(input);
    boundedJson(input, MAX_BUNDLE_CHARS);
    const bundle = normalizeAgentSkillBundle(input);
    const manifest = bundle.header.manifest;
    if (bundle.body.length > 65_536 || manifest.owner !== 'author'
        || !['filesystem', 'imported'].includes(manifest.sourceType) || manifest.scope.kind !== 'global'
        || JSON.stringify(manifest.contentModes) !== '["nsf"]' || manifest.riskTier !== 'advisory'
        || manifest.autoPromotion || manifest.desiredTools.length || manifest.writableArtifactKinds.length
        || manifest.limits.maxModelCalls !== 0 || manifest.limits.maxToolCalls !== 0) {
        throw new Error('candidate-draft-policy-denied');
    }
    if (parseAgentSkillProgramBody(bundle.body).kind !== manifest.kind) {
        throw new Error('candidate-program-kind-mismatch');
    }
    return bundle;
}


function schemaSql(db: DatabaseSync): string[] {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SqlRow[])
        .map((row) => {
            if (typeof row.sql !== 'string') throw new Error('candidate-schema-invalid');
            return row.sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
        }).sort();
}


function pragma(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
    return count((db.prepare(`PRAGMA ${name}`).get() as SqlRow | undefined)?.[name]);
}


/** Exact read-only contract: snapshots must not repair unknown schemas or invent defaults. */
export function inspectAgentSkillCandidateSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== AGENT_SKILL_CANDIDATE_APPLICATION_ID
        || pragma(db, 'user_version') !== AGENT_SKILL_CANDIDATE_SCHEMA_VERSION) {
        throw new Error('candidate-schema-metadata-mismatch');
    }
    const expected = SCHEMA_STATEMENTS.map((value) =>
        value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(expected)) throw new Error('candidate-schema-mismatch');
}


function initialize(db: DatabaseSync): void {
    const applicationId = pragma(db, 'application_id');
    let version = pragma(db, 'user_version');
    if (applicationId || version) {
        if (applicationId !== AGENT_SKILL_CANDIDATE_APPLICATION_ID) {
            throw new Error('candidate-schema-metadata-mismatch');
        }
        if (version === 1) { migrateV1ToV2(db); version = 2; }
        if (version === 2) { migrateV2ToV3(db); version = 3; }
        inspectAgentSkillCandidateSchema(db);
        return;
    }
    if (schemaSql(db).length) throw new Error('candidate-uninitialized-not-empty');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${AGENT_SKILL_CANDIDATE_APPLICATION_ID}`);
        for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
        db.exec(`PRAGMA user_version=${AGENT_SKILL_CANDIDATE_SCHEMA_VERSION}`);
        inspectAgentSkillCandidateSchema(db);
        db.exec('COMMIT');
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
    }
}

/** v1 → v2：只追加采用回执表与其不可变触发器。 */
function migrateV1ToV2(db: DatabaseSync): void {
    const expectedV1 = SCHEMA_STATEMENTS_V1.map((value) =>
        value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(expectedV1)) {
        throw new Error('candidate-schema-mismatch');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const statement of SCHEMA_STATEMENTS_V2) db.exec(statement);
        db.exec('PRAGMA user_version=2');
        db.exec('COMMIT');
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
    }
}

/**
 * v2 → v3：`skill_candidate_record.state` 的 CHECK 闭集加入 `killed`。
 *
 * SQLite 改不了 CHECK，只能重建表；重建期间必须临时关外键（job/intent/receipt 都引用 record），
 * 提交后立刻 `foreign_key_check` 再打开，任何不一致都 fail closed。
 * 用「先改名再建同名新表」而不是「建新名再 rename」，是因为 rename 会把 DDL 改写成带引号的
 * `CREATE TABLE "x"`，与 schema 快照比对永远不相等。
 */
function migrateV2ToV3(db: DatabaseSync): void {
    const expectedV2 = SCHEMA_STATEMENTS_V2_FULL.map((value) =>
        value.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
    if (JSON.stringify(schemaSql(db)) !== JSON.stringify(expectedV2)) {
        throw new Error('candidate-schema-mismatch');
    }
    // legacy_alter_table：否则 RENAME 会连带改写 job/intent/receipt 里的 FK 目标，
    // 新表建好后那些参照就指向一个已被 DROP 的名字。
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec('ALTER TABLE skill_candidate_record RENAME TO skill_candidate_record_v2');
        db.exec(recordTableDdl(RECORD_STATES_V3));
        db.exec(`INSERT INTO skill_candidate_record
            (record_id,candidate_id,bundle_digest,record_json,record_digest,revision,state)
            SELECT record_id,candidate_id,bundle_digest,record_json,record_digest,revision,state
            FROM skill_candidate_record_v2`);
        db.exec('DROP TABLE skill_candidate_record_v2');
        // 改名把原表的 no_delete 触发器带走了；新表要按同名重建，schema 快照才对得上。
        db.exec(`CREATE TRIGGER skill_candidate_record_no_delete BEFORE DELETE ON skill_candidate_record
            BEGIN SELECT RAISE(ABORT,'candidate retained history'); END`);
        db.exec('PRAGMA user_version=3');
        db.exec('COMMIT');
    } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON');
        throw error;
    }
    const broken = db.prepare('PRAGMA foreign_key_check').all() as SqlRow[];
    db.exec('PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON');
    if (broken.length > 0) throw new Error('candidate-schema-foreign-key-broken');
}


function existingStat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}


function privateDirectory(path: string): void {
    if (path === parse(path).root) throw new Error('candidate-directory-invalid');
    let current = path;
    while (current !== dirname(current)) {
        const stat = existingStat(current);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('candidate-directory-invalid');
        current = dirname(current);
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}


function regularFile(path: string): void {
    const stat = existingStat(path);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('candidate-file-invalid');
}


export function agentSkillCandidateValidationJobId(candidateId: string, bundleDigest: string): string {
    return hash(['candidate-static-validation-v1', candidateId, bundleDigest]);
}

const jobIdOf = agentSkillCandidateValidationJobId;


function normalizeJob(input: unknown): AgentSkillCandidateJobV1 {
    const value = record(input);
    exactKeys(value, ['jobVersion', 'jobId', 'candidateId', 'bundleDigest', 'kind', 'state', 'revision', 'attempt',
        'expectedCandidateRevision', 'createdAt', 'updatedAt', 'ownerId', 'ownerToken', 'claimedAt', 'leaseExpiresAt',
        'validationEvidenceDigest', 'reasonCode']);
    const job: AgentSkillCandidateJobV1 = Object.freeze({
        jobVersion: 'agent-skill-candidate-job-v1', jobId: digest(value.jobId),
        candidateId: digest(value.candidateId), bundleDigest: digest(value.bundleDigest), kind: 'static-validation',
        state: value.state as AgentSkillCandidateJobV1['state'], revision: count(value.revision),
        attempt: count(value.attempt, 0, MAX_ATTEMPTS),
        expectedCandidateRevision: count(value.expectedCandidateRevision),
        createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt),
        ownerId: value.ownerId === null ? null : token(value.ownerId),
        ownerToken: value.ownerToken === null ? null : token(value.ownerToken),
        claimedAt: value.claimedAt === null ? null : timestamp(value.claimedAt),
        leaseExpiresAt: value.leaseExpiresAt === null ? null : timestamp(value.leaseExpiresAt),
        validationEvidenceDigest: value.validationEvidenceDigest === null
            ? null : digest(value.validationEvidenceDigest),
        reasonCode: value.reasonCode === null ? null : token(value.reasonCode),
    });
    if (value.jobVersion !== job.jobVersion || value.kind !== job.kind
        || !['queued', 'running', 'succeeded', 'failed'].includes(job.state)
        || job.jobId !== jobIdOf(job.candidateId, job.bundleDigest) || job.updatedAt < job.createdAt
        || job.expectedCandidateRevision !== 0 || job.revision < job.attempt) throw new Error('candidate-job-invalid');
    const leased = job.ownerId !== null && job.ownerToken !== null && job.leaseExpiresAt !== null
        && job.claimedAt !== null;
    if (job.state === 'queued' && (leased || job.ownerId !== null || job.ownerToken !== null
        || job.claimedAt !== null || job.leaseExpiresAt !== null
        || job.validationEvidenceDigest !== null || job.reasonCode !== null
        || job.attempt >= MAX_ATTEMPTS)
        || job.state === 'running' && (!leased || job.attempt < 1 || job.claimedAt !== job.updatedAt
            || job.leaseExpiresAt! <= job.updatedAt
            || job.validationEvidenceDigest !== null || job.reasonCode !== null)
        || job.state === 'succeeded' && (!leased || job.validationEvidenceDigest === null || job.reasonCode === null)
        || job.state === 'failed' && (job.reasonCode === null
            || job.validationEvidenceDigest === null && (job.reasonCode !== 'restart-attempt-limit'
                || job.attempt !== MAX_ATTEMPTS || leased))) throw new Error('candidate-job-state-invalid');
    return job;
}


function parseJob(row: SqlRow): AgentSkillCandidateJobV1 {
    if (typeof row.job_json !== 'string' || row.job_json.length > MAX_RECORD_CHARS) {
        throw new Error('candidate-job-packet-invalid');
    }
    const job = normalizeJob(JSON.parse(row.job_json));
    if (JSON.stringify(job) !== row.job_json || hash(job) !== row.job_digest || job.jobId !== row.job_id
        || job.candidateId !== row.candidate_id || job.state !== row.state || job.revision !== row.revision
        || job.attempt !== row.attempt || job.leaseExpiresAt !== row.lease_until) {
        throw new Error('candidate-job-corrupt');
    }
    return job;
}


/** Persistent bounded static work, independent of runtime Skill catalog and rollout controls. */
export class AgentSkillCandidateStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #claims = new WeakSet<object>();
    #closed = false;

    constructor(options: { readonly dataDir: string; readonly now?: () => string }) {
        if (typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
            throw new Error('candidate-directory-invalid');
        }
        const directory = resolve(options.dataDir);
        privateDirectory(directory);
        const path = join(directory, AGENT_SKILL_CANDIDATE_DB_FILE);
        for (const suffix of ['', '-wal', '-shm', '-journal']) regularFile(`${path}${suffix}`);
        this.#db = new DatabaseSync(path);
        try {
            this.#db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON');
            initialize(this.#db);
            this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
            for (const suffix of ['', '-wal', '-shm']) {
                const file = `${path}${suffix}`;
                regularFile(file);
                if (existingStat(file)) {
                    try { chmodSync(file, 0o600); }
                    catch (error) { if (process.platform !== 'win32') throw error; }
                }
            }
        } catch (error) { this.#db.close(); throw error; }
        this.#now = options.now ?? (() => new Date().toISOString());
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error('candidate-store-closed');
    }

    #transaction<T>(work: () => T, write = true): T {
        this.#assertOpen();
        if (this.#db.isTransaction) throw new Error('candidate-transaction-nested');
        this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            const result = work();
            if (!this.#db.isTransaction) throw new Error('candidate-business-transaction-lost');
            this.#db.exec('COMMIT');
            return result;
        } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    }

    #bundle(bundleDigest: string): AgentSkillBundleV1 {
        const row = this.#db.prepare('SELECT * FROM skill_candidate_bundle WHERE bundle_digest=?')
            .get(bundleDigest) as SqlRow | undefined;
        if (!row || typeof row.bundle_json !== 'string' || row.bundle_json.length > MAX_BUNDLE_CHARS) {
            throw new Error('candidate-bundle-missing-or-invalid');
        }
        const bundle = normalizeBundle(JSON.parse(row.bundle_json));
        if (JSON.stringify(bundle) !== row.bundle_json || bundle.bundleDigest !== bundleDigest
            || bundle.header.manifest.skillId !== row.skill_id
            || bundle.header.manifest.version !== row.skill_version) {
            throw new Error('candidate-bundle-corrupt');
        }
        return bundle;
    }

    #job(jobId: string): AgentSkillCandidateJobV1 | null {
        const row = this.#db.prepare('SELECT * FROM skill_candidate_job WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        return row ? parseJob(row) : null;
    }

    #receipt(jobId: string): CandidateStaticValidationReceipt | null {
        const row = this.#db.prepare('SELECT * FROM skill_candidate_validation_receipt WHERE job_id=?')
            .get(jobId) as SqlRow | undefined;
        if (!row) return null;
        if (typeof row.receipt_json !== 'string' || row.receipt_json.length > MAX_RECORD_CHARS) {
            throw new Error('candidate-validation-packet-invalid');
        }
        const receipt = normalizeCandidateStaticValidationReceipt(JSON.parse(row.receipt_json));
        if (JSON.stringify(receipt) !== row.receipt_json || receipt.evidenceDigest !== row.evidence_digest
            || receipt.jobId !== jobId) throw new Error('candidate-validation-packet-corrupt');
        return receipt;
    }

    #readCandidate(candidateId: string): StoredAgentSkillCandidate | null {
        const row = this.#db.prepare('SELECT * FROM skill_candidate_record WHERE candidate_id=?')
            .get(candidateId) as SqlRow | undefined;
        if (!row) return null;
        if (typeof row.record_json !== 'string' || row.record_json.length > MAX_RECORD_CHARS) {
            throw new Error('candidate-lifecycle-packet-invalid');
        }
        const candidate = normalizeAgentSkillCandidate(JSON.parse(row.record_json));
        const bundle = this.#bundle(candidate.bundleDigest);
        if (JSON.stringify(candidate) !== row.record_json || hash(candidate) !== row.record_digest
            || candidate.candidateId !== candidateId || candidate.bundleDigest !== row.bundle_digest
            || candidate.revision !== row.revision || candidate.state !== row.state
            || JSON.stringify(candidate.header) !== JSON.stringify(bundle.header)
            || candidate.operationalReplayEvidenceDigest !== null || candidate.revision > 3) {
            throw new Error('candidate-lifecycle-packet-corrupt');
        }
        // (revision, state) 必须是真实可达的组合：记录是数据，不能让伪造的对子冒充已 kill 的候选。
        const reachable = candidate.revision === 0 ? candidate.state === 'candidate'
            : candidate.revision === 1 ? candidate.state === 'validated' || candidate.state === 'rejected'
                : candidate.revision === 2 ? candidate.state === 'validated' || candidate.state === 'killed'
                    : candidate.revision === 3 ? candidate.state === 'killed'
                        : false;
        if (!reachable) throw new Error('candidate-lifecycle-packet-corrupt');
        if (candidate.parentBundleDigest !== null
            && this.#bundle(candidate.parentBundleDigest).header.manifest.skillId !== bundle.header.manifest.skillId) {
            throw new Error('candidate-parent-binding-invalid');
        }
        const job = this.#job(jobIdOf(candidateId, candidate.bundleDigest));
        if (!job || job.bundleDigest !== candidate.bundleDigest || job.createdAt !== candidate.createdAt) {
            throw new Error('candidate-job-binding-invalid');
        }
        const validation = this.#receipt(job.jobId);
        if (!validation && (candidate.revision !== 0 || candidate.state !== 'candidate'
            || job.validationEvidenceDigest !== null || job.state === 'succeeded')) {
            throw new Error('candidate-validation-missing');
        }
        if (validation && (validation.candidateId !== candidateId || validation.bundleDigest !== candidate.bundleDigest
            || validation.evidenceDigest !== job.validationEvidenceDigest || validation.attempt !== job.attempt
            || validation.ownerToken !== job.ownerToken || validation.jobRevision + 1 !== job.revision
            || validation.expectedCandidateRevision !== 0
            // 绑定的是**校验事件自身的时间**，不是 candidate.updatedAt：
            // 采用（adoption）会把 updatedAt 推进到 adoptedAt，用 updatedAt 比会让
            // 「校验后过一会儿才采用」的真实路径在回读时被误判为记录损坏。
            || validation.validatedAt !== candidate.history[0]?.occurredAt
            || validation.reasonCode !== job.reasonCode
            || (candidate.revision !== 1 && candidate.revision !== 2 && candidate.revision !== 3)
            || validation.validatedAt !== job.updatedAt || job.claimedAt === null
            || validation.validatedAt < job.claimedAt || validation.validatedAt >= job.leaseExpiresAt!
            || validation.claimDigest !== candidateStaticValidationClaimDigest({
                claimVersion: 'agent-skill-candidate-claim-v1', jobId: job.jobId,
                candidateId, bundleDigest: job.bundleDigest, ownerId: job.ownerId, ownerToken: job.ownerToken,
                attempt: job.attempt, jobRevision: job.revision - 1,
                expectedCandidateRevision: job.expectedCandidateRevision,
                claimedAt: job.claimedAt, leaseExpiresAt: job.leaseExpiresAt,
            })
            || candidate.history[0]?.eventType !== 'validation-result'
            || candidate.history[0]?.evidenceDigest !== validation.evidenceDigest
            // kill 之后 state 变成 killed，但校验回执仍然有效：只有「校验通过」的候选才可能被杀。
            || (validation.passed
                ? candidate.state !== 'validated' && candidate.state !== 'killed'
                : candidate.state !== 'rejected')
            || job.state !== (validation.passed ? 'succeeded' : 'failed'))) {
            throw new Error('candidate-validation-binding-invalid');
        }
        return Object.freeze({ candidate, bundle, validation });
    }

    #writeJob(previous: AgentSkillCandidateJobV1, next: AgentSkillCandidateJobV1): void {
        const value = normalizeJob(next);
        const result = this.#db.prepare(`UPDATE skill_candidate_job
            SET job_json=?,job_digest=?,state=?,revision=?,attempt=?,lease_until=?
            WHERE job_id=? AND revision=? AND job_digest=?`)
            .run(boundedJson(value, MAX_RECORD_CHARS), hash(value), value.state, value.revision, value.attempt,
                value.leaseExpiresAt, previous.jobId, previous.revision, hash(previous));
        if (Number(result.changes) !== 1 || JSON.stringify(this.#job(value.jobId)) !== JSON.stringify(value)) {
            throw new Error('candidate-job-revision-conflict');
        }
    }

    #quarantine(row: SqlRow, now: string): void {
        if (typeof row.job_id !== 'string' || row.job_id.length > 240) {
            throw new Error('candidate-quarantine-key-invalid');
        }
        this.#db.prepare(`INSERT INTO skill_candidate_job_quarantine(job_id,quarantined_at,reason_code)
            VALUES(?,?,'candidate-storage-invalid')`).run(row.job_id, now);
        const retained = this.#db.prepare('SELECT * FROM skill_candidate_job_quarantine WHERE job_id=?')
            .get(row.job_id) as SqlRow | undefined;
        if (retained?.quarantined_at !== now || retained.reason_code !== 'candidate-storage-invalid') {
            throw new Error('candidate-quarantine-storage-mismatch');
        }
    }

    submit(input: { readonly bundle: unknown; readonly parentBundleDigest: string | null; readonly createdAt: string },
        idempotencyKey: string): Readonly<{ candidate: AgentSkillCandidateRecordV1; job: AgentSkillCandidateJobV1 }> {
        this.#assertOpen();
        const value = record(input);
        exactKeys(value, ['bundle', 'parentBundleDigest', 'createdAt']);
        const bundle = normalizeBundle(value.bundle);
        const parentBundleDigest = value.parentBundleDigest === null ? null : digest(value.parentBundleDigest);
        const createdAt = timestamp(value.createdAt);
        const key = token(idempotencyKey);
        if (createdAt > timestamp(this.#now())) throw new Error('candidate-created-in-future');
        const candidate = createAgentSkillCandidate({
            createVersion: AGENT_SKILL_CANDIDATE_CREATE_VERSION,
            header: bundle.header, bundleDigest: bundle.bundleDigest, parentBundleDigest, createdAt
        });
        const intentDigest = hash({ bundleDigest: bundle.bundleDigest, parentBundleDigest, createdAt });
        return this.#transaction(() => {
            const intent = this.#db.prepare('SELECT * FROM skill_candidate_submit_intent WHERE idempotency_key=?')
                .get(key) as SqlRow | undefined;
            if (intent && (intent.intent_digest !== intentDigest || intent.candidate_id !== candidate.candidateId
                || intent.created_at !== createdAt)) throw new Error('candidate-submit-idempotency-conflict');
            if (parentBundleDigest !== null
                && this.#bundle(parentBundleDigest).header.manifest.skillId !== bundle.header.manifest.skillId) {
                throw new Error('candidate-parent-skill-mismatch');
            }
            const existing = this.#readCandidate(candidate.candidateId);
            if (existing && (existing.candidate.createdAt !== createdAt
                || JSON.stringify(existing.bundle) !== JSON.stringify(bundle))) {
                throw new Error('candidate-immutable-intent-conflict');
            }
            if (!existing) {
                this.#db.prepare(`INSERT INTO skill_candidate_bundle(bundle_digest,skill_id,skill_version,bundle_json)
                    VALUES(?,?,?,?)`).run(bundle.bundleDigest, bundle.header.manifest.skillId,
                    bundle.header.manifest.version, boundedJson(bundle, MAX_BUNDLE_CHARS));
                this.#db.prepare(`INSERT INTO skill_candidate_record
                    (candidate_id,bundle_digest,record_json,record_digest,revision,state) VALUES(?,?,?,?,?,?)`)
                    .run(candidate.candidateId, bundle.bundleDigest, boundedJson(candidate, MAX_RECORD_CHARS),
                        hash(candidate), candidate.revision, candidate.state);
                const job: AgentSkillCandidateJobV1 = normalizeJob({
                    jobVersion: 'agent-skill-candidate-job-v1',
                    jobId: jobIdOf(candidate.candidateId, bundle.bundleDigest),
                    candidateId: candidate.candidateId, bundleDigest: bundle.bundleDigest, kind: 'static-validation',
                    state: 'queued', revision: 0, attempt: 0, expectedCandidateRevision: 0,
                    createdAt, updatedAt: createdAt,
                    ownerId: null, ownerToken: null, claimedAt: null, leaseExpiresAt: null,
                    validationEvidenceDigest: null, reasonCode: null,
                });
                this.#db.prepare(`INSERT INTO skill_candidate_job
                    (job_id,candidate_id,job_json,job_digest,state,revision,attempt,lease_until)
                    VALUES(?,?,?,?,?,?,?,?)`)
                    .run(job.jobId, job.candidateId, boundedJson(job, MAX_RECORD_CHARS), hash(job),
                        job.state, job.revision, job.attempt, null);
            }
            if (!intent) this.#db.prepare(`INSERT INTO skill_candidate_submit_intent
                (idempotency_key,intent_digest,candidate_id,created_at) VALUES(?,?,?,?)`)
                .run(key, intentDigest, candidate.candidateId, createdAt);
            const retainedIntent = this.#db.prepare(
                'SELECT * FROM skill_candidate_submit_intent WHERE idempotency_key=?',
            ).get(key) as SqlRow | undefined;
            if (!retainedIntent || retainedIntent.intent_digest !== intentDigest
                || retainedIntent.candidate_id !== candidate.candidateId || retainedIntent.created_at !== createdAt) {
                throw new Error('candidate-submit-intent-storage-mismatch');
            }
            const result = this.#readCandidate(candidate.candidateId);
            if (!result) throw new Error('candidate-submit-insert-missing');
            const job = this.#job(jobIdOf(candidate.candidateId, bundle.bundleDigest));
            if (!job) throw new Error('candidate-submit-job-missing');
            return Object.freeze({ candidate: result.candidate, job });
        });
    }

    readCandidate(candidateId: string): StoredAgentSkillCandidate | null {
        this.#assertOpen();
        digest(candidateId);
        return this.#transaction(() => this.#readCandidate(candidateId), false);
    }

    getJob(jobId: string): AgentSkillCandidateJobV1 | null {
        this.#assertOpen();
        digest(jobId);
        return this.#transaction(() => {
            const job = this.#job(jobId);
            if (job && !this.#readCandidate(job.candidateId)) throw new Error('candidate-job-owner-missing');
            return job;
        }, false);
    }

    claimNext(ownerId: string, leaseMs = 30_000): AgentSkillCandidateClaimV1 | null {
        token(ownerId);
        count(leaseMs, 1, 300_000);
        const now = timestamp(this.#now());
        const claim = this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_candidate_job
                    WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM skill_candidate_job_quarantine AS quarantine
                        WHERE quarantine.job_id=skill_candidate_job.job_id)
                    ORDER BY rowid LIMIT 64`).all() as SqlRow[];
            for (const row of rows) {
                let job: AgentSkillCandidateJobV1;
                try {
                    job = parseJob(row);
                    const source = this.#readCandidate(job.candidateId);
                    if (!source || source.candidate.revision !== job.expectedCandidateRevision
                        || source.candidate.state !== 'candidate') throw new Error('candidate-storage-invalid');
                } catch { this.#quarantine(row, now); continue; }
                if (now < job.updatedAt) throw new Error('candidate-clock-regressed');
                const next = normalizeJob({
                    ...job, state: 'running', revision: job.revision + 1,
                    attempt: job.attempt + 1, updatedAt: now, ownerId, ownerToken: `lease:${randomUUID()}`,
                    claimedAt: now, leaseExpiresAt: timestamp(new Date(Date.parse(now) + leaseMs).toISOString())
                });
                this.#writeJob(job, next);
                return Object.freeze({
                    claimVersion: 'agent-skill-candidate-claim-v1' as const,
                    jobId: next.jobId, candidateId: next.candidateId, bundleDigest: next.bundleDigest,
                    ownerId, ownerToken: next.ownerToken!, attempt: next.attempt, jobRevision: next.revision,
                    expectedCandidateRevision: next.expectedCandidateRevision, claimedAt: now,
                    leaseExpiresAt: next.leaseExpiresAt!
                });
            }
            return null;
        });
        if (claim) this.#claims.add(claim);
        return claim;
    }

    finishValidation(claim: AgentSkillCandidateClaimV1, proof: unknown): StoredAgentSkillCandidate {
        this.#assertOpen();
        if (!claim || !this.#claims.has(claim)) throw new Error('candidate-claim-brand-invalid');
        const receipt = readCandidateStaticValidationProof(proof);
        if (['candidate-static-input-invalid', 'candidate-static-binding-mismatch', 'candidate-static-claim-expired']
            .includes(receipt.reasonCode)) throw new Error('candidate-proof-not-a-candidate-result');
        if (receipt.jobId !== claim.jobId || receipt.candidateId !== claim.candidateId
            || receipt.bundleDigest !== claim.bundleDigest || receipt.attempt !== claim.attempt
            || receipt.jobRevision !== claim.jobRevision || receipt.ownerToken !== claim.ownerToken
            || receipt.expectedCandidateRevision !== claim.expectedCandidateRevision
            || receipt.claimDigest !== candidateStaticValidationClaimDigest(claim)
            || receipt.validatedAt < claim.claimedAt || receipt.validatedAt >= claim.leaseExpiresAt) {
            throw new Error('candidate-proof-binding-mismatch');
        }
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            if (this.#db.prepare('SELECT 1 FROM skill_candidate_job_quarantine WHERE job_id=?').get(claim.jobId)) {
                throw new Error('candidate-job-quarantined');
            }
            const source = this.#readCandidate(claim.candidateId);
            const job = this.#job(claim.jobId);
            if (!source || !job) throw new Error('candidate-claim-source-missing');
            if (source.validation) {
                if (source.validation.evidenceDigest !== receipt.evidenceDigest
                    || JSON.stringify(source.validation) !== JSON.stringify(receipt)) {
                    throw new Error('candidate-validation-result-conflict');
                }
                return source;
            }
            if (job.state !== 'running' || job.revision !== claim.jobRevision || job.attempt !== claim.attempt
                || job.ownerId !== claim.ownerId || job.ownerToken !== claim.ownerToken
                || job.claimedAt !== claim.claimedAt || job.leaseExpiresAt !== claim.leaseExpiresAt
                || job.expectedCandidateRevision !== claim.expectedCandidateRevision
                || source.candidate.revision !== claim.expectedCandidateRevision
                || source.candidate.state !== 'candidate'
                || now >= claim.leaseExpiresAt || now < receipt.validatedAt) {
                throw new Error('candidate-claim-expired-or-stale');
            }
            const candidate = transitionAgentSkillCandidate(source.candidate, {
                eventVersion: AGENT_SKILL_CANDIDATE_EVENT_VERSION, type: 'validation-result',
                expectedRevision: claim.expectedCandidateRevision, occurredAt: receipt.validatedAt,
                evidenceDigest: receipt.evidenceDigest, passed: receipt.passed, reasonCode: receipt.reasonCode,
            });
            this.#db.prepare(`INSERT INTO skill_candidate_validation_receipt(job_id,receipt_json,evidence_digest)
                VALUES(?,?,?)`).run(job.jobId, boundedJson(receipt, MAX_RECORD_CHARS), receipt.evidenceDigest);
            const changed = this.#db.prepare(`UPDATE skill_candidate_record
                SET record_json=?,record_digest=?,revision=?,state=?
                WHERE candidate_id=? AND revision=? AND record_digest=?`)
                .run(boundedJson(candidate, MAX_RECORD_CHARS), hash(candidate), candidate.revision, candidate.state,
                    candidate.candidateId, source.candidate.revision, hash(source.candidate));
            if (Number(changed.changes) !== 1) throw new Error('candidate-revision-conflict');
            this.#writeJob(job, normalizeJob({
                ...job, state: receipt.passed ? 'succeeded' : 'failed',
                revision: job.revision + 1, updatedAt: receipt.validatedAt,
                validationEvidenceDigest: receipt.evidenceDigest, reasonCode: receipt.reasonCode
            }));
            const result = this.#readCandidate(candidate.candidateId);
            if (!result || result.validation?.evidenceDigest !== receipt.evidenceDigest) {
                throw new Error('candidate-validation-write-mismatch');
            }
            return result;
        });
    }

    /**
     * D-Q3a2c：原子消费采用回执。要求记录当前为 validated/rev1 且校验证据与回执一致，
     * 以 adoption 事件推进到 revision=2（state 不变），同事务写回执并回读。
     * 已消费且回执摘要相同 ⇒ 幂等返回；摘要不同 ⇒ 冲突。
     */
    consumeAdoptionReceipt(input: unknown): StoredAgentSkillCandidate {
        const receipt = this.#adoptionReceipt(input);
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const source = this.#readCandidate(receipt.candidateId);
            if (!source) throw new Error('candidate-adoption-record-missing');
            const existing = this.#adoptionRow(receipt.candidateId);
            if (source.candidate.revision === 2 && existing?.receipt_digest === receipt.adoptionDigest) {
                return this.#readCandidate(receipt.candidateId)!;
            }
            if (source.candidate.revision === 2 || existing) {
                throw new Error('candidate-adoption-revision-conflict');
            }
            if (source.candidate.state !== 'validated' || source.candidate.revision !== 1
                || source.candidate.validationEvidenceDigest
                !== receipt.candidateValidationEvidenceDigest) {
                throw new Error('candidate-adoption-binding-mismatch');
            }
            if (now < receipt.adoptedAt) throw new Error('candidate-adoption-clock-regressed');
            const candidate = transitionAgentSkillCandidate(source.candidate, {
                eventVersion: AGENT_SKILL_CANDIDATE_EVENT_VERSION, type: 'adoption',
                expectedRevision: 1, occurredAt: receipt.adoptedAt,
                evidenceDigest: receipt.adoptionDigest,
            });
            const changed = this.#db.prepare(`UPDATE skill_candidate_record
                SET record_json=?,record_digest=?,revision=?,state=?
                WHERE candidate_id=? AND revision=? AND record_digest=?`)
                .run(boundedJson(candidate, MAX_RECORD_CHARS), hash(candidate), candidate.revision, candidate.state,
                    candidate.candidateId, source.candidate.revision, hash(source.candidate));
            if (Number(changed.changes) !== 1) throw new Error('candidate-revision-conflict');
            this.#db.prepare(`INSERT INTO skill_candidate_adoption_receipt
                (candidate_id,receipt_json,receipt_digest,consumed_at) VALUES(?,?,?,?)`)
                .run(receipt.candidateId, boundedJson(receipt, MAX_RECORD_CHARS), receipt.adoptionDigest, now);
            const stored = this.#readCandidate(receipt.candidateId);
            const storedReceipt = this.#adoptionRow(receipt.candidateId);
            const last = stored?.candidate.history.at(-1);
            if (!stored || stored.candidate.revision !== 2 || stored.candidate.state !== 'validated'
                || !storedReceipt || storedReceipt.receipt_digest !== receipt.adoptionDigest
                || last?.eventType !== 'adoption' || last?.evidenceDigest !== receipt.adoptionDigest) {
                throw new Error('candidate-adoption-write-mismatch');
            }
            return stored;
        });
    }

    /**
     * 失败只 Kill 当前 Candidate：`validated`（rev1 或 rev2）→ `killed`。
     *
     * 边界：
     * 1) 只接受 `expectedRevision` 与当前记录完全一致的 CAS，不猜「大概就是它」；
     * 2) 事件 append-only，记录只推进一格，历史一行不删；
     * 3) `reasonCode` 必填（上限 64 字符闭集词表外的自由短语也可，但必须可追溯）；
     * 4) 已 killed / rejected / 记录漂移一律拒绝，不产生半套状态；
     * 5) kill 之后该候选不能再被 promote 或作为回滚目标（Channel 侧按 state 拒）。
     */
    kill(candidateIdInput: unknown, input: unknown): StoredAgentSkillCandidate {
        if (typeof candidateIdInput !== 'string' || !HASH.test(candidateIdInput)) {
            throw new Error('candidate-id-invalid');
        }
        const value = record(input);
        exactKeys(value, ['expectedRevision', 'reasonCode']);
        const expected = count(value.expectedRevision, 1, 2);
        const reasonCode = token(value.reasonCode);
        if ([...reasonCode].length > 64) throw new Error('candidate-kill-reason-invalid');
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const source = this.#readCandidate(candidateIdInput);
            if (!source) throw new Error('candidate-kill-record-missing');
            if (source.candidate.state !== 'validated' || source.candidate.revision !== expected) {
                throw new Error('candidate-kill-revision-conflict');
            }
            if (now < source.candidate.updatedAt) throw new Error('candidate-clock-regressed');
            const evidenceDigest = hash({
                killVersion: 'candidate-kill-v1', candidateId: candidateIdInput,
                expectedRevision: expected, reasonCode, occurredAt: now,
            });
            const candidate = transitionAgentSkillCandidate(source.candidate, {
                eventVersion: AGENT_SKILL_CANDIDATE_EVENT_VERSION,
                type: 'kill',
                expectedRevision: expected,
                occurredAt: now,
                evidenceDigest,
                reasonCode,
            });
            const changed = this.#db.prepare(`UPDATE skill_candidate_record
                SET record_json=?,record_digest=?,revision=?,state=?
                WHERE candidate_id=? AND revision=? AND record_digest=?`)
                .run(boundedJson(candidate, MAX_RECORD_CHARS), hash(candidate), candidate.revision, candidate.state,
                    candidate.candidateId, source.candidate.revision, hash(source.candidate));
            if (Number(changed.changes) !== 1) throw new Error('candidate-revision-conflict');
            const stored = this.#readCandidate(candidateIdInput);
            const last = stored?.candidate.history.at(-1);
            if (!stored || stored.candidate.state !== 'killed'
                || stored.candidate.revision !== expected + 1
                || last?.eventType !== 'kill' || last?.evidenceDigest !== evidenceDigest
                || last?.reasonCode !== reasonCode) {
                throw new Error('candidate-kill-write-mismatch');
            }
            return stored;
        });
    }

    /** 只读采用回执；损坏即 fail closed。 */
    readAdoptionReceipt(candidateIdInput: unknown): SkillCandidateAdoptionReceipt | null {
        if (typeof candidateIdInput !== 'string' || !HASH.test(candidateIdInput)) {
            throw new Error('candidate-id-invalid');
        }
        return this.#transaction(() => {
            const row = this.#adoptionRow(candidateIdInput);
            if (!row) return null;
            const receipt = this.#adoptionReceipt(JSON.parse(String(row.receipt_json)));
            if (JSON.stringify(receipt) !== row.receipt_json
                || receipt.adoptionDigest !== row.receipt_digest
                || receipt.candidateId !== candidateIdInput) {
                throw new Error('candidate-adoption-receipt-invalid');
            }
            return receipt;
        }, false);
    }

    #adoptionReceipt(input: unknown): SkillCandidateAdoptionReceipt {
        try { return readSkillCandidateAdoptionReceipt(input); }
        catch { throw new Error('candidate-adoption-receipt-invalid'); }
    }

    #adoptionRow(candidateId: string): SqlRow | undefined {
        return this.#db.prepare(
            'SELECT * FROM skill_candidate_adoption_receipt WHERE candidate_id=?',
        ).get(candidateId) as SqlRow | undefined;
    }

    /** Only expired pure work may be requeued; exhaustion is a job failure, not fabricated validator evidence. */
    recoverExpired(): number {
        const now = timestamp(this.#now());
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT * FROM skill_candidate_job
                WHERE state='running' AND lease_until<=?
                    AND NOT EXISTS(SELECT 1 FROM skill_candidate_job_quarantine AS quarantine
                        WHERE quarantine.job_id=skill_candidate_job.job_id)
                ORDER BY rowid LIMIT 64`).all(now) as SqlRow[];
            let recovered = 0;
            for (const row of rows) {
                let job: AgentSkillCandidateJobV1;
                try {
                    job = parseJob(row);
                    const source = this.#readCandidate(job.candidateId);
                    if (!source || source.candidate.revision !== job.expectedCandidateRevision
                        || source.validation) throw new Error('candidate-storage-invalid');
                } catch { this.#quarantine(row, now); continue; }
                if (now < job.updatedAt) throw new Error('candidate-clock-regressed');
                const exhausted = job.attempt >= MAX_ATTEMPTS;
                this.#writeJob(job, normalizeJob({
                    ...job, state: exhausted ? 'failed' : 'queued',
                    revision: job.revision + 1, updatedAt: now, ownerId: null, ownerToken: null,
                    claimedAt: null, leaseExpiresAt: null, reasonCode: exhausted ? 'restart-attempt-limit' : null
                }));
                recovered += 1;
            }
            return recovered;
        });
    }

    jobStatus(): Readonly<{ queued: number; running: number; nextLeaseUntil: string | null }> {
        this.#assertOpen();
        const row = this.#db.prepare(`SELECT
            COALESCE(SUM(state='queued'),0) AS queued,COALESCE(SUM(state='running'),0) AS running,
            MIN(CASE WHEN state='running' THEN lease_until END) AS next_lease_until
            FROM skill_candidate_job WHERE NOT EXISTS(SELECT 1 FROM skill_candidate_job_quarantine AS quarantine
                WHERE quarantine.job_id=skill_candidate_job.job_id)`).get() as SqlRow;
        return Object.freeze({
            queued: count(row.queued), running: count(row.running),
            nextLeaseUntil: row.next_lease_until === null ? null : timestamp(row.next_lease_until)
        });
    }

    list(input: { readonly limit?: number; readonly cursor?: number } = {}): AgentSkillCandidatePage {
        this.#assertOpen();
        const options = record(input);
        if (Object.keys(options).some((key) => !['limit', 'cursor'].includes(key))) {
            throw new Error('candidate-list-fields-invalid');
        }
        const limit = count(input.limit ?? 64, 1, 256);
        const cursor = count(input.cursor ?? 0);
        return this.#transaction(() => {
            const rows = this.#db.prepare(`SELECT record_id,candidate_id FROM skill_candidate_record
            WHERE record_id>? ORDER BY record_id LIMIT ?`).all(cursor, limit + 1) as SqlRow[];
            const page = rows.slice(0, limit);
            const records: AgentSkillCandidateRecordV1[] = [];
            let failed = 0;
            for (const row of page) {
                try {
                    const source = this.#readCandidate(digest(row.candidate_id));
                    if (!source) throw new Error('candidate-list-record-missing');
                    records.push(source.candidate);
                } catch { failed += 1; }
            }
            return Object.freeze({
                records: Object.freeze(records), attempted: page.length, failed,
                nextCursor: page.length ? count(page.at(-1)!.record_id, 1) : cursor, hasMore: rows.length > limit
            });
        }, false);
    }

    close(): void {
        if (this.#closed) return;
        this.#db.close();
        this.#closed = true;
    }
}
