/** Content-free authority for edited-branch attribution, never initial preference inference. */
import {
    normalizeBranchPreferenceSkillSource, branchPreferenceSkillSourceDigest,
} from '../../../packages/memory/public/branch-preference-skill-source.ts';
import type {
    BranchPreferenceSkillSourceReader, BranchPreferenceSkillSourceV1,
} from '../../../packages/session/public/branch-preference-skill-source.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import {
    createServerAgentSkillSourceContextAuthority, type ServerAgentSkillContextSourceV1,
    type ServerAgentSkillSourceContextAuthorityDependencies,
} from './context-authority.ts';

const SOURCES = new WeakSet<object>();
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const SOURCE_KEYS = Object.freeze([
    'sourceVersion', 'taskKind', 'policyVersion', 'stage', 'runId', 'parentRunId', 'sessionId',
    'sourceRevision', 'contentMode', 'scope', 'assetRevision', 'worldbookSourceRevision', 'round',
    'exposureRound', 'regenerate', 'userInputDigest', 'branchSetDigest', 'storyIndexDigest',
    'exposureDigest', 'candidatesDigest', 'preferenceEpoch', 'preferenceEvidenceRevision',
    'historyEpoch', 'inputDigest', 'authorityRevision',
]);
export const BRANCH_PREFERENCE_SKILL_POLICY_VERSION = 'p14-q6-branch-semantic-v1' as const;
export type { BranchPreferenceSkillSourceReader };

/** Serialization retains metadata, not the process-local source identity. */
export interface BranchPreferenceSkillSourceSnapshotV1 extends BranchPreferenceSkillSourceV1 {
    readonly sourceDigest: string;
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function sourceMetadata(value: unknown): BranchPreferenceSkillSourceSnapshotV1 | null {
    if (!record(value) || !record(value.scope)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...SOURCE_KEYS].sort())
        || Object.keys(value.scope).some((key) => !['sessionId', 'cardId', 'worldId'].includes(key))) return null;
    // Normalize the exact independent Branch contract, including request/authority hash consistency.
    const metadata = Object.fromEntries(SOURCE_KEYS.map((key) => [key, value[key]]));
    metadata.scope = { sessionId: value.scope.sessionId,
        ...(value.scope.cardId === undefined ? {} : { cardId: value.scope.cardId }),
        ...(value.scope.worldId === undefined ? {} : { worldId: value.scope.worldId }) };
    try {
        return normalizeBranchPreferenceSkillSource({
            ...metadata, sourceDigest: branchPreferenceSkillSourceDigest(metadata),
        });
    } catch { return null; }
}

export function captureBranchPreferenceSkillSource(input: {
    readonly runId: string;
    readonly sourceAuthority: BranchPreferenceSkillSourceReader;
}): BranchPreferenceSkillSourceSnapshotV1 {
    if (!TOKEN.test(input.runId)) throw new Error('branch-preference-skill-source-invalid');
    const source = sourceMetadata(input.sourceAuthority.readBranchPreferenceSkillSource(input.runId));
    if (!source || source.runId !== input.runId) throw new Error('branch-preference-skill-source-invalid');
    SOURCES.add(source);
    return source;
}

export interface BranchPreferenceSkillContextDependencies
    extends Omit<ServerAgentSkillSourceContextAuthorityDependencies, 'sourceAuthority'> {
    readonly source: BranchPreferenceSkillSourceSnapshotV1;
    readonly sourceAuthority: BranchPreferenceSkillSourceReader;
    readonly isSessionOpen: (sessionId: string) => boolean;
}
type SourceDependencies = Pick<BranchPreferenceSkillContextDependencies,
    'source' | 'sourceAuthority' | 'leaseAuthority' | 'isSessionOpen' | 'nowMs'>;

/** Base source liveness remains mandatory when optional Skill assembly is disabled. */
export function createBranchPreferenceSkillSourceAuthority(input: SourceDependencies) {
    const source = input.source;
    if (!SOURCES.has(source)) throw new Error('branch-preference-skill-context-binding-invalid');
    const readCurrent = input.sourceAuthority.readBranchPreferenceSkillSource.bind(input.sourceAuthority);
    const ownsLease = input.leaseAuthority.ownsLease.bind(input.leaseAuthority);
    const isSessionOpen = input.isSessionOpen;
    const nowMs = input.nowMs ?? Date.now;
    const readSource = (lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null => {
        if (!ownsLease(lease) || lease.lane !== 'learning' || lease.taskKind !== 'preference_extract'
            || lease.policyVersion !== BRANCH_PREFERENCE_SKILL_POLICY_VERSION
            || lease.runId !== source.runId || lease.parentRunId !== source.parentRunId
            || lease.sessionId !== source.sessionId || lease.sourceRevision !== source.sourceRevision
            || lease.mode !== source.contentMode || nowMs() >= lease.expiresAtMs
            || isSessionOpen(source.sessionId) !== true) return null;
        const current = sourceMetadata(readCurrent(source.runId));
        if (!current || current.sourceDigest !== source.sourceDigest
            || isSessionOpen(source.sessionId) !== true) return null;
        return Object.freeze({
            sourceContextVersion: 'server-agent-skill-context-source-v1', origin: 'active-turn',
            runId: source.runId, parentRunId: source.parentRunId, sessionId: source.sessionId,
            sourceRevision: source.sourceRevision, contentMode: source.contentMode, scope: source.scope,
            assetRevision: source.assetRevision, worldbookSourceRevision: source.worldbookSourceRevision,
            authorityRevision: branchPreferenceSkillSourceDigest([source.authorityRevision, source.sourceDigest]),
        });
    };
    return Object.freeze({ readForLease: readSource });
}

/** Closed Branch registration; initial Preference and Style cannot acquire this source. */
export function createBranchPreferenceSkillContextAuthority(input: BranchPreferenceSkillContextDependencies) {
    if (input.bindings.length !== 1 || input.bindings[0]?.taskKind !== 'preference_extract'
        || input.bindings[0].policyVersion !== BRANCH_PREFERENCE_SKILL_POLICY_VERSION
        || input.bindings[0].capabilityId !== 'learning.branchPreference' || input.bindings[0].phase !== 'learn') {
        throw new Error('branch-preference-skill-context-binding-invalid');
    }
    return createServerAgentSkillSourceContextAuthority({
        ...input, sourceAuthority: createBranchPreferenceSkillSourceAuthority(input),
    });
}
