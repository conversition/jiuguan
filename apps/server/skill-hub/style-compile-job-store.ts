/** @author Codex @date 2026-10-20 @version 5.0
 * P17-01.4：Style Compiler 耐久账本与业务提交权限。
 * 执行前租约可重领；执行后的异常、过期或崩溃记为 uncertain，禁止自动重打模型。
 * Provider 计算与业务写入分离；写入仅可在 generation/TTL 校验后的同步提交区内进行。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const STYLE_COMPILE_JOB_STORE_VERSION = 'style-compile-job-v5' as const;
export const STYLE_COMPILE_JOB_DB_FILE = 'jobs.sqlite' as const;
export const STYLE_COMPILE_JOB_DATA_DIRECTORY = 'style-compile' as const;
export const STYLE_COMPILE_JOB_APPLICATION_ID = 0x4a475354; // JGST
export const STYLE_COMPILE_JOB_SCHEMA_VERSION = 5;
export const STYLE_COMPILE_JOB_STATES = Object.freeze([
    'pending', 'leased', 'executing', 'uncertain', 'done', 'failed', 'cancelled',
] as const);
export type StyleCompileJobState = typeof STYLE_COMPILE_JOB_STATES[number];
export const STYLE_COMPILE_JOB_REASON_CODES = Object.freeze([
    'style-job-completed',
    'style-job-failed-provider',
    'style-job-failed-rejected',
    'style-job-cancelled-session-deleted',
    'style-job-cancelled-request',
    'style-job-cancelled-quiesce',
    'style-job-fenced-source-revision',
    'style-job-attempts-exhausted',
    'style-job-skipped-ineligible',
    'style-job-execution-uncertain',
    'style-job-deferred-unavailable',
    'style-job-intent-unbound',
] as const);
export type StyleCompileJobReasonCode = typeof STYLE_COMPILE_JOB_REASON_CODES[number];

const MAX_ATTEMPTS = 3;
const MAX_PILOTS = 256;
const MAX_PILOT_CALLS = 64;
const MAX_PILOT_COST_MICROUSD = 1_000_000_000;
const PILOT_POLICY_KEYS = Object.freeze([
    'pilotIdDigest', 'policyDigest', 'maxCalls', 'maxCostMicrousd', 'expiresAt', 'now',
]);
const PILOT_RESERVATION_KEYS = Object.freeze([
    ...PILOT_POLICY_KEYS, 'reservationDigest', 'reservedCostMicrousd',
]);
const INPUT_KEYS = Object.freeze([
    'jobId', 'sessionId', 'runId', 'intentPacketDigest', 'contentMode', 'styleSkillId', 'round', 'sourceRevision', 'explicitRequest', 'now',
]);
const CANCEL_REASONS = Object.freeze([
    'style-job-cancelled-session-deleted', 'style-job-cancelled-request', 'style-job-cancelled-quiesce',
] as const);

export type StyleCompileJobResult =
    | Readonly<{ status: 'created'; proposalId: string }>
    | Readonly<{ status: 'rejected' }>
    | Readonly<{ status: 'skipped' }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'unknown'; attempted: true | null }>;

export interface StyleCompileJobRecord {
    readonly jobId: string;
    readonly sessionId: string;
    /** Null is retained only for migrated, non-replayable legacy rows. */
    readonly runId: string | null;
    readonly intentPacketDigest: string | null;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly styleSkillId: string;
    readonly round: number;
    readonly sourceRevision: string;
    readonly explicitRequest: boolean;
    readonly state: StyleCompileJobState;
    readonly attempts: number;
    readonly availabilityDeferrals: number;
    readonly notBefore: string | null;
    readonly owner: string | null;
    readonly leaseExpiresAt: string | null;
    readonly reasonCode: StyleCompileJobReasonCode | null;
    readonly executionStartedAt: string | null;
    readonly result: StyleCompileJobResult | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** attempts 是只增认领 generation，不是 Provider 次数；可用性等待不消耗安全重领预算。 */
export type StyleCompileJobClaim = Pick<StyleCompileJobRecord, 'jobId' | 'owner' | 'attempts'>;

export interface StyleCompileJobInput {
    readonly jobId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly intentPacketDigest: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly styleSkillId: string;
    readonly round: number;
    readonly sourceRevision: string;
    readonly explicitRequest: boolean;
    readonly now: string;
}

/** Explicit operator registration does not itself authorize a Provider call. */
export interface StyleCompilePilotBudgetPolicy {
    readonly pilotIdDigest: string;
    readonly policyDigest: string;
    readonly maxCalls: number;
    readonly maxCostMicrousd: number;
    readonly expiresAt: string;
    readonly now: string;
}

export interface StyleCompilePilotBudgetReservation extends StyleCompilePilotBudgetPolicy {
    readonly reservationDigest: string;
    readonly reservedCostMicrousd: number;
}

interface PilotBudgetRow {
    readonly policy_digest: string | null;
    readonly max_calls: number | null;
    readonly max_cost_microusd: number | null;
    readonly expires_at: string | null;
    readonly halted: number;
}

function assertPilotDigest(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
        throw new TypeError('style-pilot-budget-digest-invalid');
    }
}

function assertPilotInput<T extends StyleCompilePilotBudgetPolicy>(input: T, reservation: boolean): T {
    const keys = reservation ? PILOT_RESERVATION_KEYS : PILOT_POLICY_KEYS;
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new TypeError('style-pilot-budget-input-invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).length !== keys.length || keys.some((key) => {
        const field = descriptors[key];
        return !field || !Object.hasOwn(field, 'value') || !field.enumerable;
    })) {
        throw new TypeError('style-pilot-budget-input-invalid');
    }
    input = Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]))) as T;
    assertPilotDigest(input.pilotIdDigest);
    assertPilotDigest(input.policyDigest);
    assertTimestamp(input.now);
    assertTimestamp(input.expiresAt);
    if (input.now >= input.expiresAt || !Number.isSafeInteger(input.maxCalls)
        || input.maxCalls < 1 || input.maxCalls > MAX_PILOT_CALLS
        || !Number.isSafeInteger(input.maxCostMicrousd) || input.maxCostMicrousd < 1
        || input.maxCostMicrousd > MAX_PILOT_COST_MICROUSD) {
        throw new TypeError('style-pilot-budget-policy-invalid');
    }
    if (reservation) {
        const permit = input as unknown as StyleCompilePilotBudgetReservation;
        assertPilotDigest(permit.reservationDigest);
        if (!Number.isSafeInteger(permit.reservedCostMicrousd) || permit.reservedCostMicrousd < 1
            || permit.reservedCostMicrousd > MAX_PILOT_COST_MICROUSD) {
            throw new TypeError('style-pilot-budget-reservation-invalid');
        }
    }
    return input;
}

function assertTimestamp(value: string): void {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
        || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) {
        throw new TypeError('style-compile-job-time-invalid');
    }
}

function assertIdentifier(value: string, label: string, maximum = 256): void {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
        throw new TypeError(`style-compile-job-${label}-invalid`);
    }
}

function normalizeResult(input: unknown): StyleCompileJobResult {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new TypeError('style-compile-job-result-invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some((key) => typeof key !== 'string'
        || !Object.hasOwn(descriptors[key]!, 'value'))) {
        throw new TypeError('style-compile-job-result-invalid');
    }
    const value = input as Record<string, unknown>;
    const keys = value.status === 'created' ? ['status', 'proposalId']
        : value.status === 'unknown' ? ['status', 'attempted'] : ['status'];
    if (Reflect.ownKeys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
        throw new TypeError('style-compile-job-result-invalid');
    }
    if (value.status === 'created') {
        assertIdentifier(value.proposalId as string, 'proposal-id');
        return Object.freeze({ status: 'created', proposalId: value.proposalId as string });
    }
    if (value.status === 'unknown' && (value.attempted === true || value.attempted === null)) {
        return Object.freeze({ status: 'unknown', attempted: value.attempted });
    }
    if (value.status === 'rejected' || value.status === 'skipped' || value.status === 'cancelled') {
        return Object.freeze({ status: value.status });
    }
    throw new TypeError('style-compile-job-result-invalid');
}

function assertInput(input: StyleCompileJobInput): StyleCompileJobInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new TypeError('style-compile-job-input-invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string' || !INPUT_KEYS.includes(key)) {
            throw new TypeError(`style-compile-job-forbidden-key: ${String(key)}`);
        }
        if (!Object.hasOwn(descriptors[key]!, 'value') || !descriptors[key]!.enumerable) {
            throw new TypeError('style-compile-job-input-invalid');
        }
    }
    if (INPUT_KEYS.some((key) => !Object.hasOwn(input, key))) {
        throw new TypeError('style-compile-job-input-incomplete');
    }
    input = Object.freeze(Object.fromEntries(INPUT_KEYS.map((key) => [key, descriptors[key]!.value]))) as unknown as StyleCompileJobInput;
    if (typeof input.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(input.jobId)) {
        throw new TypeError('style-compile-job-id-invalid');
    }
    assertIdentifier(input.sessionId, 'session-id');
    assertIdentifier(input.runId, 'run-id');
    if (typeof input.intentPacketDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input.intentPacketDigest)) {
        throw new TypeError('style-compile-job-intent-digest-invalid');
    }
    assertIdentifier(input.styleSkillId, 'skill-id');
    assertIdentifier(input.sourceRevision, 'source-revision', 512);
    assertTimestamp(input.now);
    if (!['nsf', 'nsfw'].includes(input.contentMode)
        || !Number.isSafeInteger(input.round) || input.round < 0 || typeof input.explicitRequest !== 'boolean') {
        throw new TypeError('style-compile-job-input-invalid');
    }
    return input;
}

export class StyleCompileJobStore {
    readonly #db: DatabaseSync;
    // SQLite may reject a halt while retaining the permit. Close paid authority for this Store's lifetime.
    #pilotBudgetFaulted = false;

    constructor(options: Readonly<{ dataDir: string; now: () => string }>) {
        const now = options.now();
        assertTimestamp(now);
        mkdirSync(options.dataDir, { recursive: true });
        this.#db = new DatabaseSync(join(options.dataDir, STYLE_COMPILE_JOB_DB_FILE));
        try {
            this.#db.exec('PRAGMA busy_timeout=5000');
            this.#migrate(now);
        } catch (error) {
            this.#db.close();
            throw error;
        }
    }

    #migrate(now: string): void {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const application = this.#db.prepare('PRAGMA application_id').get() as { application_id: number };
            if (application.application_id !== 0 && application.application_id !== STYLE_COMPILE_JOB_APPLICATION_ID) {
                throw new Error('style-compile-job-application-id-unsupported');
            }
            const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
                .all() as Array<{ name: string }>;
            const allowedTables = [
                'style_compile_job', 'style_compile_job_schema',
                'style_compile_pilot_budget', 'style_compile_pilot_permit',
            ];
            if (tables.some(({ name }) => !allowedTables.includes(name))) {
                throw new Error('style-compile-job-schema-foreign');
            }
            const header = this.#db.prepare('PRAGMA user_version').get() as { user_version: number };
            if (!Number.isSafeInteger(header.user_version) || header.user_version < 0
                || header.user_version > STYLE_COMPILE_JOB_SCHEMA_VERSION) {
                throw new Error('style-compile-job-sqlite-version-unsupported');
            }
            const schemaExists = this.#db.prepare(`SELECT name FROM sqlite_master
                WHERE type='table' AND name='style_compile_job_schema'`).get();
            const row = schemaExists
                ? this.#db.prepare('SELECT version FROM style_compile_job_schema WHERE id=1')
                    .get() as { version: number } | undefined
                : undefined;
            // Reject newer contracts before altering their job table.
            if (row && ![2, 3, 4, STYLE_COMPILE_JOB_SCHEMA_VERSION].includes(row.version)) {
                throw new Error('style-compile-job-schema-version-unsupported');
            }
            this.#db.exec(`CREATE TABLE IF NOT EXISTS style_compile_job (
                job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content_mode TEXT NOT NULL,
                style_skill_id TEXT NOT NULL, round INTEGER NOT NULL, source_revision TEXT NOT NULL,
                explicit_request INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                owner TEXT, lease_expires_at TEXT, reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                availability_deferrals INTEGER NOT NULL DEFAULT 0, not_before TEXT,
                run_id TEXT, intent_packet_digest TEXT, execution_started_at TEXT, result_json TEXT
            );
            CREATE INDEX IF NOT EXISTS style_compile_job_due ON style_compile_job(state, lease_expires_at);
            CREATE TABLE IF NOT EXISTS style_compile_job_schema (
                id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL
            )`);
            if (!row || row.version < 4) {
                const columns = this.#db.prepare('PRAGMA table_info(style_compile_job)')
                    .all() as Array<{ name: string }>;
                if (!columns.some((column) => column.name === 'availability_deferrals')) {
                    this.#db.exec('ALTER TABLE style_compile_job ADD COLUMN availability_deferrals INTEGER NOT NULL DEFAULT 0');
                }
                if (!columns.some((column) => column.name === 'not_before')) {
                    this.#db.exec('ALTER TABLE style_compile_job ADD COLUMN not_before TEXT');
                }
                for (const column of ['run_id', 'intent_packet_digest', 'execution_started_at', 'result_json']) {
                    if (!columns.some((existing) => existing.name === column)) {
                        this.#db.exec(`ALTER TABLE style_compile_job ADD COLUMN ${column} TEXT`);
                    }
                }
            }
            if (!row) {
                // v1 没有执行意图标记；leased 可能已发送模型请求，重启不能将其当作可重试。
                this.#db.prepare(`UPDATE style_compile_job
                    SET state='uncertain', owner=NULL, lease_expires_at=NULL, reason_code=?, updated_at=?
                    WHERE state IN ('leased','executing')`).run('style-job-execution-uncertain', now);
                this.#db.prepare('INSERT INTO style_compile_job_schema(id,version) VALUES(1,?)')
                    .run(STYLE_COMPILE_JOB_SCHEMA_VERSION);
            } else if (row.version < STYLE_COMPILE_JOB_SCHEMA_VERSION) {
                this.#db.prepare('UPDATE style_compile_job_schema SET version=? WHERE id=1')
                    .run(STYLE_COMPILE_JOB_SCHEMA_VERSION);
            }
            if (!row || row.version < 4) {
                // Old inputs contain no original packet authority. Never infer it from run/source fields.
                this.#db.prepare(`UPDATE style_compile_job SET state='cancelled', owner=NULL,
                lease_expires_at=NULL, not_before=NULL, reason_code=?, result_json=?, updated_at=?
                WHERE (run_id IS NULL OR intent_packet_digest IS NULL) AND state IN ('pending','leased')`)
                .run('style-job-intent-unbound', JSON.stringify({ status: 'cancelled' }), now);
                this.#db.prepare(`UPDATE style_compile_job SET state='uncertain', owner=NULL,
                lease_expires_at=NULL, reason_code=?, result_json=?, updated_at=?
                WHERE (run_id IS NULL OR intent_packet_digest IS NULL) AND state IN ('executing','uncertain')`)
                .run('style-job-execution-uncertain', JSON.stringify({ status: 'unknown', attempted: null }), now);
            }
            this.#db.exec('CREATE INDEX IF NOT EXISTS style_compile_job_available ON style_compile_job(state,not_before,created_at)');
            this.#db.exec('CREATE INDEX IF NOT EXISTS style_compile_job_session ON style_compile_job(session_id)');
            this.#db.exec(`CREATE TABLE IF NOT EXISTS style_compile_pilot_budget (
                pilot_id_digest TEXT PRIMARY KEY, policy_digest TEXT, max_calls INTEGER,
                max_cost_microusd INTEGER, expires_at TEXT, halted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS style_compile_pilot_permit (
                reservation_digest TEXT PRIMARY KEY, pilot_id_digest TEXT NOT NULL,
                reserved_cost_microusd INTEGER NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS style_compile_pilot_permit_budget
                ON style_compile_pilot_permit(pilot_id_digest)`);
            // A reopened ledger cannot prove what happened after dispatch or after a backup.
            // Existing paid authority is therefore never automatically restored by a new connection.
            this.#db.exec(`UPDATE style_compile_pilot_budget SET halted=1 WHERE pilot_id_digest IN
                (SELECT pilot_id_digest FROM style_compile_pilot_permit)`);
            if (this.#db.prepare(`SELECT 1 FROM style_compile_pilot_permit AS permit
                LEFT JOIN style_compile_pilot_budget AS budget USING(pilot_id_digest)
                WHERE budget.halted IS NOT 1 LIMIT 1`).get()) {
                throw new Error('style-pilot-budget-reopen-halt-failed');
            }
            // Legacy v1-v4 files used only their application schema row (header=0).
            // Snapshot inventory requires a positive, real SQLite migration header.
            this.#db.exec(`PRAGMA user_version=${STYLE_COMPILE_JOB_SCHEMA_VERSION}`);
            this.#db.exec(`PRAGMA application_id=${STYLE_COMPILE_JOB_APPLICATION_ID}`);
            this.#db.exec('COMMIT');
        } catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    close(): void {
        this.#db.close();
    }

    #pilotWrite(effect: () => void): void {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            effect();
            this.#db.exec('COMMIT');
        } catch (error) {
            if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    #pilotRow(pilotIdDigest: string): PilotBudgetRow | null {
        const row = this.#db.prepare('SELECT * FROM style_compile_pilot_budget WHERE pilot_id_digest=?')
            .get(pilotIdDigest) as unknown as PilotBudgetRow | undefined;
        if (!row) return null;
        if (row.halted !== 0 && row.halted !== 1) throw new Error('style-pilot-budget-state-invalid');
        if (row.policy_digest === null && row.max_calls === null && row.max_cost_microusd === null
            && row.expires_at === null && row.halted === 1) return row;
        assertPilotDigest(row.policy_digest);
        assertTimestamp(row.expires_at as string);
        if (!Number.isSafeInteger(row.max_calls) || row.max_calls! < 1 || row.max_calls! > MAX_PILOT_CALLS
            || !Number.isSafeInteger(row.max_cost_microusd) || row.max_cost_microusd! < 1
            || row.max_cost_microusd! > MAX_PILOT_COST_MICROUSD) {
            throw new Error('style-pilot-budget-state-invalid');
        }
        return row;
    }

    #pilotUsage(pilotIdDigest: string): Readonly<{ calls: number; reservedCostMicrousd: number }> {
        const usage = this.#db.prepare(`SELECT COUNT(*) AS calls,
            COALESCE(SUM(reserved_cost_microusd),0) AS cost FROM style_compile_pilot_permit WHERE pilot_id_digest=?`)
            .get(pilotIdDigest) as { calls: number; cost: number };
        if (!Number.isSafeInteger(usage.calls) || usage.calls < 0 || usage.calls > MAX_PILOT_CALLS
            || !Number.isSafeInteger(usage.cost) || usage.cost < 0 || usage.cost > MAX_PILOT_COST_MICROUSD) {
            throw new Error('style-pilot-budget-state-invalid');
        }
        // A negative/fractional corrupt row must not cancel another reservation in SUM and mint headroom.
        const permits = this.#db.prepare(`SELECT reservation_digest,reserved_cost_microusd,created_at
            FROM style_compile_pilot_permit WHERE pilot_id_digest=?`).all(pilotIdDigest);
        for (const permit of permits) {
            assertPilotDigest(permit.reservation_digest);
            assertTimestamp(permit.created_at as string);
            if (!Number.isSafeInteger(permit.reserved_cost_microusd)
                || Number(permit.reserved_cost_microusd) < 1
                || Number(permit.reserved_cost_microusd) > MAX_PILOT_COST_MICROUSD) {
                throw new Error('style-pilot-budget-state-invalid');
            }
        }
        return Object.freeze({ calls: usage.calls, reservedCostMicrousd: usage.cost });
    }

    #assertPilotCapacity(): void {
        const row = this.#db.prepare('SELECT COUNT(*) AS count FROM style_compile_pilot_budget')
            .get() as { count: number };
        if (!Number.isSafeInteger(row.count) || row.count >= MAX_PILOTS) {
            throw new Error('style-pilot-budget-capacity-exhausted');
        }
    }

    #assertPilotPolicy(row: PilotBudgetRow, input: StyleCompilePilotBudgetPolicy): void {
        if (row.halted === 1) throw new Error('style-pilot-budget-halted');
        if (row.policy_digest !== input.policyDigest || row.max_calls !== input.maxCalls
            || row.max_cost_microusd !== input.maxCostMicrousd || row.expires_at !== input.expiresAt) {
            throw new Error('style-pilot-budget-policy-conflict');
        }
    }

    /** Only the explicit offline operator path may register a new immutable pilot policy. */
    openPilotBudget(input: StyleCompilePilotBudgetPolicy): void {
        input = assertPilotInput(input, false);
        if (this.#pilotBudgetFaulted) throw new Error('style-pilot-budget-faulted');
        this.#pilotWrite(() => {
            const existing = this.#pilotRow(input.pilotIdDigest);
            if (existing) {
                this.#assertPilotPolicy(existing, input);
                return;
            }
            this.#assertPilotCapacity();
            const inserted = this.#db.prepare(`INSERT INTO style_compile_pilot_budget
                (pilot_id_digest,policy_digest,max_calls,max_cost_microusd,expires_at,halted) VALUES(?,?,?,?,?,0)`)
                .run(input.pilotIdDigest, input.policyDigest, input.maxCalls, input.maxCostMicrousd, input.expiresAt);
            if (Number(inserted.changes) !== 1) throw new Error('style-pilot-budget-registration-failed');
            this.#assertPilotPolicy(this.#pilotRow(input.pilotIdDigest)!, input);
        });
    }

    /** Pre-dispatch pessimistic reservation: no refund, renewal, replay or automatic registration. */
    reservePilotBudget(input: StyleCompilePilotBudgetReservation): void {
        input = assertPilotInput(input, true);
        if (this.#pilotBudgetFaulted) throw new Error('style-pilot-budget-faulted');
        this.#pilotWrite(() => {
            const policy = this.#pilotRow(input.pilotIdDigest);
            if (!policy) throw new Error('style-pilot-budget-unregistered');
            this.#assertPilotPolicy(policy, input);
            if (this.#db.prepare('SELECT 1 FROM style_compile_pilot_permit WHERE reservation_digest=?')
                .get(input.reservationDigest)) throw new Error('style-pilot-budget-reservation-replayed');
            const usage = this.#pilotUsage(input.pilotIdDigest);
            const nextCost = usage.reservedCostMicrousd + input.reservedCostMicrousd;
            if (usage.calls >= input.maxCalls || nextCost > input.maxCostMicrousd) {
                throw new Error('style-pilot-budget-exhausted');
            }
            const inserted = this.#db.prepare(`INSERT INTO style_compile_pilot_permit
                (reservation_digest,pilot_id_digest,reserved_cost_microusd,created_at) VALUES(?,?,?,?)`)
                .run(input.reservationDigest, input.pilotIdDigest, input.reservedCostMicrousd, input.now);
            const after = this.#pilotUsage(input.pilotIdDigest);
            if (Number(inserted.changes) !== 1 || after.calls !== usage.calls + 1
                || after.reservedCostMicrousd !== nextCost) {
                throw new Error('style-pilot-budget-reservation-failed');
            }
        });
    }

    /** An unknown pilot receives a permanent tombstone so halt can never accidentally grant authority. */
    haltPilotBudget(pilotIdDigest: string): void {
        assertPilotDigest(pilotIdDigest);
        try {
            this.#pilotWrite(() => {
                if (!this.#pilotRow(pilotIdDigest)) {
                    this.#assertPilotCapacity();
                    this.#db.prepare(`INSERT INTO style_compile_pilot_budget
                        (pilot_id_digest,policy_digest,max_calls,max_cost_microusd,expires_at,halted)
                        VALUES(?,NULL,NULL,NULL,NULL,1)`).run(pilotIdDigest);
                } else {
                    this.#db.prepare('UPDATE style_compile_pilot_budget SET halted=1 WHERE pilot_id_digest=?')
                        .run(pilotIdDigest);
                }
                if (this.#pilotRow(pilotIdDigest)?.halted !== 1) throw new Error('style-pilot-budget-halt-failed');
            });
        } catch (error) {
            // Shared by all per-run clients. Even a later successful halt cannot silently reopen this Store.
            // A new Store also seals consumed pilots from the retained durable permits during migration.
            this.#pilotBudgetFaulted = true;
            throw error;
        }
    }

    pilotBudgetSnapshot(pilotIdDigest: string): Readonly<{
        calls: number; reservedCostMicrousd: number; halted: boolean;
    }> | null {
        assertPilotDigest(pilotIdDigest);
        const policy = this.#pilotRow(pilotIdDigest);
        if (!policy) return null;
        return Object.freeze({ ...this.#pilotUsage(pilotIdDigest), halted: policy.halted === 1 });
    }

    #row(jobId: string): StyleCompileJobRecord | null {
        const row = this.#db.prepare('SELECT * FROM style_compile_job WHERE job_id=?')
            .get(jobId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return Object.freeze({
            jobId: String(row.job_id), sessionId: String(row.session_id),
            runId: row.run_id === null ? null : String(row.run_id),
            intentPacketDigest: row.intent_packet_digest === null ? null : String(row.intent_packet_digest),
            contentMode: row.content_mode as 'nsf' | 'nsfw', styleSkillId: String(row.style_skill_id),
            round: Number(row.round), sourceRevision: String(row.source_revision),
            explicitRequest: Number(row.explicit_request) === 1, state: row.state as StyleCompileJobState,
            attempts: Number(row.attempts), owner: row.owner === null ? null : String(row.owner),
            availabilityDeferrals: Number(row.availability_deferrals),
            notBefore: row.not_before === null ? null : String(row.not_before),
            leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
            reasonCode: (row.reason_code as StyleCompileJobReasonCode | null) ?? null,
            executionStartedAt: row.execution_started_at === null ? null : String(row.execution_started_at),
            result: row.result_json === null ? null : normalizeResult(JSON.parse(String(row.result_json))),
            createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        });
    }

    read(jobId: string): StyleCompileJobRecord | null {
        return this.#row(jobId);
    }

    /** Bounded metadata-only sweep, including terminal rows which may have survived a restore. */
    scanSessionIds(input: Readonly<{ cursor: string | null; limit: number }>): Readonly<{
        sessionIds: readonly string[]; nextCursor: string | null;
    }> {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 128) {
            throw new TypeError('style-compile-job-session-scan-limit-invalid');
        }
        if (input.cursor !== null) assertIdentifier(input.cursor, 'session-cursor');
        const rows = this.#db.prepare(`SELECT DISTINCT session_id FROM style_compile_job
            WHERE (? IS NULL OR session_id>?) ORDER BY session_id LIMIT ?`)
            .all(input.cursor, input.cursor, input.limit + 1) as Array<{ session_id: string }>;
        const selected = rows.slice(0, input.limit);
        for (const row of selected) assertIdentifier(row.session_id, 'session-id');
        return Object.freeze({ sessionIds: Object.freeze(selected.map((row) => row.session_id)),
            nextCursor: rows.length > input.limit ? selected.at(-1)!.session_id : null });
    }

    enqueue(input: StyleCompileJobInput): Readonly<{ created: boolean; replayed: boolean }> {
        input = assertInput(input);
        // INSERT OR IGNORE 将并发入账的胜者交给主键约束，随后逐字段核对幂等性。
        const changed = this.#db.prepare(`INSERT OR IGNORE INTO style_compile_job
            (job_id,session_id,run_id,intent_packet_digest,content_mode,style_skill_id,round,source_revision,explicit_request,
             state,attempts,owner,lease_expires_at,reason_code,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,'pending',0,NULL,NULL,NULL,?,?)`)
            .run(input.jobId, input.sessionId, input.runId, input.intentPacketDigest, input.contentMode, input.styleSkillId, input.round,
                input.sourceRevision, input.explicitRequest ? 1 : 0, input.now, input.now);
        if (Number(changed.changes) === 1) return Object.freeze({ created: true, replayed: false });
        const existing = this.#row(input.jobId);
        if (existing && existing.sessionId === input.sessionId && existing.contentMode === input.contentMode
            && existing.runId === input.runId && existing.intentPacketDigest === input.intentPacketDigest
            && existing.styleSkillId === input.styleSkillId && existing.round === input.round
            && existing.sourceRevision === input.sourceRevision && existing.explicitRequest === input.explicitRequest) {
            return Object.freeze({ created: false, replayed: true });
        }
        throw new Error('style-compile-job-conflict');
    }

    claimDue(options: Readonly<{ owner: string; now: string; leaseMs: number; limit: number }>):
        readonly StyleCompileJobRecord[] {
        assertIdentifier(options.owner, 'owner');
        assertTimestamp(options.now);
        if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0
            || !Number.isSafeInteger(options.limit) || options.limit < 1) {
            throw new TypeError('style-compile-job-claim-args-invalid');
        }
        const leaseUntil = new Date(Date.parse(options.now) + options.leaseMs).toISOString();
        assertTimestamp(leaseUntil);
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            this.#db.prepare(`UPDATE style_compile_job
                SET state='uncertain', owner=NULL, lease_expires_at=NULL, reason_code=?, result_json=?, updated_at=?
                WHERE state='executing' AND lease_expires_at<=?`)
                .run('style-job-execution-uncertain', JSON.stringify({ status: 'unknown', attempted: null }), options.now, options.now);
            this.#db.prepare(`UPDATE style_compile_job
                SET state='failed', owner=NULL, lease_expires_at=NULL, reason_code=?, result_json=?, updated_at=?
                WHERE state='leased' AND lease_expires_at<=? AND attempts-availability_deferrals>=?`)
                .run('style-job-attempts-exhausted', JSON.stringify({ status: 'cancelled' }), options.now, options.now, MAX_ATTEMPTS);
            const rows = this.#db.prepare(`SELECT job_id FROM style_compile_job
                WHERE run_id IS NOT NULL AND intent_packet_digest IS NOT NULL
                AND ((state='pending' AND (not_before IS NULL OR not_before<=?))
                OR (state='leased' AND lease_expires_at<=?)) ORDER BY created_at,job_id LIMIT ?`)
                .all(options.now, options.now, options.limit) as Array<{ job_id: string }>;
            const claimed: StyleCompileJobRecord[] = [];
            for (const { job_id: jobId } of rows) {
                this.#db.prepare(`UPDATE style_compile_job SET state='leased', owner=?, lease_expires_at=?,
                    attempts=attempts+1, not_before=NULL, reason_code=NULL, updated_at=? WHERE job_id=?`)
                    .run(options.owner, leaseUntil, options.now, jobId);
                claimed.push(this.#row(jobId)!);
            }
            this.#db.exec('COMMIT');
            return Object.freeze(claimed);
        } catch (error) {
            this.#db.exec('ROLLBACK');
            throw error;
        }
    }

    isClaimCurrent(claim: StyleCompileJobClaim, now: string, expectedState?: 'leased' | 'executing'): boolean {
        assertTimestamp(now);
        const row = this.#row(claim.jobId);
        return !!row && typeof claim.owner === 'string' && claim.owner.length > 0
            && Number.isSafeInteger(claim.attempts) && claim.attempts > 0
            && row.owner === claim.owner && row.attempts === claim.attempts
            && (expectedState ? row.state === expectedState : row.state === 'leased' || row.state === 'executing')
            && row.leaseExpiresAt !== null && row.leaseExpiresAt > now;
    }

    startExecution(claim: StyleCompileJobClaim, now: string): boolean {
        assertTimestamp(now);
        const changed = this.#db.prepare(`UPDATE style_compile_job SET state='executing', execution_started_at=?, updated_at=?
            WHERE job_id=? AND state='leased' AND owner=? AND attempts=? AND lease_expires_at>?
                AND run_id IS NOT NULL AND intent_packet_digest IS NOT NULL`)
            .run(now, now, claim.jobId, claim.owner, claim.attempts, now);
        return Number(changed.changes) === 1;
    }

    /** Only a current, unstarted lease may wait for availability; dispatched work is never replayable. */
    deferUnavailable(claim: StyleCompileJobClaim, now: string, delayMs: number): boolean {
        assertTimestamp(now);
        if (!Number.isSafeInteger(delayMs) || delayMs <= 0) {
            throw new TypeError('style-compile-job-defer-delay-invalid');
        }
        const notBefore = new Date(Date.parse(now) + delayMs).toISOString();
        assertTimestamp(notBefore);
        const changed = this.#db.prepare(`UPDATE style_compile_job
            SET state='pending', owner=NULL, lease_expires_at=NULL, not_before=?,
                availability_deferrals=availability_deferrals+1, reason_code=?, updated_at=?
            WHERE job_id=? AND state='leased' AND owner=? AND attempts=? AND lease_expires_at>?`)
            .run(notBefore, 'style-job-deferred-unavailable', now, claim.jobId, claim.owner, claim.attempts, now);
        return Number(changed.changes) === 1;
    }

    #settle(claim: StyleCompileJobClaim, state: 'done' | 'failed' | 'cancelled',
        reasonCode: StyleCompileJobReasonCode, now: string, result: StyleCompileJobResult,
        executingOnly = false): boolean {
        assertTimestamp(now);
        const changed = this.#db.prepare(`UPDATE style_compile_job
            SET state=?, owner=NULL, lease_expires_at=NULL, reason_code=?, result_json=?, updated_at=?
            WHERE job_id=? AND state IN (${executingOnly ? "'executing'" : "'leased','executing'"})
                AND owner=? AND attempts=? AND lease_expires_at>?`)
            .run(state, reasonCode, JSON.stringify(normalizeResult(result)), now, claim.jobId, claim.owner, claim.attempts, now);
        return Number(changed.changes) === 1;
    }

    complete(claim: StyleCompileJobClaim, reasonCode: StyleCompileJobReasonCode, now: string): boolean {
        if (!['style-job-failed-provider', 'style-job-failed-rejected'].includes(reasonCode)) {
            throw new TypeError('style-compile-job-complete-reason-invalid');
        }
        if (!this.isClaimCurrent(claim, now, 'executing')) return false;
        return reasonCode === 'style-job-failed-provider'
            ? this.markUncertain(claim, now)
            : this.#settle(claim, 'failed', reasonCode, now, { status: 'rejected' }, true);
    }

    fenceByExecutor(claim: StyleCompileJobClaim, now: string): boolean {
        const row = this.#row(claim.jobId);
        return this.#settle(claim, 'cancelled', 'style-job-fenced-source-revision', now,
            row?.executionStartedAt ? { status: 'unknown', attempted: null } : { status: 'cancelled' });
    }

    skipIneligible(claim: StyleCompileJobClaim, now: string): boolean {
        return this.#settle(claim, 'cancelled', 'style-job-skipped-ineligible', now, { status: 'skipped' });
    }

    markUncertain(claim: StyleCompileJobClaim, now: string, attempted: true | null = null): boolean {
        assertTimestamp(now);
        if (attempted !== true && attempted !== null) throw new TypeError('style-compile-job-result-invalid');
        const changed = this.#db.prepare(`UPDATE style_compile_job
            SET state='uncertain', owner=NULL, lease_expires_at=NULL, reason_code=?, result_json=?, updated_at=?
            WHERE job_id=? AND state IN ('leased','executing') AND owner=? AND attempts=?`)
            .run('style-job-execution-uncertain', JSON.stringify({ status: 'unknown', attempted }), now,
                claim.jobId, claim.owner, claim.attempts);
        return Number(changed.changes) === 1;
    }

    /**
     * SQLite 写锁覆盖权限复验、同步业务写入与账本提交。effect 必须同步且只做业务提交。
     * 业务库与账本不一定同库；effect/提交异常保留 uncertain，重启后禁止自动重复副作用。
     * true 只表示取得并使用了权限，业务成功必须读取 durable state/result；禁止视为 done。
     */
    withCommitAuthority(claim: StyleCompileJobClaim, now: string, effect: () => StyleCompileJobResult): boolean {
        assertTimestamp(now);
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            if (!this.isClaimCurrent(claim, now, 'executing')) {
                this.#db.exec('COMMIT');
                return false;
            }
            if (Object.prototype.toString.call(effect) === '[object AsyncFunction]') {
                throw new TypeError('style-compile-job-commit-must-be-synchronous');
            }
            const result: unknown = effect();
            if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
                // 合同违规仍记 unknown；观察迟到拒绝，避免未处理 Promise 将 Worker 进程终止。
                void Promise.resolve(result).catch(() => {});
                throw new TypeError('style-compile-job-commit-must-be-synchronous');
            }
            const normalized = normalizeResult(result);
            // Only an acknowledged created proposal proves completion. A returned rejection may follow
            // a partially applied domain write, so no-effect semantics cannot be inferred here.
            const settled = normalized.status === 'created'
                ? this.#settle(claim, 'done', 'style-job-completed', now, normalized, true)
                : this.markUncertain(claim, now, normalized.status === 'unknown' ? normalized.attempted : true);
            if (!settled) {
                throw new Error('style-compile-job-commit-authority-lost');
            }
            this.#db.exec('COMMIT');
            return true;
        } catch (error) {
            this.#db.exec('ROLLBACK');
            this.markUncertain(claim, now);
            throw error;
        }
    }

    cancelForSession(sessionId: string, reasonCode: 'style-job-cancelled-session-deleted'
        | 'style-job-cancelled-request' | 'style-job-cancelled-quiesce', now: string): number {
        assertIdentifier(sessionId, 'session-id');
        assertTimestamp(now);
        if (!CANCEL_REASONS.includes(reasonCode)) throw new TypeError('style-compile-job-cancel-reason-invalid');
        const changed = this.#db.prepare(`UPDATE style_compile_job
            SET state='cancelled', owner=NULL, lease_expires_at=NULL, reason_code=?,
                result_json=CASE WHEN execution_started_at IS NULL THEN ? ELSE ? END, updated_at=?
            WHERE session_id=? AND state IN ('pending','leased','executing')`)
            .run(reasonCode, JSON.stringify({ status: 'cancelled' }),
                JSON.stringify({ status: 'unknown', attempted: null }), now, sessionId);
        return Number(changed.changes);
    }

    cancelBySourceRevision(sessionId: string, sourceRevision: string, now: string): number {
        assertIdentifier(sessionId, 'session-id');
        assertIdentifier(sourceRevision, 'source-revision', 512);
        assertTimestamp(now);
        const changed = this.#db.prepare(`UPDATE style_compile_job
            SET state='cancelled', owner=NULL, lease_expires_at=NULL, reason_code=?,
                result_json=CASE WHEN execution_started_at IS NULL THEN ? ELSE ? END, updated_at=?
            WHERE session_id=? AND source_revision=? AND state IN ('pending','leased','executing')`)
            .run('style-job-fenced-source-revision', JSON.stringify({ status: 'cancelled' }),
                JSON.stringify({ status: 'unknown', attempted: null }), now, sessionId, sourceRevision);
        return Number(changed.changes);
    }

    stats(): Readonly<Record<StyleCompileJobState, number>> {
        const rows = this.#db.prepare('SELECT state, COUNT(*) AS n FROM style_compile_job GROUP BY state')
            .all() as Array<{ state: StyleCompileJobState; n: number }>;
        const out = { pending: 0, leased: 0, executing: 0, uncertain: 0, done: 0, failed: 0, cancelled: 0 };
        for (const row of rows) out[row.state] = row.n;
        return Object.freeze(out);
    }

    /** Host must already hold the durable privacy fence and quiesce this Session. */
    deleteSessionAfterPrivacyFence(sessionId: string): void {
        assertIdentifier(sessionId, 'session-id');
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            this.#db.prepare('DELETE FROM style_compile_job WHERE session_id=?').run(sessionId);
            if (this.#db.prepare('SELECT 1 FROM style_compile_job WHERE session_id=? LIMIT 1').get(sessionId)) {
                throw new Error('style-compile-job-redaction-incomplete');
            }
            this.#db.exec('COMMIT');
        } catch (error) {
            if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
            throw error;
        }
    }
}
