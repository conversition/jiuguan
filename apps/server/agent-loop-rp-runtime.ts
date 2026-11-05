/** @author Codex @date 2026-10-26 @version 1.0
 * RP scope for the original Runtime's sole Coordinator. No independent Runner, parent join or production route.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import type { AgentLoopCoordinatorPorts, AgentLoopStepResult } from './agent-loop-coordinator.ts';
import {
    AgentLoopProjectionStore,
    hasUnsettledAgentLoopDagBudgetOverrun,
    type AgentLoopTaskRecord,
} from './agent-loop-projection-store.ts';
import {
    normalizeRpChildAnalysisBinding,
    rpChildAnalysisDigest,
    type RpChildAnalysisBindingV1,
} from '../../packages/memory/public/rp-child-analysis.ts';
import {
    isRpAnalysisSourceAdapter,
    readRpAnalysisSourceBinding,
    type RpAnalysisSourceAdapter,
} from './agent-loop-rp-analysis-source.ts';
import { createAgentLoopRpModel, type AgentLoopRpModelOptions } from './agent-loop-rp-model.ts';
import { consumeAgentLoopModelInvocationPermit } from './agent-loop-model-invocation-permit.ts';
import { readAgentLoopModelOutcome } from './agent-loop-model-outcome.ts';
import { readAgentLoopActionOutcome, createAgentLoopActionOutcome } from './agent-loop-action-outcome.ts';
import { AgentLoopActionGateway, type AgentLoopActionRequest } from './agent-loop-action-gateway.ts';
import {
    AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
    normalizeAgentLoopActionObject,
} from './agent-loop-action-receipt.ts';
import { createAgentLoopRpCharacterActionPersistence } from './agent-loop-get-variables-action-persistence.ts';
import { createRpCharacterAction, readRpCharacterActionResult } from './agent-loop-rp-character-action.ts';
import { createRpCharacterVerification } from './agent-loop-rp-character-verification.ts';
import {
    issueAgentLoopCompletionRequest,
    consumeAgentLoopCompletionRequest,
    revokeAgentLoopCompletionRequest,
} from './agent-loop-completion-request.ts';
import {
    prepareFrozenAgentLoopCompletion,
    commitFrozenAgentLoopCompletion,
    revokeFrozenAgentLoopCompletion,
} from './agent-loop-frozen-completion.ts';
import { RP_CHILD_ANALYSIS_TASK_CONTRACT, RP_CHILD_ANALYSIS_VERIFIER_SET } from './agent-loop-rp-scenario-template.ts';
import { withProviderWorkSettlement } from '../../packages/proxy/public/provider-runtime.ts';
import { reserveRpDelegatedChild, type RpDelegationCreationHost, type RpDelegationCreationInput } from './agent-loop-rp-delegation-admission.ts';

const MAX_LEAF_STEPS = 5;
const MIN_VERIFY_WALL_MS = 1;
const CONTEXT_VERSION = 'agent-loop-rp-readonly-execution-context-v1' as const;

export interface AgentLoopRpReadonlyExecutionContext {
    readonly version: typeof CONTEXT_VERSION;
}

interface ContextData {
    readonly store: AgentLoopProjectionStore;
    readonly ownerId: string;
    readonly reservationId: string;
    readonly binding: RpChildAnalysisBindingV1;
    readonly source: RpAnalysisSourceAdapter;
    readonly sourceRef: string;
    readonly signal: AbortSignal;
    readonly harnessRunId: string;
}

export type AgentLoopRpReadonlyModelHost = Pick<
    AgentLoopRpModelOptions,
    | 'broker'
    | 'client'
    | 'selection'
    | 'budgetProfile'
    | 'policyVersion'
    | 'estimateCost'
    | 'recordUsage'
    | 'onLeaseClosed'
    | 'arbitrationRuntime'
>;

export interface AgentLoopRpReadonlyExecutionConfig {
    readonly model: AgentLoopRpReadonlyModelHost;
    readonly delegation?: RpDelegationCreationHost;
}

export interface AgentLoopRpReadonlyExecutionResult {
    readonly steps: readonly AgentLoopStepResult[];
    readonly record: AgentLoopTaskRecord;
    readonly settled: boolean;
}

export interface AgentLoopRpReadonlyExecutionPort {
    delegate(input: RpDelegationCreationInput): ReturnType<AgentLoopProjectionStore['readDagBudget']>;
    execute(context: AgentLoopRpReadonlyExecutionContext): Promise<AgentLoopRpReadonlyExecutionResult>;
}

const CONTEXTS = new WeakMap<object, ContextData>();
const RUNTIME_PORTS = new WeakMap<object, AgentLoopRpReadonlyExecutionPort>();

function reject(): never {
    throw new Error('agent-loop-rp-readonly-execution-denied');
}

/** Trusted host only. A reserved allocation and a reviewed source are necessary, not dispatch authority by DTO. */
export function createAgentLoopRpReadonlyExecutionContext(input: ContextData): AgentLoopRpReadonlyExecutionContext {
    if (types.isProxy(input)) reject();
    normalizeAgentLoopActionObject(input, [
        'store',
        'ownerId',
        'reservationId',
        'binding',
        'source',
        'sourceRef',
        'signal',
        'harnessRunId',
    ]);
    const binding = normalizeRpChildAnalysisBinding(input.binding);
    if (
        !(input.store instanceof AgentLoopProjectionStore) ||
        !isRpAnalysisSourceAdapter(input.source) ||
        rpChildAnalysisDigest(readRpAnalysisSourceBinding(input.source)) !== rpChildAnalysisDigest(binding) ||
        !(input.signal instanceof AbortSignal) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(input.ownerId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(input.harnessRunId) ||
        !/^rp-character:sha256:[a-f0-9]{64}$/u.test(input.sourceRef)
    )
        reject();
    const snapshot = input.store.readDagBudget(binding.parentTaskId);
    const entry = snapshot.allocations.find((item) => item.allocation.reservationId === input.reservationId);
    const child = input.store.read(binding.childTaskId);
    if (
        snapshot.state !== 'active' ||
        snapshot.record.ownerId !== input.ownerId ||
        snapshot.record.envelope.currentAttemptId !== binding.parentAttemptId ||
        !entry ||
        entry.status !== 'reserved' ||
        entry.allocation.childEnvelope.taskId !== binding.childTaskId ||
        !child ||
        child.fenced ||
        child.ownerId !== input.ownerId ||
        child.revision !== 1 ||
        child.envelope.state !== 'CREATED' ||
        child.envelope.phase !== 'PREPARE' ||
        child.envelope.currentAttemptId !== undefined ||
        child.envelope.taskKind !== RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind ||
        child.envelope.taskContractRef !== RP_CHILD_ANALYSIS_TASK_CONTRACT.ref ||
        child.envelope.verifier.verifierSetRef !== RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRef ||
        child.envelope.verifier.verifierSetRevision !== RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRevision ||
        child.envelope.budget.granted.modelCalls !== 1 ||
        child.envelope.budget.granted.toolCalls !== 1
    )
        reject();
    input.source.assertCurrent();
    const context = Object.freeze({ version: CONTEXT_VERSION });
    CONTEXTS.set(context, Object.freeze({ ...input, binding }));
    return context;
}

/** Copies and an unconfigured/default Runtime cannot acquire the separately bound readonly execution port. */
export function createAgentLoopRpReadonlyExecutionPort(runtime: object): AgentLoopRpReadonlyExecutionPort {
    return RUNTIME_PORTS.get(runtime) ?? reject();
}

type Scope = {
    readonly data: ContextData;
    readonly store: AgentLoopProjectionStore;
    readonly deadlineMs: number;
    stage: AgentLoopTaskRecord['envelope']['phase'];
    active: boolean;
    revision: number;
    model?: ReturnType<typeof createAgentLoopRpModel>;
    modelOutcome?: unknown;
    actionOutcome?: unknown;
    completionRequest?: ReturnType<typeof issueAgentLoopCompletionRequest>;
    evaluation?: Awaited<ReturnType<typeof prepareFrozenAgentLoopCompletion>>;
    verification?: ReturnType<typeof createRpCharacterVerification>;
};

/** Installed inside createAgentLoopServerComposition; all steps are delegated to its existing Coordinator. */
export function createAgentLoopRpReadonlyRuntimeScope(
    options: Readonly<{
        store: AgentLoopProjectionStore;
        ownerId: string;
        clock: () => string;
        config: AgentLoopRpReadonlyExecutionConfig;
        closed: () => boolean;
        track: (work: Promise<unknown>) => void;
    }>,
) {
    const local = new AsyncLocalStorage<Scope>();
    const active = new Map<string, Scope>();
    const { store, ownerId, clock } = options;
    const config = Object.freeze({ model: Object.freeze({ ...options.config.model }),
        delegation: options.config.delegation ? Object.freeze({ ...options.config.delegation }) : undefined });

    function current(allowAccounting = false): Scope {
        const scope = local.getStore();
        if (
            !scope ||
            !scope.active ||
            active.get(scope.data.binding.childTaskId) !== scope ||
            (!allowAccounting && (options.closed() || scope.data.signal.aborted))
        )
            reject();
        const now = Date.parse(clock());
        if (!Number.isSafeInteger(now) || (!allowAccounting && now >= scope.deadlineMs)) reject();
        return scope;
    }

    function assertCurrent(scope: Scope, revision = scope.revision): AgentLoopTaskRecord {
        if (current() !== scope) reject();
        const snapshot = store.readDagBudget(scope.data.binding.parentTaskId);
        const root = snapshot.record;
        const child = store.read(scope.data.binding.childTaskId);
        const now = Date.parse(clock());
        const unresolvedOverrun = hasUnsettledAgentLoopDagBudgetOverrun(snapshot, (taskId) => store.read(taskId));
        if (
            unresolvedOverrun ||
            snapshot.state !== 'active' ||
            root.envelope.children.some(item => item.joinState === 'rejected') ||
            root.fenced ||
            root.ownerId !== ownerId ||
            !root.leaseExpiresAt ||
            Date.parse(root.leaseExpiresAt) <= now ||
            root.envelope.currentAttemptId !== scope.data.binding.parentAttemptId ||
            !child ||
            child.fenced ||
            child.ownerId !== ownerId ||
            child.revision !== revision ||
            child.envelope.phase !== scope.stage ||
            !child.leaseExpiresAt ||
            Date.parse(child.leaseExpiresAt) <= now ||
            (child.envelope.currentAttemptId !== undefined &&
                child.envelope.currentAttemptId !== scope.data.binding.childAttemptId)
        )
            reject();
        scope.data.source.assertCurrent();
        return child;
    }

    function sourceCurrentAtCommit(scope: Scope): void {
        current();
        scope.data.source.assertCurrent();
        const action = readAgentLoopActionOutcome(scope.actionOutcome);
        if (!action?.artifactBundle || !action.usageDelta) reject();
        readRpCharacterActionResult({
            sourceAdapter: scope.data.source,
            binding: scope.data.binding,
            sourceRef: scope.data.sourceRef,
            metadata: {
                sourceKind: action.sourceKind,
                sourceRef: action.sourceRef,
                payloadDigest: action.payloadDigest,
                completeness: action.completeness,
                evidenceRefs: action.evidenceRefs,
                usage: action.usageDelta,
            },
        });
    }

    const taskStore: AgentLoopCoordinatorPorts['taskStore'] = Object.freeze({
        read: (taskId) => current(true).store.read(taskId),
        readEvents: (taskId) => current(true).store.readEvents(taskId),
        readObservations: (taskId) => current(true).store.readObservations(taskId),
        readRefs: (taskId) => current(true).store.readRefs(taskId),
        readRepairState: (input) => current(true).store.readRepairState(input),
        commit(input) {
            const scope = current(true);
            const value = normalizeAgentLoopActionObject(
                input,
                ['taskId', 'expectedRevision', 'ownerId', 'envelope', 'event'],
                ['providerObservation', 'modelOutcome', 'artifactRefs', 'requirePristinePrepare'],
            );
            try {
                assertCurrent(scope);
            } catch {
                const modeled = readAgentLoopModelOutcome(scope.modelOutcome);
                if (
                    scope.stage === 'MODEL' &&
                    modeled &&
                    value.modelOutcome === scope.modelOutcome &&
                    value.providerObservation === modeled.observation
                ) {
                    // Withdrawal can revoke a Decision between the Model return and Core CAS.
                    // Only the real Gateway accounting is retained, never the next executable phase.
                    const settled = scope.store.ingestObservation({
                        observation: modeled.observation,
                        expectedRevision: value.expectedRevision,
                        ownerId,
                        modelOutcome: scope.modelOutcome,
                    });
                    scope.revision = settled.record.revision;
                }
                return reject();
            }
            const result = scope.store.commit(input);
            scope.revision = result.revision;
            scope.stage = result.envelope.phase;
            return result;
        },
        annotate: (input) => {
            const scope = current(true);
            const value = normalizeAgentLoopActionObject(
                input,
                ['taskId', 'expectedRevision', 'ownerId', 'event'],
                ['requireNew'],
            );
            const event = normalizeAgentLoopActionObject(value.event, ['eventId', 'kind'], ['reasonCode']);
            if (event.kind !== 'action-completed' || !readAgentLoopActionOutcome(scope.actionOutcome))
                assertCurrent(scope);
            return scope.store.annotate(input);
        },
        ingestObservation(input) {
            const scope = current(true);
            const value = normalizeAgentLoopActionObject(
                input,
                ['observation', 'expectedRevision', 'ownerId'],
                ['modelOutcome'],
            );
            const model = readAgentLoopModelOutcome(scope.modelOutcome),
                action = readAgentLoopActionOutcome(scope.actionOutcome);
            if (value.observation !== model?.observation && value.observation !== action?.observation) reject();
            if (value.observation === model?.observation && value.modelOutcome !== scope.modelOutcome) reject();
            const result = scope.store.ingestObservation(input);
            if (result.classification === 'applied') scope.revision = result.record.revision;
            return result;
        },
    });

    const ports = Object.freeze({
        taskStore,
        prepare: async (step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0]) => {
            const scope = current();
            const record = assertCurrent(scope, step.revision);
            if (scope.stage !== 'PREPARE' || record.revision !== 1) reject();
            return Object.freeze({ attemptId: scope.data.binding.childAttemptId });
        },
        decide: async (step: Parameters<AgentLoopCoordinatorPorts['decide']>[0]) => {
            const scope = current(),
                record = assertCurrent(scope, step.revision);
            if (scope.stage !== 'MODEL' || !step.invocationPermit || scope.model) reject();
            const admissionScope = consumeAgentLoopModelInvocationPermit(step.invocationPermit, {
                record,
                ownerId,
                deadlineMs: scope.deadlineMs,
            });
            if (config.model.budgetProfile.maxWallMs + MIN_VERIFY_WALL_MS > record.envelope.budget.granted.wallMs)
                reject();
            scope.model = createAgentLoopRpModel({
                ...config.model,
                binding: scope.data.binding,
                source: scope.data.source,
                sourceRef: scope.data.sourceRef,
                admissionScope,
                runId: scope.data.harnessRunId,
                parentRunId: scope.data.binding.parentTaskId,
                harnessRunId: scope.data.harnessRunId,
                clock,
                signal: scope.data.signal,
                assertCurrent: (input) => {
                    assertCurrent(scope, input.revision);
                },
            });
            const outcome = await scope.model.decide(step);
            scope.modelOutcome = outcome;
            if (!readAgentLoopModelOutcome(outcome)) reject();
            return outcome;
        },
        act: async (step: Parameters<AgentLoopCoordinatorPorts['act']>[0]) => {
            const scope = current(),
                record = assertCurrent(scope, step.actionRequest.expectedTaskRevision);
            if (
                scope.stage !== 'ACT' ||
                scope.actionOutcome ||
                !scope.model?.readDraft() ||
                step.decision.kind !== 'act' ||
                step.decision.actionContractRef !== AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT ||
                rpChildAnalysisDigest(step.decision) !==
                    rpChildAnalysisDigest(readAgentLoopModelOutcome(scope.modelOutcome)?.decision ?? null)
            )
                reject();
            const request: AgentLoopActionRequest = Object.freeze({
                ...step.actionRequest,
                taskContractRef: record.envelope.taskContractRef,
                taskKind: record.envelope.taskKind,
                authorityRevision: rpChildAnalysisDigest(scope.data.binding),
            });
            const action = createRpCharacterAction({
                sourceAdapter: scope.data.source,
                binding: scope.data.binding,
                sourceRef: scope.data.sourceRef,
                readDraft: () => scope.model!.readDraft(),
                clock: () => Date.parse(clock()),
            });
            const persistence = createAgentLoopRpCharacterActionPersistence({ store: scope.store, ownerId, request });
            const gateway = new AgentLoopActionGateway({
                ...persistence,
                clock,
                contracts: {
                    resolve: (input) =>
                        input.taskKind === RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind &&
                        input.taskContractRef === RP_CHILD_ANALYSIS_TASK_CONTRACT.ref
                            ? { actionContractRefs: [AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT] }
                            : null,
                },
                policy: {
                    evaluate: () => {
                        assertCurrent(scope);
                        return { decision: 'allow', reasonCodes: [], contentMode: 'nsf' };
                    },
                },
                approvals: { find: () => null },
                execute: async (input) => {
                    assertCurrent(scope);
                    return action.execute(input);
                },
            });
            const result = await gateway.run(request, { toolCalls: 1, wallMs: 0 });
            if (result.status !== 'executed') reject();
            const receipt = scope.store.readActionReceipt({ taskId: request.taskId, actionId: request.actionId });
            if (!receipt?.result || receipt.status !== 'completed' || !receipt.settledAt) reject();
            const artifactBundle = action.readArtifactBundle(request, receipt.result);
            const outcome = createAgentLoopActionOutcome({
                actionRequest: step.actionRequest,
                clock,
                artifactBundle,
                result: {
                    sourceKind: receipt.result.sourceKind,
                    sourceRef: receipt.result.sourceRef,
                    payloadDigest: receipt.result.payloadDigest,
                    completeness: receipt.result.completeness,
                    evidenceRefs: receipt.result.evidenceRefs,
                    usageDelta: receipt.result.usage,
                },
            });
            scope.actionOutcome = outcome;
            return outcome;
        },
        verify: async (step: Parameters<AgentLoopCoordinatorPorts['verify']>[0]) => {
            const scope = current();
            assertCurrent(scope, step.revision);
            scope.verification ??= createRpCharacterVerification({
                store: scope.store,
                sourceAdapter: scope.data.source,
                binding: scope.data.binding,
                sourceRef: scope.data.sourceRef,
                ownerId,
                clock,
            });
            scope.verification.read(step.revision);
            return Object.freeze({ disposition: 'passed' as const, reasonCodes: Object.freeze([]) });
        },
        completion: Object.freeze({
            request(
                input: Parameters<NonNullable<NonNullable<AgentLoopCoordinatorPorts['completion']>['request']>>[0],
            ) {
                const scope = current();
                assertCurrent(scope, input.record.revision);
                if (scope.stage !== 'OBSERVE' || !scope.actionOutcome || scope.completionRequest) reject();
                const request = issueAgentLoopCompletionRequest({
                    ...input,
                    store: scope.store,
                    assertSourceCurrent: () => sourceCurrentAtCommit(scope),
                });
                scope.completionRequest = request;
                return request;
            },
            commitRequested(
                input: Parameters<
                    NonNullable<NonNullable<AgentLoopCoordinatorPorts['completion']>['commitRequested']>
                >[0],
            ) {
                const scope = current();
                if (input.request !== scope.completionRequest) reject();
                const result = consumeAgentLoopCompletionRequest(input.request, {
                    store: scope.store,
                    record: input.record,
                    ownerId: input.ownerId,
                    actionWatermark: input.actionWatermark,
                });
                scope.revision = result.revision;
                scope.stage = result.envelope.phase;
                return result;
            },
            async evaluate(input: Parameters<NonNullable<AgentLoopCoordinatorPorts['completion']>['evaluate']>[0]) {
                const scope = current();
                const record = assertCurrent(scope, input.revision),
                    verification = scope.verification;
                if (!verification || scope.evaluation || scope.stage !== 'VERIFY') reject();
                const candidate = scope.store.freezeCompletionCandidate({
                    taskId: record.envelope.taskId,
                    expectedRevision: record.revision,
                    ownerId,
                });
                const evaluation = await prepareFrozenAgentLoopCompletion({
                    store: scope.store,
                    ownerId,
                    taskId: record.envelope.taskId,
                    candidateRef: candidate.candidateRef,
                    expectedRevision: record.revision,
                    registry: verification.registry,
                    runners: verification.runners,
                    contractBinding: {
                        taskKind: RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind,
                        taskContractRef: RP_CHILD_ANALYSIS_TASK_CONTRACT.ref,
                        contractRevision: RP_CHILD_ANALYSIS_TASK_CONTRACT.version,
                    },
                    repairAttempts: 0,
                    maxRepairAttempts: 0,
                    clock,
                    signal: scope.data.signal,
                    assertSourceCurrent: (value) => {
                        assertCurrent(scope);
                        verification.assertSourceCurrent(value);
                    },
                    assertSourceCurrentAtCommit: (value) => {
                        current();
                        verification.assertSourceCurrentAtCommit(value);
                    },
                });
                scope.evaluation = evaluation;
                return evaluation;
            },
            commitVerified(
                input: Parameters<
                    NonNullable<NonNullable<AgentLoopCoordinatorPorts['completion']>['commitVerified']>
                >[0],
            ) {
                const scope = current();
                if (input.evaluation !== scope.evaluation) reject();
                const result = commitFrozenAgentLoopCompletion(input.evaluation, {
                    store: scope.store,
                    record: input.record,
                    ownerId: input.ownerId,
                });
                scope.revision = result.revision;
                return result;
            },
        }),
    });

    return Object.freeze({
        owns: () => local.getStore() !== undefined,
        ports,
        allowsHook: (taskId: unknown, revision: unknown) => {
            try {
                const scope = current();
                return (
                    taskId === scope.data.binding.childTaskId && revision === scope.revision && !!assertCurrent(scope)
                );
            } catch {
                return false;
            }
        },
        bind(
            runtime: object,
            step: (taskId: string) => Promise<AgentLoopStepResult>,
            forget: (taskId: string) => void,
        ) {
            const port = Object.freeze({
                delegate(input: RpDelegationCreationInput) {
                    if (!config.delegation || options.closed()) reject();
                    return reserveRpDelegatedChild({ store, ownerId, clock, host: config.delegation, closed: options.closed }, input);
                },
                execute(context: AgentLoopRpReadonlyExecutionContext): Promise<AgentLoopRpReadonlyExecutionResult> {
                    const data = CONTEXTS.get(context);
                    CONTEXTS.delete(context);
                    if (
                        !data ||
                        data.store !== store ||
                        data.ownerId !== ownerId ||
                        options.closed() ||
                        data.signal.aborted ||
                        active.has(data.binding.childTaskId)
                    )
                        return Promise.reject(new Error('agent-loop-rp-readonly-execution-denied'));
                    const snapshot = store.readDagBudget(data.binding.parentTaskId);
                    const entry = snapshot.allocations.find(
                        (item) => item.allocation.reservationId === data.reservationId,
                    );
                    if (!entry || entry.status !== 'reserved' || store.read(data.binding.childTaskId)?.revision !== 1)
                        reject();
                    const deadlineMs = Math.min(
                        Date.parse(snapshot.policy.deadlineAt),
                        Date.parse(entry.allocation.deadlineAt),
                        Date.parse(clock()) + entry.allocation.childEnvelope.budget.granted.wallMs,
                    );
                    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.parse(clock())) reject();
                    data.source.assertCurrent();
                    store.markDagChildDispatched({
                        taskId: data.binding.parentTaskId,
                        expectedRevision: snapshot.record.revision,
                        ownerId,
                        reservationId: data.reservationId,
                    });
                    let scope!: Scope;
                    const scopedStore = store.createDagLeafExecutionPort(() => {
                        if (local.getStore() !== scope || !scope.active) return null;
                        const root = store.read(data.binding.parentTaskId);
                        if (!root) return null;
                        return {
                            rootTaskId: data.binding.parentTaskId,
                            rootAttemptId: data.binding.parentAttemptId,
                            rootExpectedRevision: root.revision,
                            rootOwnerId: ownerId,
                            reservationId: data.reservationId,
                            childTaskId: data.binding.childTaskId,
                            childAttemptId: data.binding.childAttemptId,
                            childOwnerId: ownerId,
                        };
                    });
                    scope = { data, store: scopedStore, deadlineMs, active: true, stage: 'PREPARE', revision: 1 };
                    active.set(data.binding.childTaskId, scope);
                    const work = Promise.resolve()
                        .then(() =>
                            local.run(scope, () =>
                                withProviderWorkSettlement(async () => {
                                    const steps: AgentLoopStepResult[] = [];
                                    for (let index = 0; index < MAX_LEAF_STEPS; index++) {
                                        await new Promise<void>((resolve) => setImmediate(resolve));
                                        const record = store.read(data.binding.childTaskId);
                                        if (
                                            !record ||
                                            ['COMPLETED', 'FAILED', 'CANCELLED'].includes(record.envelope.state)
                                        )
                                            break;
                                        scope.stage = record.envelope.phase;
                                        scope.revision = record.revision;
                                        assertCurrent(scope);
                                        const result = await step(data.binding.childTaskId);
                                        steps.push(result);
                                        if (
                                            result.outcome === 'blocked' ||
                                            result.outcome === 'acted-uncertain' ||
                                            result.nextPhase === null
                                        )
                                            break;
                                    }
                                    const record = store.read(data.binding.childTaskId);
                                    if (!record) reject();
                                    let settled = false;
                                    if (record.envelope.state === 'COMPLETED') {
                                        const root = store.read(data.binding.parentTaskId);
                                        if (!root) reject();
                                        store.settleDagChild({
                                            taskId: data.binding.parentTaskId,
                                            expectedRevision: root.revision,
                                            ownerId,
                                            reservationId: data.reservationId,
                                            usage: record.envelope.budget.spent,
                                            settlementRef: `rp-settlement:${rpChildAnalysisDigest({
                                                binding: data.binding,
                                                envelopeDigest: record.envelopeDigest,
                                            }).slice(7)}`,
                                        });
                                        settled = true;
                                    }
                                    return Object.freeze({
                                        steps: Object.freeze(steps),
                                        record: store.read(data.binding.childTaskId)!,
                                        settled,
                                    });
                                }),
                            ),
                        )
                        .finally(() => {
                            scope.active = false;
                            revokeAgentLoopCompletionRequest(scope.completionRequest);
                            revokeFrozenAgentLoopCompletion(scope.evaluation);
                            forget(data.binding.childTaskId);
                            active.delete(data.binding.childTaskId);
                        });
                    options.track(work);
                    return work;
                },
            });
            RUNTIME_PORTS.set(runtime, port);
        },
    });
}
