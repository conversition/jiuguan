/** Host-only narrow Action settlement. A structural/JSON copy has no receipt authority. */
import {
    normalizeAgentLoopObservation,
    type AgentLoopObservationEnvelopeV1,
    type AgentLoopTaskEnvelopeV1,
} from '@jiuguan/agent-loop-contract';
import type { AgentLoopActResult, AgentLoopCoordinatorPorts } from './agent-loop-coordinator.ts';
import {
    AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT,
    AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT,
    AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
    AGENT_LOOP_RP_CHARACTER_EXPANSION_BUDGET_TOKENS,
} from './agent-loop-action-receipt.ts';
import {
    normalizeAgentLoopActionContractRef,
    normalizeAgentLoopActionResult,
    normalizeAgentLoopActionObject,
    normalizeAgentLoopActionToken,
    normalizeAgentLoopActionDigest,
} from './agent-loop-action-receipt.ts';
import {
    normalizeAgentLoopArtifactRefDescriptor,
    type AgentLoopArtifactRefDescriptor,
} from './agent-loop-projection-store.ts';

export const AGENT_LOOP_ACTION_OUTCOME_VERSION = 'agent-loop-action-outcome-v1' as const;
export interface AgentLoopActionOutcome extends AgentLoopActResult {
    readonly contractVersion: typeof AGENT_LOOP_ACTION_OUTCOME_VERSION;
}
export interface AgentLoopActionOutcomeData extends AgentLoopActResult {
    readonly observation: AgentLoopObservationEnvelopeV1;
    readonly artifactBundle?: AgentLoopActionArtifactBundle;
}
export interface AgentLoopActionArtifactBundle {
    readonly artifact: AgentLoopTaskEnvelopeV1['artifacts'][number];
    readonly descriptor: AgentLoopArtifactRefDescriptor;
}
const outcomes = new WeakMap<object, AgentLoopActionOutcomeData>();

/** Called only after the original ActionGateway persists and settles its actual metadata. */
export function createAgentLoopActionOutcome(
    input: Readonly<{
        actionRequest: Parameters<AgentLoopCoordinatorPorts['act']>[0]['actionRequest'];
        result: AgentLoopActResult;
        clock?: () => string;
        artifactBundle?: AgentLoopActionArtifactBundle;
    }>,
): AgentLoopActionOutcome {
    const { actionRequest: request } = input;
    let result = input.result;
    let contract: ReturnType<typeof normalizeAgentLoopActionContractRef>;
    try {
        contract = normalizeAgentLoopActionContractRef(request.actionContractRef);
    } catch {
        throw new Error('agent-loop-action-outcome-invalid');
    }
    const harnessRunId = request.harnessRunId;
    // A new domain-apply receipt is exact own-data metadata. Snapshot before the
    // clock/Observation ports; never evaluate a result getter or silently discard
    // a body/payloadRef into a branded apply outcome. Old read/proposal callers
    // retain their existing input shape and are still contract-checked below.
    if (
        contract === AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT ||
        contract === AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT
    ) {
        try {
            normalizeAgentLoopActionObject(result, [
                'sourceKind',
                'sourceRef',
                'payloadDigest',
                'completeness',
                'evidenceRefs',
                'usageDelta',
            ]);
            const normalized = normalizeAgentLoopActionResult(
                {
                    sourceKind: result.sourceKind,
                    sourceRef: result.sourceRef,
                    payloadDigest: result.payloadDigest,
                    completeness: result.completeness,
                    evidenceRefs: result.evidenceRefs,
                    usage: result.usageDelta,
                },
                contract,
            );
            result = Object.freeze({
                sourceKind: normalized.sourceKind,
                sourceRef: normalized.sourceRef,
                payloadDigest: normalized.payloadDigest,
                completeness: normalized.completeness,
                evidenceRefs: normalized.evidenceRefs,
                usageDelta: normalized.usage,
            });
        } catch {
            throw new Error('agent-loop-action-outcome-invalid');
        }
    }
    const observation = normalizeAgentLoopObservation({
        contractVersion: 'agent-loop-observation-v1',
        observationId: `obs:${request.actionId}`,
        taskId: request.taskId,
        attemptId: request.attemptId,
        observedForTaskRevision: request.expectedTaskRevision,
        sourceKind: result.sourceKind,
        sourceRef: result.sourceRef,
        causalActionId: request.actionId,
        observedAt: request.requestedAt,
        ingestedAt: (input.clock ?? (() => new Date().toISOString()))(),
        payloadDigest: result.payloadDigest,
        completeness: result.completeness,
        evidenceRefs: result.evidenceRefs,
        ...(result.payloadRef === undefined ? {} : { payloadRef: result.payloadRef }),
        ...(result.usageDelta === undefined ? {} : { usageDelta: result.usageDelta }),
    });
    const usage = observation.usageDelta;
    if (observation.payloadRef !== undefined || usage === undefined) {
        throw new Error('agent-loop-action-outcome-invalid');
    }
    let metadata: ReturnType<typeof normalizeAgentLoopActionResult>;
    try {
        metadata = normalizeAgentLoopActionResult(
            {
                sourceKind: observation.sourceKind,
                sourceRef: observation.sourceRef,
                payloadDigest: observation.payloadDigest,
                completeness: observation.completeness,
                evidenceRefs: observation.evidenceRefs,
                usage,
            },
            contract,
        );
    } catch {
        throw new Error('agent-loop-action-outcome-invalid');
    }
    const fields: AgentLoopActResult = Object.freeze({
        sourceKind: metadata.sourceKind,
        sourceRef: observation.sourceRef,
        payloadDigest: observation.payloadDigest,
        completeness: observation.completeness,
        evidenceRefs: observation.evidenceRefs,
        usageDelta: observation.usageDelta,
        ...(observation.payloadRef === undefined ? {} : { payloadRef: observation.payloadRef }),
    });
    let artifactBundle: AgentLoopActionArtifactBundle | undefined;
    if (contract === AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT) {
        try {
            if (input.artifactBundle === undefined) throw new Error();
            const args = normalizeAgentLoopActionObject(request.args, ['sourceRef']);
            if (args.sourceRef !== observation.sourceRef) throw new Error();
            const bundle = normalizeAgentLoopActionObject(input.artifactBundle, ['artifact', 'descriptor']);
            const artifact = normalizeAgentLoopActionObject(bundle.artifact, [
                'artifactRef',
                'kind',
                'status',
                'evidenceRefs',
            ]);
            const descriptor = normalizeAgentLoopArtifactRefDescriptor(bundle.descriptor);
            const refs = normalizeAgentLoopObservation({
                ...observation,
                evidenceRefs: artifact.evidenceRefs,
            }).evidenceRefs;
            if (
                artifact.kind !== 'rp-child-analysis' ||
                artifact.status !== 'available' ||
                artifact.artifactRef !== observation.evidenceRefs[5] ||
                descriptor.refId !== artifact.artifactRef ||
                descriptor.kind !== 'session-artifact' ||
                descriptor.expectedDigest !== observation.payloadDigest ||
                !/^rp-analysis-owner:[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/u.test(descriptor.ownerRef) ||
                descriptor.expectedRevision !== observation.evidenceRefs[0] ||
                descriptor.policy !== 'required' ||
                descriptor.aclClass !== 'restricted' ||
                descriptor.expandBudgetTokens !== AGENT_LOOP_RP_CHARACTER_EXPANSION_BUDGET_TOKENS ||
                JSON.stringify(refs) !== JSON.stringify(observation.evidenceRefs)
            )
                throw new Error();
            artifactBundle = Object.freeze({
                artifact: Object.freeze({
                    artifactRef: descriptor.refId,
                    kind: 'rp-child-analysis',
                    status: 'available',
                    evidenceRefs: refs,
                }),
                descriptor,
            });
        } catch {
            throw new Error('agent-loop-action-outcome-invalid');
        }
    }
    if (input.artifactBundle !== undefined && contract !== AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT) {
        const apply = contract === AGENT_LOOP_ROLLING_SUMMARY_APPLY_ACTION_CONTRACT;
        if (contract !== AGENT_LOOP_ROLLING_SUMMARY_PROPOSAL_ACTION_CONTRACT && !apply)
            throw new Error('agent-loop-action-outcome-invalid');
        const bundle = normalizeAgentLoopActionObject(input.artifactBundle, ['artifact', 'descriptor']);
        const artifact = normalizeAgentLoopActionObject(bundle.artifact, [
            'artifactRef',
            'kind',
            'status',
            'evidenceRefs',
        ]);
        const descriptor = normalizeAgentLoopArtifactRefDescriptor(bundle.descriptor);
        const refs = normalizeAgentLoopObservation({
            ...observation,
            evidenceRefs: artifact.evidenceRefs,
        }).evidenceRefs;
        const artifactKind = apply ? 'agent-loop-rolling-summary-apply' : 'agent-loop-rolling-summary-proposal';
        const descriptorKind = apply ? 'memory-record' : 'candidate';
        if (
            observation.completeness !== 'complete' ||
            artifact.kind !== artifactKind ||
            artifact.status !== 'available' ||
            descriptor.refId !== artifact.artifactRef ||
            descriptor.kind !== descriptorKind ||
            descriptor.expectedDigest !== observation.payloadDigest ||
            descriptor.ownerRef !== `maintenancejob.${harnessRunId}` ||
            descriptor.policy !== 'required' ||
            descriptor.aclClass !== 'restricted' ||
            descriptor.expandBudgetTokens !== 0 ||
            descriptor.expectedRevision === undefined ||
            !refs.includes(descriptor.expectedRevision) ||
            refs.length < 4 ||
            refs.some((ref) => !observation.evidenceRefs.includes(ref))
        )
            throw new Error('agent-loop-action-outcome-invalid');
        if (apply) {
            try {
                if (
                    observation.sourceKind !== 'domain-readback' ||
                    observation.sourceRef !== `maintenance.summary:${harnessRunId}` ||
                    typeof artifact.artifactRef !== 'string' ||
                    !/^maintenance\.summary\.apply\.artifact:[a-f0-9]{64}$/u.test(artifact.artifactRef) ||
                    observation.evidenceRefs.length !== 11 ||
                    observation.evidenceRefs[8] !== observation.payloadDigest ||
                    descriptor.expectedRevision !== observation.evidenceRefs[9] ||
                    refs.length !== new Set(observation.evidenceRefs).size
                )
                    throw new Error();
                for (const ref of observation.evidenceRefs.slice(0, 10)) normalizeAgentLoopActionDigest(ref);
                const updatedAtRef = observation.evidenceRefs[10]!;
                if (!updatedAtRef.startsWith('act-updated-at:')) throw new Error();
                const updatedAt = updatedAtRef.slice('act-updated-at:'.length);
                if (!Number.isSafeInteger(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt)
                    throw new Error();
            } catch {
                throw new Error('agent-loop-action-outcome-invalid');
            }
        }
        artifactBundle = Object.freeze({
            artifact: Object.freeze({
                artifactRef: normalizeAgentLoopActionToken(artifact.artifactRef),
                kind: artifactKind,
                status: 'available',
                evidenceRefs: refs,
            }),
            descriptor,
        });
    }
    const value = Object.freeze({ contractVersion: AGENT_LOOP_ACTION_OUTCOME_VERSION, ...fields });
    outcomes.set(value, Object.freeze({ ...fields, observation, ...(artifactBundle ? { artifactBundle } : {}) }));
    return value;
}

/** No decoding/assimilation: only the original trusted host object is recognized. */
export function readAgentLoopActionOutcome(value: unknown): AgentLoopActionOutcomeData | null {
    return value !== null && typeof value === 'object' ? (outcomes.get(value) ?? null) : null;
}
