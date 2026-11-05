/** @author Codex @date 2026-10-26 @version 1.0
 * RP DelegationAdmission and its original Runtime's admission-before-reserve host. No dispatch or fallback.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
    AGENT_LOOP_TASK_BUDGET_KEYS,
    normalizeAgentLoopDecision,
    normalizeAgentLoopTaskEnvelope,
} from '@jiuguan/agent-loop-contract';
import { AgentLoopActionGateway, type AgentLoopDelegationRequest } from './agent-loop-action-gateway.ts';
import { AgentLoopProjectionStore, type AgentLoopDagBudgetSnapshot } from './agent-loop-projection-store.ts';
import { normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import { normalizeRpChildAnalysisBinding, rpChildAnalysisDigest,
    type RpChildAnalysisBindingV1 } from '../../packages/memory/public/rp-child-analysis.ts';
import { isRpAnalysisSourceAdapter, readRpAnalysisSourceBinding,
    type RpAnalysisSourceAdapter } from './agent-loop-rp-analysis-source.ts';
import {
    dagBudgetExact,
    dagBudgetInteger,
    dagBudgetTimestamp,
    dagBudgetToken,
    normalizeAgentLoopDagBudget,
    normalizeAgentLoopDagRootPolicy,
    agentLoopDagBudgetDigest,
    type AgentLoopDagBudgetVector,
} from './agent-loop-dag-budget.ts';
import {
    RP_SCENARIO_TEMPLATE_CATALOG,
    RP_CHILD_ANALYSIS_TASK_CONTRACT,
    RP_CHILD_ANALYSIS_VERIFIER_SET,
    resolveRpScenarioTemplate,
    isRpScenarioTemplateCatalog,
    type createRpScenarioTemplateCatalog,
} from './agent-loop-rp-scenario-template.ts';

export const RP_DELEGATION_ADMISSION_VERSION = 'rp-delegation-admission-v1' as const;
/** Synthetic cost units are a versioned admission heuristic, not measured latency or literary quality. */
export const RP_DELEGATION_HEURISTIC_POLICY = Object.freeze({
    version: 'rp-delegation-heuristic-policy-v1',
    minimumParentLoadUnits: 100,
    minimumAnalysisWorkUnits: 32,
    minimumNetBenefitUnits: 16,
} as const);
export const RP_DELEGATION_REASON_CODES = Object.freeze([
    'rp-delegation-input-invalid',
    'rp-delegation-host-unavailable',
    'rp-delegation-snapshot-stale',
    'rp-delegation-parent-unavailable',
    'rp-delegation-template-unavailable',
    'rp-delegation-contract-denied',
    'rp-delegation-authority-denied',
    'rp-delegation-partition-denied',
    'rp-delegation-source-unavailable',
    'rp-delegation-depth-exceeded',
    'rp-delegation-concurrency-exhausted',
    'rp-delegation-child-limit-exhausted',
    'rp-delegation-budget-insufficient',
    'rp-delegation-verification-reserve-insufficient',
    'rp-delegation-deadline-exceeded',
    'rp-delegation-not-isolatable',
    'rp-delegation-simple-task',
    'rp-delegation-benefit-insufficient',
] as const);
export type RpDelegationReasonCode = (typeof RP_DELEGATION_REASON_CODES)[number];
type Catalog = ReturnType<typeof createRpScenarioTemplateCatalog>;

export interface RpDelegationCostMetrics {
    readonly version: 'rp-delegation-cost-metrics-v1';
    readonly sourceRef: string;
    readonly sourceRevision: string;
    readonly parentTaskRevision: number;
    readonly isolatable: boolean;
    readonly sharedMutableState: boolean;
    readonly parentLoadUnits: number;
    readonly analysisWorkUnits: number;
    readonly contextIsolationBenefitUnits: number;
    readonly capabilityIsolationBenefitUnits: number;
    readonly parallelWorkUnits: number;
    readonly creationCostUnits: number;
    readonly communicationCostUnits: number;
    readonly mergeCostUnits: number;
    readonly parentProviderPoolRef: string | null;
    readonly childProviderPoolRef: string | null;
    readonly independentPoolCapacity: boolean;
}

export interface RpDelegationCreationHost {
    readonly readHostContext: (request: AgentLoopDelegationRequest, snapshot: AgentLoopDagBudgetSnapshot,
        observedAt: string) => RpDelegationHostContext | null;
    readonly catalog?: Catalog;
}

export interface RpDelegationCreationInput {
    readonly request: AgentLoopDelegationRequest;
    readonly binding: RpChildAnalysisBindingV1;
    readonly source: RpAnalysisSourceAdapter;
    readonly sourceRef: string;
    readonly signal: AbortSignal;
}

/** Called only by the configured RP Runtime host. Creation grants no Model/Action execution authority. */
export function reserveRpDelegatedChild(options: Readonly<{
    store: AgentLoopProjectionStore; ownerId: string; clock: () => string;
    host: RpDelegationCreationHost; closed: () => boolean;
}>, input: RpDelegationCreationInput): AgentLoopDagBudgetSnapshot {
    normalizeAgentLoopActionObject(input, ['request', 'binding', 'source', 'sourceRef', 'signal']);
    const proposal = request(input.request), binding = normalizeRpChildAnalysisBinding(data(input.binding));
    const { store, ownerId, clock, host } = options;
    const denied = (): never => { throw new Error('rp-delegation-input-invalid'); };
    if (!(store instanceof AgentLoopProjectionStore) || !isRpAnalysisSourceAdapter(input.source)
        || rpChildAnalysisDigest(readRpAnalysisSourceBinding(input.source)) !== rpChildAnalysisDigest(binding)
        || !(input.signal instanceof AbortSignal) || typeof input.sourceRef !== 'string'
        || !/^rp-character:sha256:[a-f0-9]{64}$/u.test(input.sourceRef)
        || binding.parentTaskId !== proposal.parentTaskId || binding.parentAttemptId !== proposal.decision!.attemptId
        || typeof host.readHostContext !== 'function' || types.isProxy(host.readHostContext)) denied();
    const assertSource = () => {
        if (options.closed() || input.signal.aborted) denied();
        input.source.assertCurrent();
        if (input.source.readCharacter(input.sourceRef).status !== 'found'
            || options.closed() || input.signal.aborted) throw new Error('rp-delegation-source-unavailable');
    };
    assertSource();
    const readHost = (snapshot: AgentLoopDagBudgetSnapshot) => {
        const observedAt = dagBudgetTimestamp(clock());
        const value = context(data(host.readHostContext(proposal, snapshot, observedAt)));
        if (value.observedAt !== observedAt) throw new Error('rp-delegation-snapshot-stale');
        return value;
    };
    let cut = store.readDagBudget(proposal.parentTaskId);
    let selected = readHost(cut);
    const stableHost = (value: RpDelegationHostContext) => {
        const { observedAt: ignored, ...rest } = value;
        void ignored;
        return digest(rest);
    };
    const pinnedHost = stableHost(selected);
    if (selected.ownerId !== ownerId || selected.childTaskId !== binding.childTaskId
        || selected.parentAttemptId !== binding.parentAttemptId || selected.templateId !== binding.templateId
        || selected.templateVersion !== binding.templateVersion || selected.templateDigest !== binding.templateDigest
        || selected.contentMode !== binding.contentMode || selected.grant.modelCalls !== 1 || selected.grant.toolCalls !== 1) denied();
    const admission = createRpDelegationAdmissionPort({ clock: () => selected.observedAt,
        readDagBudget: () => cut, readHostContext: () => selected, ...(host.catalog ? { catalog: host.catalog } : {}) });
    const gateway = new AgentLoopActionGateway({
        clock, readTaskRevision: () => cut.record.revision,
        contracts: { resolve: () => null }, policy: { evaluate: () => ({ decision: 'deny', reasonCodes: [] }) },
        approvals: { find: () => null }, budget: { reserve: denied, settle: denied, release: denied },
        receipts: { read: () => null, markStarted: denied, writeCompleted: denied },
        reconcile: { readback: () => ({ verdict: 'unknown' }) }, execute: async () => denied(), delegation: admission,
    });
    const admit = () => {
        const verdict = gateway.admitDelegation(proposal);
        if (!verdict.admitted) throw new Error(verdict.reasonCode ?? 'rp-delegation-input-invalid');
        assertSource();
    };
    admit();
    const template = resolveRpScenarioTemplate(host.catalog ?? RP_SCENARIO_TEMPLATE_CATALOG,
        selected.templateId, selected.templateVersion, selected.templateDigest);
    const zero = Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map(key => [key, 0]));
    const childEnvelope = normalizeAgentLoopTaskEnvelope({
        contractVersion: 'agent-loop-task-envelope-v1', taskId: selected.childTaskId,
        rootTaskId: proposal.parentTaskId, parentTaskId: proposal.parentTaskId, dependencyTaskIds: [],
        taskKind: RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind, taskContractRef: RP_CHILD_ANALYSIS_TASK_CONTRACT.ref,
        state: 'CREATED', phase: 'PREPARE', goal: { summary: proposal.objective, sourceRefs: [input.sourceRef] },
        todos: [], confirmedFacts: [], blockers: [], children: [], artifacts: [],
        budget: { policyRef: selected.budgetPolicyRef, granted: selected.grant, reserved: zero, spent: zero },
        verifier: { verifierSetRef: RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRef,
            verifierSetRevision: RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRevision },
        revision: 1, createdAt: selected.observedAt, updatedAt: selected.observedAt,
    });
    return store.reserveDagChild({ taskId: proposal.parentTaskId, ownerId,
        expectedRevision: proposal.decision!.expectedTaskRevision, reservationId: selected.reservationId,
        childEnvelope, requirement: selected.childRequirement, deadlineAt: selected.deadlineAt,
        profile: template.executionProfileSnapshot.leafPolicy,
    }, snapshot => {
        cut = snapshot;
        selected = readHost(snapshot);
        if (stableHost(selected) !== pinnedHost) throw new Error('rp-delegation-snapshot-stale');
        admit();
    });
}

/** Host-owned current authority/contract/source cut; never accepted from a model request. */
export interface RpDelegationHostContext {
    readonly version: 'rp-delegation-host-context-v1';
    readonly observedAt: string;
    readonly ownerId: string;
    readonly parentTaskRevision: number;
    readonly parentAttemptId: string;
    readonly parentContractRef: string;
    readonly parentContractRevision: string;
    readonly delegationAllowed: boolean;
    readonly inlineFallbackAllowed: boolean;
    readonly inlineCapabilityAllowed: boolean;
    readonly childRequirement: 'required' | 'optional';
    readonly fallbackDeclared: boolean;
    readonly reservationId: string;
    readonly childTaskId: string;
    readonly budgetPolicyRef: string;
    readonly deadlineAt: string;
    readonly grant: AgentLoopDagBudgetVector;
    readonly verificationReserve: AgentLoopDagBudgetVector;
    readonly authorityRevision: string;
    readonly authorities: readonly string[];
    readonly contentMode: 'nsf' | 'nsfw';
    readonly sourceContentModes: readonly string[];
    readonly sourceState: 'current' | 'missing' | 'stale' | 'forbidden' | 'unknown';
    readonly templateId: string;
    readonly templateVersion: string;
    readonly templateDigest: string;
    readonly catalogRevision: string;
    readonly metrics: RpDelegationCostMetrics;
}

export interface RpDelegationCostBenefit {
    readonly metricsVersion: 'rp-delegation-cost-metrics-v1';
    readonly metricsSourceRef: string;
    readonly metricsSourceRevision: string;
    readonly contextIsolationBenefitUnits: number;
    readonly capabilityIsolationBenefitUnits: number;
    readonly effectiveParallelBenefitUnits: number;
    readonly creationCostUnits: number;
    readonly communicationCostUnits: number;
    readonly mergeCostUnits: number;
    readonly netBenefitUnits: number;
    readonly minimumNetBenefitUnits: 16;
    readonly heuristicOnly: true;
}

export interface RpDelegationAdmissionAssessment {
    readonly version: typeof RP_DELEGATION_ADMISSION_VERSION;
    readonly admitted: boolean;
    readonly reasonCode: RpDelegationReasonCode | null;
    readonly inlineFallbackAllowed: boolean;
    readonly inputDigest: string | null;
    readonly assessmentDigest: string;
    readonly costBenefit: RpDelegationCostBenefit | null;
    readonly executionAuthorized: false;
    readonly budgetReserved: false;
}

export interface RpDelegationAdmissionOptions {
    readonly clock: () => string;
    readonly readDagBudget: (parentTaskId: string) => AgentLoopDagBudgetSnapshot | null;
    readonly readHostContext: (request: AgentLoopDelegationRequest) => RpDelegationHostContext | null;
    readonly catalog?: Catalog;
}

function digest(input: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function data(input: unknown, depth = 0, counter = { nodes: 0 }): unknown {
    if (++counter.nodes > 131_072 || depth > 24 || types.isProxy(input)) throw new Error('rp-admission-data-invalid');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string' && input.length <= 131_072) return input;
    if (typeof input === 'number' && Number.isSafeInteger(input)) return input;
    if (!input || typeof input !== 'object') throw new Error('rp-admission-data-invalid');
    if (Array.isArray(input)) {
        const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (!Number.isSafeInteger(length) || length > 512 || Reflect.ownKeys(input).length !== length + 1)
            throw new Error('rp-admission-data-invalid');
        return Object.freeze(
            Array.from({ length }, (_, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
                    throw new Error('rp-admission-data-invalid');
                return data(descriptor.value, depth + 1, counter);
            }),
        );
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('rp-admission-data-invalid');
    const keys = Reflect.ownKeys(input);
    if (keys.length > 64) throw new Error('rp-admission-data-invalid');
    return Object.freeze(
        Object.fromEntries(
            keys
                .sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
                .map((key) => {
                    const descriptor = Object.getOwnPropertyDescriptor(input, key);
                    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
                        throw new Error('rp-admission-data-invalid');
                    }
                    return [key, data(descriptor.value, depth + 1, counter)];
                }),
        ),
    );
}

function boolean(input: unknown): boolean {
    if (typeof input !== 'boolean') throw new Error('rp-admission-boolean-invalid');
    return input;
}

function tokens(input: unknown): readonly string[] {
    if (!Array.isArray(input) || input.length > 32) throw new Error('rp-admission-tokens-invalid');
    const values = input.map(dagBudgetToken);
    if (new Set(values).size !== values.length) throw new Error('rp-admission-tokens-invalid');
    return Object.freeze(values);
}

function metrics(input: unknown): RpDelegationCostMetrics {
    const value = dagBudgetExact(input, [
        'version',
        'sourceRef',
        'sourceRevision',
        'parentTaskRevision',
        'isolatable',
        'sharedMutableState',
        'parentLoadUnits',
        'analysisWorkUnits',
        'contextIsolationBenefitUnits',
        'capabilityIsolationBenefitUnits',
        'parallelWorkUnits',
        'creationCostUnits',
        'communicationCostUnits',
        'mergeCostUnits',
        'parentProviderPoolRef',
        'childProviderPoolRef',
        'independentPoolCapacity',
    ]);
    if (value.version !== 'rp-delegation-cost-metrics-v1') throw new Error('rp-admission-metrics-version-invalid');
    const result = { ...value };
    for (const key of [
        'parentTaskRevision',
        'parentLoadUnits',
        'analysisWorkUnits',
        'contextIsolationBenefitUnits',
        'capabilityIsolationBenefitUnits',
        'parallelWorkUnits',
        'creationCostUnits',
        'communicationCostUnits',
        'mergeCostUnits',
    ])
        result[key] = dagBudgetInteger(value[key], key === 'parentTaskRevision' ? 1 : 0, 1_000_000_000);
    for (const key of ['sourceRef', 'sourceRevision']) result[key] = dagBudgetToken(value[key]);
    for (const key of ['isolatable', 'sharedMutableState', 'independentPoolCapacity'])
        result[key] = boolean(value[key]);
    for (const key of ['parentProviderPoolRef', 'childProviderPoolRef']) {
        result[key] = value[key] === null ? null : dagBudgetToken(value[key]);
    }
    return Object.freeze(result) as unknown as RpDelegationCostMetrics;
}

function context(input: unknown): RpDelegationHostContext {
    const value = dagBudgetExact(input, [
        'version',
        'observedAt',
        'ownerId',
        'parentTaskRevision',
        'parentAttemptId',
        'parentContractRef',
        'parentContractRevision',
        'delegationAllowed',
        'inlineFallbackAllowed',
        'inlineCapabilityAllowed',
        'childRequirement',
        'fallbackDeclared',
        'reservationId',
        'childTaskId',
        'budgetPolicyRef',
        'deadlineAt',
        'grant',
        'verificationReserve',
        'authorityRevision',
        'authorities',
        'contentMode',
        'sourceContentModes',
        'sourceState',
        'templateId',
        'templateVersion',
        'templateDigest',
        'catalogRevision',
        'metrics',
    ]);
    if (
        value.version !== 'rp-delegation-host-context-v1' ||
        !['required', 'optional'].includes(String(value.childRequirement)) ||
        !['nsf', 'nsfw'].includes(String(value.contentMode)) ||
        !['current', 'missing', 'stale', 'forbidden', 'unknown'].includes(String(value.sourceState))
    ) {
        throw new Error('rp-admission-context-invalid');
    }
    const result = { ...value };
    for (const key of [
        'ownerId',
        'parentAttemptId',
        'parentContractRef',
        'parentContractRevision',
        'reservationId',
        'childTaskId',
        'budgetPolicyRef',
        'authorityRevision',
        'templateId',
        'templateVersion',
        'templateDigest',
        'catalogRevision',
    ])
        result[key] = dagBudgetToken(value[key]);
    for (const key of ['delegationAllowed', 'inlineFallbackAllowed', 'inlineCapabilityAllowed', 'fallbackDeclared']) {
        result[key] = boolean(value[key]);
    }
    result.parentTaskRevision = dagBudgetInteger(value.parentTaskRevision, 1);
    result.observedAt = dagBudgetTimestamp(value.observedAt);
    result.deadlineAt = dagBudgetTimestamp(value.deadlineAt);
    result.grant = normalizeAgentLoopDagBudget(value.grant);
    result.verificationReserve = normalizeAgentLoopDagBudget(value.verificationReserve);
    result.authorities = tokens(value.authorities);
    result.sourceContentModes = tokens(value.sourceContentModes);
    result.metrics = metrics(value.metrics);
    return Object.freeze(result) as unknown as RpDelegationHostContext;
}

function request(input: unknown): AgentLoopDelegationRequest {
    const value = dagBudgetExact(data(input), [
        'parentTaskId',
        'childTaskContractRef',
        'objective',
        'depth',
        'activeChildren',
        'decision',
    ]);
    const decision = normalizeAgentLoopDecision(value.decision);
    if (
        decision.kind !== 'delegate' ||
        decision.taskId !== value.parentTaskId ||
        decision.childTaskContractRef !== value.childTaskContractRef ||
        decision.objective !== value.objective
    ) {
        throw new Error('rp-admission-decision-invalid');
    }
    return Object.freeze({
        parentTaskId: dagBudgetToken(value.parentTaskId),
        childTaskContractRef: dagBudgetToken(value.childTaskContractRef),
        objective: decision.objective,
        depth: dagBudgetInteger(value.depth, 1),
        activeChildren: dagBudgetInteger(value.activeChildren),
        decision,
    });
}

function assessment(
    reasonCode: RpDelegationReasonCode | null,
    inputDigest: string | null = null,
    costBenefit: RpDelegationCostBenefit | null = null,
    inlineFallbackAllowed = false,
): RpDelegationAdmissionAssessment {
    const result = Object.freeze({
        version: RP_DELEGATION_ADMISSION_VERSION,
        admitted: reasonCode === null,
        reasonCode,
        inlineFallbackAllowed,
        inputDigest,
        costBenefit,
        executionAuthorized: false as const,
        budgetReserved: false as const,
    });
    return Object.freeze({ ...result, assessmentDigest: digest(result) });
}

function costBenefit(value: RpDelegationCostMetrics): RpDelegationCostBenefit {
    const parallel =
        value.independentPoolCapacity &&
        value.parentProviderPoolRef !== null &&
        value.childProviderPoolRef !== null &&
        value.parentProviderPoolRef !== value.childProviderPoolRef
            ? Math.min(value.parallelWorkUnits, value.analysisWorkUnits)
            : 0;
    const totalCost = value.creationCostUnits + value.communicationCostUnits + value.mergeCostUnits;
    return Object.freeze({
        metricsVersion: value.version,
        metricsSourceRef: value.sourceRef,
        metricsSourceRevision: value.sourceRevision,
        contextIsolationBenefitUnits: value.contextIsolationBenefitUnits,
        capabilityIsolationBenefitUnits: value.capabilityIsolationBenefitUnits,
        effectiveParallelBenefitUnits: parallel,
        creationCostUnits: value.creationCostUnits,
        communicationCostUnits: value.communicationCostUnits,
        mergeCostUnits: value.mergeCostUnits,
        netBenefitUnits:
            value.contextIsolationBenefitUnits + value.capabilityIsolationBenefitUnits + parallel - totalCost,
        minimumNetBenefitUnits: RP_DELEGATION_HEURISTIC_POLICY.minimumNetBenefitUnits,
        heuristicOnly: true,
    });
}

function evaluate(
    proposal: AgentLoopDelegationRequest,
    root: AgentLoopDagBudgetSnapshot,
    host: RpDelegationHostContext,
    catalog: Catalog,
): RpDelegationAdmissionAssessment {
    const inputDigest = digest({
        version: RP_DELEGATION_ADMISSION_VERSION,
        proposal,
        root,
        host,
        catalogRevision: catalog.catalogRevision,
        heuristicPolicy: RP_DELEGATION_HEURISTIC_POLICY,
    });
    const deny = (reason: RpDelegationReasonCode) => assessment(reason, inputDigest);
    const envelope = normalizeAgentLoopTaskEnvelope(root.record.envelope);
    const policy = normalizeAgentLoopDagRootPolicy(root.policy);
    if (
        root.rootTaskId !== proposal.parentTaskId ||
        envelope.taskId !== proposal.parentTaskId ||
        envelope.rootTaskId !== proposal.parentTaskId ||
        root.record.revision !== envelope.revision ||
        agentLoopDagBudgetDigest(envelope) !== root.record.envelopeDigest ||
        proposal.decision!.expectedTaskRevision !== envelope.revision ||
        proposal.decision!.attemptId !== envelope.currentAttemptId ||
        host.parentTaskRevision !== envelope.revision ||
        host.parentAttemptId !== envelope.currentAttemptId ||
        host.metrics.parentTaskRevision !== envelope.revision ||
        envelope.updatedAt > host.observedAt
    ) {
        return deny('rp-delegation-snapshot-stale');
    }
    if (
        root.state !== 'active' ||
        root.record.fenced ||
        envelope.state !== 'RUNNING' ||
        !['PREPARE', 'ACT'].includes(envelope.phase) ||
        root.record.ownerId !== host.ownerId ||
        !root.record.leaseExpiresAt ||
        root.record.leaseExpiresAt <= host.observedAt
    ) {
        return deny('rp-delegation-parent-unavailable');
    }
    if (envelope.parentTaskId !== undefined || proposal.depth !== 1 || policy.maxDepth !== 1) {
        return deny('rp-delegation-depth-exceeded');
    }
    const active = root.allocations.filter((item) => item.status === 'reserved' || item.status === 'dispatched').length;
    if (proposal.activeChildren !== active) return deny('rp-delegation-snapshot-stale');
    if (active >= policy.maxConcurrentChildren) return deny('rp-delegation-concurrency-exhausted');
    if (
        root.allocations.length >= policy.maxTotalChildren ||
        root.allocations.some(
            (item) =>
                item.allocation.reservationId === host.reservationId ||
                item.allocation.childEnvelope.taskId === host.childTaskId,
        )
    ) {
        return deny('rp-delegation-child-limit-exhausted');
    }
    if (
        host.observedAt >= policy.deadlineAt ||
        host.observedAt >= host.deadlineAt ||
        host.deadlineAt > policy.deadlineAt ||
        host.grant.wallMs > Date.parse(host.deadlineAt) - Date.parse(host.observedAt)
    ) {
        return deny('rp-delegation-deadline-exceeded');
    }
    let template;
    try {
        if (host.catalogRevision !== catalog.catalogRevision) return deny('rp-delegation-template-unavailable');
        template = resolveRpScenarioTemplate(catalog, host.templateId, host.templateVersion, host.templateDigest);
    } catch {
        return deny('rp-delegation-template-unavailable');
    }
    if (
        !host.delegationAllowed ||
        host.parentContractRef !== envelope.taskContractRef ||
        proposal.decision!.taskContractRef !== envelope.taskContractRef ||
        proposal.childTaskContractRef !== template.taskContract.ref ||
        proposal.decision!.taskKind !== RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind ||
        host.budgetPolicyRef !== envelope.budget.policyRef ||
        host.childTaskId === envelope.taskId ||
        JSON.stringify(policy.leafProfile) !== JSON.stringify(template.executionProfileSnapshot.leafPolicy)
    ) {
        return deny('rp-delegation-contract-denied');
    }
    if (
        host.contentMode !== template.contextPolicy.contentMode ||
        host.sourceContentModes.length < 1 ||
        host.sourceContentModes.some((mode) => mode !== host.contentMode)
    )
        return deny('rp-delegation-partition-denied');
    if (host.sourceState !== 'current') return deny('rp-delegation-source-unavailable');
    if (template.requiresAuthorities.some((authority) => !host.authorities.includes(authority))) {
        return deny('rp-delegation-authority-denied');
    }
    const grant = host.grant,
        verification = host.verificationReserve;
    if (
        grant.writes !== 0 ||
        grant.highRiskActions !== 0 ||
        grant.childTasks !== 0 ||
        verification.writes !== 0 ||
        verification.highRiskActions !== 0 ||
        verification.childTasks !== 0
    ) {
        return deny('rp-delegation-authority-denied');
    }
    const budget = envelope.budget;
    const available = (key: keyof AgentLoopDagBudgetVector) =>
        budget.granted[key] - budget.spent[key] - budget.reserved[key];
    if (
        available('childTasks') < 1 ||
        grant.modelCalls < 1 ||
        grant.inputTokens < 1 ||
        grant.outputTokens < 1 ||
        AGENT_LOOP_TASK_BUDGET_KEYS.some((key) => grant[key] > available(key))
    ) {
        return deny('rp-delegation-budget-insufficient');
    }
    if (
        verification.toolCalls < 1 ||
        verification.wallMs < 1 ||
        AGENT_LOOP_TASK_BUDGET_KEYS.some((key) => verification[key] > grant[key])
    ) {
        return deny('rp-delegation-verification-reserve-insufficient');
    }
    const benefit = costBenefit(host.metrics);
    let reason: RpDelegationReasonCode | null = null;
    if (!host.metrics.isolatable || host.metrics.sharedMutableState) reason = 'rp-delegation-not-isolatable';
    else if (
        host.metrics.parentLoadUnits < RP_DELEGATION_HEURISTIC_POLICY.minimumParentLoadUnits ||
        host.metrics.analysisWorkUnits < RP_DELEGATION_HEURISTIC_POLICY.minimumAnalysisWorkUnits
    )
        reason = 'rp-delegation-simple-task';
    else if (benefit.netBenefitUnits < benefit.minimumNetBenefitUnits) reason = 'rp-delegation-benefit-insufficient';
    const fallback =
        reason !== null &&
        host.inlineFallbackAllowed &&
        host.inlineCapabilityAllowed &&
        host.childRequirement === 'optional' &&
        host.fallbackDeclared;
    return assessment(reason, inputDigest, benefit, fallback);
}

/** Pure assessment on one frozen host cut. Any later creation must recheck original Store CAS/lease/fence. */
export function createRpDelegationAdmissionPort(options: RpDelegationAdmissionOptions) {
    if (
        !options ||
        typeof options !== 'object' ||
        types.isProxy(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
        throw new Error('rp-delegation-options-invalid');
    const keys = Reflect.ownKeys(options);
    if (
        keys.some(
            (key) =>
                typeof key !== 'string' ||
                !['clock', 'readDagBudget', 'readHostContext', 'catalog'].includes(key) ||
                !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key) ?? {}, 'value'),
        )
    ) {
        throw new Error('rp-delegation-options-invalid');
    }
    const readBudget = Object.getOwnPropertyDescriptor(options, 'readDagBudget')?.value;
    const readContext = Object.getOwnPropertyDescriptor(options, 'readHostContext')?.value;
    const clock = Object.getOwnPropertyDescriptor(options, 'clock')?.value;
    const catalog: Catalog = Object.getOwnPropertyDescriptor(options, 'catalog')?.value ?? RP_SCENARIO_TEMPLATE_CATALOG;
    if (
        [clock, readBudget, readContext].some((value) => typeof value !== 'function' || types.isProxy(value)) ||
        !isRpScenarioTemplateCatalog(catalog)
    )
        throw new Error('rp-delegation-options-invalid');
    const assess = (input: AgentLoopDelegationRequest): RpDelegationAdmissionAssessment => {
        let proposal: AgentLoopDelegationRequest;
        try {
            proposal = request(input);
        } catch {
            return assessment('rp-delegation-input-invalid');
        }
        try {
            const observedAt = dagBudgetTimestamp(clock());
            const host = context(data(readContext(proposal)));
            if (host.observedAt !== observedAt) return assessment('rp-delegation-snapshot-stale');
            const root = data(readBudget(proposal.parentTaskId)) as AgentLoopDagBudgetSnapshot | null;
            if (!root) return assessment('rp-delegation-host-unavailable');
            return evaluate(proposal, root, host, catalog);
        } catch {
            return assessment('rp-delegation-host-unavailable');
        }
    };
    return Object.freeze({
        assess,
        admit(
            input: AgentLoopDelegationRequest,
        ): Readonly<{ admitted: true }> | Readonly<{ admitted: false; reasonCode: RpDelegationReasonCode }> {
            const result = assess(input);
            return result.admitted
                ? Object.freeze({ admitted: true })
                : Object.freeze({ admitted: false, reasonCode: result.reasonCode! });
        },
    });
}
