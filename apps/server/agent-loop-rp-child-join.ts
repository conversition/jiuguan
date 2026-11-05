/** @author Codex @date 2026-10-26 @version 1.0
 * Original Core child-result exchange and bounded parent Query Prepare. No parent MODEL or new Runner.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { types as nodeTypes } from 'node:util';
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
import { createRpChildResultEvidenceReader, type RpChildResultEvidenceV1 } from './agent-loop-rp-child-result.ts';
import { AgentLoopProjectionStore, type AgentLoopTaskRecord } from './agent-loop-projection-store.ts';
import type {
    AgentLoopCoordinator,
    AgentLoopCoordinatorPorts,
    AgentLoopChildWaitRequest,
    AgentLoopChildReconcileResult,
    AgentLoopStepResult,
} from './agent-loop-coordinator.ts';
import { normalizeAgentLoopActionObject } from './agent-loop-action-receipt.ts';
import { buildActiveContextSnapshot, resolveAgentLoopContinuation } from './agent-loop-continuation.ts';
import {
    compileRpQueryContext,
    normalizeRpQueryContextHostInput,
    type RpQueryContextHostInput,
    type RpQueryContextTrace,
} from '../../packages/prompt/public/rp-query-context.ts';
import {
    expandAgentLoopRpMaintenanceMemoryContext,
    isAgentLoopRpMaintenanceMemoryContext,
    matchesAgentLoopRpMaintenanceMemoryContext,
    readAgentLoopRpMaintenanceMemoryDescriptors,
    resolveAgentLoopRpMaintenanceMemoryContext,
    type AgentLoopRpMaintenanceMemoryContext,
} from './agent-loop-rp-maintenance-memory-context.ts';
import type { AgentLoopRefResolverRequest, AgentLoopRefState } from './agent-loop-continuation.ts';

export interface AgentLoopRpChildSource {
    readonly sourceAdapter: RpAnalysisSourceAdapter;
    readonly binding: RpChildAnalysisBindingV1;
    readonly sourceRef: string;
}

export interface AgentLoopRpChildJoinInput extends AgentLoopRpChildSource {
    /** Fresh, independently authorized sources for previously accepted siblings. */
    readonly additionalChildSources?: readonly AgentLoopRpChildSource[];
    readonly reservationId: string;
    readonly waitId: string;
    readonly signal: AbortSignal;
    readonly maxExpansionTokens: number;
    /** Host-frozen context only. Child results and authoritative task state cannot be supplied here. */
    readonly queryContext?: RpQueryContextHostInput;
    /** Optional private-branded, same parent/session P3 source. Refs publish only with an accepted join. */
    readonly maintenanceMemoryContext?: AgentLoopRpMaintenanceMemoryContext;
}

export const AGENT_LOOP_RP_MAINTENANCE_MEMORY_TRACE_VERSION =
    'agent-loop-rp-maintenance-memory-trace-v1' as const;

export interface AgentLoopRpMaintenanceMemoryTrace {
    readonly version: typeof AGENT_LOOP_RP_MAINTENANCE_MEMORY_TRACE_VERSION;
    readonly refs: readonly Readonly<{
        refId: string;
        kind: 'memory-fact' | 'rolling-summary';
        policy: 'required' | 'optional';
        status: AgentLoopRefState['status'];
        reasonCode: string | null;
        revision: string | null;
        digest: string | null;
        tokens: number;
        adopted: boolean;
    }>[];
    readonly traceDigest: string;
}

export interface AgentLoopRpParentPreparation {
    readonly artifactRef: string;
    readonly snapshotDigest: string;
    readonly continuationDigest: string;
    readonly resultDigest: string;
    readonly expandedTokens: number;
}

export interface AgentLoopRpChildJoinResult extends AgentLoopChildReconcileResult {
    readonly prepare: AgentLoopStepResult | null;
    readonly preparation: AgentLoopRpParentPreparation | null;
    /** Body-free compile diagnostics, including a blocked plan; not a Model execution grant. */
    readonly queryContext?: RpQueryContextTrace;
    /** Body-free P3 adoption/degradation diagnostics. */
    readonly maintenanceMemory?: AgentLoopRpMaintenanceMemoryTrace;
}

export interface AgentLoopRpChildJoinPort {
    wait(input: AgentLoopRpChildJoinInput): AgentLoopTaskRecord;
    reconcile(input: AgentLoopRpChildJoinInput): Promise<AgentLoopRpChildJoinResult>;
}

const PORTS = new WeakMap<object, AgentLoopRpChildJoinPort>();
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;

function denied(): never {
    throw new Error('agent-loop-rp-child-join-denied');
}

export function createAgentLoopRpChildJoinPort(runtime: object): AgentLoopRpChildJoinPort {
    return PORTS.get(runtime) ?? denied();
}

type Scope = {
    readonly input: AgentLoopRpChildJoinInput;
    readonly reader: ReturnType<typeof createRpChildResultEvidenceReader>;
    active: boolean;
    revision: number;
    stage: 'wait' | 'reconcile' | 'prepare' | 'prepared';
    proof?: RpChildResultEvidenceV1;
    childSources: readonly {
        input: AgentLoopRpChildSource;
        reader: ReturnType<typeof createRpChildResultEvidenceReader>;
        proof: RpChildResultEvidenceV1;
    }[];
    preparation: AgentLoopRpParentPreparation | null;
    queryContext?: RpQueryContextTrace;
    maintenanceMemory?: AgentLoopRpMaintenanceMemoryTrace;
    maintenanceAtCommit?: readonly AgentLoopRefResolverRequest[];
};

/** Installed only alongside the explicit RP readonly host. Its private scope never authorizes a Model or Action. */
export function createAgentLoopRpChildJoinRuntimeScope(
    options: Readonly<{
        store: AgentLoopProjectionStore;
        ownerId: string;
        clock: () => string;
        closed: () => boolean;
        track: (work: Promise<unknown>) => void;
    }>,
) {
    const { store, ownerId, clock } = options;
    const local = new AsyncLocalStorage<Scope>();
    const active = new Set<string>();

    function inputOf(value: AgentLoopRpChildJoinInput): AgentLoopRpChildJoinInput {
        normalizeAgentLoopActionObject(
            value,
            ['sourceAdapter', 'binding', 'sourceRef', 'reservationId', 'waitId', 'signal', 'maxExpansionTokens'],
            ['queryContext', 'maintenanceMemoryContext', 'additionalChildSources'],
        );
        const binding = normalizeRpChildAnalysisBinding(value.binding);
        if (
            !isRpAnalysisSourceAdapter(value.sourceAdapter) ||
            rpChildAnalysisDigest(readRpAnalysisSourceBinding(value.sourceAdapter)) !==
                rpChildAnalysisDigest(binding) ||
            typeof value.sourceRef !== 'string' ||
            typeof value.reservationId !== 'string' ||
            typeof value.waitId !== 'string' ||
            !/^rp-character:sha256:[a-f0-9]{64}$/u.test(value.sourceRef) ||
            !TOKEN.test(value.reservationId) ||
            !TOKEN.test(value.waitId) ||
            !(value.signal instanceof AbortSignal) ||
            !Number.isSafeInteger(value.maxExpansionTokens) ||
            value.maxExpansionTokens < 0 ||
            value.maxExpansionTokens > 32_768
        )
            denied();
        let additionalChildSources: readonly AgentLoopRpChildSource[] | undefined;
        if (Object.hasOwn(value, 'additionalChildSources')) {
            const sources = value.additionalChildSources;
            if (!Array.isArray(sources) || nodeTypes.isProxy(sources)
                || Object.getPrototypeOf(sources) !== Array.prototype || sources.length > 128
                || Reflect.ownKeys(sources).length !== sources.length + 1
                || !Array.from({ length: sources.length }, (_, index) =>
                    Object.getOwnPropertyDescriptor(sources, String(index)))
                    .every((descriptor) => descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) denied();
            const seen = new Set([binding.childTaskId]);
            additionalChildSources = Object.freeze(sources.map((source) => {
                normalizeAgentLoopActionObject(source, ['sourceAdapter', 'binding', 'sourceRef']);
                const sibling = normalizeRpChildAnalysisBinding(source.binding);
                if (!isRpAnalysisSourceAdapter(source.sourceAdapter)
                    || rpChildAnalysisDigest(readRpAnalysisSourceBinding(source.sourceAdapter)) !== rpChildAnalysisDigest(sibling)
                    || ['parentTaskId', 'parentAttemptId', 'sessionId', 'contentMode', 'historyEpoch', 'sourceRevision']
                        .some((key) => sibling[key as keyof typeof sibling] !== binding[key as keyof typeof binding])
                    || seen.has(sibling.childTaskId) || typeof source.sourceRef !== 'string'
                    || !/^rp-character:sha256:[a-f0-9]{64}$/u.test(source.sourceRef)) denied();
                seen.add(sibling.childTaskId);
                return Object.freeze({ sourceAdapter: source.sourceAdapter, binding: sibling, sourceRef: source.sourceRef });
            }));
        }
        const parent = store.read(binding.parentTaskId);
        const siblings = parent?.envelope.children.filter((child) =>
            child.joinState === 'accepted' && child.taskId !== binding.childTaskId) ?? [];
        if (siblings.length !== (additionalChildSources?.length ?? 0)
            || siblings.some((child) => !additionalChildSources?.some((source) =>
                source.binding.childTaskId === child.taskId))) denied();
        const queryContext = Object.hasOwn(value, 'queryContext')
            ? normalizeRpQueryContextHostInput(value.queryContext)
            : undefined;
        const maintenanceMemoryContext = Object.hasOwn(value, 'maintenanceMemoryContext')
            ? value.maintenanceMemoryContext
            : undefined;
        if (maintenanceMemoryContext !== undefined) {
            if (!queryContext || !isAgentLoopRpMaintenanceMemoryContext(maintenanceMemoryContext)
                || !matchesAgentLoopRpMaintenanceMemoryContext(maintenanceMemoryContext, store, binding)) denied();
            const descriptors = readAgentLoopRpMaintenanceMemoryDescriptors(maintenanceMemoryContext);
            if (!descriptors) denied();
            const reserved = new Set(descriptors.map((descriptor) => descriptor.refId));
            if ((queryContext.retrieval ?? []).some((source) => reserved.has(source.sourceRef))) denied();
        }
        return Object.freeze({
            ...value,
            binding,
            ...(additionalChildSources ? { additionalChildSources } : {}),
            ...(queryContext ? { queryContext } : {}),
            ...(maintenanceMemoryContext ? { maintenanceMemoryContext } : {}),
        });
    }

    function maintenanceTrace(
        states: readonly AgentLoopRefState[],
        tokens: ReadonlyMap<string, number>,
        adopted: ReadonlySet<string>,
        overrides: ReadonlyMap<string, AgentLoopRefState['status']> = new Map(),
    ): AgentLoopRpMaintenanceMemoryTrace {
        const refs = Object.freeze(states
            .filter((item): item is AgentLoopRefState & { kind: 'memory-fact' | 'rolling-summary' } =>
                item.kind === 'memory-fact' || item.kind === 'rolling-summary')
            .map((item) => Object.freeze({
                refId: item.refId,
                kind: item.kind,
                policy: item.policy,
                status: overrides.get(item.refId) ?? item.status,
                reasonCode: overrides.has(item.refId)
                    ? `rp-maintenance-memory-expand-${overrides.get(item.refId)}`
                    : item.reasonCode,
                revision: item.revision,
                digest: item.digest,
                tokens: tokens.get(item.refId) ?? 0,
                adopted: adopted.has(item.refId),
            })));
        const payload = Object.freeze({
            version: AGENT_LOOP_RP_MAINTENANCE_MEMORY_TRACE_VERSION,
            refs,
        });
        return Object.freeze({ ...payload, traceDigest: rpChildAnalysisDigest(payload) });
    }

    function current(): Scope {
        const scope = local.getStore();
        if (!scope || !scope.active || !active.has(scope.input.binding.parentTaskId)) denied();
        return scope;
    }

    function sourceAtCommit(scope: Scope): void {
        if (current() !== scope || options.closed() || scope.input.signal.aborted || !scope.proof) denied();
        scope.reader.assertSourceCurrentAtCommit(scope.proof);
        for (const source of scope.childSources) source.reader.assertSourceCurrentAtCommit(source.proof);
    }

    function maintenanceAtCommit(scope: Scope): void {
        const requests = scope.maintenanceAtCommit ?? [];
        if (requests.length === 0) return;
        const context = scope.input.maintenanceMemoryContext;
        if (!context) denied();
        for (const request of requests) {
            const resolved = resolveAgentLoopRpMaintenanceMemoryContext(context, request);
            if (resolved.status !== 'found'
                || resolved.digest !== request.expectedDigest
                || request.expectedRevision !== undefined
                    && resolved.revision !== request.expectedRevision) denied();
        }
    }

    function requestOf(scope: Scope): AgentLoopChildWaitRequest {
        const record = store.read(scope.input.binding.parentTaskId);
        if (!record) denied();
        return Object.freeze({
            taskId: record.envelope.taskId,
            expectedRevision: record.revision,
            ownerId,
            attemptId: scope.input.binding.parentAttemptId,
            reservationId: scope.input.reservationId,
            waitId: scope.input.waitId,
        });
    }

    function assertRequest(request: AgentLoopChildWaitRequest): Scope {
        const scope = current();
        normalizeAgentLoopActionObject(request, [
            'taskId',
            'expectedRevision',
            'ownerId',
            'attemptId',
            'reservationId',
            'waitId',
        ]);
        if (
            request.taskId !== scope.input.binding.parentTaskId ||
            request.ownerId !== ownerId ||
            request.attemptId !== scope.input.binding.parentAttemptId ||
            request.reservationId !== scope.input.reservationId ||
            request.waitId !== scope.input.waitId
        )
            denied();
        return scope;
    }

    function prepareCurrent(scope: Scope, revision: number): AgentLoopTaskRecord {
        if (current() !== scope || options.closed() || scope.input.signal.aborted || !scope.proof) denied();
        const snapshot = store.readDagBudget(scope.input.binding.parentTaskId);
        const record = snapshot.record;
        const entry = snapshot.allocations.find((item) => item.allocation.reservationId === scope.input.reservationId);
        const now = Date.parse(clock());
        if (
            !Number.isSafeInteger(now) ||
            snapshot.state !== 'active' ||
            now >= Date.parse(snapshot.policy.deadlineAt) ||
            !entry ||
            entry.status !== 'settled' ||
            now >= Date.parse(entry.allocation.deadlineAt) ||
            snapshot.allocations.some((allocation) => now >= Date.parse(allocation.allocation.deadlineAt)) ||
            record.envelope.children.some((joined) => {
                const child = store.read(joined.taskId);
                return !child || child.fenced || child.revision !== joined.taskRevision;
            }) ||
            record.fenced ||
            record.ownerId !== ownerId ||
            record.revision !== revision ||
            !record.leaseExpiresAt ||
            now >= Date.parse(record.leaseExpiresAt) ||
            record.envelope.currentAttemptId !== scope.input.binding.parentAttemptId ||
            record.envelope.state !== 'RUNNING' ||
            record.envelope.wait !== undefined ||
            record.envelope.phase !== (scope.stage === 'prepared' ? 'MODEL' : 'PREPARE') ||
            !record.envelope.children.some(
                (child) =>
                    child.taskId === scope.input.binding.childTaskId &&
                    child.joinState === 'accepted' &&
                    child.outcomeRef === scope.proof!.artifact.refId,
            ) ||
            record.envelope.children.some((child) => child.joinState !== 'accepted')
        )
            denied();
        sourceAtCommit(scope);
        return record;
    }

    const childResults: NonNullable<AgentLoopCoordinatorPorts['childResults']> = Object.freeze({
        wait(request) {
            const scope = assertRequest(request);
            if (scope.stage !== 'wait' || options.closed() || scope.input.signal.aborted) denied();
            scope.input.sourceAdapter.assertCurrent();
            return store.waitForDagChild(request).record;
        },
        reconcile(request) {
            const scope = assertRequest(request);
            if (scope.stage !== 'reconcile' || options.closed()) denied();
            const snapshot = store.readDagBudget(request.taskId);
            const entry = snapshot.allocations.find(item => item.allocation.reservationId === request.reservationId);
            if (!entry || entry.allocation.childEnvelope.taskId !== scope.input.binding.childTaskId) denied();
            const child = snapshot.record.envelope.children.find(item => item.taskId === scope.input.binding.childTaskId)!;
            if (['FAILED', 'CANCELLED'].includes(child.state)) {
                const result = store.rejectDagChild(request, () => {
                    if (options.closed() || scope.input.signal.aborted) denied();
                    scope.input.sourceAdapter.assertCurrent();
                    if (scope.input.signal.aborted) denied();
                });
                const rejected = result.record.envelope.children.find(item => item.taskId === child.taskId)!;
                const correlation = rpChildAnalysisDigest({ waitId: request.waitId, attemptId: request.attemptId, reservationId: request.reservationId });
                return Object.freeze({ status: result.record.envelope.state === 'RUNNING' && result.record.envelope.phase === 'PREPARE'
                    && result.record.envelope.wait === undefined && result.record.envelope.currentAttemptId === request.attemptId
                    && rejected.joinState === 'rejected' && rejected.evidenceRefs.includes(`child-correlation:${correlation}`)
                    ? child.joinState === 'rejected' ? 'already-rejected' as const : 'rejected' as const : 'stale' as const,
                    record: result.record });
            }
            try {
                scope.proof = scope.reader.read();
            } catch {
                return Object.freeze({ status: 'inconclusive' as const, record: store.read(request.taskId)! });
            }
            const before = store.read(request.taskId)!;
            const already = before.envelope.children.some(
                (child) =>
                    child.taskId === scope.proof!.childTaskId &&
                    child.joinState === 'accepted' &&
                    child.outcomeRef === scope.proof!.artifact.refId,
            );
            const notified = store.notifyDagChildCompleted({ ...request, evidence: scope.proof }, () =>
                sourceAtCommit(scope),
            );
            if (notified.classification === 'stale')
                return Object.freeze({
                    status: 'stale' as const,
                    record: notified.record,
                    observationId: notified.observationId,
                });
            const joined = store.joinDagChildAndWake(
                {
                    ...request,
                    expectedRevision: notified.record.revision,
                    observationId: notified.observationId,
                    evidence: scope.proof,
                    ...(scope.input.maintenanceMemoryContext
                        ? {
                              maintenanceRefs:
                                  readAgentLoopRpMaintenanceMemoryDescriptors(
                                      scope.input.maintenanceMemoryContext,
                                  ) ?? denied(),
                          }
                        : {}),
                },
                () => sourceAtCommit(scope),
            );
            const accepted = joined.record.envelope.children.some(
                (child) =>
                    child.taskId === scope.proof!.childTaskId &&
                    child.joinState === 'accepted' &&
                    child.outcomeRef === scope.proof!.artifact.refId,
            );
            return Object.freeze({
                status: accepted ? (already ? ('already-joined' as const) : ('joined' as const)) : ('stale' as const),
                record: joined.record,
                observationId: notified.observationId,
            });
        },
    });

    return Object.freeze({
        owns: () => local.getStore() !== undefined,
        childResults,
        allowsHook(taskId: unknown, revision: unknown): boolean {
            try {
                const scope = current();
                return (
                    ['prepare', 'prepared'].includes(scope.stage) &&
                    taskId === scope.input.binding.parentTaskId &&
                    revision === scope.revision &&
                    !!prepareCurrent(scope, scope.revision)
                );
            } catch {
                return false;
            }
        },
        commit(input: unknown): AgentLoopTaskRecord {
            const scope = current();
            if (scope.stage !== 'prepare' || !scope.preparation) denied();
            prepareCurrent(scope, scope.revision);
            const record = store.commitDagParentPrepared(input, () => {
                sourceAtCommit(scope);
                maintenanceAtCommit(scope);
            });
            scope.revision = record.revision;
            scope.stage = 'prepared';
            return record;
        },
        async prepare(step: Parameters<AgentLoopCoordinatorPorts['prepare']>[0]) {
            const scope = current();
            if (scope.stage !== 'prepare') denied();
            const record = prepareCurrent(scope, step.revision);
            const accepted = record.envelope.children.filter((child) => child.joinState === 'accepted');
            const supplied = [scope.input, ...(scope.input.additionalChildSources ?? [])];
            if (accepted.length !== supplied.length) denied();
            scope.childSources = Object.freeze(accepted.map((child) => {
                const input = supplied.find((source) => source.binding.childTaskId === child.taskId);
                if (!input) denied();
                const reader = input === scope.input ? scope.reader : createRpChildResultEvidenceReader({
                    store, sourceAdapter: input.sourceAdapter, binding: input.binding, sourceRef: input.sourceRef,
                });
                const proof = reader.read();
                if (child.outcomeRef !== proof.artifact.refId) denied();
                return Object.freeze({ input, reader, proof });
            }));
            const refs = store.readRefs(record.envelope.taskId);
            const childByRef = new Map(scope.childSources.map((source) => [source.proof.artifact.refId, source]));
            if (childByRef.size !== scope.childSources.length) denied();
            const snapshot = buildActiveContextSnapshot({
                record,
                refs,
                observations: store.readObservations(record.envelope.taskId),
                events: store.readEvents(record.envelope.taskId),
            });
            const maintenance = scope.input.maintenanceMemoryContext;
            const continuation = await resolveAgentLoopContinuation({
                snapshot,
                refs,
                resolvers: {
                    'session-artifact': (request) => childByRef.get(request.refId)?.input.sourceAdapter.resolve(request)
                        ?? Object.freeze({ status: 'forbidden' as const }),
                    ...(maintenance ? {
                        'memory-fact': (request: Parameters<typeof resolveAgentLoopRpMaintenanceMemoryContext>[1]) =>
                            resolveAgentLoopRpMaintenanceMemoryContext(maintenance, request),
                        'rolling-summary': (request: Parameters<typeof resolveAgentLoopRpMaintenanceMemoryContext>[1]) =>
                            resolveAgentLoopRpMaintenanceMemoryContext(maintenance, request),
                    } : {}),
                },
                grantedAclClasses: maintenance ? ['restricted', 'session'] : ['restricted'],
                expansionBudgetTokens: scope.input.maxExpansionTokens,
            });
            const expandedTokens = new Map<string, number>();
            const adopted = new Set<string>();
            const expansionOverrides = new Map<string, AgentLoopRefState['status']>();
            if (maintenance) {
                scope.maintenanceMemory = maintenanceTrace(
                    continuation.refStates, expandedTokens, adopted, expansionOverrides,
                );
            }
            prepareCurrent(scope, step.revision);
            const ref = continuation.refStates.find((item) => item.refId === scope.proof!.artifact.refId);
            const maintenanceBlocked = continuation.refStates.some((item) =>
                (item.kind === 'memory-fact' || item.kind === 'rolling-summary')
                    ? item.policy === 'required' && (item.status !== 'fresh' || !item.expansion)
                    : item.status !== 'fresh');
            if (
                (!maintenance && continuation.completeness !== 'complete') ||
                (maintenance && maintenanceBlocked) ||
                !ref ||
                ref.status !== 'fresh' ||
                !ref.expansion ||
                ref.expansion.tokens > scope.input.maxExpansionTokens
            )
                denied();
            const childResults = scope.childSources.map((source) => {
                const state = continuation.refStates.find((item) => item.refId === source.proof.artifact.refId);
                if (!state || state.status !== 'fresh' || !state.expansion) denied();
                const expanded = source.input.sourceAdapter.expand({
                    loaderRef: state.expansion.loaderRef, budgetTokens: state.expansion.tokens,
                });
                if (expanded.status !== 'found' || expanded.tokens !== state.expansion.tokens) denied();
                return Object.freeze({ artifactRef: state.refId, resultDigest: rpChildAnalysisDigest(expanded.result),
                    result: expanded.result, tokens: expanded.tokens });
            });
            const childTokens = childResults.reduce((sum, child) => sum + child.tokens, 0);
            if (childTokens > scope.input.maxExpansionTokens) denied();
            prepareCurrent(scope, step.revision);
            if (scope.input.queryContext) {
                const retrieval = [...(scope.input.queryContext.retrieval ?? [])];
                if (maintenance) {
                    for (const state of continuation.refStates) {
                        if (state.kind !== 'memory-fact' && state.kind !== 'rolling-summary') continue;
                        if (state.status !== 'fresh' || !state.expansion) continue;
                        const materialized = expandAgentLoopRpMaintenanceMemoryContext(maintenance, {
                            refId: state.refId,
                            kind: state.kind,
                            loaderRef: state.expansion.loaderRef,
                            budgetTokens: state.expansion.tokens,
                        });
                        if (materialized.status !== 'found') {
                            expansionOverrides.set(state.refId,
                                materialized.status === 'budget-exhausted' ? 'deferred' : materialized.status);
                            scope.maintenanceMemory = maintenanceTrace(
                                continuation.refStates, expandedTokens, adopted, expansionOverrides,
                            );
                            if (state.policy === 'required') denied();
                            continue;
                        }
                        expandedTokens.set(state.refId, materialized.tokens);
                        retrieval.push(materialized.source);
                        prepareCurrent(scope, step.revision);
                    }
                }
                const compiled = compileRpQueryContext({
                    ...scope.input.queryContext,
                    retrieval,
                    taskState: {
                        sourceRef: `rp-parent:${rpChildAnalysisDigest(record.envelope.taskId)}`,
                        content: JSON.stringify({
                            taskId: record.envelope.taskId,
                            currentAttemptId: record.envelope.currentAttemptId,
                            state: record.envelope.state,
                            phase: record.envelope.phase,
                            revision: record.revision,
                            goal: record.envelope.goal,
                            todos: record.envelope.todos,
                            confirmedFacts: record.envelope.confirmedFacts,
                            blockers: record.envelope.blockers,
                        }),
                        required: true,
                    },
                    childResults: childResults.map(({ tokens: ignored, ...child }) => { void ignored; return child; }),
                });
                scope.queryContext = compiled.trace;
                if (maintenance) {
                    if (compiled.status === 'ready') {
                        for (const source of compiled.trace.sourceOrder) {
                            if (source.layer === 'P3') adopted.add(source.sourceRef);
                        }
                    }
                    scope.maintenanceMemory = maintenanceTrace(
                        continuation.refStates, expandedTokens, adopted, expansionOverrides,
                    );
                }
                prepareCurrent(scope, step.revision);
                if (compiled.status !== 'ready') denied();
                if (maintenance) {
                    scope.maintenanceAtCommit = Object.freeze(
                        refs
                            .filter(
                                (candidate) =>
                                    adopted.has(candidate.refId) &&
                                    (candidate.kind === 'memory-fact' || candidate.kind === 'rolling-summary'),
                            )
                            .map((candidate) =>
                                Object.freeze({
                                    refId: candidate.refId,
                                    kind: candidate.kind,
                                    ownerRef: candidate.ownerRef,
                                    expectedDigest: candidate.expectedDigest,
                                    ...(candidate.expectedRevision === undefined
                                        ? {}
                                        : { expectedRevision: candidate.expectedRevision }),
                                }),
                            ),
                    );
                }
            }
            scope.preparation = Object.freeze({
                artifactRef: ref.refId,
                snapshotDigest: snapshot.snapshotDigest,
                continuationDigest: continuation.continuationDigest,
                resultDigest: childResults.length === 1 ? childResults[0]!.resultDigest
                    : rpChildAnalysisDigest(childResults.map(({ artifactRef, resultDigest }) => ({ artifactRef, resultDigest }))),
                expandedTokens: childTokens
                    + [...expandedTokens.values()].reduce((sum, tokens) => sum + tokens, 0),
            });
            return Object.freeze({ attemptId: scope.input.binding.parentAttemptId });
        },
        bind(runtime: object, coordinator: AgentLoopCoordinator) {
            function scopeOf(input: AgentLoopRpChildJoinInput, stage: Scope['stage']): Scope {
                const safe = inputOf(input);
                if (options.closed() || active.has(safe.binding.parentTaskId)) denied();
                const reader = createRpChildResultEvidenceReader({
                    store,
                    sourceAdapter: safe.sourceAdapter,
                    binding: safe.binding,
                    sourceRef: safe.sourceRef,
                });
                return {
                    input: safe,
                    reader,
                    active: true,
                    revision: store.read(safe.binding.parentTaskId)?.revision ?? 0,
                    stage,
                    preparation: null,
                    childSources: [],
                };
            }
            const port: AgentLoopRpChildJoinPort = Object.freeze({
                wait(input: AgentLoopRpChildJoinInput) {
                    const scope = scopeOf(input, 'wait');
                    active.add(scope.input.binding.parentTaskId);
                    try {
                        return local.run(scope, () => coordinator.waitForChild(requestOf(scope)));
                    } finally {
                        scope.active = false;
                        active.delete(scope.input.binding.parentTaskId);
                    }
                },
                reconcile(input: AgentLoopRpChildJoinInput) {
                    const scope = scopeOf(input, 'reconcile');
                    active.add(scope.input.binding.parentTaskId);
                    const work = Promise.resolve()
                        .then(() =>
                            local.run(scope, async () => {
                                const result = coordinator.resumeChildResult(requestOf(scope));
                                let prepared: AgentLoopStepResult | null = null;
                                if (
                                    ['joined', 'already-joined'].includes(result.status) &&
                                    result.record.envelope.state === 'RUNNING' &&
                                    result.record.envelope.phase === 'PREPARE' &&
                                    !result.record.envelope.children.some((child) => child.joinState !== 'accepted')
                                ) {
                                    scope.stage = 'prepare';
                                    scope.revision = result.record.revision;
                                    prepared = await coordinator.step({
                                        taskId: scope.input.binding.parentTaskId,
                                        ownerId,
                                    });
                                }
                                return Object.freeze({
                                    ...result,
                                    record: store.read(scope.input.binding.parentTaskId)!,
                                    prepare: prepared,
                                    preparation: scope.preparation,
                                    ...(scope.queryContext ? { queryContext: scope.queryContext } : {}),
                                    ...(scope.maintenanceMemory
                                        ? { maintenanceMemory: scope.maintenanceMemory }
                                        : {}),
                                });
                            }),
                        )
                        .finally(() => {
                            scope.active = false;
                            active.delete(scope.input.binding.parentTaskId);
                            coordinator.forget(scope.input.binding.parentTaskId);
                        });
                    options.track(work);
                    return work;
                },
            });
            PORTS.set(runtime, port);
        },
    });
}
