import { randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { sqliteTransaction } from './sqlite-transaction.ts';
import { DIRECTOR_PLAN_OUTPUT_TOKENS, assertMaterial, assertSourceSnapshot, creativeContinuitySchema, creativeDigest, creativePolicySchema, creativeToken,
    initialMaterial, type CreativeContinuity, type CreativePolicy, type DirectorSourceSnapshot, type SceneMaterial } from './director-creative-contract.ts';
import { acceptedSceneContext, assertSequencePlan, renderDirectorStoryboard } from './director-sequence-plan.ts';

export const DIRECTOR_CREATIVE_DB_FILE = 'director-creative.sqlite';
export const DIRECTOR_CREATIVE_APPLICATION_ID = 0x4a474443;
const APP = DIRECTOR_CREATIVE_APPLICATION_ID;
const budgetSchema = z.object({ maxCalls: z.number().int().positive().max(32), callsUsed: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().positive().max(65536), outputReserved: z.number().int().nonnegative(),
    inputUsed: z.number().int().nonnegative(), outputUsed: z.number().int().nonnegative(), usageUnknown: z.boolean() }).strict();
const sessionSchema = z.object({ schemaVersion: z.literal('creative-session-v1'), id: creativeToken,
    ownerSessionId: creativeToken, partition: z.enum(['nsf', 'nsfw']), adaptationBranchId: creativeToken,
    revision: z.number().int().positive(), activeRevision: z.number().int().positive(),
    status: z.enum(['paused', 'running', 'cancelled', 'failed']), stage: z.literal('material'),
    attemptId: creativeToken.nullable(), stepKey: creativeToken.nullable(),
    policy: creativePolicySchema, budget: budgetSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
    failureCode: z.string().nullable(),
}).strict();
export type CreativeSession = z.infer<typeof sessionSchema>;
export interface CreativeRevision {
    schemaVersion: 'creative-revision-v1'; revision: number; source: DirectorSourceSnapshot;
    material: SceneMaterial; reason: string; operationKey: string; createdAt: string; continuity?: CreativeContinuity;
}
const SCHEMA = [
    `CREATE TABLE creative_session (id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,
        UNIQUE(owner,request_key))`,
    `CREATE UNIQUE INDEX creative_one_running ON creative_session((1)) WHERE status='running'`,
    `CREATE TABLE creative_revision (session_id TEXT NOT NULL,revision INTEGER NOT NULL,operation_key TEXT NOT NULL,
        payload TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(session_id,revision),UNIQUE(session_id,operation_key))`,
    `CREATE TABLE creative_artifact (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,revision INTEGER NOT NULL,
        kind TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL)`,
    `CREATE TRIGGER creative_revision_immutable BEFORE UPDATE ON creative_revision BEGIN SELECT RAISE(ABORT,'director-revision-immutable'); END`,
    `CREATE TRIGGER creative_artifact_immutable BEFORE UPDATE ON creative_artifact BEGIN SELECT RAISE(ABORT,'director-artifact-immutable'); END`,
];
const schemaSql = (db: DatabaseSync) => db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => String(row.sql).replace(/\s+/gu, ' ').trim()).sort();
export function inspectDirectorCreativeSchema(db: DatabaseSync): void {
    if (db.prepare('PRAGMA application_id').get()?.application_id !== APP || db.prepare('PRAGMA user_version').get()?.user_version !== 1
        || JSON.stringify(schemaSql(db)) !== JSON.stringify(SCHEMA.map(sql => sql.replace(/\s+/gu, ' ').trim()).sort()))
        throw new Error('director-storage-schema-invalid');
}
function fail(code: string): never { throw new Error(`director-${code}`); }
function jsonValue(row: Record<string, unknown>): unknown {
    if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > (row.kind === 'export' ? 1048576 : 524288)) return fail('storage-invalid');
    const value = JSON.parse(row.payload);
    if (creativeDigest(value) !== row.digest) return fail('storage-invalid');
    return value;
}

/** One creation owner, immutable revisions and artifacts. No scheduler, lease or RP writer. */
export class DirectorCreativeStore {
    readonly #db: DatabaseSync;
    readonly #allowed: (owner: string) => boolean;
    readonly #now: () => string;
    constructor(input: { dataDir: string; allowed(owner: string): boolean; now?: () => string }) {
        mkdirSync(input.dataDir, { recursive: true });
        const path = join(input.dataDir, DIRECTOR_CREATIVE_DB_FILE);
        if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) fail('storage-file-invalid');
        this.#db = new DatabaseSync(path); this.#allowed = input.allowed; this.#now = input.now ?? (() => new Date().toISOString());
        try {
            this.#db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL');
            if (this.#db.prepare('PRAGMA user_version').get()?.user_version === 0) {
                if (schemaSql(this.#db).length || this.#db.prepare('PRAGMA application_id').get()?.application_id !== 0) fail('storage-schema-invalid');
                sqliteTransaction(this.#db, () => {
                    for (const sql of SCHEMA) this.#db.exec(sql);
                    this.#db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=1`);
                });
            }
            inspectDirectorCreativeSchema(this.#db);
        } catch (error) { this.#db.close(); throw error; }
    }
    #permit(owner: string): void { if (this.#allowed(owner) !== true) fail('source-forbidden'); }
    #read(owner: string, id: string): CreativeSession {
        this.#permit(owner); creativeToken.parse(owner); creativeToken.parse(id);
        const row = this.#db.prepare('SELECT * FROM creative_session WHERE id=? AND owner=?').get(id, owner);
        if (!row) return fail('session-not-found');
        const value = sessionSchema.parse(jsonValue(row));
        if (value.id !== id || value.ownerSessionId !== owner || value.revision !== row.revision || value.status !== row.status) fail('storage-invalid');
        return value;
    }
    #revision(session: CreativeSession, revision = session.activeRevision): CreativeRevision {
        const row = this.#db.prepare('SELECT * FROM creative_revision WHERE session_id=? AND revision=?').get(session.id, revision);
        if (!row) return fail('revision-not-found');
        const raw = jsonValue(row) as CreativeRevision;
        const source = assertSourceSnapshot(raw.source);
        const material = assertMaterial(raw.material, source, session.policy);
        if (raw.schemaVersion !== 'creative-revision-v1' || raw.revision !== revision || source.sessionId !== session.ownerSessionId || source.partition !== session.partition
            || row.operation_key !== raw.operationKey) return fail('storage-invalid');
        const continuity = raw.continuity === undefined ? undefined : creativeContinuitySchema.parse(raw.continuity);
        return { ...raw, source, material, ...(continuity ? { continuity } : {}) };
    }
    #lineage(session: CreativeSession, version: CreativeRevision) {
        const sources: DirectorSourceSnapshot[] = [], seen = new Set([session.id]);
        const contexts: CreativeContinuity[] = [];
        let valid = true, child = session, current = version;
        while (current.continuity) {
            const link = current.continuity;
            if (seen.has(link.parentSessionId) || seen.size >= 32) return fail('continuity-invalid');
            seen.add(link.parentSessionId);
            const parent = this.#read(session.ownerSessionId, link.parentSessionId), parentVersion = this.#revision(parent, link.parentRevision);
            if (parent.adaptationBranchId !== child.adaptationBranchId || parent.partition !== child.partition
                || parentVersion.source.sourceSnapshotRef !== link.parentSourceSnapshotRef
                || current.source.firstRound <= parentVersion.source.lastRound) return fail('continuity-invalid');
            const plan = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='plan'")
                .get(link.parentPlanId, parent.id, link.parentRevision);
            const acceptance = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='review'")
                .get(link.parentAcceptanceId, parent.id, link.parentRevision);
            if (!plan || plan.digest !== link.parentPlanDigest || !acceptance || acceptance.digest !== link.parentAcceptanceDigest)
                return fail('continuity-invalid');
            const parsed = assertSequencePlan(jsonValue(plan), parentVersion.source, parent.policy);
            const record = jsonValue(acceptance) as { schemaVersion?: string; acceptedBy?: string; planId?: string; planDigest?: string; sourceSnapshotRef?: string;
                branchId?: string; revision?: number; boardId?: string; boardDigest?: string };
            const board = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='previz'")
                .get(record.boardId ?? '', parent.id, link.parentRevision);
            if (record.schemaVersion !== 'director-scene-acceptance-v1' || record.acceptedBy !== 'user' || record.planId !== link.parentPlanId
                || record.planDigest !== link.parentPlanDigest || record.sourceSnapshotRef !== link.parentSourceSnapshotRef
                || record.branchId !== parent.adaptationBranchId || record.revision !== link.parentRevision
                || !board || board.digest !== record.boardDigest
                || creativeDigest(acceptedSceneContext(parsed)) !== creativeDigest(link.accepted)) return fail('continuity-invalid');
            const preview = jsonValue(board) as { schemaVersion?: unknown; planId?: unknown; planDigest?: unknown; sourceSnapshotRef?: unknown;
                adaptationBranchId?: unknown; revision?: unknown; durationBasis?: unknown; shots?: unknown };
            if (preview.schemaVersion !== 'director-visual-board-v1' || preview.planId !== link.parentPlanId
                || preview.planDigest !== link.parentPlanDigest || preview.sourceSnapshotRef !== link.parentSourceSnapshotRef
                || preview.adaptationBranchId !== parent.adaptationBranchId || preview.revision !== link.parentRevision || preview.durationBasis !== 'estimated'
                || !Array.isArray(preview.shots) || creativeDigest(preview.shots) !== creativeDigest(parsed.shots)) return fail('continuity-invalid');
            if (parent.activeRevision !== link.parentRevision || parent.status === 'cancelled') valid = false;
            contexts.push(link);
            sources.push(parentVersion.source); child = parent; current = parentVersion;
        }
        return { valid, sources, contexts: contexts.reverse() };
    }
    #write(previous: CreativeSession, next: CreativeSession): CreativeSession {
        this.#permit(previous.ownerSessionId); sessionSchema.parse(next);
        const result = this.#db.prepare('UPDATE creative_session SET revision=?,status=?,payload=?,digest=? WHERE id=? AND revision=?')
            .run(next.revision, next.status, JSON.stringify(next), creativeDigest(next), previous.id, previous.revision);
        if (Number(result.changes) !== 1) return fail('revision-conflict');
        return next;
    }
    #expect(owner: string, id: string, revision: number, allowRunning = false, allowStaleContinuity = false): CreativeSession {
        const value = this.#read(owner, id);
        if (value.revision !== revision) return fail('revision-conflict');
        if (value.status === 'cancelled') return fail('cancelled');
        if (!allowRunning && value.status === 'running') return fail('step-running');
        if (!allowStaleContinuity && !this.#lineage(value, this.#revision(value)).valid) return fail('continuity-needs-review');
        return value;
    }
    #append(session: CreativeSession, input: { source: DirectorSourceSnapshot; material: unknown; reason: string; operationKey: string; continuity?: CreativeContinuity }): CreativeSession {
        const source = assertSourceSnapshot(input.source), material = assertMaterial(input.material, source, session.policy);
        if (source.sessionId !== session.ownerSessionId || source.partition !== session.partition || !input.reason || input.reason.length > 1000) return fail('revision-invalid');
        creativeToken.parse(input.operationKey);
        const revision = session.activeRevision + 1;
        if (revision > 128) return fail('revision-limit');
        const continuity = input.continuity ?? this.#revision(session).continuity;
        const value: CreativeRevision = { schemaVersion: 'creative-revision-v1', revision, source, material,
            reason: input.reason, operationKey: input.operationKey, createdAt: this.#now(), ...(continuity ? { continuity } : {}) };
        if (continuity && !this.#lineage(session, value).valid) return fail('continuity-needs-review');
        const payload = JSON.stringify(value);
        if (Buffer.byteLength(payload) > 524288) return fail('revision-limit');
        this.#db.prepare('INSERT INTO creative_revision VALUES(?,?,?,?,?)')
            .run(session.id, revision, input.operationKey, payload, creativeDigest(value));
        // Artifact currentness is derived from this pointer in the same read transaction;
        // old artifact bytes are never rewritten to pretend to match the new revision.
        return this.#write(session, { ...session, revision: session.revision + 1, activeRevision: revision,
            status: 'paused', failureCode: null, updatedAt: value.createdAt });
    }
    create(input: { source: DirectorSourceSnapshot; requestKey: string; policy: CreativePolicy; continuity?: CreativeContinuity; branchId?: string }): CreativeSession {
        const source = assertSourceSnapshot(input.source), policy = creativePolicySchema.parse(input.policy);
        const key = creativeToken.parse(input.requestKey), owner = source.sessionId;
        const continuity = input.continuity === undefined ? undefined : creativeContinuitySchema.parse(input.continuity);
        if (!!continuity !== !!input.branchId) return fail('continuity-invalid');
        const requestDigest = creativeDigest({ sourceRef: source.sourceSnapshotRef, policy, ...(continuity ? { continuity, branchId: input.branchId } : {}) });
        return sqliteTransaction(this.#db, () => {
            this.#permit(owner);
            const previous = this.#db.prepare('SELECT id,request_digest FROM creative_session WHERE owner=? AND request_key=?').get(owner, key);
            if (previous) {
                if (previous.request_digest !== requestDigest) return fail('idempotency-conflict');
                return this.#read(owner, String(previous.id));
            }
            const at = this.#now(), id = `creative-${randomUUID()}`;
            const session: CreativeSession = { schemaVersion: 'creative-session-v1', id, ownerSessionId: owner,
                partition: source.partition, adaptationBranchId: input.branchId ?? `adaptation-${randomUUID()}`, revision: 1, activeRevision: 1,
                status: 'paused', stage: 'material', attemptId: null, stepKey: null, policy,
                budget: { maxCalls: 8, callsUsed: 0, maxOutputTokens: 20480, outputReserved: 0, inputUsed: 0, outputUsed: 0, usageUnknown: false },
                createdAt: at, updatedAt: at, failureCode: null };
            const revision: CreativeRevision = { schemaVersion: 'creative-revision-v1', revision: 1, source,
                material: initialMaterial(), reason: 'manual-create', operationKey: key, createdAt: at, ...(continuity ? { continuity } : {}) };
            if (continuity && !this.#lineage(session, revision).valid) return fail('continuity-needs-review');
            if (continuity && this.#read(owner, continuity.parentSessionId).status !== 'paused') return fail('continuity-needs-review');
            this.#db.prepare('INSERT INTO creative_session VALUES(?,?,?,?,?,?,?,?)')
                .run(id, owner, key, requestDigest, 1, session.status, JSON.stringify(session), creativeDigest(session));
            this.#db.prepare('INSERT INTO creative_revision VALUES(?,?,?,?,?)')
                .run(id, 1, key, JSON.stringify(revision), creativeDigest(revision));
            this.#permit(owner); return session;
        });
    }
    read(owner: string, id: string, revision?: number) {
        return sqliteTransaction(this.#db, () => {
            const session = this.#read(owner, id), version = this.#revision(session, revision);
            const lineage = this.#lineage(session, version);
            const artifacts = this.#db.prepare('SELECT * FROM creative_artifact WHERE session_id=? AND revision=? ORDER BY created_at,id').all(id, version.revision)
                .map(row => ({ id: String(row.id), kind: String(row.kind), revision: Number(row.revision),
                    digest: String(row.digest), payload: jsonValue(row),
                    state: session.status === 'cancelled' || Number(row.revision) !== session.activeRevision || !lineage.valid ? 'stale' : 'current',
                    stalenessReason: session.status === 'cancelled' ? 'session-cancelled'
                        : Number(row.revision) !== session.activeRevision ? 'active-revision-changed' : !lineage.valid ? 'upstream-revised' : null }));
            // Stage is a read projection of the active immutable artifacts, not the selected historical revision.
            const activeKinds = this.#db.prepare('SELECT kind FROM creative_artifact WHERE session_id=? AND revision=?')
                .all(id, session.activeRevision).map(row => row.kind);
            const stage = activeKinds.includes('previz') ? 'previz' as const
                : activeKinds.includes('plan') ? 'rehearsal' as const : 'material' as const;
            this.#permit(owner); return { session: { ...session, stage }, version, artifacts,
                continuityStatus: lineage.valid ? 'current' as const : 'needs-review' as const, continuityContexts: lineage.contexts,
                lineageSources: lineage.sources };
        }, false);
    }
    revise(input: { owner: string; id: string; expectedRevision: number; material: unknown;
        source?: DirectorSourceSnapshot; operationKey: string; reason: string; continuity?: CreativeContinuity; refreshContinuity?: boolean }): CreativeSession {
        return sqliteTransaction(this.#db, () => {
            const session = this.#expect(input.owner, input.id, input.expectedRevision, false, input.refreshContinuity === true);
            if (input.refreshContinuity && (!input.continuity || this.#read(input.owner, input.continuity.parentSessionId).status !== 'paused'))
                return fail('continuity-needs-review');
            return this.#append(session, { ...input, source: input.source ?? this.#revision(session).source });
        });
    }
    saveArtifact(input: { owner: string; id: string; expectedRevision: number; artifactId: string;
        kind: 'plan' | 'previz' | 'review' | 'export'; payload: unknown }): void {
        creativeToken.parse(input.artifactId);
        if (!['plan', 'previz', 'review', 'export'].includes(input.kind) || Buffer.byteLength(JSON.stringify(input.payload)) > 262144)
            fail('artifact-invalid');
        sqliteTransaction(this.#db, () => {
            const session = this.#expect(input.owner, input.id, input.expectedRevision);
            const digest = creativeDigest(input.payload), previous = this.#db.prepare('SELECT * FROM creative_artifact WHERE id=?').get(input.artifactId);
            if (previous) {
                if (previous.session_id !== input.id || previous.revision !== session.activeRevision
                    || previous.kind !== input.kind || previous.digest !== digest) fail('idempotency-conflict');
                return;
            }
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)').run(input.artifactId,
                input.id, session.activeRevision, input.kind, JSON.stringify(input.payload), digest, this.#now());
            this.#permit(input.owner);
        });
    }
    savePlan(input: { owner: string; id: string; expectedRevision: number; operationKey: string; plan: unknown }): void {
        creativeToken.parse(input.operationKey);
        const payload = JSON.stringify(input.plan);
        if (Buffer.byteLength(payload) > 262144) return fail('artifact-invalid');
        const artifactId = 'plan-' + creativeDigest([input.id, input.operationKey]).slice(7);
        sqliteTransaction(this.#db, () => {
            const session = this.#expect(input.owner, input.id, input.expectedRevision);
            const digest = creativeDigest(input.plan);
            const existing = this.#db.prepare("SELECT * FROM creative_artifact WHERE session_id=? AND revision=? AND kind='plan'")
                .all(input.id, session.activeRevision);
            if (existing.length) {
                if (existing.length === 1 && existing[0]!.id === artifactId && existing[0]!.digest === digest) return;
                return fail('plan-conflict');
            }
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                .run(artifactId, input.id, session.activeRevision, 'plan', payload, digest, this.#now());
            this.#permit(input.owner);
        });
    }
    revisePlan(input: { owner: string; id: string; expectedRevision: number; operationKey: string; reason: string; plan: unknown;
        advice?: { id: string; digest: string; planDigest: string };
        feedback?: { id: string; digest: string; planDigest: string; boardId: string; boardDigest: string };
        comparison?: { id: string; digest: string; planDigest: string; visualReviewed: true } }): void {
        creativeToken.parse(input.operationKey);
        const payload = JSON.stringify(input.plan);
        if (Buffer.byteLength(payload) > 262144) return fail('artifact-invalid');
        sqliteTransaction(this.#db, () => {
            const previous = this.#expect(input.owner, input.id, input.expectedRevision);
            const previousPlan = this.#db.prepare("SELECT * FROM creative_artifact WHERE session_id=? AND revision=? AND kind='plan'")
                .all(input.id, previous.activeRevision);
            if (previousPlan.length !== 1) return fail('plan-not-found');
            const version = this.#revision(previous);
            let selection: { previousTreatmentId: string; selectedTreatmentId: string } | undefined;
            if (input.comparison) {
                if (input.comparison.visualReviewed !== true) return fail('selection-review-required');
                const compared = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='review'")
                    .get(input.comparison.id, input.id, previous.activeRevision);
                if (!compared || compared.digest !== input.comparison.digest || previousPlan[0]!.digest !== input.comparison.planDigest)
                    return fail('comparison-invalid');
                const record = jsonValue(compared) as { schemaVersion?: string; planId?: string; planDigest?: string; sourceSnapshotRef?: string; revision?: number };
                if (record.schemaVersion !== 'director-comparison-observation-v1' || record.planId !== previousPlan[0]!.id
                    || record.planDigest !== previousPlan[0]!.digest || record.sourceSnapshotRef !== version.source.sourceSnapshotRef
                    || record.revision !== previous.activeRevision) return fail('comparison-invalid');
                const oldPlan = assertSequencePlan(jsonValue(previousPlan[0]!), version.source, previous.policy);
                const nextPlan = assertSequencePlan(input.plan, version.source, previous.policy);
                if (oldPlan.selectedTreatmentId === nextPlan.selectedTreatmentId || !oldPlan.treatments.some(item => item.id === nextPlan.selectedTreatmentId))
                    return fail('selection-unchanged');
                if (creativeDigest(oldPlan.treatments) !== creativeDigest(nextPlan.treatments)
                    || creativeDigest(oldPlan.differences) !== creativeDigest(nextPlan.differences)) return fail('comparison-changed');
                selection = { previousTreatmentId: oldPlan.selectedTreatmentId, selectedTreatmentId: nextPlan.selectedTreatmentId };
            }
            if (input.advice) {
                const advice = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='review'")
                    .get(input.advice.id, input.id, previous.activeRevision);
                if (!advice || advice.digest !== input.advice.digest || previousPlan[0]!.digest !== input.advice.planDigest)
                    return fail('advice-stale');
                const record = jsonValue(advice) as { schemaVersion?: unknown; planDigest?: unknown };
                if (record.schemaVersion !== 'director-consultation-v1' || record.planDigest !== input.advice.planDigest) return fail('advice-stale');
                if (this.#db.prepare('SELECT 1 FROM creative_artifact WHERE id=?').get('review-' + creativeDigest([input.id, `decision:${input.advice.id}`]).slice(7)))
                    return fail('advice-already-decided');
            }
            if (input.feedback) {
                const feedback = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='review'")
                    .get(input.feedback.id, input.id, previous.activeRevision);
                const board = this.#db.prepare("SELECT digest FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='previz'")
                    .get(input.feedback.boardId, input.id, previous.activeRevision);
                if (!feedback || feedback.digest !== input.feedback.digest || !board || board.digest !== input.feedback.boardDigest
                    || previousPlan[0]!.digest !== input.feedback.planDigest) return fail('observation-invalid');
                const record = jsonValue(feedback) as { schemaVersion?: unknown; phase?: unknown; planDigest?: unknown; boardId?: unknown; boardDigest?: unknown };
                if (record.schemaVersion !== 'director-board-observation-v1' || record.phase !== 'contrast'
                    || record.planDigest !== input.feedback.planDigest || record.boardId !== input.feedback.boardId
                    || record.boardDigest !== input.feedback.boardDigest) return fail('observation-invalid');
            }
            const next = this.#append(previous, { source: version.source, material: version.material,
                operationKey: input.operationKey, reason: input.reason });
            const artifactId = 'plan-' + creativeDigest([input.id, input.operationKey]).slice(7);
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                .run(artifactId, input.id, next.activeRevision, 'plan', payload, creativeDigest(input.plan), this.#now());
            if (input.comparison && selection) {
                const decision = { schemaVersion: 'director-selection-change-v1', decision: 'change-treatment', reason: input.reason,
                    decidedBy: 'session-caller', actorVerification: 'unverified', visualReview: 'caller-declared', sourceSnapshotRef: version.source.sourceSnapshotRef,
                    revision: next.activeRevision, planId: artifactId, planDigest: creativeDigest(input.plan),
                    previousRevision: previous.activeRevision, previousPlanId: previousPlan[0]!.id, previousPlanDigest: previousPlan[0]!.digest,
                    comparisonId: input.comparison.id, comparisonDigest: input.comparison.digest, ...selection };
                const decisionId = 'review-' + creativeDigest([input.id, `selection-change:${input.operationKey}`]).slice(7);
                this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                    .run(decisionId, input.id, next.activeRevision, 'review', JSON.stringify(decision), creativeDigest(decision), this.#now());
            }
            if (input.advice) {
                const decision = { schemaVersion: 'director-advice-decision-v1', adviceId: input.advice.id,
                    adviceDigest: input.advice.digest, sourcePlanDigest: input.advice.planDigest, planDigest: creativeDigest(input.plan),
                    decision: 'accepted', inclusion: 'caller-declared', reason: input.reason,
                    decidedBy: 'session-caller', actorVerification: 'unverified' };
                const decisionId = 'review-' + creativeDigest([input.id, `decision:${input.advice.id}`]).slice(7);
                this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                    .run(decisionId, input.id, next.activeRevision, 'review', JSON.stringify(decision), creativeDigest(decision), this.#now());
            }
            if (input.feedback) {
                const origins = this.#db.prepare("SELECT * FROM creative_artifact WHERE session_id=? AND revision=? AND kind='review' AND json_extract(payload,'$.schemaVersion')='director-plan-provenance-v1'")
                    .all(input.id, previous.activeRevision);
                if (origins.length > 1) return fail('plan-stale');
                const origin = origins[0];
                if (origin) {
                    const record = jsonValue(origin) as { planId?: unknown; planDigest?: unknown; sourceSnapshotRef?: unknown; revision?: unknown };
                    if (record.planId !== previousPlan[0]!.id || record.planDigest !== previousPlan[0]!.digest
                        || record.sourceSnapshotRef !== version.source.sourceSnapshotRef || record.revision !== previous.activeRevision) return fail('plan-stale');
                }
                const cause = { schemaVersion: 'director-revision-cause-v1', kind: 'intent-change', reason: input.reason,
                    previousRevision: previous.activeRevision, previousPlanId: previousPlan[0]!.id, previousPlanDigest: input.feedback.planDigest,
                    ...(origin ? { previousProvenanceId: origin.id, previousProvenanceDigest: origin.digest } : {}),
                    previousBoardId: input.feedback.boardId, previousBoardDigest: input.feedback.boardDigest,
                    feedbackId: input.feedback.id, feedbackDigest: input.feedback.digest, independence: 'unverified',
                    planDigest: creativeDigest(input.plan), declaredBy: 'session-caller', authorship: 'caller-edited', actorVerification: 'unverified' };
                const causeId = 'review-' + creativeDigest([input.id, `revision:${input.operationKey}`]).slice(7);
                this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                    .run(causeId, input.id, next.activeRevision, 'review', JSON.stringify(cause), creativeDigest(cause), this.#now());
            }
            this.#permit(input.owner);
        });
    }
    savePreviz(input: { owner: string; id: string; expectedRevision: number; operationKey: string;
        planId: string; planDigest: string; preview: unknown }): void {
        creativeToken.parse(input.operationKey);
        const payload = JSON.stringify(input.preview), digest = creativeDigest(input.preview);
        if (Buffer.byteLength(payload) > 262144) return fail('artifact-invalid');
        const artifactId = 'previz-' + creativeDigest([input.id, input.operationKey]).slice(7);
        sqliteTransaction(this.#db, () => {
            const session = this.#expect(input.owner, input.id, input.expectedRevision);
            const plan = this.#db.prepare("SELECT id,digest FROM creative_artifact WHERE session_id=? AND revision=? AND kind='plan'")
                .all(input.id, session.activeRevision);
            if (plan.length !== 1 || plan[0]!.id !== input.planId || plan[0]!.digest !== input.planDigest) return fail('plan-stale');
            const previous = this.#db.prepare('SELECT * FROM creative_artifact WHERE id=?').get(artifactId);
            if (previous) {
                if (previous.session_id !== input.id || previous.revision !== session.activeRevision || previous.kind !== 'previz'
                    || previous.digest !== digest) return fail('idempotency-conflict');
                return;
            }
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                .run(artifactId, input.id, session.activeRevision, 'previz', payload, digest, this.#now());
            this.#permit(input.owner);
        });
    }
    saveReview(input: { owner: string; id: string; expectedRevision: number; operationKey: string;
        planId: string; planDigest: string; record: unknown; uniqueIdentity?: string; boardId?: string; boardDigest?: string }): void {
        creativeToken.parse(input.operationKey);
        const payload = JSON.stringify(input.record), digest = creativeDigest(input.record);
        if (Buffer.byteLength(payload) > 262144) return fail('artifact-invalid');
        const artifactId = 'review-' + creativeDigest([input.id, input.uniqueIdentity ?? input.operationKey]).slice(7);
        sqliteTransaction(this.#db, () => {
            const session = this.#expect(input.owner, input.id, input.expectedRevision);
            const plan = this.#db.prepare("SELECT id,digest FROM creative_artifact WHERE session_id=? AND revision=? AND kind='plan'")
                .all(input.id, session.activeRevision);
            if (plan.length !== 1 || plan[0]!.id !== input.planId || plan[0]!.digest !== input.planDigest) return fail('plan-stale');
            if (input.boardId !== undefined || input.boardDigest !== undefined) {
                const board = this.#db.prepare("SELECT id,digest FROM creative_artifact WHERE session_id=? AND revision=? AND kind='previz' AND id=?")
                    .get(input.id, session.activeRevision, input.boardId ?? '');
                if (!board || board.digest !== input.boardDigest) return fail('board-stale');
            }
            const previous = this.#db.prepare('SELECT * FROM creative_artifact WHERE id=?').get(artifactId);
            if (previous) {
                if (previous.session_id !== input.id || previous.revision !== session.activeRevision || previous.kind !== 'review'
                    || previous.digest !== digest) return fail('idempotency-conflict');
                return;
            }
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                .run(artifactId, input.id, session.activeRevision, 'review', payload, digest, this.#now());
            this.#permit(input.owner);
        });
    }
    saveExport(input: { owner: string; id: string; expectedRevision: number; operationKey: string;
        sourceSnapshotRef: string; branchId: string; dependencies: { id: string; kind: 'plan' | 'previz' | 'review'; digest: string }[]; payload: unknown }): void {
        creativeToken.parse(input.operationKey);
        const payload = JSON.stringify(input.payload), digest = creativeDigest(input.payload);
        if (Buffer.byteLength(payload) > 1048576) return fail('artifact-invalid');
        const planDep = input.dependencies.filter(item => item.kind === 'plan');
        const boardDep = input.dependencies.filter(item => item.kind === 'previz');
        if (planDep.length !== 1 || boardDep.length !== 1 || new Set(input.dependencies.map(item => item.id)).size !== input.dependencies.length)
            return fail('export-dependency-invalid');
        const value = input.payload as { schemaVersion?: unknown; status?: unknown; storyboard?: unknown; plan?: unknown; renderSpec?: unknown;
            manifest?: { sourceSessionId?: unknown; creativeSessionId?: unknown; sourceSnapshotRef?: unknown; adaptationBranchId?: unknown;
                directorModelIdentity?: unknown; directorModelVersion?: unknown; independentReview?: unknown; timing?: unknown; audio?: unknown;
                revision?: unknown; dependencies?: unknown; historicalDependencies?: unknown; continuityChain?: unknown };
            reviews?: { id?: unknown; digest?: unknown; payload?: unknown }[] };
        if (!value || value.schemaVersion !== 'director-export-v1' || value.status !== 'draft' || typeof value.storyboard !== 'string' || !value.plan || !value.renderSpec
            || !value.manifest || !Array.isArray(value.manifest.dependencies) || value.manifest.sourceSessionId !== input.owner
            || value.manifest.creativeSessionId !== input.id || value.manifest.independentReview !== 'unverified' || value.manifest.directorModelVersion !== 'unavailable'
            || value.manifest.timing !== 'estimated' || value.manifest.audio !== 'not-rendered'
            || value.manifest.sourceSnapshotRef !== input.sourceSnapshotRef || value.manifest.adaptationBranchId !== input.branchId
            || creativeDigest(value.manifest.dependencies) !== creativeDigest(input.dependencies)
            || creativeDigest(value.plan) !== planDep[0]!.digest || creativeDigest(value.renderSpec) !== boardDep[0]!.digest
            || !Array.isArray(value.reviews)) return fail('export-dependency-invalid');
        const reviewDeps = input.dependencies.filter(item => item.kind === 'review');
        if (value.reviews.length !== reviewDeps.length || value.reviews.some((item, index) =>
            !item || item.payload === undefined || item.id !== reviewDeps[index]!.id || item.digest !== reviewDeps[index]!.digest || creativeDigest(item.payload) !== item.digest))
            return fail('export-dependency-invalid');
        const artifactId = 'export-' + creativeDigest([input.id, input.operationKey]).slice(7);
        sqliteTransaction(this.#db, () => {
            const session = this.#expect(input.owner, input.id, input.expectedRevision);
            if (session.adaptationBranchId !== input.branchId || this.#revision(session).source.sourceSnapshotRef !== input.sourceSnapshotRef)
                return fail('source-stale');
            if (value.manifest!.revision !== session.activeRevision
                || creativeDigest(value.manifest!.continuityChain ?? []) !== creativeDigest(this.#lineage(session, this.#revision(session)).contexts))
                return fail('export-dependency-invalid');
            const plan = assertSequencePlan(value.plan, this.#revision(session).source, session.policy);
            if (value.storyboard !== renderDirectorStoryboard(plan)) return fail('export-dependency-invalid');
            const board = value.renderSpec as { schemaVersion?: unknown; planId?: unknown; planDigest?: unknown;
                sourceSnapshotRef?: unknown; adaptationBranchId?: unknown; revision?: unknown; durationBasis?: unknown; shots?: unknown };
            if (board.schemaVersion !== 'director-visual-board-v1' || board.planId !== planDep[0]!.id
                || board.planDigest !== planDep[0]!.digest || board.sourceSnapshotRef !== input.sourceSnapshotRef
                || board.adaptationBranchId !== input.branchId || board.revision !== session.activeRevision || board.durationBasis !== 'estimated' || !Array.isArray(board.shots)
                || creativeDigest(board.shots) !== creativeDigest(plan.shots)) return fail('export-dependency-invalid');
            const observations = value.reviews!.filter(item => (item.payload as { schemaVersion?: string }).schemaVersion === 'director-board-observation-v1');
            const comparisons = value.reviews!.filter(item => (item.payload as { schemaVersion?: string }).schemaVersion === 'director-comparison-observation-v1');
            const selections = value.reviews!.filter(item => (item.payload as { schemaVersion?: string }).schemaVersion === 'director-selection-decision-v1');
            const selectionChanges = value.reviews!.filter(item => (item.payload as { schemaVersion?: string }).schemaVersion === 'director-selection-change-v1');
            const causes = value.reviews!.filter(item => (item.payload as { schemaVersion?: string }).schemaVersion === 'director-revision-cause-v1');
            const origins = value.reviews!.filter(item => (item.payload as { schemaVersion?: string }).schemaVersion === 'director-plan-provenance-v1');
            if (observations.length + comparisons.length + selections.length + selectionChanges.length + causes.length + origins.length !== value.reviews!.length
                || comparisons.length > 1 || selections.length > 1 || selectionChanges.length > 1 || causes.length > 1 || origins.length > 1
                || (observations.length !== 0 && observations.length !== 2)) return fail('export-dependency-invalid');
            if (comparisons.some(item => { const record = item.payload as { planId?: string; planDigest?: string; sourceSnapshotRef?: string; revision?: number };
                return record.planId !== planDep[0]!.id || record.planDigest !== planDep[0]!.digest
                    || record.sourceSnapshotRef !== input.sourceSnapshotRef || record.revision !== session.activeRevision; })) return fail('export-dependency-invalid');
            if (selections.some(item => { const record = item.payload as { planId?: string; planDigest?: string; sourceSnapshotRef?: string; revision?: number;
                comparisonId?: string; comparisonDigest?: string; selectedTreatmentId?: string; decidedBy?: string; actorVerification?: string; decision?: string };
                return record.planId !== planDep[0]!.id || record.planDigest !== planDep[0]!.digest
                    || record.sourceSnapshotRef !== input.sourceSnapshotRef || record.revision !== session.activeRevision
                    || record.comparisonId !== comparisons[0]?.id || record.comparisonDigest !== comparisons[0]?.digest
                    || record.selectedTreatmentId !== plan.selectedTreatmentId || record.decidedBy !== 'session-caller'
                    || record.actorVerification !== 'unverified' || record.decision !== 'retain-current'; }))
                return fail('export-dependency-invalid');
            if (selectionChanges.length) {
                const record = selectionChanges[0]!.payload as { decision?: string; decidedBy?: string; actorVerification?: string; visualReview?: string;
                    sourceSnapshotRef?: string; revision?: number; planId?: string; planDigest?: string; previousRevision?: number;
                    previousPlanId?: string; previousPlanDigest?: string; comparisonId?: string; comparisonDigest?: string;
                    previousTreatmentId?: string; selectedTreatmentId?: string };
                if (record.decision !== 'change-treatment' || record.decidedBy !== 'session-caller' || record.actorVerification !== 'unverified'
                    || record.visualReview !== 'caller-declared'
                    || record.sourceSnapshotRef !== input.sourceSnapshotRef || record.revision !== session.activeRevision
                    || record.planId !== planDep[0]!.id || record.planDigest !== planDep[0]!.digest
                    || record.selectedTreatmentId !== plan.selectedTreatmentId || !Number.isSafeInteger(record.previousRevision)
                    || record.previousRevision! >= session.activeRevision) return fail('export-dependency-invalid');
                const oldPlan = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='plan'")
                    .get(record.previousPlanId ?? '', session.id, record.previousRevision!);
                const oldComparison = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='review'")
                    .get(record.comparisonId ?? '', session.id, record.previousRevision!);
                if (!oldPlan || oldPlan.digest !== record.previousPlanDigest || !oldComparison || oldComparison.digest !== record.comparisonDigest)
                    return fail('export-dependency-stale');
                const oldVersion = this.#revision(session, record.previousRevision);
                const oldPlanData = assertSequencePlan(jsonValue(oldPlan), oldVersion.source, session.policy);
                const oldComparisonData = jsonValue(oldComparison) as { schemaVersion?: string; planId?: string; planDigest?: string;
                    sourceSnapshotRef?: string; revision?: number };
                if (oldVersion.source.sourceSnapshotRef !== input.sourceSnapshotRef || oldPlanData.selectedTreatmentId !== record.previousTreatmentId
                    || !oldPlanData.treatments.some(item => item.id === record.selectedTreatmentId) || record.previousTreatmentId === record.selectedTreatmentId
                    || creativeDigest(oldPlanData.treatments) !== creativeDigest(plan.treatments)
                    || creativeDigest(oldPlanData.differences) !== creativeDigest(plan.differences)
                    || oldComparisonData.schemaVersion !== 'director-comparison-observation-v1' || oldComparisonData.planId !== oldPlan.id
                    || oldComparisonData.planDigest !== oldPlan.digest || oldComparisonData.sourceSnapshotRef !== input.sourceSnapshotRef
                    || oldComparisonData.revision !== record.previousRevision) return fail('export-dependency-invalid');
                const expected = [{ id: oldPlan.id, kind: 'plan', revision: record.previousRevision, digest: oldPlan.digest },
                    { id: oldComparison.id, kind: 'review', revision: record.previousRevision, digest: oldComparison.digest }];
                if (!Array.isArray(value.manifest!.historicalDependencies)
                    || creativeDigest(value.manifest!.historicalDependencies) !== creativeDigest(expected)) return fail('export-dependency-invalid');
            } else if (value.manifest!.historicalDependencies !== undefined) return fail('export-dependency-invalid');
            if (causes.some(item => (item.payload as { planDigest?: string }).planDigest !== planDep[0]!.digest)) return fail('export-dependency-invalid');
            const origin = origins[0]?.payload as { planId?: string; planDigest?: string; sourceSnapshotRef?: string; revision?: number;
                identity?: string; modelVersion?: string } | undefined;
            if (origin && (origin.planId !== planDep[0]!.id || origin.planDigest !== planDep[0]!.digest
                || origin.sourceSnapshotRef !== input.sourceSnapshotRef || origin.revision !== session.activeRevision
                || !['official-response-reported', 'unverified'].includes(origin.identity ?? '') || origin.modelVersion !== 'unavailable'))
                return fail('export-dependency-invalid');
            if (value.manifest!.directorModelIdentity !== (origin?.identity ?? 'unverified')) return fail('export-dependency-invalid');
            if (observations.length) {
                const blind = observations.find(item => (item.payload as { phase?: string }).phase === 'blind');
                const contrast = observations.find(item => (item.payload as { phase?: string }).phase === 'contrast');
                const first = blind?.payload as { boardId?: string; boardDigest?: string; planDigest?: string; sourceSnapshotRef?: string;
                    adaptationBranchId?: string; revision?: number; observer?: string; observerKind?: string; sourceExposure?: string; intentExposure?: string;
                    exposureReference?: string; phaseContext?: { source?: string; intent?: string } } | undefined;
                const second = contrast?.payload as typeof first & { blindReviewId?: string; revisionCauseId?: string; revisionCauseDigest?: string };
                if (!blind || !contrast || !first || !second || second.blindReviewId !== blind.id
                    || [first, second].some(record => record.boardId !== boardDep[0]!.id || record.boardDigest !== boardDep[0]!.digest
                        || record.planDigest !== planDep[0]!.digest || record.sourceSnapshotRef !== input.sourceSnapshotRef
                        || record.adaptationBranchId !== input.branchId || record.revision !== session.activeRevision)
                    || first.observer !== second.observer || first.sourceExposure !== second.sourceExposure || first.intentExposure !== second.intentExposure
                    || (causes.length ? second.revisionCauseId !== causes[0]!.id || second.revisionCauseDigest !== causes[0]!.digest
                        : second.revisionCauseId !== undefined || second.revisionCauseDigest !== undefined)) return fail('export-dependency-invalid');
                if (first.phaseContext !== undefined && (first.observerKind !== 'official-model' || first.exposureReference !== 'before-first-observation'
                    || first.phaseContext.source !== 'none' || first.phaseContext.intent !== 'none')) return fail('export-dependency-invalid');
                if (second.phaseContext !== undefined && (second.observerKind !== 'official-model' || second.exposureReference !== 'before-first-observation'
                    || second.phaseContext.source !== 'provided' || second.phaseContext.intent !== 'provided')) return fail('export-dependency-invalid');
            }
            for (const dependency of input.dependencies) {
                const row = this.#db.prepare('SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind=?')
                    .get(dependency.id, input.id, session.activeRevision, dependency.kind);
                if (!row || row.digest !== dependency.digest) return fail('export-dependency-stale');
                jsonValue(row); // Verify the stored bytes still match their digest.
            }
            const previous = this.#db.prepare('SELECT * FROM creative_artifact WHERE id=?').get(artifactId);
            if (previous) {
                if (previous.session_id !== input.id || previous.revision !== session.activeRevision || previous.kind !== 'export'
                    || previous.digest !== digest) return fail('idempotency-conflict');
                return;
            }
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)')
                .run(artifactId, input.id, session.activeRevision, 'export', payload, digest, this.#now());
            this.#permit(input.owner);
        });
    }
    startStep(owner: string, id: string, expectedRevision: number, stepKey: string, kind: 'material' | 'plan' | 'consult' = 'material'): CreativeSession {
        creativeToken.parse(stepKey);
        return sqliteTransaction(this.#db, () => {
            const session = this.#expect(owner, id, expectedRevision), budget = session.budget;
            if (session.stepKey === stepKey || this.#db.prepare('SELECT 1 FROM creative_revision WHERE session_id=? AND operation_key=?').get(id, stepKey))
                return fail('step-already-attempted');
            if (this.#db.prepare('SELECT 1 FROM creative_artifact WHERE id=?').get('plan-' + creativeDigest([id, stepKey]).slice(7)))
                return fail('step-already-attempted');
            if (this.#db.prepare('SELECT 1 FROM creative_artifact WHERE id=?').get('review-' + creativeDigest([id, stepKey]).slice(7)))
                return fail('step-already-attempted');
            if (kind === 'plan' && this.#db.prepare("SELECT 1 FROM creative_artifact WHERE session_id=? AND revision=? AND kind='plan'")
                .get(id, session.activeRevision)) return fail('plan-conflict');
            const reservedOutput = kind === 'plan' ? DIRECTOR_PLAN_OUTPUT_TOKENS : 2048;
            if (budget.usageUnknown || budget.callsUsed >= budget.maxCalls || budget.outputReserved + reservedOutput > budget.maxOutputTokens) return fail('budget-exhausted');
            if (this.#db.prepare("SELECT 1 FROM creative_session WHERE status='running'").get()) return fail('concurrency-limit');
            return this.#write(session, { ...session, revision: session.revision + 1, status: 'running',
                stepKey, attemptId: `attempt-${randomUUID()}`, failureCode: null, updatedAt: this.#now(),
                budget: { ...budget, callsUsed: budget.callsUsed + 1, outputReserved: budget.outputReserved + reservedOutput } });
        });
    }
    finishStep(claim: CreativeSession, material: unknown, usage: { prompt_tokens: number; completion_tokens: number }): CreativeSession {
        return sqliteTransaction(this.#db, () => {
            const session = this.#expect(claim.ownerSessionId, claim.id, claim.revision, true);
            if (session.status !== 'running' || session.attemptId !== claim.attemptId) return fail('attempt-stale');
            if (![usage.prompt_tokens, usage.completion_tokens].every(v => Number.isSafeInteger(v) && v >= 0)
                || usage.completion_tokens > 2048) return fail('usage-invalid');
            return this.#append({ ...session, budget: { ...session.budget,
                inputUsed: session.budget.inputUsed + usage.prompt_tokens,
                outputUsed: session.budget.outputUsed + usage.completion_tokens } },
                { source: this.#revision(session).source, material, reason: 'material-review', operationKey: session.stepKey! });
        });
    }
    finishPlanStep(claim: CreativeSession, plan: unknown, usage: { prompt_tokens: number; completion_tokens: number },
        origin: { providerId: string; requestedModel: string; reportedModel: string | null; identity: 'official-response-reported' | 'unverified'; requestDigest: string | null }): CreativeSession {
        const payload = JSON.stringify(plan);
        if (Buffer.byteLength(payload) > 262144) return fail('artifact-invalid');
        return sqliteTransaction(this.#db, () => {
            const session = this.#expect(claim.ownerSessionId, claim.id, claim.revision, true);
            if (session.status !== 'running' || session.attemptId !== claim.attemptId) return fail('attempt-stale');
            if (![usage.prompt_tokens, usage.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0)
                || usage.completion_tokens > DIRECTOR_PLAN_OUTPUT_TOKENS) return fail('usage-invalid');
            if (this.#db.prepare("SELECT 1 FROM creative_artifact WHERE session_id=? AND revision=? AND kind='plan'")
                .get(session.id, session.activeRevision)) return fail('plan-conflict');
            const artifactId = 'plan-' + creativeDigest([session.id, session.stepKey]).slice(7);
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)').run(artifactId, session.id,
                session.activeRevision, 'plan', payload, creativeDigest(plan), this.#now());
            const provenance = { schemaVersion: 'director-plan-provenance-v1', planId: artifactId, planDigest: creativeDigest(plan),
                sourceSnapshotRef: this.#revision(session).source.sourceSnapshotRef, revision: session.activeRevision,
                attemptId: session.attemptId, providerId: origin.providerId, requestedModel: origin.requestedModel,
                reportedModel: origin.reportedModel, identity: origin.identity, requestDigest: origin.requestDigest, modelVersion: 'unavailable' };
            const provenanceId = 'review-' + creativeDigest([session.id, `plan-provenance:${session.stepKey}`]).slice(7);
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)').run(provenanceId, session.id,
                session.activeRevision, 'review', JSON.stringify(provenance), creativeDigest(provenance), this.#now());
            return this.#write(session, { ...session, revision: session.revision + 1, status: 'paused', updatedAt: this.#now(),
                budget: { ...session.budget, inputUsed: session.budget.inputUsed + usage.prompt_tokens,
                    outputUsed: session.budget.outputUsed + usage.completion_tokens } });
        });
    }
    finishReviewStep(claim: CreativeSession, review: unknown, usage: { prompt_tokens: number; completion_tokens: number },
        planId: string, planDigest: string, boardBinding?: { id: string; digest: string; blindId?: string; blindDigest?: string }): CreativeSession {
        const payload = JSON.stringify(review);
        if (Buffer.byteLength(payload) > 262144) return fail('artifact-invalid');
        return sqliteTransaction(this.#db, () => {
            const session = this.#expect(claim.ownerSessionId, claim.id, claim.revision, true);
            if (session.status !== 'running' || session.attemptId !== claim.attemptId) return fail('attempt-stale');
            if (![usage.prompt_tokens, usage.completion_tokens].every(value => Number.isSafeInteger(value) && value >= 0)
                || usage.completion_tokens > 2048) return fail('usage-invalid');
            const plan = this.#db.prepare("SELECT id,digest FROM creative_artifact WHERE session_id=? AND revision=? AND kind='plan'")
                .all(session.id, session.activeRevision);
            if (plan.length !== 1 || plan[0]!.id !== planId || plan[0]!.digest !== planDigest) return fail('plan-stale');
            if (boardBinding) {
                const board = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='previz'")
                    .get(boardBinding.id, session.id, session.activeRevision);
                if (!board || board.digest !== boardBinding.digest) return fail('board-stale');
                jsonValue(board);
                if (boardBinding.blindId) {
                    const blind = this.#db.prepare("SELECT * FROM creative_artifact WHERE id=? AND session_id=? AND revision=? AND kind='review'")
                        .get(boardBinding.blindId, session.id, session.activeRevision);
                    if (!blind || blind.digest !== boardBinding.blindDigest) return fail('observation-invalid');
                    jsonValue(blind);
                }
            }
            const artifactId = 'review-' + creativeDigest([session.id, session.stepKey]).slice(7);
            this.#db.prepare('INSERT INTO creative_artifact VALUES(?,?,?,?,?,?,?)').run(artifactId, session.id,
                session.activeRevision, 'review', payload, creativeDigest(review), this.#now());
            return this.#write(session, { ...session, revision: session.revision + 1, status: 'paused', updatedAt: this.#now(),
                budget: { ...session.budget, inputUsed: session.budget.inputUsed + usage.prompt_tokens,
                    outputUsed: session.budget.outputUsed + usage.completion_tokens } });
        });
    }
    failStep(claim: CreativeSession): void {
        sqliteTransaction(this.#db, () => {
            // Close only the exact attempted step even after read access is revoked.
            const row = this.#db.prepare('SELECT * FROM creative_session WHERE id=? AND owner=?').get(claim.id, claim.ownerSessionId);
            if (!row) return;
            const session = sessionSchema.parse(jsonValue(row));
            if (session.status !== 'running' || session.revision !== claim.revision || session.attemptId !== claim.attemptId) return;
            const next = { ...session, revision: session.revision + 1, status: 'failed',
                budget: { ...session.budget, usageUnknown: true }, failureCode: 'step-failed-no-replay', updatedAt: this.#now() };
            this.#db.prepare('UPDATE creative_session SET revision=?,status=?,payload=?,digest=? WHERE id=? AND revision=?')
                .run(next.revision, next.status, JSON.stringify(next), creativeDigest(next), session.id, session.revision);
        });
    }
    cancel(owner: string, id: string, expectedRevision: number): CreativeSession {
        return sqliteTransaction(this.#db, () => {
            const session = this.#read(owner, id);
            if (session.revision !== expectedRevision) return fail('revision-conflict');
            if (session.status === 'cancelled') return session;
            return this.#write(session, { ...session, revision: session.revision + 1, status: 'cancelled',
                budget: { ...session.budget, usageUnknown: session.budget.usageUnknown || session.status === 'running' }, updatedAt: this.#now() });
        });
    }
    recoverInterrupted(): void {
        sqliteTransaction(this.#db, () => {
            for (const row of this.#db.prepare("SELECT * FROM creative_session WHERE status='running'").all()) {
                const session = sessionSchema.parse(jsonValue(row));
                const next = { ...session, revision: session.revision + 1, status: 'failed',
                    budget: { ...session.budget, usageUnknown: true }, failureCode: 'restart-uncertain-no-replay', updatedAt: this.#now() };
                this.#db.prepare('UPDATE creative_session SET revision=?,status=?,payload=?,digest=? WHERE id=? AND revision=?')
                    .run(next.revision, next.status, JSON.stringify(next), creativeDigest(next), session.id, session.revision);
            }
        });
    }
    deleteSource(owner: string): void {
        creativeToken.parse(owner);
        sqliteTransaction(this.#db, () => {
            for (const table of ['creative_revision', 'creative_artifact'])
                this.#db.prepare(`DELETE FROM ${table} WHERE session_id IN (SELECT id FROM creative_session WHERE owner=?)`).run(owner);
            this.#db.prepare('DELETE FROM creative_session WHERE owner=?').run(owner);
        });
    }
    close(): void { this.#db.close(); }
}
