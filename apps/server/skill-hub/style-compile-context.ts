/** Durable intent + real executing claim. A recovered metadata object is never an execution source. */
import type { DatabaseSync } from 'node:sqlite';
import { ChatSession } from '../../../packages/session/public/session.ts';
import { MemoryDb } from '../../../packages/memory/public/db.ts';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import { StyleCompileIntentOutbox, type StyleCompileIntent } from '../../../packages/memory/public/style-compile-intent-outbox.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import { StyleCompileJobStore, type StyleCompileJobRecord } from './style-compile-job-store.ts';
import { styleCompileJobId, type StyleCompileProposalInput } from './style-compile-pipeline.ts';
import { createServerAgentSkillSourceContextAuthority, type ServerAgentSkillContextSourceV1,
    type ServerAgentSkillSourceContextAuthorityDependencies } from './context-authority.ts';

export const STYLE_COMPILE_SKILL_POLICY_VERSION = 'p14-q7-style-compiler-v1' as const;
export interface StyleCompileSkillSourceSnapshotV1 {
    readonly sourceVersion: 'style-compile-skill-source-v1';
    readonly taskKind: 'style_compile';
    readonly policyVersion: typeof STYLE_COMPILE_SKILL_POLICY_VERSION;
    readonly runId: string; readonly parentRunId: string; readonly sessionId: string;
    readonly sourceRevision: string; readonly contentMode: 'nsf' | 'nsfw';
    readonly scope: Readonly<{ sessionId: string; cardId?: string; worldId?: string }>;
    readonly assetRevision: string; readonly worldbookSourceRevision: string;
    readonly jobId: string; readonly claimOwnerDigest: string; readonly claimAttempts: number;
    readonly leaseExpiresAt: string; readonly executionStartedAt: string; readonly intentPacketDigest: string;
    readonly round: number; readonly historyEpoch: number; readonly styleSkillId: string;
    readonly explicitRequest: boolean; readonly sourceProfileDigest: string; readonly profileVersion: string;
    readonly bindingDigest: string; readonly forbiddenIdentityDigest: string; readonly samplesDigest: string;
    readonly inputDigest: string; readonly memoryAuthorityDigest: string;
    readonly authorityRevision: string; readonly sourceDigest: string;
}
const KEYS = Object.freeze(['sourceVersion', 'taskKind', 'policyVersion', 'runId', 'parentRunId', 'sessionId',
    'sourceRevision', 'contentMode', 'scope', 'assetRevision', 'worldbookSourceRevision', 'jobId', 'claimOwnerDigest',
    'claimAttempts', 'leaseExpiresAt', 'executionStartedAt', 'intentPacketDigest', 'round', 'historyEpoch', 'styleSkillId',
    'explicitRequest', 'sourceProfileDigest', 'profileVersion', 'bindingDigest', 'forbiddenIdentityDigest', 'samplesDigest',
    'inputDigest', 'memoryAuthorityDigest', 'authorityRevision', 'sourceDigest']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u, DIGEST = /^sha256:[a-f0-9]{64}$/u;
const native = Object.freeze({ memory: ChatSession.prototype.getMemory, assets: ChatSession.prototype.readAgentSkillAssetContext,
    intent: ChatSession.prototype.readStyleCompileIntent, request: ChatSession.prototype.styleCompileIntentRequest,
    obsolete: ChatSession.prototype.styleCompileIntentIsObsolete, epoch: ChatSession.prototype.getHistoryEpoch,
    job: StyleCompileJobStore.prototype.read, authority: MemoryDb.prototype.readSessionAuthority,
    retained: StyleCompileIntentOutbox.prototype.readRetainedSource });
interface NativeSource {
    readonly rawSessionId: string; readonly session: ChatSession; readonly memory: MemoryDb;
    readonly store: StyleCompileJobStore; readonly job: StyleCompileJobRecord; readonly input: StyleCompileProposalInput;
    readonly isSessionOpen: () => boolean; readonly nowMs: () => number;
}
const SOURCES = new WeakMap<object, NativeSource>();
function hash(value: unknown): string { return sha256Digest(JSON.stringify(value)); }
function fail(): never { throw new Error('style-compile-skill-source-invalid'); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
    const own = Reflect.ownKeys(value);
    if (own.some((key) => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
        || JSON.stringify(own.sort()) !== JSON.stringify([...keys].sort())) fail();
}
function token(value: unknown): string { if (typeof value !== 'string' || !TOKEN.test(value)) fail(); return value; }
function digest(value: unknown): string { if (typeof value !== 'string' || !DIGEST.test(value)) fail(); return value; }
function count(value: unknown, min = 0): number {
    if (!Number.isSafeInteger(value) || Object.is(value, -0) || Number(value) < min) fail(); return Number(value);
}
function time(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
    return value;
}
/** Strict metadata recovery deliberately does not restore the process-local native source brand. */
export function normalizeStyleCompileSkillSourceSnapshot(input: unknown): StyleCompileSkillSourceSnapshotV1 {
    const value = record(input); exact(value, KEYS); const scope = record(value.scope);
    exact(scope, ['sessionId', ...(scope.cardId === undefined ? [] : ['cardId']), ...(scope.worldId === undefined ? [] : ['worldId'])]);
    if (value.sourceVersion !== 'style-compile-skill-source-v1' || value.taskKind !== 'style_compile'
        || value.policyVersion !== STYLE_COMPILE_SKILL_POLICY_VERSION || !['nsf', 'nsfw'].includes(String(value.contentMode))
        || typeof value.explicitRequest !== 'boolean') fail();
    const result = { sourceVersion: 'style-compile-skill-source-v1' as const, taskKind: 'style_compile' as const,
        policyVersion: STYLE_COMPILE_SKILL_POLICY_VERSION, runId: token(value.runId), parentRunId: token(value.parentRunId),
        sessionId: token(value.sessionId), sourceRevision: token(value.sourceRevision), contentMode: value.contentMode as 'nsf' | 'nsfw',
        scope: Object.freeze({ sessionId: token(scope.sessionId), ...(scope.cardId === undefined ? {} : { cardId: token(scope.cardId) }),
            ...(scope.worldId === undefined ? {} : { worldId: token(scope.worldId) }) }),
        assetRevision: digest(value.assetRevision), worldbookSourceRevision: digest(value.worldbookSourceRevision),
        jobId: token(value.jobId), claimOwnerDigest: digest(value.claimOwnerDigest), claimAttempts: count(value.claimAttempts, 1),
        leaseExpiresAt: time(value.leaseExpiresAt), executionStartedAt: time(value.executionStartedAt),
        intentPacketDigest: digest(value.intentPacketDigest), round: count(value.round, 1), historyEpoch: count(value.historyEpoch),
        styleSkillId: token(value.styleSkillId), explicitRequest: value.explicitRequest, sourceProfileDigest: digest(value.sourceProfileDigest),
        profileVersion: token(value.profileVersion), bindingDigest: digest(value.bindingDigest),
        forbiddenIdentityDigest: digest(value.forbiddenIdentityDigest), samplesDigest: digest(value.samplesDigest),
        inputDigest: digest(value.inputDigest), memoryAuthorityDigest: digest(value.memoryAuthorityDigest) };
    if (result.runId !== result.parentRunId || result.sessionId !== result.scope.sessionId
        || !/^style\.[a-f0-9]{64}$/u.test(result.jobId) || result.executionStartedAt >= result.leaseExpiresAt
        || !new RegExp(`^round-${result.round}-assistant-[1-9][0-9]*$`, 'u').test(result.sourceRevision)
        || !/^style-profile-v1-(0|[1-9][0-9]*)$/u.test(result.profileVersion)
        || digest(value.authorityRevision) !== hash(result)) fail();
    const authority = { ...result, authorityRevision: value.authorityRevision as string };
    if (digest(value.sourceDigest) !== hash(authority)) fail();
    return Object.freeze({ ...authority, sourceDigest: value.sourceDigest as string });
}
function requestMetadata(value: StyleCompileProposalInput) {
    return { rawSessionId: value.rawSessionId, ticketSessionId: value.ticketSessionId, runId: value.runId,
        sourceRevision: value.sourceRevision, contentMode: value.contentMode, sourceDigest: value.sourceDigest,
        profileVersion: value.profileVersion, explicitRequest: value.explicitRequest, scope: value.scope,
        originalBinding: value.originalBinding, intentPacketDigest: value.intentPacketDigest,
        samples: value.samples.map((item) => ({ sourceRevision: item.sourceRevision, proseDigest: sha256Digest(item.prose) })),
        forbiddenIdentityDigest: hash(value.forbiddenIdentityTerms) };
}
function payloadMatches(p: StyleCompileIntent, source: StyleCompileSkillSourceSnapshotV1, rawSessionId: string): boolean {
    return p.rawSessionId === rawSessionId && p.runId === source.runId && p.scope.sessionId === source.sessionId
        && source.sessionId === opaqueLearningToken('session', rawSessionId) && p.scope.contentMode === source.contentMode
        && p.sourceRevision === source.sourceRevision && p.round === source.round && p.historyEpoch === source.historyEpoch
        && p.styleSkillId === source.styleSkillId && p.explicitRequest === source.explicitRequest
        && p.sourceDigest === source.sourceProfileDigest && p.profileVersion === source.profileVersion
        && hash(p.binding) === source.bindingDigest && hash(p.samples) === source.samplesDigest
        && p.forbiddenIdentityDigest === source.forbiddenIdentityDigest && source.jobId === styleCompileJobId(rawSessionId, p.runId);
}
/** Historical liveness survives ordinary success settlement; rollback/deletion of original samples does not. */
export function isStyleCompileSkillSourceRetained(db: DatabaseSync, rawSessionId: string, input: unknown): boolean {
    let began = false;
    try {
        const source = normalizeStyleCompileSkillSourceSnapshot(input);
        if (!db.isTransaction) { db.exec('BEGIN DEFERRED;'); began = true; }
        const retained = native.retained.call(new StyleCompileIntentOutbox(db, rawSessionId), source.runId);
        if (!retained || !retained.current || retained.entry.packetDigest !== source.intentPacketDigest
            || !payloadMatches(retained.entry.payload, source, rawSessionId)) fail();
        const samples = retained.entry.payload.samples.map((ref) => {
            const row = db.prepare("SELECT content FROM chat_log WHERE id=? AND round=? AND role='assistant'")
                .get(ref.assistantMessageId, ref.round) as { content: string } | undefined;
            if (!row || sha256Digest(row.content) !== ref.proseDigest) fail();
            return { sourceRevision: ref.sourceRevision, prose: row.content };
        });
        const valid = source.inputDigest === hash({ profileVersion: source.profileVersion, samples });
        if (began) { db.exec('COMMIT;'); began = false; }
        return valid;
    } catch { if (began && db.isTransaction) db.exec('ROLLBACK;'); return false; }
}
function jobMatches(job: StyleCompileJobRecord, p: StyleCompileIntent, packetDigest: string): boolean {
    return job.jobId === styleCompileJobId(p.rawSessionId, p.runId) && job.sessionId === p.rawSessionId && job.runId === p.runId
        && job.intentPacketDigest === packetDigest && job.contentMode === p.scope.contentMode && job.styleSkillId === p.styleSkillId
        && job.round === p.round && job.sourceRevision === p.sourceRevision && job.explicitRequest === p.explicitRequest;
}
export function captureStyleCompileSkillSource(input: {
    readonly rawSessionId: string; readonly session: ChatSession; readonly store: StyleCompileJobStore;
    readonly job: StyleCompileJobRecord; readonly input: StyleCompileProposalInput;
    readonly isSessionOpen: () => boolean; readonly nowMs?: () => number;
}): StyleCompileSkillSourceSnapshotV1 {
    try {
        const nowMs = input.nowMs ?? Date.now, request = input.input, session = input.session, memory = native.memory.call(session).mem;
        if (memory.db.isTransaction || input.isSessionOpen() !== true || request.signal?.aborted
            || request.rawSessionId !== input.rawSessionId || request.ticketSessionId !== opaqueLearningToken('session', input.rawSessionId)) fail();
        const entry = native.intent.call(session, request.runId), original = entry && native.request.call(session, request.runId, entry.packetDigest);
        const job = native.job.call(input.store, input.job.jobId), p = entry?.payload;
        if (!entry || entry.state !== 'delivered' || !original || !p || !job || !jobMatches(job, p, entry.packetDigest)
            || !jobMatches(input.job, p, entry.packetDigest) || !job.owner || job.owner !== input.job.owner
            || job.attempts !== input.job.attempts || job.state !== 'executing' || !job.leaseExpiresAt || !job.executionStartedAt
            || job.leaseExpiresAt !== input.job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= nowMs()
            || Date.parse(job.executionStartedAt) > nowMs()
            || native.obsolete.call(session, p.runId, entry.packetDigest) || request.client !== original.client
            || JSON.stringify(requestMetadata(original)) !== JSON.stringify(requestMetadata(request))) fail();
        const assets = native.assets.call(session);
        const metadata = { sourceVersion: 'style-compile-skill-source-v1' as const, taskKind: 'style_compile' as const,
            policyVersion: STYLE_COMPILE_SKILL_POLICY_VERSION, runId: request.runId, parentRunId: request.runId,
            sessionId: assets.sessionId, sourceRevision: request.sourceRevision, contentMode: request.contentMode,
            scope: assets.scope, assetRevision: assets.assetRevision, worldbookSourceRevision: assets.worldbookSourceRevision,
            jobId: job.jobId, claimOwnerDigest: hash(job.owner), claimAttempts: job.attempts, leaseExpiresAt: job.leaseExpiresAt,
            executionStartedAt: job.executionStartedAt, intentPacketDigest: entry.packetDigest, round: p.round, historyEpoch: p.historyEpoch,
            styleSkillId: p.styleSkillId, explicitRequest: p.explicitRequest, sourceProfileDigest: p.sourceDigest, profileVersion: p.profileVersion,
            bindingDigest: hash(p.binding), forbiddenIdentityDigest: p.forbiddenIdentityDigest, samplesDigest: hash(p.samples),
            inputDigest: hash({ profileVersion: request.profileVersion, samples: request.samples }), memoryAuthorityDigest: hash(native.authority.call(memory)) };
        const authority = { ...metadata, authorityRevision: hash(metadata) };
        const source = normalizeStyleCompileSkillSourceSnapshot({ ...authority, sourceDigest: hash(authority) });
        SOURCES.set(source, { rawSessionId: input.rawSessionId, session, memory, store: input.store, job,
            input: request, isSessionOpen: input.isSessionOpen, nowMs });
        if (!isStyleCompileSkillSourceCurrent(source)) { SOURCES.delete(source); fail(); }
        return source;
    } catch { return fail(); }
}
export function assertStyleCompileSkillSourceSessionBinding(source: StyleCompileSkillSourceSnapshotV1, rawSessionId: string, session: ChatSession): void {
    const c = SOURCES.get(source);
    if (!c || c.rawSessionId !== rawSessionId || c.session !== session || native.memory.call(session).mem !== c.memory) fail();
}
function currentSource(source: StyleCompileSkillSourceSnapshotV1, afterReceiptInsert: boolean): boolean {
    try {
        const c = SOURCES.get(source);
        const authorityMatches = (): boolean => {
            if (!c) return false;
            const coordinate = native.authority.call(c.memory);
            if (!afterReceiptInsert) return hash(coordinate) === source.memoryAuthorityDigest;
            // Only the dedicated metadata INSERT readback may account for its own one trigger.
            // A second write (including trigger side effects) fails this exact +1 comparison.
            return c.memory.db.isTransaction === true && coordinate.revision > 0
                && hash({ ...coordinate, revision: coordinate.revision - 1 }) === source.memoryAuthorityDigest;
        };
        if (!c || c.isSessionOpen() !== true || c.input.signal?.aborted || c.nowMs() >= Date.parse(source.leaseExpiresAt)
            || c.nowMs() < Date.parse(source.executionStartedAt)
            || native.memory.call(c.session).mem !== c.memory || !authorityMatches()) return false;
        const job = native.job.call(c.store, source.jobId), assets = native.assets.call(c.session);
        const retained = native.retained.call(new StyleCompileIntentOutbox(c.memory.db, c.rawSessionId), source.runId);
        if (!job || !retained || !retained.current || retained.settlement !== null || retained.entry.state !== 'delivered'
            || retained.entry.packetDigest !== source.intentPacketDigest || !payloadMatches(retained.entry.payload, source, c.rawSessionId)
            || job.state !== 'executing' || !jobMatches(job, retained.entry.payload, source.intentPacketDigest)
            || job.owner !== c.job.owner || job.attempts !== source.claimAttempts || hash(job.owner) !== source.claimOwnerDigest
            || job.leaseExpiresAt !== source.leaseExpiresAt || job.executionStartedAt !== source.executionStartedAt
            || assets.sessionId !== source.sessionId || JSON.stringify(assets.scope) !== JSON.stringify(source.scope)
            || assets.assetRevision !== source.assetRevision || assets.worldbookSourceRevision !== source.worldbookSourceRevision
            || native.epoch.call(c.session) !== source.historyEpoch || !isStyleCompileSkillSourceRetained(c.memory.db, c.rawSessionId, source)) return false;
        if (!c.memory.db.isTransaction) {
            const request = native.request.call(c.session, source.runId, source.intentPacketDigest);
            if (!request || request.client !== c.input.client || JSON.stringify(requestMetadata(request)) !== JSON.stringify(requestMetadata(c.input))
                || native.obsolete.call(c.session, source.runId, source.intentPacketDigest)) return false;
        }
        return c.isSessionOpen() === true && !c.input.signal?.aborted && c.nowMs() < Date.parse(source.leaseExpiresAt)
            && native.memory.call(c.session).mem === c.memory && authorityMatches();
    } catch { return false; }
}
export function isStyleCompileSkillSourceCurrent(source: StyleCompileSkillSourceSnapshotV1): boolean {
    return currentSource(source, false);
}
/** Dedicated in-transaction sidecar readback only; never used by a lease or dispatch authority. */
export function isStyleCompileSkillSourceCurrentAfterReceiptWrite(source: StyleCompileSkillSourceSnapshotV1): boolean {
    return currentSource(source, true);
}
export interface StyleCompileSkillContextDependencies extends Omit<ServerAgentSkillSourceContextAuthorityDependencies, 'sourceAuthority'> {
    readonly source: StyleCompileSkillSourceSnapshotV1;
}
export function createStyleCompileSkillSourceAuthority(input: Pick<StyleCompileSkillContextDependencies, 'source' | 'leaseAuthority' | 'nowMs'>) {
    if (!SOURCES.has(input.source)) fail();
    const source = input.source, ownsLease = input.leaseAuthority.ownsLease.bind(input.leaseAuthority), nowMs = input.nowMs ?? Date.now;
    return Object.freeze({ readForLease(lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null {
        if (!ownsLease(lease) || lease.lane !== 'learning' || lease.taskKind !== 'style_compile'
            || lease.policyVersion !== STYLE_COMPILE_SKILL_POLICY_VERSION || lease.runId !== source.runId || lease.parentRunId !== source.parentRunId
            || lease.sessionId !== source.sessionId || lease.sourceRevision !== source.sourceRevision || lease.mode !== source.contentMode
            || nowMs() >= lease.expiresAtMs || !isStyleCompileSkillSourceCurrent(source)) return null;
        const binding = SOURCES.get(source)?.input.originalBinding;
        if (!binding || lease.modelId !== binding.modelId || lease.budgetProfileDigest !== binding.budgetProfileDigest) return null;
        return Object.freeze({ sourceContextVersion: 'server-agent-skill-context-source-v1', origin: 'maintenance-job', runId: source.runId,
            parentRunId: source.parentRunId, sessionId: source.sessionId, sourceRevision: source.sourceRevision,
            contentMode: source.contentMode, scope: source.scope, assetRevision: source.assetRevision,
            worldbookSourceRevision: source.worldbookSourceRevision, authorityRevision: hash([source.authorityRevision, source.sourceDigest]) });
    } });
}
export function createStyleCompileSkillContextAuthority(input: StyleCompileSkillContextDependencies) {
    if (input.bindings.length !== 1 || input.bindings[0]?.taskKind !== 'style_compile'
        || input.bindings[0].policyVersion !== STYLE_COMPILE_SKILL_POLICY_VERSION
        || input.bindings[0].capabilityId !== 'learning.styleCompile' || input.bindings[0].phase !== 'learn') fail();
    return createServerAgentSkillSourceContextAuthority({ ...input, sourceAuthority: createStyleCompileSkillSourceAuthority(input) });
}
