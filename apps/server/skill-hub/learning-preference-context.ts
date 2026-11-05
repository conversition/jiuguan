/** @author Codex @date 2026-10-14 @version 1.0
 * Initial preference authority binds the current player input, not generated prose or an idle session.
 */
import { createHash } from 'node:crypto';
import {
    SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION,
    type LearningPreferenceSkillSourceReader,
    type LearningPreferenceSkillSourceV1,
} from '../../../packages/session/public/learning-preference-skill-source.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import {
    createServerAgentSkillSourceContextAuthority,
    type ServerAgentSkillContextSourceV1,
    type ServerAgentSkillSourceContextAuthorityDependencies,
} from './context-authority.ts';

const SOURCES = new WeakSet<object>();
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SOURCE_KEYS = Object.freeze([
    'sourceVersion', 'taskKind', 'policyVersion', 'stage', 'runId', 'parentRunId', 'sessionId',
    'sourceRevision', 'contentMode', 'scope', 'assetRevision', 'worldbookSourceRevision', 'round',
    'explicitPreferenceCount', 'regenerate', 'userPromptDigest', 'inputDigest', 'preferenceEpoch',
    'preferenceEvidenceRevision', 'authorityRevision',
].sort());

export const LEARNING_PREFERENCE_SKILL_POLICY_VERSION = 'p14-q6-preference-v1' as const;

export type { LearningPreferenceSkillSourceReader };

/** A process-local source identity. Serializing it preserves metadata, never authority. */
export interface LearningPreferenceSkillSourceSnapshotV1 extends LearningPreferenceSkillSourceV1 {
    readonly sourceDigest: string;
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function sourceMetadata(value: unknown): LearningPreferenceSkillSourceV1 | null {
    if (!record(value) || !record(value.scope)) return null;
    const scope = value.scope;
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(SOURCE_KEYS)
        || value.sourceVersion !== SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION
        || value.taskKind !== 'preference_extract' || value.policyVersion !== LEARNING_PREFERENCE_SKILL_POLICY_VERSION
        || value.stage !== 'initial-prompt-inference' || value.round !== 1
        || value.explicitPreferenceCount !== 0 || value.regenerate !== false
        || !Number.isSafeInteger(value.preferenceEpoch) || (value.preferenceEpoch as number) < 0
        || !['nsf', 'nsfw'].includes(value.contentMode as string)
        || scope.sessionId !== value.sessionId
        || Object.keys(scope).some((key) => !['sessionId', 'cardId', 'worldId'].includes(key))
        || ['runId', 'parentRunId', 'sessionId', 'sourceRevision'].some((key) => (
            typeof value[key] !== 'string' || !TOKEN.test(value[key] as string)
        )) || value.parentRunId !== value.runId
        || ['assetRevision', 'worldbookSourceRevision', 'userPromptDigest', 'inputDigest',
            'preferenceEvidenceRevision', 'authorityRevision']
            .some((key) => typeof value[key] !== 'string' || !DIGEST.test(value[key] as string))
        || ['cardId', 'worldId'].some((key) => (
            scope[key] !== undefined
            && (typeof scope[key] !== 'string' || !TOKEN.test(scope[key] as string))
        ))) return null;
    return Object.freeze({
        sourceVersion: SESSION_LEARNING_PREFERENCE_SKILL_SOURCE_VERSION, taskKind: 'preference_extract',
        policyVersion: LEARNING_PREFERENCE_SKILL_POLICY_VERSION, stage: 'initial-prompt-inference',
        runId: value.runId as string, parentRunId: value.parentRunId as string,
        sessionId: value.sessionId as string, sourceRevision: value.sourceRevision as string,
        contentMode: value.contentMode as 'nsf' | 'nsfw',
        scope: Object.freeze({
            sessionId: value.sessionId as string,
            ...(scope.cardId === undefined ? {} : { cardId: scope.cardId as string }),
            ...(scope.worldId === undefined ? {} : { worldId: scope.worldId as string }),
        }),
        assetRevision: value.assetRevision as string, worldbookSourceRevision: value.worldbookSourceRevision as string,
        round: 1, explicitPreferenceCount: 0, regenerate: false,
        userPromptDigest: value.userPromptDigest as string, inputDigest: value.inputDigest as string,
        preferenceEpoch: value.preferenceEpoch as number,
        preferenceEvidenceRevision: value.preferenceEvidenceRevision as string,
        authorityRevision: value.authorityRevision as string,
    });
}

/** Only a fixed server-owned reader may attest that the initial inference lifecycle is current. */
export function captureLearningPreferenceSkillSource(input: {
    readonly runId: string;
    readonly sourceAuthority: LearningPreferenceSkillSourceReader;
}): LearningPreferenceSkillSourceSnapshotV1 {
    if (!TOKEN.test(input.runId)) throw new Error('learning-preference-skill-source-invalid');
    const metadata = sourceMetadata(input.sourceAuthority.readLearningPreferenceSkillSource(input.runId));
    if (!metadata || metadata.runId !== input.runId) throw new Error('learning-preference-skill-source-invalid');
    const source = Object.freeze({ ...metadata, sourceDigest: digest(metadata) });
    SOURCES.add(source);
    return source;
}

export interface LearningPreferenceSkillContextDependencies
    extends Omit<ServerAgentSkillSourceContextAuthorityDependencies, 'sourceAuthority'> {
    readonly source: LearningPreferenceSkillSourceSnapshotV1;
    readonly sourceAuthority: LearningPreferenceSkillSourceReader;
    readonly isSessionOpen: (sessionId: string) => boolean;
}

type SourceDependencies = Pick<LearningPreferenceSkillContextDependencies,
    'source' | 'sourceAuthority' | 'leaseAuthority' | 'isSessionOpen' | 'nowMs'>;

/** Base source liveness is independent of optional Skill activation; it grants no model or write budget. */
export function createLearningPreferenceSkillSourceAuthority(input: SourceDependencies) {
    const source = input.source;
    if (!SOURCES.has(source)) throw new Error('learning-preference-skill-context-binding-invalid');
    const readCurrent = input.sourceAuthority.readLearningPreferenceSkillSource.bind(input.sourceAuthority);
    const ownsLease = input.leaseAuthority.ownsLease.bind(input.leaseAuthority);
    const isSessionOpen = input.isSessionOpen;
    const nowMs = input.nowMs ?? Date.now;
    const readSource = (lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null => {
        if (!ownsLease(lease) || lease.lane !== 'learning' || lease.taskKind !== 'preference_extract'
            || lease.policyVersion !== LEARNING_PREFERENCE_SKILL_POLICY_VERSION
            || lease.runId !== source.runId || lease.parentRunId !== source.parentRunId
            || lease.sessionId !== source.sessionId || lease.sourceRevision !== source.sourceRevision
            || lease.mode !== source.contentMode || nowMs() >= lease.expiresAtMs
            || isSessionOpen(source.sessionId) !== true) return null;
        const current = sourceMetadata(readCurrent(source.runId));
        if (!current || digest(current) !== source.sourceDigest
            || isSessionOpen(source.sessionId) !== true) return null;
        return Object.freeze({
            sourceContextVersion: 'server-agent-skill-context-source-v1', origin: 'active-turn',
            runId: source.runId, parentRunId: source.parentRunId, sessionId: source.sessionId,
            sourceRevision: source.sourceRevision, contentMode: source.contentMode, scope: source.scope,
            assetRevision: source.assetRevision, worldbookSourceRevision: source.worldbookSourceRevision,
            authorityRevision: digest([source.authorityRevision, source.sourceDigest]),
        });
    };
    return Object.freeze({ readForLease: readSource });
}

/** Reuse current control/safety checks without admitting Branch, Style, or a completed active turn. */
export function createLearningPreferenceSkillContextAuthority(input: LearningPreferenceSkillContextDependencies) {
    if (input.bindings.length !== 1 || input.bindings[0]?.taskKind !== 'preference_extract'
        || input.bindings[0].policyVersion !== LEARNING_PREFERENCE_SKILL_POLICY_VERSION
        || input.bindings[0].capabilityId !== 'learning.preference' || input.bindings[0].phase !== 'learn') {
        throw new Error('learning-preference-skill-context-binding-invalid');
    }
    return createServerAgentSkillSourceContextAuthority({
        ...input, sourceAuthority: createLearningPreferenceSkillSourceAuthority(input),
    });
}
