import { types } from 'node:util';
import { ChatSession } from '../../../packages/session/public/session.ts';
import { SESSION_AQL_REPLAN_SKILL_SOURCE_VERSION, type AqlReplanSkillSourceV1 }
    from '../../../packages/session/public/aql-replan-skill-source.ts';
import { opaqueLearningToken, sha256Digest } from '../../../packages/memory/public/learning-outbox.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import { createServerAgentSkillSourceContextAuthority, type ServerAgentSkillContextSourceV1,
    type ServerAgentSkillSourceContextAuthorityDependencies } from './context-authority.ts';

export const AQL_REPLAN_SKILL_POLICY_VERSION = 'p14-q9r-aql-replan-interactive-v1' as const;
export interface AqlReplanSkillSourceSnapshotV1 extends AqlReplanSkillSourceV1 { readonly sourceDigest: string }
const READ_SOURCE = ChatSession.prototype.readAqlReplanSkillSource;
const GET_MEMORY = ChatSession.prototype.getMemory;
const SOURCES = new WeakMap<object, { session: ChatSession; memory: ReturnType<ChatSession['getMemory']>['mem']; valid: boolean }>();
const FIELDS = ['sourceVersion', 'taskKind', 'policyVersion', 'runId', 'parentRunId', 'sessionId', 'sourceRevision',
    'contentMode', 'scope', 'assetRevision', 'worldbookSourceRevision', 'round', 'historyEpoch', 'assistantMessageId',
    'assistantDigest', 'markerDigest', 'inputDigest', 'authorityRevision'] as const;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
function fail(): never { throw new Error('aql-replan-skill-source-invalid'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || types.isProxy(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !descriptors[key]
        || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable)) fail();
    return value as Record<string, unknown>;
}
function normalizeSource(value: unknown): AqlReplanSkillSourceV1 {
    const row = exact(value, FIELDS);
    if (row.sourceVersion !== SESSION_AQL_REPLAN_SKILL_SOURCE_VERSION || row.taskKind !== 'aql_replan'
        || row.policyVersion !== AQL_REPLAN_SKILL_POLICY_VERSION
        || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')) fail();
    for (const name of ['runId', 'parentRunId', 'sessionId'] as const) {
        if (typeof row[name] !== 'string' || !TOKEN.test(row[name])) fail();
    }
    if (row.parentRunId !== row.runId) fail();
    if (typeof row.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sourceRevision)) fail();
    for (const name of ['assetRevision', 'worldbookSourceRevision', 'assistantDigest',
        'markerDigest', 'inputDigest', 'authorityRevision'] as const) {
        if (typeof row[name] !== 'string' || !HASH.test(row[name])) fail();
    }
    for (const name of ['round', 'historyEpoch', 'assistantMessageId'] as const) {
        if (!Number.isSafeInteger(row[name]) || Number(row[name]) < (name === 'historyEpoch' ? 0 : 1)) fail();
    }
    const rawScope = row.scope;
    if (!rawScope || typeof rawScope !== 'object' || types.isProxy(rawScope)) fail();
    const scopeKeys = Object.keys(rawScope);
    if (scopeKeys.some((key) => !['sessionId', 'cardId', 'worldId'].includes(key)) || !scopeKeys.includes('sessionId')) fail();
    const scope = exact(rawScope, scopeKeys);
    if (scope.sessionId !== row.sessionId || Object.values(scope).some((value) => typeof value !== 'string' || !TOKEN.test(value))) fail();
    const stableScope = Object.freeze({ sessionId: scope.sessionId as string,
        ...(scope.cardId === undefined ? {} : { cardId: scope.cardId as string }),
        ...(scope.worldId === undefined ? {} : { worldId: scope.worldId as string }) });
    return Object.freeze(Object.fromEntries(FIELDS.map((key) => [key, key === 'scope' ? stableScope : row[key]]))) as unknown as AqlReplanSkillSourceV1;
}
function snapshot(value: unknown): AqlReplanSkillSourceSnapshotV1 {
    const source = normalizeSource(value);
    return Object.freeze({ ...source, sourceDigest: sha256Digest(JSON.stringify(source)) });
}
/** Metadata normalization never restores the process-local native source brand. */
export function normalizeAqlReplanSkillSourceSnapshot(value: unknown): AqlReplanSkillSourceSnapshotV1 {
    const row = exact(value, [...FIELDS, 'sourceDigest']);
    const result = snapshot(Object.fromEntries(FIELDS.map((key) => [key, row[key]])));
    if (row.sourceDigest !== result.sourceDigest) fail();
    return result;
}
export function captureAqlReplanSkillSource(input: { readonly session: ChatSession; readonly runId: string }): AqlReplanSkillSourceSnapshotV1 {
    if (!(input.session instanceof ChatSession) || types.isProxy(input.session) || !TOKEN.test(input.runId)) fail();
    const source = snapshot(READ_SOURCE.call(input.session, input.runId));
    if (source.runId !== input.runId) fail();
    SOURCES.set(source, { session: input.session, memory: GET_MEMORY.call(input.session).mem, valid: true });
    if (!isAqlReplanSkillSourceCurrent(source)) fail();
    return source;
}
export function isAqlReplanSkillSourceCurrent(source: AqlReplanSkillSourceSnapshotV1): boolean {
    const state = SOURCES.get(source);
    if (!state?.valid) return false;
    try {
        const current = snapshot(READ_SOURCE.call(state.session, source.runId));
        if (GET_MEMORY.call(state.session).mem === state.memory && current.sourceDigest === source.sourceDigest) return true;
    } catch { /* A missing or changed native window is a permanent revocation for this capture. */ }
    state.valid = false;
    return false;
}
export function assertAqlReplanSkillSourceSessionBinding(
    source: AqlReplanSkillSourceSnapshotV1, rawSessionId: string, session: ChatSession,
): void {
    const state = SOURCES.get(source);
    if (!state || state.session !== session || source.sessionId !== opaqueLearningToken('session', rawSessionId)
        || !isAqlReplanSkillSourceCurrent(source)) fail();
}
export function createAqlReplanSkillSourceAuthority(input: {
    readonly source: AqlReplanSkillSourceSnapshotV1;
    readonly leaseAuthority: ServerAgentSkillSourceContextAuthorityDependencies['leaseAuthority'];
    readonly nowMs?: () => number;
}) {
    const source = input.source;
    if (!SOURCES.has(source)) fail();
    const ownsLease = input.leaseAuthority.ownsLease.bind(input.leaseAuthority), nowMs = input.nowMs ?? Date.now;
    return Object.freeze({ readForLease(lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null {
        if (!ownsLease(lease) || lease.lane !== 'interactive' || lease.taskKind !== 'aql_replan'
            || lease.policyVersion !== AQL_REPLAN_SKILL_POLICY_VERSION || lease.runId !== source.runId
            || lease.parentRunId !== source.parentRunId || lease.sessionId !== source.sessionId
            || lease.sourceRevision !== source.sourceRevision || lease.mode !== source.contentMode
            || nowMs() >= lease.expiresAtMs || !isAqlReplanSkillSourceCurrent(source)) return null;
        return Object.freeze({ sourceContextVersion: 'server-agent-skill-context-source-v1', origin: 'active-turn',
            runId: source.runId, parentRunId: source.parentRunId, sessionId: source.sessionId,
            sourceRevision: source.sourceRevision, contentMode: source.contentMode, scope: source.scope,
            assetRevision: source.assetRevision, worldbookSourceRevision: source.worldbookSourceRevision,
            authorityRevision: source.authorityRevision });
    } });
}
export interface AqlReplanSkillContextDependencies
    extends Omit<ServerAgentSkillSourceContextAuthorityDependencies, 'sourceAuthority'> {
    readonly source: AqlReplanSkillSourceSnapshotV1;
}
export function createAqlReplanSkillContextAuthority(input: AqlReplanSkillContextDependencies) {
    if (input.bindings.length !== 1 || input.bindings[0]?.taskKind !== 'aql_replan'
        || input.bindings[0].policyVersion !== AQL_REPLAN_SKILL_POLICY_VERSION
        || input.bindings[0].capabilityId !== 'interactive.aqlReplan' || input.bindings[0].phase !== 'plan') fail();
    return createServerAgentSkillSourceContextAuthority({ ...input,
        sourceAuthority: createAqlReplanSkillSourceAuthority(input) });
}
