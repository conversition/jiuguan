/** @author Codex @date 2026-10-14 @version 1.0
 * Summary authority binds a current job claim to complete fixed baseline and contiguous message evidence.
 */
import { createHash } from 'node:crypto';
import type { AgentSkillAssetContextV1 } from '../../../packages/session/public/agent-skill-turn-context.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { MaintenanceExecutionRecord } from '../maintenance-job-manager.ts';
import type { MaintenanceSnapshot } from '../maintenance-harness-service.ts';
import {
    isRollingSummaryApplyContext,
    maintenanceMessageEvidenceBinding,
    type RollingSummaryProposalContext,
} from '../maintenance-types.ts';
import {
    createServerAgentSkillSourceContextAuthority,
    type ServerAgentSkillContextSourceV1,
    type ServerAgentSkillSourceContextAuthorityDependencies,
} from './context-authority.ts';

const SOURCES = new WeakSet<object>();
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const MAX_FIXED_INPUT_CHARS = 1_000_000;
const MAX_BASELINE_CHARS = 16_000;

export const MAINTENANCE_SUMMARY_SKILL_SOURCE_VERSION =
    'maintenance-summary-skill-source-v1' as const;

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
        ? value as Record<string, unknown> : null;
}

/** Formal context hashes alone cannot prove that its complete baseline and source bytes reached the Provider. */
function fixedSummaryEvidenceMatches(snapshot: MaintenanceSnapshot, context: RollingSummaryProposalContext): boolean {
    try {
        const message = record(JSON.parse(snapshot.userMessage));
        const evidence = record(message?.evidence);
        const summary = record(evidence?.rollingSummary);
        const memory = record(snapshot.state.memory);
        const history = evidence?.recentHistory;
        if (!message || message.taskKind !== 'rolling_summary' || message.sourceRevision !== snapshot.revision
            || digest(message.proposalContext) !== digest(context) || !summary || !memory
            || typeof summary.longterm !== 'string' || summary.longterm.length > MAX_BASELINE_CHARS
            || digest(summary.longterm) !== context.baseSummaryDigest
            || summary.summaryRound !== context.expectedSummaryRound || summary.targetRound !== context.targetRound
            || summary.historyEpoch !== context.historyEpoch || summary.baseSummaryDigest !== context.baseSummaryDigest
            || summary.inputDigest !== context.inputDigest || digest(memory.rollingSummary) !== digest(summary)
            || !Array.isArray(history) || history.length !== context.sourceEvidence?.length
            || digest(memory.recentHistory) !== digest(history)) return false;
        return history.every((value, index) => {
            const row = record(value);
            if (!row || Object.keys(row).length !== 4
                || !['id', 'round', 'role', 'content'].every((key) => Object.hasOwn(row, key))) return false;
            const binding = maintenanceMessageEvidenceBinding(row as unknown as Parameters<
                typeof maintenanceMessageEvidenceBinding>[0]);
            return digest(binding) === digest(context.sourceEvidence![index]);
        });
    } catch {
        return false;
    }
}

export interface MaintenanceSummarySkillSourceV1 {
    readonly sourceVersion: typeof MAINTENANCE_SUMMARY_SKILL_SOURCE_VERSION;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly assetSessionId: string;
    readonly scope: ServerAgentSkillContextSourceV1['scope'];
    readonly assetRevision: string;
    readonly worldbookSourceRevision: string;
    readonly fixedInputDigest: string;
    readonly proposalContextDigest: string;
    readonly sourceDigest: string;
}

/** Host issuance attests one fixed Summary source; it grants neither Profile nor formal write permission. */
export function captureMaintenanceSummarySkillSource(input: {
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly assets: AgentSkillAssetContextV1;
    readonly snapshot: MaintenanceSnapshot;
}): MaintenanceSummarySkillSourceV1 {
    const { assets, snapshot } = input;
    const context = snapshot.proposalContext;
    if (!TOKEN.test(input.sessionId) || !['nsf', 'nsfw'].includes(input.contentMode)
        || assets.assetContextVersion !== 'session-agent-skill-assets-v1'
        || assets.sessionId !== assets.scope.sessionId || !TOKEN.test(assets.sessionId)
        || !DIGEST.test(assets.assetRevision) || !DIGEST.test(assets.worldbookSourceRevision)
        || context === null || typeof context !== 'object' || !isRollingSummaryApplyContext(context)
        || context.sessionId !== input.sessionId || context.sourceRevision !== snapshot.revision
        || snapshot.strictContextUnavailableReason !== undefined
        || snapshot.providerProposalContext !== undefined
        && digest(snapshot.providerProposalContext) !== digest(context)
        || typeof snapshot.userMessage !== 'string' || snapshot.userMessage.length > MAX_FIXED_INPUT_CHARS
        || !fixedSummaryEvidenceMatches(snapshot, context)) {
        throw new Error('maintenance-summary-skill-source-invalid');
    }
    if ([assets.scope.cardId, assets.scope.worldId].some((id) => id !== undefined && !TOKEN.test(id))) {
        throw new Error('maintenance-summary-skill-source-invalid');
    }
    let state: string;
    try {
        state = JSON.stringify(snapshot.state);
    } catch {
        throw new Error('maintenance-summary-skill-source-invalid');
    }
    if (typeof state !== 'string' || state.length > MAX_FIXED_INPUT_CHARS) {
        throw new Error('maintenance-summary-skill-source-invalid');
    }
    const metadata = {
        sourceVersion: MAINTENANCE_SUMMARY_SKILL_SOURCE_VERSION,
        sessionId: input.sessionId, sourceRevision: snapshot.revision, contentMode: input.contentMode,
        assetSessionId: assets.sessionId,
        scope: Object.freeze({
            sessionId: input.sessionId,
            ...(assets.scope.cardId === undefined ? {} : { cardId: assets.scope.cardId }),
            ...(assets.scope.worldId === undefined ? {} : { worldId: assets.scope.worldId }),
        }),
        assetRevision: assets.assetRevision, worldbookSourceRevision: assets.worldbookSourceRevision,
        fixedInputDigest: digest([snapshot.userMessage, state]), proposalContextDigest: digest(context),
    };
    const source = Object.freeze({ ...metadata, sourceDigest: digest(metadata) });
    SOURCES.add(source);
    return source;
}

export interface MaintenanceSummarySkillContextDependencies
    extends Omit<ServerAgentSkillSourceContextAuthorityDependencies, 'sourceAuthority'> {
    readonly execution: MaintenanceExecutionRecord;
    readonly source: MaintenanceSummarySkillSourceV1;
    readonly jobAuthority: { readExecution(runId: string): MaintenanceExecutionRecord | null };
    /** Current reads are synchronous, body-free and issued from the exact current fixed snapshot. */
    readonly sourceAuthority: { readCurrent(sessionId: string): MaintenanceSummarySkillSourceV1 | null };
    readonly isSessionOpen: (sessionId: string) => boolean;
}

function executionIdentity(execution: MaintenanceExecutionRecord) {
    const job = execution.job;
    return {
        runId: job.runId, parentRunId: job.parentRunId ?? job.runId, sessionId: job.sessionId,
        taskKind: job.taskKind, sourceRevision: job.sourceRevision, policyVersion: job.policyVersion,
        attempt: job.attempt, trigger: job.trigger, mode: job.mode, owner: execution.leaseOwnerInstanceId,
    };
}

export function createMaintenanceSummarySkillContextAuthority(input: MaintenanceSummarySkillContextDependencies) {
    return createServerAgentSkillSourceContextAuthority({
        ...input, sourceAuthority: createMaintenanceSummarySkillSourceAuthority(input),
    });
}

/** A completed parent turn is valid; only this running Summary owner/attempt/TTL may retain authority. */
export function createMaintenanceSummarySkillSourceAuthority(input: Pick<MaintenanceSummarySkillContextDependencies,
    'execution' | 'source' | 'jobAuthority' | 'sourceAuthority' | 'isSessionOpen' | 'nowMs'>) {
    const nowMs = input.nowMs ?? Date.now;
    const readExecution = input.jobAuthority.readExecution.bind(input.jobAuthority);
    const readCurrent = input.sourceAuthority.readCurrent.bind(input.sourceAuthority);
    const isSessionOpen = input.isSessionOpen;
    const expected = Object.freeze(executionIdentity(input.execution));
    const source = input.source;
    if (!SOURCES.has(source) || expected.taskKind !== 'rolling_summary'
        || expected.sessionId !== source.sessionId || expected.sourceRevision !== source.sourceRevision
        || !Number.isSafeInteger(expected.attempt) || expected.attempt < 1 || !TOKEN.test(expected.owner)) {
        throw new Error('maintenance-summary-skill-context-binding-invalid');
    }
    const identityDigest = digest(expected);
    const readSource = (lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null => {
        if (lease.lane !== 'maintenance' || lease.taskKind !== 'rolling_summary'
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
            authorityRevision: digest([identityDigest, source.sourceDigest]),
        });
    };
    return Object.freeze({ readForLease: readSource });
}
