/** @author Codex @date 2026-10-26 @version 1.0
 * Deterministic RP shape/source/readonly-boundary verification; never a literary-quality or parent-join claim.
 */
import {
    normalizeRpChildAnalysisBinding,
    rpChildAnalysisDigest,
    type RpChildAnalysisBindingV1,
} from '../../packages/memory/public/rp-child-analysis.ts';
import { normalizeAgentLoopTaskEnvelope } from '@jiuguan/agent-loop-contract';
import { agentLoopActionDigest } from './agent-loop-action-gateway.ts';
import {
    AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
    normalizeAgentLoopActionToken,
    type AgentLoopActionResultMetadata,
} from './agent-loop-action-receipt.ts';
import {
    AgentLoopVerifierRegistry,
    type AgentLoopCompletionCandidate,
    type AgentLoopVerifierRunner,
} from './agent-loop-completion-gate.ts';
import { AgentLoopProjectionStore, type AgentLoopArtifactRefDescriptor } from './agent-loop-projection-store.ts';
import { RP_CHILD_ANALYSIS_TASK_CONTRACT, RP_CHILD_ANALYSIS_VERIFIER_SET } from './agent-loop-rp-scenario-template.ts';
import { readRpCharacterActionResult, type RpAnalysisSourceAdapter } from './agent-loop-rp-character-action.ts';
import { isRpAnalysisSourceAdapter, readRpAnalysisSourceBinding } from './agent-loop-rp-analysis-source.ts';

function invalid(): never {
    throw new Error('rp-character-verification-invalid');
}

function same(left: unknown, right: unknown): boolean {
    return rpChildAnalysisDigest(left) === rpChildAnalysisDigest(right);
}

function descriptor(input: AgentLoopArtifactRefDescriptor): AgentLoopArtifactRefDescriptor {
    return {
        refId: input.refId,
        kind: input.kind,
        ownerRef: input.ownerRef,
        expectedDigest: input.expectedDigest,
        expectedRevision: input.expectedRevision,
        policy: input.policy,
        aclClass: input.aclClass,
        expandBudgetTokens: input.expandBudgetTokens,
    };
}

/** Reads the original Store/Session evidence. The original FrozenCompletion/Core still owns all terminal authority. */
export function createRpCharacterVerification(
    options: Readonly<{
        store: AgentLoopProjectionStore;
        sourceAdapter: RpAnalysisSourceAdapter;
        binding: RpChildAnalysisBindingV1;
        sourceRef: string;
        ownerId: string;
        clock: () => string;
    }>,
) {
    const { store, sourceAdapter, sourceRef, clock } = options;
    const binding = normalizeRpChildAnalysisBinding(options.binding);
    const ownerId = normalizeAgentLoopActionToken(options.ownerId);
    const sourceBinding = readRpAnalysisSourceBinding(sourceAdapter);
    if (
        !(store instanceof AgentLoopProjectionStore) ||
        typeof clock !== 'function' ||
        !isRpAnalysisSourceAdapter(sourceAdapter) ||
        !sourceBinding ||
        !same(sourceBinding, binding)
    )
        invalid();
    const taskId = binding.childTaskId;
    const registry = new AgentLoopVerifierRegistry();
    registry.register({
        taskKind: RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind,
        contractRevision: RP_CHILD_ANALYSIS_TASK_CONTRACT.version,
        ...RP_CHILD_ANALYSIS_VERIFIER_SET,
    });
    const read = (expectedRevision: number) => {
        const current = store.read(taskId);
        const now = Date.parse(clock());
        if (
            !Number.isSafeInteger(expectedRevision) ||
            !current ||
            current.revision !== expectedRevision ||
            !Number.isSafeInteger(now) ||
            current.ownerId !== ownerId ||
            current.fenced ||
            current.leaseExpiresAt === null ||
            Date.parse(current.leaseExpiresAt) <= now
        )
            invalid();
        const envelope = current.envelope;
        if (
            envelope.taskKind !== 'rp.child-analysis' ||
            envelope.taskContractRef !== RP_CHILD_ANALYSIS_TASK_CONTRACT.ref ||
            envelope.currentAttemptId !== binding.childAttemptId ||
            envelope.state !== 'RUNNING' ||
            !['OBSERVE', 'VERIFY'].includes(envelope.phase) ||
            envelope.artifacts.length !== 1 ||
            envelope.children.length !== 0 ||
            envelope.budget.granted.modelCalls !== 1 ||
            envelope.budget.granted.toolCalls !== 1 ||
            envelope.budget.spent.modelCalls !== 1 ||
            envelope.budget.spent.toolCalls !== 1 ||
            ['writes', 'highRiskActions', 'childTasks'].some(
                (key) => envelope.budget.granted[key as 'writes'] !== 0 || envelope.budget.spent[key as 'writes'] !== 0,
            )
        )
            invalid();
        const events = store.readEvents(taskId);
        const starts = events.filter((event) => event.kind === 'action-started');
        const completes = events.filter((event) => event.kind === 'action-completed');
        if (
            starts.length !== 1 ||
            completes.length !== 1 ||
            events.some((event) => ['action-reconciled', 'action-uncertain'].includes(event.kind))
        )
            invalid();
        const start = starts[0]!,
            completed = completes[0]!;
        const actionId = start.eventId.slice('action-started:'.length);
        const receipt = store.readActionReceipt({ taskId, actionId });
        if (
            !receipt ||
            receipt.status !== 'observed' ||
            receipt.actionContractRef !== AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT ||
            receipt.taskId !== taskId ||
            receipt.attemptId !== binding.childAttemptId ||
            receipt.ownerId !== ownerId ||
            receipt.expectedRevision !== start.revision ||
            receipt.expectedRevision !== 3 ||
            receipt.appliedRevision !== 4 ||
            receipt.result === undefined ||
            receipt.startedAt === undefined ||
            receipt.completedAt === undefined ||
            receipt.settledAt === undefined ||
            receipt.observedAt === undefined ||
            receipt.releasedAt !== undefined ||
            receipt.receiptRef !== `receipt:${actionId}` ||
            receipt.observationId !== `obs:${actionId}` ||
            completed.eventId !== `action-completed:${actionId}` ||
            completed.revision !== 4 ||
            completed.reasonCode !== 'act' ||
            start.reasonCode !== 'act'
        )
            invalid();
        const receiptKey = rpChildAnalysisDigest(actionId).slice(7);
        if (events.filter((event) => event.kind.startsWith('action-receipt-')).length !== 5) invalid();
        for (const stage of ['reserved', 'started', 'completed', 'settled', 'observed'] as const) {
            const matches = events.filter((event) => event.eventId === `action-receipt:${receiptKey}:${stage}`);
            const timestamp =
                stage === 'reserved'
                    ? receipt.createdAt
                    : stage === 'started'
                      ? receipt.startedAt
                      : stage === 'completed'
                        ? receipt.completedAt
                        : stage === 'settled'
                          ? receipt.settledAt
                          : receipt.observedAt;
            if (
                matches.length !== 1 ||
                matches[0]!.kind !== `action-receipt-${stage}` ||
                matches[0]!.revision !== (stage === 'observed' ? 4 : 3) ||
                matches[0]!.acceptedAt !== timestamp
            )
                invalid();
        }
        const actualActionDigest = agentLoopActionDigest({
            actionId,
            taskId,
            attemptId: binding.childAttemptId,
            expectedTaskRevision: receipt.expectedRevision,
            actionContractRef: AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
            args: { sourceRef },
        });
        if (
            receipt.actionDigest !== actualActionDigest ||
            receipt.result.usage.writes !== 0 ||
            receipt.result.usage.highRiskActions !== 0 ||
            receipt.result.usage.toolCalls !== 1 ||
            receipt.result.usage.modelCalls !== 0
        )
            invalid();
        const actual = readRpCharacterActionResult({ sourceAdapter, binding, sourceRef, metadata: receipt.result });
        const actualRefs = store.readRefs(taskId);
        const actualArtifact = envelope.artifacts[0]!;
        // The original Envelope canonicalizes artifact refs as a set; receipt refs keep their six semantic positions.
        const expectedArtifact = normalizeAgentLoopTaskEnvelope({
            ...envelope,
            artifacts: [actual.artifactBundle.artifact],
        }).artifacts[0]!;
        const registered = actualRefs.find((ref) => ref.refId === actual.artifactBundle.descriptor.refId);
        const phase = events.find((event) => event.eventId === `phase:${taskId}:4:ACT-OBSERVE`);
        const refEvent = events.find((event) => event.eventId === `ref-registered:${actualArtifact.artifactRef}`);
        if (
            actualRefs.length !== 1 ||
            !registered ||
            !same(descriptor(registered), descriptor(actual.artifactBundle.descriptor)) ||
            !same(actualArtifact, expectedArtifact) ||
            registered.taskRevision !== 5 ||
            !phase ||
            phase.revision !== 5 ||
            phase.kind !== 'phase-advanced' ||
            !refEvent ||
            refEvent.revision !== 5 ||
            refEvent.kind !== 'ref-registered' ||
            events.indexOf(refEvent) + 1 !== events.indexOf(phase) ||
            registered.registeredAt !== refEvent.acceptedAt ||
            phase.acceptedAt !== refEvent.acceptedAt
        )
            invalid();
        const observations = store.readObservations(taskId);
        const observation = observations.find((item) => item.observationId === receipt.observationId);
        const observedEvents = events.filter((event) => event.eventId === `observation:${receipt.observationId}`);
        if (
            !observation ||
            observation.taskId !== taskId ||
            observation.attemptId !== binding.childAttemptId ||
            observation.observedForTaskRevision !== 3 ||
            observation.appliedRevision !== 4 ||
            observation.classification !== 'applied' ||
            observation.sourceKind !== 'tool' ||
            observation.completeness !== 'complete' ||
            observedEvents.length !== 1 ||
            observedEvents[0]!.kind !== 'observation-applied' ||
            observedEvents[0]!.revision !== 4 ||
            observedEvents[0]!.acceptedAt !== receipt.observedAt ||
            observations.filter((item) => item.sourceKind === 'provider' && item.classification === 'applied')
                .length !== 1 ||
            events.filter((event) => event.kind === 'model-invocation-reserved').length !== 1
        )
            invalid();
        return Object.freeze({
            taskId,
            attemptId: binding.childAttemptId,
            taskRevision: expectedRevision,
            actionWatermark: completed.eventId,
            actionDigest: actualActionDigest,
            metadata: receipt.result,
            artifactRefs: Object.freeze([actualArtifact.artifactRef]),
            result: actual.result,
            evidenceRefs: Object.freeze([
                ...receipt.result.evidenceRefs,
                receipt.result.payloadDigest,
                actualActionDigest,
            ]),
        });
    };
    let baseline: Readonly<{
        candidateRef: string;
        candidateDigest: string;
        metadata: AgentLoopActionResultMetadata;
    }> | null = null;
    const candidateEvidence = (candidate: AgentLoopCompletionCandidate) => {
        const candidateDigest = rpChildAnalysisDigest(candidate);
        const evidence = read(candidate.taskRevision);
        if (
            candidate.taskId !== taskId ||
            candidate.attemptId !== binding.childAttemptId ||
            candidate.actionWatermark !== evidence.actionWatermark ||
            !same(candidate.artifactRefs, evidence.artifactRefs)
        )
            invalid();
        baseline = Object.freeze({
            candidateRef: candidate.candidateRef,
            candidateDigest,
            metadata: evidence.metadata,
        });
        return evidence;
    };
    const runners = Object.freeze(
        Object.fromEntries(
            RP_CHILD_ANALYSIS_VERIFIER_SET.verifiers.map((expected) => {
                const runner: AgentLoopVerifierRunner = async ({ candidate, declaration }) => {
                    try {
                        if (!same(declaration, expected)) invalid();
                        const evidence = candidateEvidence(candidate);
                        // player-sovereignty checks the real readonly execution boundary and analysis-only output shape.
                        // It deliberately makes no semantic guarantee about free-text conclusions or their literary quality.
                        return Object.freeze({
                            disposition: 'passed',
                            reasonCodes: Object.freeze([]),
                            evidenceRefs: evidence.evidenceRefs,
                        });
                    } catch {
                        return Object.freeze({
                            disposition: 'inconclusive',
                            reasonCodes: Object.freeze(['rp-character-verification-invalid']),
                            evidenceRefs: Object.freeze([]),
                        });
                    }
                };
                return [expected.verifierId, runner];
            }),
        ),
    ) as Readonly<Record<string, AgentLoopVerifierRunner>>;
    return Object.freeze({
        registry,
        runners,
        read,
        assertSourceCurrent(candidate: AgentLoopCompletionCandidate): void {
            candidateEvidence(candidate);
        },
        /** Called inside the original AL writer lock: never nests a Store read/transaction. */
        assertSourceCurrentAtCommit(candidate: AgentLoopCompletionCandidate): void {
            if (
                !baseline ||
                baseline.candidateRef !== candidate.candidateRef ||
                baseline.candidateDigest !== rpChildAnalysisDigest(candidate)
            )
                invalid();
            readRpCharacterActionResult({ sourceAdapter, binding, sourceRef, metadata: baseline.metadata });
        },
    });
}
