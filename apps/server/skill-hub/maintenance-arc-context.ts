/** @author Codex @date 2026-10-14 @version 1.0
 * Background arc authority comes from a current job claim and fixed source, never activeTurn.
 */
import { createHash } from 'node:crypto';
import type { AgentSkillAssetContextV1 } from '../../../packages/session/public/agent-skill-turn-context.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { MaintenanceExecutionRecord } from '../maintenance-job-manager.ts';
import type { MaintenanceSnapshot } from '../maintenance-harness-service.ts';
import { validateMaintenanceProposal, type ArcMaintenanceProposalContext,
    type MaintenanceStrictProposalContext } from '../maintenance-types.ts';
import {
    createServerAgentSkillSourceContextAuthority,
    type ServerAgentSkillContextSourceV1,
    type ServerAgentSkillSourceContextAuthorityDependencies,
} from './context-authority.ts';

const SOURCES = new WeakSet<object>();
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

export const MAINTENANCE_ARC_SKILL_SOURCE_VERSION =
    'maintenance-arc-skill-source-v1' as const;

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export interface MaintenanceArcSkillSourceV1 {
    readonly sourceVersion: typeof MAINTENANCE_ARC_SKILL_SOURCE_VERSION;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly assetSessionId: string;
    readonly scope: ServerAgentSkillContextSourceV1['scope'];
    readonly assetRevision: string;
    readonly worldbookSourceRevision: string;
    readonly fixedInputDigest: string;
    readonly proposalContextDigest: string;
    readonly providerProposalContextDigest: string;
    readonly sourceDigest: string;
}

/** The existing Provider contract deliberately excludes the local review catalog. */
export function maintenanceArcSkillProviderProposalContext(
    context: MaintenanceStrictProposalContext,
): ArcMaintenanceProposalContext {
    if (!context || typeof context !== 'object' || !('allowedArcIds' in context)
        || typeof context.arcProjectionDigest !== 'string' || !DIGEST.test(context.arcProjectionDigest)
        || !Array.isArray(context.arcEvidence)) throw new Error('maintenance-arc-skill-context-invalid');
    return {
        sessionId: context.sessionId, sourceRevision: context.sourceRevision,
        arcProjectionDigest: context.arcProjectionDigest,
        allowedArcIds: context.allowedArcIds, allowedSourceRefs: context.allowedSourceRefs,
        maxRound: context.maxRound, arcEvidence: context.arcEvidence,
    };
}

/** Host-only issuance, not permission. Callers must read an exact, current fixed snapshot. */
export function captureMaintenanceArcSkillSource(input: {
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly assets: AgentSkillAssetContextV1;
    readonly snapshot: MaintenanceSnapshot;
}): MaintenanceArcSkillSourceV1 {
    const { assets, snapshot } = input;
    const context = snapshot.proposalContext;
    if (!TOKEN.test(input.sessionId) || !['nsf', 'nsfw'].includes(input.contentMode)
        || assets.assetContextVersion !== 'session-agent-skill-assets-v1'
        || assets.sessionId !== assets.scope.sessionId || !TOKEN.test(assets.sessionId)
        || !DIGEST.test(assets.assetRevision) || !DIGEST.test(assets.worldbookSourceRevision)
        || context === null || typeof context !== 'object' || !('allowedArcIds' in context)
        || context.sessionId !== input.sessionId || context.sourceRevision !== snapshot.revision
        || !DIGEST.test(snapshot.revision)
        || !Array.isArray(context.arcReviewDescriptors)
        || !Array.isArray(context.allowedArcIds) || context.allowedArcIds.length < 1
        || context.arcReviewDescriptors.length !== context.allowedArcIds.length
        || new Set(context.arcReviewDescriptors.map((row) => row.arcId)).size !== context.allowedArcIds.length
        || snapshot.strictContextUnavailableReason !== undefined
        || typeof snapshot.userMessage !== 'string' || snapshot.userMessage.length > 1_000_000) {
        throw new Error('maintenance-arc-skill-source-invalid');
    }
    const providerContext = maintenanceArcSkillProviderProposalContext(context);
    let fixedInput: { taskKind?: unknown; sourceRevision?: unknown; proposalContext?: unknown };
    try { fixedInput = JSON.parse(snapshot.userMessage); }
    catch { throw new Error('maintenance-arc-skill-provider-context-invalid'); }
    if (!snapshot.providerProposalContext
        || digest(snapshot.providerProposalContext) !== digest(providerContext)
        || !fixedInput || fixedInput.taskKind !== 'branch_index' || fixedInput.sourceRevision !== snapshot.revision
        || !fixedInput.proposalContext || typeof fixedInput.proposalContext !== 'object'
        || digest(fixedInput.proposalContext) !== digest(providerContext)
        || /"arcReviewDescriptors"\s*:/u.test(snapshot.userMessage)) {
        throw new Error('maintenance-arc-skill-provider-context-invalid');
    }
    // Reuse the native Arc context validator without granting a proposal or writing an artifact.
    validateMaintenanceProposal('branch_index', {
        version: 'arc-maintenance-proposal-v1', sessionId: context.sessionId,
        sourceRevision: context.sourceRevision,
        actions: [{ kind: 'chapter_boundary', arcIds: [context.allowedArcIds[0]],
            boundaryRound: context.maxRound, sourceRefs: [context.allowedSourceRefs[0]] }],
    }, context);
    if ([assets.scope.cardId, assets.scope.worldId].some((id) => id !== undefined && !TOKEN.test(id))) {
        throw new Error('maintenance-arc-skill-source-invalid');
    }
    const state = JSON.stringify(snapshot.state);
    if (typeof state !== 'string' || state.length > 1_000_000
        || /"arcReviewDescriptors"\s*:/u.test(state)) throw new Error('maintenance-arc-skill-source-invalid');
    const metadata = {
        sourceVersion: MAINTENANCE_ARC_SKILL_SOURCE_VERSION,
        sessionId: input.sessionId, sourceRevision: snapshot.revision, contentMode: input.contentMode,
        assetSessionId: assets.sessionId,
        scope: Object.freeze({
            sessionId: input.sessionId,
            ...(assets.scope.cardId === undefined ? {} : { cardId: assets.scope.cardId }),
            ...(assets.scope.worldId === undefined ? {} : { worldId: assets.scope.worldId })
        }),
        assetRevision: assets.assetRevision, worldbookSourceRevision: assets.worldbookSourceRevision,
        fixedInputDigest: digest([snapshot.userMessage, state]), proposalContextDigest: digest(context),
        providerProposalContextDigest: digest(providerContext),
    };
    const source = Object.freeze({ ...metadata, sourceDigest: digest(metadata) });
    SOURCES.add(source);
    return source;
}

export interface MaintenanceArcSkillContextDependencies
    extends Omit<ServerAgentSkillSourceContextAuthorityDependencies, 'sourceAuthority'> {
    readonly execution: MaintenanceExecutionRecord;
    readonly source: MaintenanceArcSkillSourceV1;
    readonly jobAuthority: { readExecution(runId: string): MaintenanceExecutionRecord | null };
    /** Current reads must be synchronous, body-free in their return value, and revision-aware. */
    readonly sourceAuthority: { readCurrent(sessionId: string): MaintenanceArcSkillSourceV1 | null };
    readonly isSessionOpen: (sessionId: string) => boolean;
}

function executionIdentity(execution: MaintenanceExecutionRecord) {
    const job = execution.job;
    return {
        runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sessionId: job.sessionId,
        taskKind: job.taskKind, sourceRevision: job.sourceRevision, policyVersion: job.policyVersion,
        attempt: job.attempt, trigger: job.trigger, mode: job.mode, owner: execution.leaseOwnerInstanceId,
        executorRoute: execution.executorRoute,
    };
}

/** Domain authority only. It neither grants a Profile purpose nor produces a consume/apply receipt. */
export function createMaintenanceArcSkillContextAuthority(input: MaintenanceArcSkillContextDependencies) {
    return createServerAgentSkillSourceContextAuthority({
        ...input, sourceAuthority: createMaintenanceArcSkillSourceAuthority(input),
    });
}

/** Source liveness is independent of optional Skill activation and never grants write permission. */
export function createMaintenanceArcSkillSourceAuthority(input: Pick<MaintenanceArcSkillContextDependencies,
    'execution' | 'source' | 'jobAuthority' | 'sourceAuthority' | 'isSessionOpen' | 'nowMs'>) {
    const nowMs = input.nowMs ?? Date.now;
    const readExecution = input.jobAuthority.readExecution.bind(input.jobAuthority);
    const readCurrent = input.sourceAuthority.readCurrent.bind(input.sourceAuthority);
    const isSessionOpen = input.isSessionOpen;
    const expected = Object.freeze(executionIdentity(input.execution));
    const source = input.source;
    if (!SOURCES.has(source) || expected.taskKind !== 'branch_index'
        || expected.sessionId !== source.sessionId || expected.sourceRevision !== source.sourceRevision
        || !Number.isSafeInteger(expected.attempt) || expected.attempt < 1 || !TOKEN.test(expected.owner)) {
        throw new Error('maintenance-arc-skill-context-binding-invalid');
    }
    const identityDigest = digest(expected);
    const readSource = (lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null => {
        if (lease.lane !== 'maintenance' || lease.taskKind !== 'branch_index'
            || lease.runId !== expected.runId || lease.parentRunId !== expected.parentRunId
            || lease.sessionId !== expected.sessionId || lease.sourceRevision !== expected.sourceRevision
            || lease.policyVersion !== expected.policyVersion || lease.mode !== source.contentMode
            || isSessionOpen(expected.sessionId) !== true) return null;
        const execution = readExecution(expected.runId);
        const expiry = execution ? Date.parse(execution.leaseExpiresAt) : NaN;
        if (!execution || execution.job.status !== 'running' || execution.cancelRequestedAt !== undefined
            || !Number.isFinite(expiry) || expiry <= nowMs()
            || digest(executionIdentity(execution)) !== identityDigest) return null;
        const current = readCurrent(expected.sessionId);
        if (!current || !SOURCES.has(current) || current.sourceDigest !== source.sourceDigest) return null;
        return Object.freeze({
            sourceContextVersion: 'server-agent-skill-context-source-v1', origin: 'maintenance-job',
            runId: expected.runId, parentRunId: expected.parentRunId, sessionId: expected.sessionId,
            sourceRevision: source.sourceRevision, contentMode: source.contentMode, scope: source.scope,
            assetRevision: source.assetRevision, worldbookSourceRevision: source.worldbookSourceRevision,
            // Heartbeat renewals may extend expiry, but never create a new owner/attempt/source identity.
            authorityRevision: digest([identityDigest, source.sourceDigest]),
        });
    };
    return Object.freeze({ readForLease: readSource });
}
