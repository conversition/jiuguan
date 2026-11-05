/** @author Codex @date 2026-10-13 @version 1.0
 * Keep request admission reusable without moving artifact adoption out of its domain.
 */
import { compileAgentSkillPrograms } from '@jiuguan/prompt/agent-skill-compiler';
import type { AdmissionTicketBroker, AgentAdmissionLease } from '../agent-admission-broker.ts';
import type { AdmittedModelGatewayOptions } from '../admitted-model-gateway.ts';
import { createServerBuiltinAgentSkillPack } from './builtin-source-pack.ts';
import { createServerAgentSkillRuntime } from './composition.ts';
import {
    createServerAgentSkillContextAuthority,
    type ServerAgentSkillContextAuthorityDependencies,
    type ServerAgentSkillContextBindingV1,
    type ServerAgentSkillSynchronousContextAuthorityPort,
} from './context-authority.ts';
import { createServerAgentSkillProfileAdmissionService } from './profile-admission-service.ts';
import {
    createServerAgentSkillPromptConsumer,
    createServerAgentSkillPromptCallGroup,
    type ServerAgentSkillPromptAttributionV1,
} from './prompt-consumer.ts';

const LIVE_CONSUMERS = Object.freeze({
    'context.compiler': { taskKind: 'context_compiler', phase: 'plan' },
    'interactive.critic': { taskKind: 'critic_revision', phase: 'validate' },
    'interactive.prelude': { taskKind: 'interactive_prelude', phase: 'plan' },
    'interactive.variableProposal': { taskKind: 'interactive_prelude', phase: 'execute' },
    'interactive.aqlReplan': { taskKind: 'aql_replan', phase: 'plan' },
    'maintenance.memory': { taskKind: 'memory_consolidation', phase: 'execute' },
    'maintenance.arc': { taskKind: 'branch_index', phase: 'execute' },
    'maintenance.npc': { taskKind: 'npc_state', phase: 'execute' },
    'maintenance.worldbook': { taskKind: 'worldbook_repair', phase: 'execute' },
    'learning.preference': { taskKind: 'preference_extract', phase: 'learn' },
    'learning.branchPreference': { taskKind: 'preference_extract', phase: 'learn' },
    'learning.styleCompile': { taskKind: 'style_compile', phase: 'learn' },
} as const);

export const LEARNING_PREFERENCE_SKILL_POLICY_VERSION = 'p14-q6-preference-v1' as const;
export const BRANCH_PREFERENCE_SKILL_POLICY_VERSION = 'p14-q6-branch-semantic-v1' as const;
export const STYLE_COMPILE_SKILL_POLICY_VERSION = 'p14-q7-style-compiler-v1' as const;
export const VARIABLE_PROPOSAL_SKILL_POLICY_VERSION = 'p17-variable-proposal-v1' as const;
export const AQL_REPLAN_SKILL_POLICY_VERSION = 'p14-q9r-aql-replan-interactive-v1' as const;

export interface ServerAgentSkillLiveSuccess {
    readonly attribution: ServerAgentSkillPromptAttributionV1;
    readonly admittedAt: string;
    readonly executedAt: string;
}

/** Independent from shadow. Adding a registered consumer does not enable its existing Agent. */
export function agentSkillLiveEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return env.JG_AGENT_SKILL_LIVE === '1';
}

/** Shared request boundary only; artifact validation and final adoption remain domain-owned. */
export interface ServerAgentSkillLiveRequestInput {
    readonly broker: AdmissionTicketBroker;
    readonly consumerId: 'context.compiler' | 'interactive.critic' | 'interactive.prelude';
    readonly policyVersion: string;
    readonly runId: string;
    readonly parentRunId: string;
    readonly sourceRevision: string;
    readonly authority: Omit<ServerAgentSkillContextAuthorityDependencies, 'bindings' | 'leaseAuthority'>;
    readonly nowMs?: () => number;
}

export function createServerAgentSkillLiveRequest(input: ServerAgentSkillLiveRequestInput) {
    const call = createLiveRequest(input, false, foregroundAuthority(input));
    return Object.freeze({ prepareRequest: call.prepareRequest, takeSuccessfulCall: call.takeSuccessfulCall });
}

/** Lease-wide program identity is fixed; only a fully successful series can be sealed. */
export function createServerAgentSkillLiveCallGroup(input: ServerAgentSkillLiveRequestInput) {
    const call = createLiveRequest(input, true, foregroundAuthority(input));
    return Object.freeze({ prepareRequest: call.prepareRequest, seal: call.takeSuccessfulCall, abandon: call.abandon });
}

type LiveIdentity = Omit<ServerAgentSkillLiveRequestInput, 'authority' | 'consumerId'> & {
    readonly consumerId: keyof typeof LIVE_CONSUMERS;
};
type ContextFactory = (binding: ServerAgentSkillContextBindingV1) => ServerAgentSkillSynchronousContextAuthorityPort;

function foregroundAuthority(input: ServerAgentSkillLiveRequestInput): ContextFactory {
    if (input.consumerId !== 'context.compiler' && input.consumerId !== 'interactive.critic'
        && input.consumerId !== 'interactive.prelude') throw new Error('skill-live-foreground-consumer-invalid');
    return (binding) => createServerAgentSkillContextAuthority({
        ...input.authority, leaseAuthority: input.broker, nowMs: input.nowMs, bindings: [binding],
    });
}

/** Closed background registration. It cannot opt a foreground consumer out of active-turn authority. */
export function createServerAgentSkillBackgroundLiveCallGroup(input: LiveIdentity & {
    readonly consumerId: 'maintenance.memory';
    /** Shared control Profile, independently fixed domain task. Omission preserves the Memory caller. */
    readonly taskKind?: 'memory_consolidation' | 'rolling_summary';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'maintenance.memory') throw new Error('skill-live-background-consumer-invalid');
    const taskKind = input.taskKind === undefined ? 'memory_consolidation' : input.taskKind;
    if (taskKind !== 'memory_consolidation' && taskKind !== 'rolling_summary') {
        throw new Error('skill-live-background-task-invalid');
    }
    const registration = Object.freeze({ taskKind, phase: 'execute' as const });
    const call = createLiveRequest(input, true, input.createAuthority, registration);
    return Object.freeze({ prepareRequest: call.prepareRequest, seal: call.takeSuccessfulCall, abandon: call.abandon });
}

/** Arc is a distinct Profile consumer on the existing branch_index job and lease. */
export function createServerAgentSkillArcLiveCallGroup(input: LiveIdentity & {
    readonly consumerId: 'maintenance.arc';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'maintenance.arc') throw new Error('skill-live-arc-consumer-invalid');
    const call = createLiveRequest(input, true, input.createAuthority);
    return Object.freeze({ prepareRequest: call.prepareRequest, seal: call.takeSuccessfulCall, abandon: call.abandon });
}

/** Native NPC proposal/no-op calls cannot borrow Arc or the NPC maintenance alias. */
export function createServerAgentSkillNpcLiveCallGroup(input: LiveIdentity & {
    readonly consumerId: 'maintenance.npc';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'maintenance.npc') throw new Error('skill-live-npc-consumer-invalid');
    const call = createLiveRequest(input, true, input.createAuthority);
    return Object.freeze({ prepareRequest: call.prepareRequest, seal: call.takeSuccessfulCall, abandon: call.abandon });
}

/** Worldbook retains its native proposal-only protocol and original job/lease. */
export function createServerAgentSkillWorldbookLiveCallGroup(input: LiveIdentity & {
    readonly consumerId: 'maintenance.worldbook';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'maintenance.worldbook') throw new Error('skill-live-worldbook-consumer-invalid');
    const call = createLiveRequest(input, true, input.createAuthority);
    return Object.freeze({ prepareRequest: call.prepareRequest, seal: call.takeSuccessfulCall, abandon: call.abandon });
}

/** One initial inference only. Branch/style cannot opt into this independent source registration. */
export function createServerAgentSkillLearningLiveRequest(input: LiveIdentity & {
    readonly consumerId: 'learning.preference';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'learning.preference'
        || input.policyVersion !== LEARNING_PREFERENCE_SKILL_POLICY_VERSION) {
        throw new Error('skill-live-learning-consumer-invalid');
    }
    return createLiveRequest(input, false, input.createAuthority);
}

/** Independent edited-branch inference; it cannot enter the initial Preference registration. */
export function createServerAgentSkillBranchPreferenceLiveRequest(input: LiveIdentity & {
    readonly consumerId: 'learning.branchPreference';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'learning.branchPreference'
        || input.policyVersion !== BRANCH_PREFERENCE_SKILL_POLICY_VERSION) {
        throw new Error('skill-live-branch-preference-consumer-invalid');
    }
    return createLiveRequest(input, false, input.createAuthority);
}

/** Independent Style compilation; its native job cannot enter Preference or Memory factories. */
export function createServerAgentSkillStyleCompileLiveRequest(input: LiveIdentity & {
    readonly consumerId: 'learning.styleCompile';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'learning.styleCompile'
        || input.policyVersion !== STYLE_COMPILE_SKILL_POLICY_VERSION) {
        throw new Error('skill-live-style-compile-consumer-invalid');
    }
    return createLiveRequest(input, false, input.createAuthority);
}

export function createServerAgentSkillVariableProposalLiveRequest(input: LiveIdentity & {
    readonly consumerId: 'interactive.variableProposal';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'interactive.variableProposal'
        || input.policyVersion !== VARIABLE_PROPOSAL_SKILL_POLICY_VERSION) {
        throw new Error('skill-live-variable-proposal-consumer-invalid');
    }
    return createLiveRequest(input, false, input.createAuthority);
}

/** Post-commit AQL has an independent source window; ordinary active turns cannot enter it. */
export function createServerAgentSkillAqlReplanLiveRequest(input: LiveIdentity & {
    readonly consumerId: 'interactive.aqlReplan';
    readonly createAuthority: ContextFactory;
}) {
    if (input.consumerId !== 'interactive.aqlReplan'
        || input.policyVersion !== AQL_REPLAN_SKILL_POLICY_VERSION) {
        throw new Error('skill-live-aql-replan-consumer-invalid');
    }
    return createLiveRequest(input, false, input.createAuthority);
}

function createLiveRequest(input: LiveIdentity, series: boolean, createAuthority: ContextFactory,
    registration: Readonly<{
        taskKind: AgentAdmissionLease['taskKind']; phase: 'plan' | 'validate' | 'execute' | 'learn';
    }>
        = LIVE_CONSUMERS[input.consumerId]) {
    const nowMs = input.nowMs ?? Date.now;
    const pack = createServerBuiltinAgentSkillPack();
    let attempted = false;
    let successful: ServerAgentSkillLiveSuccess | null = null;
    let closed = false;
    let originalLease: AgentAdmissionLease | null = null;
    let sink: ReturnType<typeof createServerAgentSkillPromptCallGroup> | null = null;
    const requestDigests: string[] = [];
    const succeededReceipts = new WeakSet<object>();
    let dispatches = 0;
    const abandon = () => { closed = true; successful = null; sink?.discard(); };
    const prepareRequest: NonNullable<AdmittedModelGatewayOptions['prepareRequest']> = async (candidate) => {
        const { lease, request, signal } = candidate;
        if (closed || (attempted && !series)) return null;
        successful = null;
        const first = !attempted;
        attempted = true;
        if (!registration || signal?.aborted || lease.taskKind !== registration.taskKind
            || lease.policyVersion !== input.policyVersion || lease.runId !== input.runId
            || lease.parentRunId !== input.parentRunId || lease.sourceRevision !== input.sourceRevision
            || (originalLease !== null && originalLease !== lease)) { abandon(); return null; }
        try {
            if (first) {
                originalLease = lease;
                const catalog = await pack.catalogPort.readCatalog();
                const foundation = catalog.headers
                    .find((header) => header.manifest.capabilityIds[0] === input.consumerId);
                if (!foundation) { abandon(); return null; }
                const authority = createAuthority({
                    taskKind: registration.taskKind, policyVersion: input.policyVersion,
                    capabilityId: input.consumerId, phase: registration.phase, candidates: null,
                    explicit: [{ skillId: foundation.manifest.skillId, version: foundation.manifest.version }]
                });
                const binding = () => {
                    const context = authority.readForLease(lease);
                    return Object.freeze({
                        ticketId: lease.ticketId, runId: lease.runId, parentRunId: lease.parentRunId,
                        sessionId: lease.sessionId, modelId: lease.modelId, toolSetDigest: lease.toolSetDigest,
                        contentMode: lease.mode, contextRevision: context.contextRevision,
                        nsfwSafetyDigest: context.nsfwSafetyDigest,
                        expiresAtMs: lease.expiresAtMs, profileId: context.profileId
                    });
                };
                const dependencies = {
                    binding: binding(), maxPromptTokens: lease.limits.maxInputTokens,
                    readCurrentBinding: binding, nowMs,
                    readCommittedConsumption: () => null,
                    recordConsumption: () => { throw new Error('skill-live-outbox-required'); },
                };
                sink = series ? createServerAgentSkillPromptCallGroup(dependencies, lease.limits.maxModelCalls)
                    : createServerAgentSkillPromptConsumer(dependencies);
                const service = createServerAgentSkillProfileAdmissionService({
                    leaseAuthority: input.broker,
                    catalogPort: pack.catalogPort, runtimePort: createServerAgentSkillRuntime(pack.catalogPort),
                    profileRegistry: pack.profileRegistry, contextAuthority: authority,
                    sourceAuthority: pack.sourceAuthority,
                    compiler: { compile: compileAgentSkillPrograms }, consumer: sink.consumer, nowMs
                });
                await service.consume(await service.prepare(lease));
            }
            if (!sink || signal?.aborted) { abandon(); return null; }
            const currentSink = sink;
            const assembled = sink.assemble(request);
            if (assembled.kind !== 'assembled') { abandon(); return null; }
            dispatches += 1;
            return Object.freeze({
                request: assembled.request,
                beforeDispatch: () => currentSink.beforeProviderDispatch(assembled.receipt, assembled.request),
                succeeded: () => {
                    if (closed || succeededReceipts.has(assembled.receipt)) return;
                    currentSink.providerSucceeded(assembled.receipt, assembled.request);
                    succeededReceipts.add(assembled.receipt);
                    requestDigests.push(assembled.receipt.requestDigest);
                    successful = Object.freeze({
                        attribution: currentSink.prepareCommitAttribution(assembled.receipt, 'not-required'),
                        admittedAt: new Date(lease.consumedAtMs).toISOString(),
                        executedAt: new Date(nowMs()).toISOString()
                    });
                    if (!series) currentSink.discard();
                },
                discard: abandon,
            });
        } catch { abandon(); return null; }
    };
    return Object.freeze({
        prepareRequest,
        abandon,
        takeSuccessfulCall(): (ServerAgentSkillLiveSuccess & { readonly requestDigests: readonly string[] }) | null {
            const result = !closed && successful && dispatches === requestDigests.length
                ? Object.freeze({ ...successful, requestDigests: Object.freeze([...requestDigests]) }) : null;
            abandon();
            return result;
        },
    });
}
