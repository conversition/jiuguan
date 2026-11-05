/** @author Codex @date 2026-10-17 @version 1.0
 * D-Q3a2c：Candidate 采用历史（append-only）与 rev1 → rev2 的 expectedRevision CAS。
 *
 * 边界：
 * 1) 采用只把**采用账本**中该候选的状态推进到 rev2（fromRevision=1 → toRevision=2），
 *    **不写** Candidate Store、不写 Active/Channel、不激活 live Skill；
 * 2) 历史行只追加，UPDATE/DELETE 一律 ABORT；
 * 3) CAS 只接受 expectedRevision=1，且必须携带可重新归一化的三源汇合证据；
 * 4) 同一 joinDigest 不能被重复采用（历史唯一键），失败不产生半套状态。
 *
 * ⚠️ 已知边界：`adoptionRevision` 与 `agent-skill-candidates.sqlite` 的 `revision` 是两套账。
 * 把 Candidate Store 记录与采用回执原子联动（consume adoption receipt）属于后续切片，
 * 在那之前不得把本账本的 rev2 当作 Candidate 记录已被改写。
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join as joinPath, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    readSkillQualityEvidenceJoin, type SkillEvidenceJoin,
} from './skill-evidence-join.ts';

export const SKILL_CANDIDATE_ADOPTION_DB_FILE = 'agent-skill-adoptions.sqlite';
export const SKILL_CANDIDATE_ADOPTION_SCHEMA_VERSION = 2;
export const SKILL_CANDIDATE_ADOPTION_APPLICATION_ID = 0x4a475341;

export const SKILL_CANDIDATE_ADOPTION_ERROR_CODES = Object.freeze([
    'candidate-adoption-input-invalid',
    'candidate-adoption-evidence-invalid',
    'candidate-adoption-revision-conflict',
    'candidate-adoption-duplicate-evidence',
    'candidate-adoption-storage-invalid',
] as const);
export type SkillCandidateAdoptionErrorCode =
    typeof SKILL_CANDIDATE_ADOPTION_ERROR_CODES[number];

export class SkillCandidateAdoptionError extends Error {
    constructor(readonly code: SkillCandidateAdoptionErrorCode) {
        if (!(SKILL_CANDIDATE_ADOPTION_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('candidate-adoption-error-code-invalid');
        }
        super(code);
        this.name = 'SkillCandidateAdoptionError';
    }
}

export interface SkillCandidateAdoptionReceipt {
    readonly receiptVersion: 'skill-candidate-adoption-receipt-v1';
    readonly candidateId: string;
    readonly fromRevision: 1;
    readonly toRevision: 2;
    readonly joinDigest: string;
    readonly evidenceDigest: string;
    /** 采用时 Candidate 记录必须处于 validated/rev1，且校验证据摘要与此值一致。 */
    readonly candidateValidationEvidenceDigest: string;
    readonly adoptedAt: string;
    readonly adoptionDigest: string;
}

/** 宿主注入的窄只读接口：只暴露绑定所需的字段，不把 Candidate Store 带进本模块。 */
export interface SkillCandidateAdoptionCandidateReader {
    readCandidate(candidateId: string): Readonly<{
        state: string;
        revision: number;
        validationEvidenceDigest: string | null;
    }> | null;
}

/**
 * 宿主注入的持久证据读端口。候选身份必须从 join 指向的 Batch 重新读取，
 * 不能由 API 入参自报，也不能依赖只在当前进程存活的对象品牌。
 */
export interface SkillCandidateAdoptionBatchReader {
    readBatchCandidateId(batchId: string): string | null;
}

export interface SkillCandidateAdoptionState {
    readonly candidateId: string;
    readonly revision: number;
    readonly adoption: SkillCandidateAdoptionReceipt | null;
}

type SqlRow = Record<string, unknown>;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SCHEMA_V1 = Object.freeze([
    `CREATE TABLE skill_candidate_adoption (
        adoption_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL CHECK(length(candidate_id)=71),
        join_digest TEXT NOT NULL UNIQUE CHECK(length(join_digest)=71),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(receipt_json)<=65536),
        receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=71),
        adopted_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_candidate_revision (
        candidate_id TEXT NOT NULL PRIMARY KEY CHECK(length(candidate_id)=71),
        revision INTEGER NOT NULL CHECK(revision IN (1,2)),
        adoption_digest TEXT CHECK(adoption_digest IS NULL OR length(adoption_digest)=71),
        updated_at TEXT NOT NULL
    )`,
    'CREATE INDEX skill_candidate_adoption_candidate ON skill_candidate_adoption(candidate_id)',
    `CREATE TRIGGER skill_candidate_adoption_no_update BEFORE UPDATE ON skill_candidate_adoption
        BEGIN SELECT RAISE(ABORT,'candidate adoption immutable history'); END`,
    `CREATE TRIGGER skill_candidate_adoption_no_delete BEFORE DELETE ON skill_candidate_adoption
        BEGIN SELECT RAISE(ABORT,'candidate adoption immutable history'); END`,
    `CREATE TRIGGER skill_candidate_revision_monotonic BEFORE UPDATE ON skill_candidate_revision
        WHEN NEW.revision <= OLD.revision
        BEGIN SELECT RAISE(ABORT,'candidate adoption revision must increase'); END`,
]);
const SOURCE_SCHEMA = Object.freeze([
    `CREATE TABLE skill_candidate_adoption_source (
        candidate_id TEXT NOT NULL PRIMARY KEY CHECK(length(candidate_id)=71),
        join_digest TEXT NOT NULL CHECK(length(join_digest)=71),
        joined_at TEXT NOT NULL
    )`,
    `CREATE TRIGGER skill_candidate_adoption_source_no_update BEFORE UPDATE ON skill_candidate_adoption_source
        BEGIN SELECT RAISE(ABORT,'candidate adoption source immutable'); END`,
    `CREATE TRIGGER skill_candidate_adoption_source_no_delete BEFORE DELETE ON skill_candidate_adoption_source
        BEGIN SELECT RAISE(ABORT,'candidate adoption source immutable'); END`,
]);
const SCHEMA = Object.freeze([...SCHEMA_V1, ...SOURCE_SCHEMA]);

function reject(code: SkillCandidateAdoptionErrorCode): never {
    throw new SkillCandidateAdoptionError(code);
}

function hash(value: unknown): string {
    const canonical = (input: unknown): string => {
        if (input === null || typeof input === 'string' || typeof input === 'boolean'
            || typeof input === 'number') return JSON.stringify(input);
        if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
        const row = input as Record<string, unknown>;
        return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
    };
    return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) reject('candidate-adoption-input-invalid');
    return value;
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) reject('candidate-adoption-input-invalid');
    return value;
}

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        reject('candidate-adoption-input-invalid');
    }
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
        reject('candidate-adoption-input-invalid');
    }
    return input as Record<string, unknown>;
}

function stat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function directory(path: string): void {
    if (path === parse(path).root) reject('candidate-adoption-storage-invalid');
    for (let current = path; current !== dirname(current); current = dirname(current)) {
        const entry = stat(current);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            reject('candidate-adoption-storage-invalid');
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}

function regular(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) reject('candidate-adoption-storage-invalid');
}

function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
    const value = (db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) reject('candidate-adoption-storage-invalid');
    return Number(value);
}

function schemaSql(db: DatabaseSync): string[] {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SqlRow[])
        .map((row) => {
            if (typeof row.sql !== 'string') reject('candidate-adoption-storage-invalid');
            return row.sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
        }).sort();
}

function normalizeSchema(statements: readonly string[]): string[] {
    return statements.map((item) => item.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
}

export function inspectSkillCandidateAdoptionSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== SKILL_CANDIDATE_ADOPTION_APPLICATION_ID
        || pragma(db, 'user_version') !== SKILL_CANDIDATE_ADOPTION_SCHEMA_VERSION
        || JSON.stringify(schemaSql(db)) !== JSON.stringify(normalizeSchema(SCHEMA))) {
        reject('candidate-adoption-storage-invalid');
    }
}

function initialize(db: DatabaseSync): void {
    if (pragma(db, 'application_id') || pragma(db, 'user_version')) {
        if (pragma(db, 'application_id') === SKILL_CANDIDATE_ADOPTION_APPLICATION_ID
            && pragma(db, 'user_version') === 1) {
            db.exec('BEGIN IMMEDIATE');
            try {
                if (pragma(db, 'application_id') !== SKILL_CANDIDATE_ADOPTION_APPLICATION_ID
                    || pragma(db, 'user_version') !== 1
                    || JSON.stringify(schemaSql(db)) !== JSON.stringify(normalizeSchema(SCHEMA_V1)))
                    reject('candidate-adoption-storage-invalid');
                for (const statement of SOURCE_SCHEMA) db.exec(statement);
                db.exec(`PRAGMA user_version=${SKILL_CANDIDATE_ADOPTION_SCHEMA_VERSION}`);
                inspectSkillCandidateAdoptionSchema(db);
                db.exec('COMMIT');
            } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
            return;
        }
        inspectSkillCandidateAdoptionSchema(db);
        return;
    }
    if (schemaSql(db).length) reject('candidate-adoption-storage-invalid');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${SKILL_CANDIDATE_ADOPTION_APPLICATION_ID}`);
        for (const statement of SCHEMA) db.exec(statement);
        db.exec(`PRAGMA user_version=${SKILL_CANDIDATE_ADOPTION_SCHEMA_VERSION}`);
        inspectSkillCandidateAdoptionSchema(db);
        db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

export function readSkillCandidateAdoptionReceipt(input: unknown): SkillCandidateAdoptionReceipt {
    const value = exact(input, ['receiptVersion', 'candidateId', 'fromRevision', 'toRevision',
        'joinDigest', 'evidenceDigest', 'candidateValidationEvidenceDigest', 'adoptedAt', 'adoptionDigest']);
    if (value.receiptVersion !== 'skill-candidate-adoption-receipt-v1'
        || value.fromRevision !== 1 || value.toRevision !== 2
        || typeof value.joinDigest !== 'string' || !HASH.test(value.joinDigest)
        || typeof value.evidenceDigest !== 'string' || !HASH.test(value.evidenceDigest)
        || typeof value.candidateValidationEvidenceDigest !== 'string'
        || !HASH.test(value.candidateValidationEvidenceDigest)) {
        reject('candidate-adoption-storage-invalid');
    }
    const core = {
        receiptVersion: 'skill-candidate-adoption-receipt-v1' as const,
        candidateId: token(value.candidateId),
        fromRevision: 1 as const,
        toRevision: 2 as const,
        joinDigest: value.joinDigest,
        evidenceDigest: value.evidenceDigest,
        candidateValidationEvidenceDigest: value.candidateValidationEvidenceDigest,
        adoptedAt: timestamp(value.adoptedAt),
    };
    if (value.adoptionDigest !== hash(core)) reject('candidate-adoption-storage-invalid');
    return Object.freeze({ ...core, adoptionDigest: value.adoptionDigest });
}

/** 采用账本：append-only 历史 + rev1→rev2 CAS。 */
export class SkillCandidateAdoptionStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #candidate: SkillCandidateAdoptionCandidateReader;
    readonly #batch: SkillCandidateAdoptionBatchReader | null;
    #closed = false;

    constructor(options: {
        readonly dataDir: string;
        readonly now?: () => string;
        /** 必填：采用必须绑定 Candidate Store 里当前 validated/rev1 的记录，不能只凭自报关。 */
        readonly candidate: SkillCandidateAdoptionCandidateReader;
        /**
         * 持久 CandidateEvaluationBatch 只读端口。可以不提供以保持账本只读可打开，
         * 但缺端口时任何 adopt 都会 fail closed 为 evidence-invalid。
         */
        readonly batch?: SkillCandidateAdoptionBatchReader;
    }) {
        if (typeof options?.dataDir !== 'string' || !options.dataDir.trim()
            || !options.candidate || typeof options.candidate.readCandidate !== 'function') {
            reject('candidate-adoption-input-invalid');
        }
        this.#candidate = options.candidate;
        if (options.batch !== undefined
            && (!options.batch || typeof options.batch.readBatchCandidateId !== 'function')) {
            reject('candidate-adoption-input-invalid');
        }
        this.#batch = options.batch ?? null;
        const dataDir = resolve(options.dataDir);
        directory(dataDir);
        const file = joinPath(dataDir, SKILL_CANDIDATE_ADOPTION_DB_FILE);
        for (const suffix of ['', '-wal', '-shm', '-journal']) regular(`${file}${suffix}`);
        this.#db = new DatabaseSync(file);
        this.#now = options.now ?? (() => new Date().toISOString());
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
    }

    #open(): void {
        if (this.#closed) reject('candidate-adoption-storage-invalid');
    }

    #transaction<T>(work: () => T, write = true): T {
        this.#open();
        this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            const result = work();
            this.#db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * 采用一次汇合证据：expectedRevision 必须为 1，成功则 Candidate 推进到 rev2。
     * 只写采用账本，不触碰 Active/Channel；同一 joinDigest 只能采用一次。
     */
    adopt(input: unknown): SkillCandidateAdoptionReceipt {
        const value = exact(input, ['candidateId', 'expectedRevision', 'join', 'evidenceDigest',
            'candidateValidationEvidenceDigest']);
        const candidateId = token(value.candidateId);
        if (value.expectedRevision !== 1) reject('candidate-adoption-revision-conflict');
        if (typeof value.evidenceDigest !== 'string' || !HASH.test(value.evidenceDigest)) {
            reject('candidate-adoption-evidence-invalid');
        }
        if (typeof value.candidateValidationEvidenceDigest !== 'string'
            || !HASH.test(value.candidateValidationEvidenceDigest)) {
            reject('candidate-adoption-evidence-invalid');
        }
        // 绑定 Candidate Store 的当前记录：必须 validated/rev1，且校验证据摘要一致。
        let record: ReturnType<SkillCandidateAdoptionCandidateReader['readCandidate']> = null;
        try { record = this.#candidate.readCandidate(candidateId); }
        catch { return reject('candidate-adoption-input-invalid'); }
        if (!record || record.state !== 'validated' || record.revision !== 1
            || record.validationEvidenceDigest !== value.candidateValidationEvidenceDigest) {
            return reject('candidate-adoption-evidence-invalid');
        }
        let evidence: SkillEvidenceJoin;
        try { evidence = readSkillQualityEvidenceJoin(value.join); }
        catch { return reject('candidate-adoption-evidence-invalid'); }
        // join v1 不扩 schema；以其 candidateBatchId 回读持久 Batch source 做等价宿主绑定。
        // 端口缺失、批次缺失/失效、读取异常或 Candidate 不同均不得采用。
        let evidenceCandidateId: string | null = null;
        try {
            evidenceCandidateId = this.#batch?.readBatchCandidateId(evidence.candidateBatchId) ?? null;
        } catch { return reject('candidate-adoption-evidence-invalid'); }
        if (evidenceCandidateId !== candidateId) {
            return reject('candidate-adoption-evidence-invalid');
        }
        const now = timestamp(this.#now());
        const receiptCore = {
            receiptVersion: 'skill-candidate-adoption-receipt-v1' as const,
            candidateId,
            fromRevision: 1 as const,
            toRevision: 2 as const,
            joinDigest: evidence.joinDigest,
            evidenceDigest: value.evidenceDigest,
            candidateValidationEvidenceDigest: value.candidateValidationEvidenceDigest,
            adoptedAt: now,
        };
        const receipt = Object.freeze({ ...receiptCore, adoptionDigest: hash(receiptCore) });
        return this.#transaction(() => {
            const current = this.#db.prepare(
                'SELECT revision FROM skill_candidate_revision WHERE candidate_id=?',
            ).get(candidateId) as SqlRow | undefined;
            const revision = current ? Number(current.revision) : 1;
            if (revision !== 1) reject('candidate-adoption-revision-conflict');
            const duplicate = this.#db.prepare(
                'SELECT 1 FROM skill_candidate_adoption WHERE join_digest=?',
            ).get(evidence.joinDigest);
            if (duplicate) reject('candidate-adoption-duplicate-evidence');
            this.#db.prepare(`INSERT INTO skill_candidate_adoption
                (candidate_id,join_digest,receipt_json,receipt_digest,adopted_at) VALUES(?,?,?,?,?)`)
                .run(candidateId, evidence.joinDigest, JSON.stringify(receipt),
                    receipt.adoptionDigest, now);
            this.#db.prepare(`INSERT INTO skill_candidate_adoption_source (candidate_id,join_digest,joined_at)
                VALUES(?,?,?)`).run(candidateId, evidence.joinDigest, evidence.joinedAt);
            if (current) {
                const changed = this.#db.prepare(`UPDATE skill_candidate_revision
                    SET revision=2,adoption_digest=?,updated_at=? WHERE candidate_id=? AND revision=1`)
                    .run(receipt.adoptionDigest, now, candidateId);
                if (Number(changed.changes) !== 1) reject('candidate-adoption-revision-conflict');
            } else {
                this.#db.prepare(`INSERT INTO skill_candidate_revision
                    (candidate_id,revision,adoption_digest,updated_at) VALUES(?,?,?,?)`)
                    .run(candidateId, 2, receipt.adoptionDigest, now);
            }
            const stored = this.#read(candidateId);
            if (!stored || stored.revision !== 2
                || stored.adoption?.adoptionDigest !== receipt.adoptionDigest) {
                reject('candidate-adoption-storage-invalid');
            }
            return stored.adoption!;
        });
    }

    /** 调用方必须已处于事务中（写事务或只读事务）。 */
    #read(candidateId: string): SkillCandidateAdoptionState | null {
        const revisionRow = this.#db.prepare(
            'SELECT revision FROM skill_candidate_revision WHERE candidate_id=?',
        ).get(candidateId) as SqlRow | undefined;
        const adoptionRow = this.#db.prepare(
            `SELECT receipt_json,receipt_digest FROM skill_candidate_adoption
             WHERE candidate_id=? ORDER BY adoption_row_id DESC LIMIT 1`,
        ).get(candidateId) as SqlRow | undefined;
        if (!revisionRow && !adoptionRow) return null;
        if (!revisionRow) reject('candidate-adoption-storage-invalid');
        const adoption = adoptionRow
            ? readSkillCandidateAdoptionReceipt(JSON.parse(String(adoptionRow.receipt_json)))
            : null;
        if (adoption) {
            if (JSON.stringify(adoption) !== adoptionRow!.receipt_json
                || adoption.adoptionDigest !== adoptionRow!.receipt_digest) {
                reject('candidate-adoption-storage-invalid');
            }
        }
        return Object.freeze({
            candidateId,
            revision: Number(revisionRow.revision),
            adoption,
        });
    }

    read(candidateIdInput: unknown): SkillCandidateAdoptionState | null {
        const candidateId = token(candidateIdInput);
        return this.#transaction(() => this.#read(candidateId), false);
    }

    /** The exact original join timestamp, bound to the retained adoption receipt. */
    readJoinedAt(candidateIdInput: unknown): string | null {
        const candidateId = token(candidateIdInput);
        return this.#transaction(() => {
            const row = this.#db.prepare(`SELECT join_digest,joined_at FROM skill_candidate_adoption_source
                WHERE candidate_id=?`).get(candidateId) as SqlRow | undefined;
            if (!row) return null; // Historical v1 did not retain this authority.
            const receipt = this.#read(candidateId)?.adoption;
            if (!receipt || row.join_digest !== receipt.joinDigest) reject('candidate-adoption-storage-invalid');
            return timestamp(row.joined_at);
        }, false);
    }

    history(candidateIdInput: unknown): readonly SkillCandidateAdoptionReceipt[] {
        const candidateId = token(candidateIdInput);
        return this.#transaction(() => {
            const rows = this.#db.prepare(
                `SELECT receipt_json FROM skill_candidate_adoption
                 WHERE candidate_id=? ORDER BY adoption_row_id`,
            ).all(candidateId) as SqlRow[];
            return Object.freeze(rows.map((row) => readSkillCandidateAdoptionReceipt(JSON.parse(String(row.receipt_json)))));
        }, false);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#db.close();
    }
}
