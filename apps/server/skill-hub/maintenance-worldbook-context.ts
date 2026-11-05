/** @author Codex @date 2026-10-28 @version 1.0
 * Background WORLDBOOK authority comes from a current job claim and fixed source, never activeTurn.
 */
import { createHash } from 'node:crypto';
import type { AgentSkillAssetContextV1 } from '../../../packages/session/public/agent-skill-turn-context.ts';
import type { AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { MaintenanceExecutionRecord } from '../maintenance-job-manager.ts';
import type { MaintenanceSnapshot } from '../maintenance-harness-service.ts';
import { maintenanceProviderTools } from '../admitted-maintenance-model.ts';
import { isWorldbookRepairProposalContext, validateMaintenanceProposal, type WorldbookRepairProposalContext,
    type MaintenanceStrictProposalContext } from '../maintenance-types.ts';
import {
    createServerAgentSkillSourceContextAuthority,
    type ServerAgentSkillContextSourceV1,
    type ServerAgentSkillSourceContextAuthorityDependencies,
} from './context-authority.ts';

const SOURCES = new WeakSet<object>();
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

export const MAINTENANCE_WORLDBOOK_SKILL_SOURCE_VERSION =
    'maintenance-worldbook-skill-source-v1' as const;

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export interface MaintenanceWorldbookSkillSourceV1 {
    readonly sourceVersion: typeof MAINTENANCE_WORLDBOOK_SKILL_SOURCE_VERSION;
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

/** Preserve the original complete multi-file native context at both validation boundaries. */
export function maintenanceWorldbookSkillProviderProposalContext(
    context: MaintenanceStrictProposalContext,
): WorldbookRepairProposalContext {
    try {
        if (!isWorldbookRepairProposalContext(context) || Object.keys(context).length !== 2
            || !Array.isArray(context.files) || context.files.length < 1 || context.files.length > 8) throw new Error();
        maintenanceProviderTools('worldbook_repair', context);
        const files = new Set<string>();
        for (const file of context.files) {
            if (Object.keys(file).length !== 4 || file.file !== file.file.normalize('NFC')
                || files.has(file.file.toLowerCase()) || !DIGEST.test(file.expectedRevision)
                || !DIGEST.test(file.evidenceSetDigest) || !Array.isArray(file.entries)
                || file.entries.length < 1 || file.entries.length > 64) throw new Error();
            files.add(file.file.toLowerCase());
            const entries = new Set<string>();
            for (const entry of file.entries) {
                if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 2
                    || entries.has(entry.entryUid) || !DIGEST.test(entry.digest)) throw new Error();
                entries.add(entry.entryUid);
                // The native parser owns filename, stable UID and session identity constraints.
                validateMaintenanceProposal('worldbook_repair', {
                    version: 'worldbook-repair-proposal-v1', sessionId: context.sessionId,
                    file: file.file, expectedRevision: file.expectedRevision, evidenceSetDigest: file.evidenceSetDigest,
                    changes: [{ entryUid: entry.entryUid, expectedEntryDigest: entry.digest,
                        reasonCode: 'disable-stale-entry', patch: { enabled: false } }],
                }, context);
            }
            if (file.evidenceSetDigest !== digest({ file: file.file, revision: file.expectedRevision,
                entries: file.entries })) throw new Error();
        }
    } catch { throw new Error('maintenance-worldbook-skill-context-invalid'); }
    return context;
}

/** Host-only issuance, not permission. Callers must read an exact, current fixed snapshot. */
export function captureMaintenanceWorldbookSkillSource(input: {
    readonly sessionId: string;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly assets: AgentSkillAssetContextV1;
    readonly snapshot: MaintenanceSnapshot;
}): MaintenanceWorldbookSkillSourceV1 {
    const { assets, snapshot } = input;
    const context = snapshot.proposalContext;
    if (!TOKEN.test(input.sessionId) || !['nsf', 'nsfw'].includes(input.contentMode)
        || assets.assetContextVersion !== 'session-agent-skill-assets-v1'
        || assets.sessionId !== assets.scope.sessionId || !TOKEN.test(assets.sessionId)
        || !DIGEST.test(assets.assetRevision) || !DIGEST.test(assets.worldbookSourceRevision)
        || !isWorldbookRepairProposalContext(context)
        || context.sessionId !== input.sessionId
        || !DIGEST.test(snapshot.revision)
        || snapshot.strictContextUnavailableReason !== undefined
        || typeof snapshot.userMessage !== 'string' || snapshot.userMessage.length > 1_000_000) {
        throw new Error('maintenance-worldbook-skill-source-invalid');
    }
    const providerContext = maintenanceWorldbookSkillProviderProposalContext(context);
    let fixedInput: { taskKind?: unknown; sourceRevision?: unknown; proposalContext?: unknown };
    try { fixedInput = JSON.parse(snapshot.userMessage); }
    catch { throw new Error('maintenance-worldbook-skill-provider-context-invalid'); }
    if (!snapshot.providerProposalContext
        || digest(snapshot.providerProposalContext) !== digest(providerContext)
        || !fixedInput || fixedInput.taskKind !== 'worldbook_repair' || fixedInput.sourceRevision !== snapshot.revision
        || !fixedInput.proposalContext || typeof fixedInput.proposalContext !== 'object'
        || digest(fixedInput.proposalContext) !== digest(providerContext)) {
        throw new Error('maintenance-worldbook-skill-provider-context-invalid');
    }
    if ([assets.scope.cardId, assets.scope.worldId].some((id) => id !== undefined && !TOKEN.test(id))) {
        throw new Error('maintenance-worldbook-skill-source-invalid');
    }
    const state = JSON.stringify(snapshot.state);
    if (typeof state !== 'string' || state.length > 1_000_000) throw new Error('maintenance-worldbook-skill-source-invalid');
    const metadata = {
        sourceVersion: MAINTENANCE_WORLDBOOK_SKILL_SOURCE_VERSION,
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

export interface MaintenanceWorldbookSkillContextDependencies
    extends Omit<ServerAgentSkillSourceContextAuthorityDependencies, 'sourceAuthority'> {
    readonly execution: MaintenanceExecutionRecord;
    readonly source: MaintenanceWorldbookSkillSourceV1;
    readonly jobAuthority: { readExecution(runId: string): MaintenanceExecutionRecord | null };
    /** Current reads must be synchronous, body-free in their return value, and revision-aware. */
    readonly sourceAuthority: { readCurrent(sessionId: string): MaintenanceWorldbookSkillSourceV1 | null };
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
export function createMaintenanceWorldbookSkillContextAuthority(input: MaintenanceWorldbookSkillContextDependencies) {
    return createServerAgentSkillSourceContextAuthority({
        ...input, sourceAuthority: createMaintenanceWorldbookSkillSourceAuthority(input),
    });
}

/** Source liveness is independent of optional Skill activation and never grants write permission. */
export function createMaintenanceWorldbookSkillSourceAuthority(input: Pick<MaintenanceWorldbookSkillContextDependencies,
    'execution' | 'source' | 'jobAuthority' | 'sourceAuthority' | 'isSessionOpen' | 'nowMs'>) {
    const nowMs = input.nowMs ?? Date.now;
    const readExecution = input.jobAuthority.readExecution.bind(input.jobAuthority);
    const readCurrent = input.sourceAuthority.readCurrent.bind(input.sourceAuthority);
    const isSessionOpen = input.isSessionOpen;
    const expected = Object.freeze(executionIdentity(input.execution));
    const source = input.source;
    if (!SOURCES.has(source) || expected.taskKind !== 'worldbook_repair' || expected.mode !== 'shadow'
        || expected.executorRoute !== 'legacy'
        || expected.sessionId !== source.sessionId || expected.sourceRevision !== source.sourceRevision
        || !Number.isSafeInteger(expected.attempt) || expected.attempt < 1 || !TOKEN.test(expected.owner)) {
        throw new Error('maintenance-worldbook-skill-context-binding-invalid');
    }
    const identityDigest = digest(expected);
    const readSource = (lease: AgentAdmissionLease): ServerAgentSkillContextSourceV1 | null => {
        if (lease.lane !== 'maintenance' || lease.taskKind !== 'worldbook_repair'
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
