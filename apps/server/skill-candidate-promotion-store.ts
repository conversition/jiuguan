/** @author Codex @date 2026-10-18 @version 1.0
 * D-Q3a2c 收口：SkillPromotionService 的 Channel Pointer Revision CAS。
 *
 * 边界：
 * 1) 只切换**命名 Channel 的指针**，不激活 live、不写 Active、不改变会话可见目录；
 * 2) 指针必须由「已采用 rev2 的候选 + 同一份汇合证据 + 同一批 Quality 执行的
 *    candidate-better 裁决」共同背书（三段摘要互相约束，缺一段即拒）；
 * 3) CAS 以 `expectedChannelRevision` 为唯一并发键（新通道=0），失败不产生半套状态；
 * 4) 历史 append-only，UPDATE/DELETE 一律 ABORT；指针 revision 只增不减；
 * 5) 回滚只换指针指向，仍是一次 revision 前进，历史不删（见 `rollback`）。
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { dirname, join as joinPath, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    readSkillCandidateAdoptionReceipt, type SkillCandidateAdoptionReceipt,
} from './skill-candidate-adoption-store.ts';
import { readSkillQualityVerdict, type SkillQualityVerdict } from './skill-quality-verdict.ts';
import { readSkillQualityEvidenceJoin, type SkillEvidenceJoin } from './skill-evidence-join.ts';

export const SKILL_CHANNEL_DB_FILE = 'agent-skill-channels.sqlite';
export const SKILL_CHANNEL_SCHEMA_VERSION = 1;
export const SKILL_CHANNEL_APPLICATION_ID = 0x4a475348;

export const SKILL_CHANNEL_ERROR_CODES = Object.freeze([
    'skill-channel-input-invalid',
    'skill-channel-evidence-invalid',
    'skill-channel-evidence-unavailable',
    'skill-channel-evidence-chain-limit',
    'skill-channel-revision-conflict',
    'skill-channel-candidate-not-adopted',
    'skill-channel-candidate-in-use',
    'skill-channel-storage-invalid',
] as const);
export type SkillChannelErrorCode = typeof SKILL_CHANNEL_ERROR_CODES[number];

export class SkillChannelError extends Error {
    constructor(readonly code: SkillChannelErrorCode) {
        if (!(SKILL_CHANNEL_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-channel-error-code-invalid');
        }
        super(code);
        this.name = 'SkillChannelError';
    }
}

export interface SkillChannelPointer {
    readonly pointerVersion: 'skill-channel-pointer-v1';
    readonly channelId: string;
    readonly revision: number;
    readonly candidateId: string;
    readonly candidateRevision: 2;
    readonly adoptionDigest: string;
    readonly verdictDigest: string;
    readonly verdict: 'candidate-better';
    readonly promotionDigest: string;
    readonly promotedAt: string;
    readonly pointerDigest: string;
}

export interface SkillChannelEvidenceRef {
    readonly sampleSuiteId: string;
    readonly batchId: string;
    readonly qualitySuiteId: string;
    readonly joinedAt: string;
    readonly decidedAt: string;
    readonly joinDigest: string;
}

export interface SkillChannelCandidateReader {
    readCandidate(candidateId: string): Readonly<{ state: string; revision: number }> | null;
}

type SqlRow = Record<string, unknown>;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/u;
const SCHEMA = Object.freeze([
    `CREATE TABLE skill_channel_pointer (
        channel_id TEXT NOT NULL PRIMARY KEY CHECK(length(channel_id)<=120),
        revision INTEGER NOT NULL CHECK(revision>=1),
        pointer_json TEXT NOT NULL CHECK(json_valid(pointer_json) AND length(pointer_json)<=65536),
        pointer_digest TEXT NOT NULL CHECK(length(pointer_digest)=71),
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE skill_promotion_history (
        promotion_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        from_revision INTEGER NOT NULL CHECK(from_revision>=0),
        to_revision INTEGER NOT NULL CHECK(to_revision>=1),
        promotion_json TEXT NOT NULL CHECK(json_valid(promotion_json) AND length(promotion_json)<=65536),
        promotion_digest TEXT NOT NULL CHECK(length(promotion_digest)=71),
        promoted_at TEXT NOT NULL,
        UNIQUE(channel_id,to_revision)
    )`,
    'CREATE INDEX skill_promotion_history_channel ON skill_promotion_history(channel_id)',
    `CREATE TRIGGER skill_promotion_history_no_update BEFORE UPDATE ON skill_promotion_history
        BEGIN SELECT RAISE(ABORT,'skill channel history immutable'); END`,
    `CREATE TRIGGER skill_promotion_history_no_delete BEFORE DELETE ON skill_promotion_history
        BEGIN SELECT RAISE(ABORT,'skill channel history immutable'); END`,
    `CREATE TRIGGER skill_channel_pointer_monotonic BEFORE UPDATE ON skill_channel_pointer
        WHEN NEW.revision <= OLD.revision
        BEGIN SELECT RAISE(ABORT,'skill channel revision must increase'); END`,
]);

function reject(code: SkillChannelErrorCode): never {
    throw new SkillChannelError(code);
}

function canonical(input: unknown): string {
    if (input === null || typeof input === 'string' || typeof input === 'boolean'
        || typeof input === 'number') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    const row = input as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
}

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) reject('skill-channel-input-invalid');
    return value;
}

function channelId(value: unknown): string {
    if (typeof value !== 'string' || !CHANNEL.test(value)) reject('skill-channel-input-invalid');
    return value;
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) reject('skill-channel-input-invalid');
    return value;
}

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        reject('skill-channel-input-invalid');
    }
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
        reject('skill-channel-input-invalid');
    }
    return input as Record<string, unknown>;
}

function stat(path: string): Stats | null {
    try { return lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function directory(path: string): void {
    if (path === parse(path).root) reject('skill-channel-storage-invalid');
    for (let current = path; current !== dirname(current); current = dirname(current)) {
        const entry = stat(current);
        if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
            reject('skill-channel-storage-invalid');
        }
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
}

function regular(path: string): void {
    const entry = stat(path);
    if (entry && (!entry.isFile() || entry.isSymbolicLink())) reject('skill-channel-storage-invalid');
}

function pragma(db: DatabaseSync, key: 'application_id' | 'user_version'): number {
    const value = (db.prepare(`PRAGMA ${key}`).get() as SqlRow | undefined)?.[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) reject('skill-channel-storage-invalid');
    return Number(value);
}

function schemaSql(db: DatabaseSync): string[] {
    return (db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as SqlRow[])
        .map((row) => {
            if (typeof row.sql !== 'string') reject('skill-channel-storage-invalid');
            return row.sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase();
        }).sort();
}

function normalizeSchema(statements: readonly string[]): string[] {
    return statements.map((item) => item.trim().replace(/;$/u, '').replace(/\s+/gu, ' ').toLowerCase()).sort();
}

export function inspectSkillChannelSchema(db: DatabaseSync): void {
    if (pragma(db, 'application_id') !== SKILL_CHANNEL_APPLICATION_ID
        || pragma(db, 'user_version') !== SKILL_CHANNEL_SCHEMA_VERSION
        || JSON.stringify(schemaSql(db)) !== JSON.stringify(normalizeSchema(SCHEMA))) {
        reject('skill-channel-storage-invalid');
    }
}

function initialize(db: DatabaseSync): void {
    if (pragma(db, 'application_id') || pragma(db, 'user_version')) {
        inspectSkillChannelSchema(db);
        return;
    }
    if (schemaSql(db).length) reject('skill-channel-storage-invalid');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec(`PRAGMA application_id=${SKILL_CHANNEL_APPLICATION_ID}`);
        for (const statement of SCHEMA) db.exec(statement);
        db.exec(`PRAGMA user_version=${SKILL_CHANNEL_SCHEMA_VERSION}`);
        inspectSkillChannelSchema(db);
        db.exec('COMMIT');
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

function normalizePointer(input: unknown): SkillChannelPointer {
    const value = exact(input, ['pointerVersion', 'channelId', 'revision', 'candidateId',
        'candidateRevision', 'adoptionDigest', 'verdictDigest', 'verdict', 'promotionDigest',
        'promotedAt', 'pointerDigest']);
    if (value.pointerVersion !== 'skill-channel-pointer-v1'
        || value.candidateRevision !== 2 || value.verdict !== 'candidate-better'
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
        reject('skill-channel-storage-invalid');
    }
    const core = {
        pointerVersion: 'skill-channel-pointer-v1' as const,
        channelId: channelId(value.channelId),
        revision: Number(value.revision),
        candidateId: token(value.candidateId),
        candidateRevision: 2 as const,
        adoptionDigest: String(value.adoptionDigest),
        verdictDigest: String(value.verdictDigest),
        verdict: 'candidate-better' as const,
        promotionDigest: String(value.promotionDigest),
        promotedAt: timestamp(value.promotedAt),
    };
    if (!HASH.test(core.adoptionDigest) || !HASH.test(core.verdictDigest)
        || !HASH.test(core.promotionDigest) || value.pointerDigest !== hash(core)) {
        reject('skill-channel-storage-invalid');
    }
    return Object.freeze({ ...core, pointerDigest: value.pointerDigest as string });
}

/** Channel 指针 CAS：一次 promote = 一条 append-only 历史 + 指针原子前进一格。 */
export class SkillChannelStore {
    readonly #db: DatabaseSync;
    readonly #now: () => string;
    readonly #candidate: SkillChannelCandidateReader;
    #closed = false;
    #retirementLock = false;

    constructor(options: {
        readonly dataDir: string;
        readonly now?: () => string;
        readonly candidate: SkillChannelCandidateReader;
    }) {
        if (typeof options?.dataDir !== 'string' || !options.dataDir.trim()
            || !options.candidate || typeof options.candidate.readCandidate !== 'function') {
            reject('skill-channel-input-invalid');
        }
        this.#candidate = options.candidate;
        const dataDir = resolve(options.dataDir);
        directory(dataDir);
        const file = joinPath(dataDir, SKILL_CHANNEL_DB_FILE);
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
        if (this.#closed) reject('skill-channel-storage-invalid');
    }

    #transaction<T>(work: () => T, write = true): T {
        this.#open();
        if (this.#retirementLock) return work();
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

    /** Serialize the entire synchronous retirement against all Channel writers. */
    withRetirementLock<T>(work: () => T): T {
        if (typeof work !== 'function' || this.#retirementLock) reject('skill-channel-input-invalid');
        return this.#transaction(() => {
            this.#retirementLock = true;
            try {
                const result = work();
                if (result && typeof (result as { then?: unknown }).then === 'function') {
                    reject('skill-channel-input-invalid');
                }
                return result;
            } finally { this.#retirementLock = false; }
        });
    }

    /**
     * 原子切换 Channel 指针。要求：候选已被采用到 rev2、裁决为 candidate-better、
     * `expectedChannelRevision` 与当前指针一致（新通道传 0）。
     */
    promote(input: unknown): SkillChannelPointer {
        const value = exact(input, ['channelId', 'expectedChannelRevision', 'candidateId',
            'adoptionReceipt', 'join', 'verdict']);
        const id = channelId(value.channelId);
        if (!Number.isSafeInteger(value.expectedChannelRevision) || Number(value.expectedChannelRevision) < 0
            || Number(value.expectedChannelRevision) > 1_000_000) {
            reject('skill-channel-input-invalid');
        }
        const expected = Number(value.expectedChannelRevision);
        const candidateId = token(value.candidateId);
        let receipt: SkillCandidateAdoptionReceipt;
        try { receipt = readSkillCandidateAdoptionReceipt(value.adoptionReceipt); }
        catch { return reject('skill-channel-evidence-invalid'); }
        if (receipt.candidateId !== candidateId) reject('skill-channel-evidence-invalid');
        // 汇合证据必须就是采用时那一份：否则「别的批次的更差候选」也能借一份更好裁决开路。
        let join: SkillEvidenceJoin;
        try { join = readSkillQualityEvidenceJoin(value.join); }
        catch { return reject('skill-channel-evidence-invalid'); }
        if (join.joinDigest !== receipt.joinDigest) reject('skill-channel-evidence-invalid');
        let verdict: SkillQualityVerdict;
        try { verdict = readSkillQualityVerdict(value.verdict); }
        catch { return reject('skill-channel-evidence-invalid'); }
        if (verdict.verdict !== 'candidate-better') reject('skill-channel-evidence-invalid');
        // 裁决必须针对同一批 Quality 执行（suite 身份），不能拿另一批的 better 复用。
        if (verdict.qualitySuiteId !== join.qualitySuiteId) reject('skill-channel-evidence-invalid');
        const now = timestamp(this.#now());
        if (now < receipt.adoptedAt || now < verdict.decidedAt) reject('skill-channel-input-invalid');
        const toRevision = expected + 1;
        const promotionCore = {
            promotionVersion: 'skill-channel-promotion-v2' as const,
            channelId: id,
            candidateId,
            candidateRevision: 2 as const,
            adoptionDigest: receipt.adoptionDigest,
            verdictDigest: verdict.verdictDigest,
            verdict: 'candidate-better' as const,
            fromRevision: expected,
            toRevision,
            promotedAt: now,
            evidence: Object.freeze({ sampleSuiteId: join.sampleSuiteId, batchId: join.candidateBatchId,
                qualitySuiteId: join.qualitySuiteId, joinedAt: join.joinedAt,
                decidedAt: verdict.decidedAt, joinDigest: join.joinDigest }),
        };
        const promotionDigest = hash(promotionCore);
        const pointerCore = {
            pointerVersion: 'skill-channel-pointer-v1' as const,
            channelId: id,
            revision: toRevision,
            candidateId,
            candidateRevision: 2 as const,
            adoptionDigest: receipt.adoptionDigest,
            verdictDigest: verdict.verdictDigest,
            verdict: 'candidate-better' as const,
            promotionDigest,
            promotedAt: now,
        };
        const pointer = Object.freeze({ ...pointerCore, pointerDigest: hash(pointerCore) });
        return this.#transaction(() => {
            let record: ReturnType<SkillChannelCandidateReader['readCandidate']> = null;
            try { record = this.#candidate.readCandidate(candidateId); }
            catch { return reject('skill-channel-input-invalid'); }
            if (!record || record.state !== 'validated' || record.revision !== 2) {
                reject('skill-channel-candidate-not-adopted');
            }
            const current = this.#pointerRow(id);
            const currentRevision = current ? Number(current.revision) : 0;
            if (currentRevision !== expected) {
                // 幂等：同一指针重复提交同一候选/回执/裁决。
                if (current && currentRevision === toRevision
                    && current.pointer_digest === pointer.pointerDigest) {
                    return normalizePointer(JSON.parse(String(current.pointer_json)));
                }
                reject('skill-channel-revision-conflict');
            }
            this.#db.prepare(`INSERT INTO skill_promotion_history
                (channel_id,from_revision,to_revision,promotion_json,promotion_digest,promoted_at)
                VALUES(?,?,?,?,?,?)`)
                .run(id, expected, toRevision, JSON.stringify(promotionCore), promotionDigest, now);
            if (current) {
                const changed = this.#db.prepare(`UPDATE skill_channel_pointer
                    SET revision=?,pointer_json=?,pointer_digest=?,updated_at=?
                    WHERE channel_id=? AND revision=?`)
                    .run(toRevision, JSON.stringify(pointer), pointer.pointerDigest, now, id, expected);
                if (Number(changed.changes) !== 1) reject('skill-channel-revision-conflict');
            } else {
                this.#db.prepare(`INSERT INTO skill_channel_pointer
                    (channel_id,revision,pointer_json,pointer_digest,updated_at) VALUES(?,?,?,?,?)`)
                    .run(id, toRevision, JSON.stringify(pointer), pointer.pointerDigest, now);
            }
            const stored = this.#readPointerUnsafe(id);
            if (!stored) reject('skill-channel-storage-invalid');
            if (stored.revision !== toRevision || stored.pointerDigest !== pointer.pointerDigest
                || stored.candidateId !== candidateId) {
                reject('skill-channel-storage-invalid');
            }
            return stored;
        });
    }

    #pointerRow(id: string): SqlRow | undefined {
        return this.#db.prepare('SELECT * FROM skill_channel_pointer WHERE channel_id=?')
            .get(id) as SqlRow | undefined;
    }

    /**
     * 精确回滚：把指针指回本 Channel 历史上某一格（`targetRevision`）。
     *
     * 语义固定：
     * 1) 指针 revision 仍**只增**（回滚是一次新的前进），历史一行不删；
     * 2) 目标格必须真的存在于本 Channel 历史里，且必须严格早于当前 revision；
     * 3) 目标候选必须仍是 `validated/rev2`——被 kill 或记录漂移的候选不能靠回滚复活；
     * 4) CAS 失败、目标不存在、候选不可用三类原因分别报错，不合并。
     */
    rollback(input: unknown): SkillChannelPointer {
        const value = exact(input, ['channelId', 'expectedChannelRevision', 'targetRevision', 'reasonCode']);
        const id = channelId(value.channelId);
        for (const key of ['expectedChannelRevision', 'targetRevision'] as const) {
            const raw = value[key];
            if (!Number.isSafeInteger(raw) || Number(raw) < 1 || Number(raw) > 1_000_000) {
                reject('skill-channel-input-invalid');
            }
        }
        const expected = Number(value.expectedChannelRevision);
        const target = Number(value.targetRevision);
        // 回滚原因必须留痕：历史是 append-only，事后没人能补，所以入口就要。
        const reasonCode = token(value.reasonCode);
        if ([...reasonCode].length > 64) reject('skill-channel-input-invalid');
        return this.#transaction(() => {
            const current = this.#pointerRow(id);
            if (!current || Number(current.revision) !== expected) {
                reject('skill-channel-revision-conflict');
            }
            // 先判「这一格到底存不存在」，再判「是不是更早」：两类失败原因不合并。
            const entry = this.#historyEntry(id, target);
            if (!entry) reject('skill-channel-evidence-invalid');
            if (target >= expected) reject('skill-channel-input-invalid');
            let record: ReturnType<SkillChannelCandidateReader['readCandidate']> = null;
            try { record = this.#candidate.readCandidate(entry.candidateId); }
            catch { return reject('skill-channel-input-invalid'); }
            if (!record || record.state !== 'validated' || record.revision !== 2) {
                reject('skill-channel-candidate-not-adopted');
            }
            const now = timestamp(this.#now());
            if (now < entry.promotedAt) reject('skill-channel-input-invalid');
            const toRevision = expected + 1;
            const rollbackCore = {
                promotionVersion: 'skill-channel-rollback-v1' as const,
                kind: 'rollback' as const,
                channelId: id,
                candidateId: entry.candidateId,
                candidateRevision: 2 as const,
                adoptionDigest: entry.adoptionDigest,
                verdictDigest: entry.verdictDigest,
                verdict: 'candidate-better' as const,
                fromRevision: expected,
                toRevision,
                rollbackTargetRevision: target,
                reasonCode,
                promotedAt: now,
            };
            const rollbackDigest = hash(rollbackCore);
            const pointerCore = {
                pointerVersion: 'skill-channel-pointer-v1' as const,
                channelId: id,
                revision: toRevision,
                candidateId: entry.candidateId,
                candidateRevision: 2 as const,
                adoptionDigest: entry.adoptionDigest,
                verdictDigest: entry.verdictDigest,
                verdict: 'candidate-better' as const,
                promotionDigest: rollbackDigest,
                promotedAt: now,
            };
            const pointer = Object.freeze({ ...pointerCore, pointerDigest: hash(pointerCore) });
            this.#db.prepare(`INSERT INTO skill_promotion_history
                (channel_id,from_revision,to_revision,promotion_json,promotion_digest,promoted_at)
                VALUES(?,?,?,?,?,?)`)
                .run(id, expected, toRevision, JSON.stringify(rollbackCore), rollbackDigest, now);
            const changed = this.#db.prepare(`UPDATE skill_channel_pointer
                SET revision=?,pointer_json=?,pointer_digest=?,updated_at=?
                WHERE channel_id=? AND revision=?`)
                .run(toRevision, JSON.stringify(pointer), pointer.pointerDigest, now, id, expected);
            if (Number(changed.changes) !== 1) reject('skill-channel-revision-conflict');
            const stored = this.#readPointerUnsafe(id);
            if (!stored || stored.revision !== toRevision
                || stored.pointerDigest !== pointer.pointerDigest
                || stored.candidateId !== entry.candidateId) {
                reject('skill-channel-storage-invalid');
            }
            return stored;
        });
    }

    /** 读某一格历史的身份摘要（只取回滚需要的四个字段）。 */
    #historyEntry(id: string, toRevision: number): Readonly<{
        candidateId: string;
        adoptionDigest: string;
        verdictDigest: string;
        promotedAt: string;
    }> | null {
        const row = this.#db.prepare(`SELECT promotion_json FROM skill_promotion_history
            WHERE channel_id=? AND to_revision=?`).get(id, toRevision) as SqlRow | undefined;
        if (!row) return null;
        let parsed: unknown;
        try { parsed = JSON.parse(String(row.promotion_json)); }
        catch { return reject('skill-channel-storage-invalid'); }
        const value = parsed as Record<string, unknown>;
        if (!value || typeof value !== 'object') reject('skill-channel-storage-invalid');
        const candidateId = value.candidateId;
        const adoptionDigest = value.adoptionDigest;
        const verdictDigest = value.verdictDigest;
        const promotedAt = value.promotedAt;
        if (typeof candidateId !== 'string' || !TOKEN.test(candidateId)
            || typeof adoptionDigest !== 'string' || !HASH.test(adoptionDigest)
            || typeof verdictDigest !== 'string' || !HASH.test(verdictDigest)
            || typeof promotedAt !== 'string' || !Number.isFinite(Date.parse(promotedAt))) {
            reject('skill-channel-storage-invalid');
        }
        return Object.freeze({
            candidateId, adoptionDigest, verdictDigest, promotedAt: String(promotedAt),
        });
    }

    #readPointerUnsafe(id: string): SkillChannelPointer | null {
        const row = this.#pointerRow(id);
        if (!row) return null;
        const pointer = normalizePointer(JSON.parse(String(row.pointer_json)));
        if (JSON.stringify(pointer) !== row.pointer_json
            || pointer.pointerDigest !== row.pointer_digest
            || pointer.revision !== Number(row.revision)
            || pointer.channelId !== id) {
            reject('skill-channel-storage-invalid');
        }
        return pointer;
    }

    readPointer(channelIdInput: unknown): SkillChannelPointer | null {
        const id = channelId(channelIdInput);
        return this.#transaction(() => this.#readPointerUnsafe(id), false);
    }

    /** Restore the evidence coordinates that actually produced the current pointer. */
    readCurrentEvidence(channelIdInput: unknown): Readonly<{
        pointer: SkillChannelPointer; evidence: SkillChannelEvidenceRef;
    }> | null {
        const id = channelId(channelIdInput);
        return this.#transaction(() => {
            const pointer = this.#readPointerUnsafe(id);
            if (!pointer) return null;
            let revision = pointer.revision;
            let expectedDigest = pointer.promotionDigest;
            for (let depth = 0; depth < 128; depth += 1) {
                const row = this.#db.prepare(`SELECT * FROM skill_promotion_history
                    WHERE channel_id=? AND to_revision=?`).get(id, revision) as SqlRow | undefined;
                if (!row || typeof row.promotion_json !== 'string') reject('skill-channel-storage-invalid');
                let event: Record<string, unknown>;
                try {
                    const parsed: unknown = JSON.parse(row.promotion_json);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
                    event = parsed as Record<string, unknown>;
                    if (hash(event) !== row.promotion_digest || (expectedDigest && row.promotion_digest !== expectedDigest)
                        || event.channelId !== id || event.toRevision !== revision
                        || event.fromRevision !== revision - 1 || row.from_revision !== revision - 1
                        || row.to_revision !== revision || event.promotedAt !== row.promoted_at
                        || event.candidateId !== pointer.candidateId || event.candidateRevision !== 2
                        || event.adoptionDigest !== pointer.adoptionDigest || event.verdictDigest !== pointer.verdictDigest
                        || event.verdict !== 'candidate-better') throw new Error('invalid');
                    timestamp(event.promotedAt);
                } catch { return reject('skill-channel-storage-invalid'); }
                if (event.promotionVersion === 'skill-channel-rollback-v1') {
                    try { exact(event, ['promotionVersion', 'kind', 'channelId', 'candidateId', 'candidateRevision',
                        'adoptionDigest', 'verdictDigest', 'verdict', 'fromRevision', 'toRevision',
                        'rollbackTargetRevision', 'reasonCode', 'promotedAt']); token(event.reasonCode); }
                    catch { return reject('skill-channel-storage-invalid'); }
                    if (event.kind !== 'rollback' || !Number.isSafeInteger(event.rollbackTargetRevision)
                        || Number(event.rollbackTargetRevision) < 1 || Number(event.rollbackTargetRevision) >= revision) {
                        reject('skill-channel-storage-invalid');
                    }
                    revision = Number(event.rollbackTargetRevision);
                    expectedDigest = '';
                    continue;
                }
                if (event.promotionVersion === 'skill-channel-promotion-v1') {
                    try { exact(event, ['promotionVersion', 'channelId', 'candidateId', 'candidateRevision', 'adoptionDigest',
                        'verdictDigest', 'verdict', 'fromRevision', 'toRevision', 'promotedAt']); }
                    catch { return reject('skill-channel-storage-invalid'); }
                    reject('skill-channel-evidence-unavailable');
                }
                if (event.promotionVersion !== 'skill-channel-promotion-v2') reject('skill-channel-storage-invalid');
                try {
                    exact(event, ['promotionVersion', 'channelId', 'candidateId', 'candidateRevision', 'adoptionDigest',
                        'verdictDigest', 'verdict', 'fromRevision', 'toRevision', 'promotedAt', 'evidence']);
                    const value = exact(event.evidence, ['sampleSuiteId', 'batchId', 'qualitySuiteId',
                        'joinedAt', 'decidedAt', 'joinDigest']);
                    const evidence = Object.freeze({
                        sampleSuiteId: String(value.sampleSuiteId), batchId: String(value.batchId),
                        qualitySuiteId: String(value.qualitySuiteId), joinedAt: timestamp(value.joinedAt),
                        decidedAt: timestamp(value.decidedAt), joinDigest: String(value.joinDigest),
                    });
                    if (![evidence.sampleSuiteId, evidence.batchId, evidence.qualitySuiteId, evidence.joinDigest]
                        .every((item) => HASH.test(item))) throw new Error('invalid');
                    return Object.freeze({ pointer, evidence });
                } catch { return reject('skill-channel-storage-invalid'); }
            }
            return reject('skill-channel-evidence-chain-limit');
        }, false);
    }

    /** Check the rollback target and other channel references before a global candidate kill. */
    assertRetirementReady(channelIdInput: unknown, revision: number, candidateId: string): void {
        const id = channelId(channelIdInput);
        if (!Number.isSafeInteger(revision) || revision < 2 || revision > 1_000_000) {
            reject('skill-channel-input-invalid');
        }
        this.#transaction(() => {
            const current = this.#readPointerUnsafe(id);
            if (!current || current.revision !== revision || current.candidateId !== candidateId) {
                reject('skill-channel-revision-conflict');
            }
            const target = this.#historyEntry(id, revision - 1);
            if (!target || target.candidateId === candidateId) reject('skill-channel-candidate-not-adopted');
            if (timestamp(this.#now()) < target.promotedAt) reject('skill-channel-input-invalid');
            const record = this.#candidate.readCandidate(target.candidateId);
            if (!record || record.state !== 'validated' || record.revision !== 2) {
                reject('skill-channel-candidate-not-adopted');
            }
            const rows = this.#db.prepare('SELECT channel_id FROM skill_channel_pointer').all() as SqlRow[];
            for (const row of rows) {
                const other = this.#readPointerUnsafe(channelId(row.channel_id));
                if (!other) reject('skill-channel-storage-invalid');
                if (other.channelId !== id && other.candidateId === candidateId) {
                    reject('skill-channel-candidate-in-use');
                }
            }
        }, false);
    }

    /**
     * 只读：枚举所有已存在的 Channel 指针（按 channelId 码点排序）。
     * 给操作者的发布总览用；不含历史、不含证据正文。
     */
    listPointers(): readonly SkillChannelPointer[] {
        return this.#transaction(() => {
            const rows = this.#db.prepare(
                'SELECT channel_id FROM skill_channel_pointer ORDER BY channel_id',
            ).all() as SqlRow[];
            const pointers: SkillChannelPointer[] = [];
            for (const row of rows) {
                const pointer = this.#readPointerUnsafe(channelId(row.channel_id));
                if (pointer) pointers.push(pointer);
            }
            return Object.freeze(pointers);
        }, false);
    }

    history(channelIdInput: unknown): readonly Readonly<Record<string, unknown>>[] {
        const id = channelId(channelIdInput);
        return this.#transaction(() => {
            const rows = this.#db.prepare(
                'SELECT promotion_json FROM skill_promotion_history WHERE channel_id=? ORDER BY promotion_row_id',
            ).all(id) as SqlRow[];
            return Object.freeze(rows.map((row) => Object.freeze(JSON.parse(String(row.promotion_json)))));
        }, false);
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#db.close();
    }
}
