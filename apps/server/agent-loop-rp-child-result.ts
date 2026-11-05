/** @author Codex @date 2026-10-26 @version 1.0
 * Restart-safe RP child result evidence. Metadata never restores old Frozen/Model/Action execution authority.
 */
import { normalizeAgentLoopTaskEnvelope } from '@jiuguan/agent-loop-contract';
import {
    normalizeRpChildAnalysisBinding,
    rpChildAnalysisDigest,
    type RpChildAnalysisBindingV1,
} from '../../packages/memory/public/rp-child-analysis.ts';
import { agentLoopActionDigest } from './agent-loop-action-gateway.ts';
import {
    AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
    normalizeAgentLoopActionObject,
    type AgentLoopActionResultMetadata,
} from './agent-loop-action-receipt.ts';
import {
    AgentLoopProjectionStore,
    normalizeAgentLoopArtifactRefDescriptor,
    type AgentLoopArtifactRefDescriptor,
} from './agent-loop-projection-store.ts';
import {
    isRpAnalysisSourceAdapter,
    readRpAnalysisSourceBinding,
    type RpAnalysisSourceAdapter,
} from './agent-loop-rp-analysis-source.ts';
import { readRpCharacterActionResult } from './agent-loop-rp-character-action.ts';
import { RP_CHILD_ANALYSIS_TASK_CONTRACT, RP_CHILD_ANALYSIS_VERIFIER_SET } from './agent-loop-rp-scenario-template.ts';

export interface RpChildResultEvidenceV1 {
    readonly version: 'agent-loop-rp-child-result-evidence-v1';
    readonly parentTaskId: string;
    readonly parentAttemptId: string;
    readonly childTaskId: string;
    readonly childAttemptId: string;
    readonly childRevision: number;
    readonly childEnvelopeDigest: string;
    readonly childTaskUpdatedAt: string;
    readonly candidateRef: string;
    readonly candidateDigest: string;
    readonly verificationResultRef: string;
    readonly verificationDigest: string;
    readonly sourceBindingDigest: string;
    readonly requiredVerifierIds: readonly string[];
    readonly artifact: AgentLoopArtifactRefDescriptor;
    readonly evidenceRefs: readonly string[];
    readonly proofDigest: string;
}

function invalid(code = 'rp-child-result-evidence-invalid'): never {
    throw new Error(code);
}

function same(left: unknown, right: unknown): boolean {
    return rpChildAnalysisDigest(left) === rpChildAnalysisDigest(right);
}

function descriptor(input: AgentLoopArtifactRefDescriptor): AgentLoopArtifactRefDescriptor {
    return normalizeAgentLoopArtifactRefDescriptor({
        refId: input.refId,
        kind: input.kind,
        ownerRef: input.ownerRef,
        expectedDigest: input.expectedDigest,
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        policy: input.policy,
        aclClass: input.aclClass,
        expandBudgetTokens: input.expandBudgetTokens,
    });
}

/** Reads original durable evidence; only this invocation's real Session readback can authorize a metadata join. */
export function createRpChildResultEvidenceReader(
    options: Readonly<{
        store: AgentLoopProjectionStore;
        sourceAdapter: RpAnalysisSourceAdapter;
        binding: RpChildAnalysisBindingV1;
        sourceRef: string;
    }>,
) {
    normalizeAgentLoopActionObject(options, ['store', 'sourceAdapter', 'binding', 'sourceRef']);
    const { store, sourceAdapter, sourceRef } = options;
    const binding = normalizeRpChildAnalysisBinding(options.binding);
    const sourceBinding = readRpAnalysisSourceBinding(sourceAdapter);
    if (
        !(store instanceof AgentLoopProjectionStore) ||
        !isRpAnalysisSourceAdapter(sourceAdapter) ||
        !sourceBinding ||
        !same(sourceBinding, binding) ||
        !/^rp-character:sha256:[a-f0-9]{64}$/u.test(sourceRef)
    )
        invalid();
    const issued = new WeakMap<object, AgentLoopActionResultMetadata>();
    const taskId = binding.childTaskId;
    const requiredVerifierIds = Object.freeze(
        RP_CHILD_ANALYSIS_VERIFIER_SET.verifiers.map((entry) => entry.verifierId),
    );

    return Object.freeze({
        read(): RpChildResultEvidenceV1 {
            const record = store.read(taskId);
            if (
                !record ||
                record.fenced ||
                record.envelope.state !== 'COMPLETED' ||
                record.envelope.phase !== 'VERIFY' ||
                record.envelope.currentAttemptId !== binding.childAttemptId ||
                record.envelope.parentTaskId !== binding.parentTaskId ||
                record.envelope.taskKind !== RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind ||
                record.envelope.taskContractRef !== RP_CHILD_ANALYSIS_TASK_CONTRACT.ref ||
                record.envelope.completion?.disposition !== 'passed'
            )
                invalid();
            const { candidateRef, verificationResultRef } = record.envelope.completion;
            if (!candidateRef || !verificationResultRef) invalid();
            const candidate = store.readCompletionCandidate({ taskId, candidateRef });
            const verification = store.readCompletionVerification({ taskId, verificationResultRef });
            if (!candidate || !verification) invalid('rp-child-result-verification-inconclusive');
            if (
                candidate.attemptId !== binding.childAttemptId ||
                candidate.taskKind !== RP_CHILD_ANALYSIS_TASK_CONTRACT.taskKind ||
                candidate.taskContractRef !== RP_CHILD_ANALYSIS_TASK_CONTRACT.ref ||
                candidate.verifierSetRef !== RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRef ||
                candidate.verifierSetRevision !== RP_CHILD_ANALYSIS_VERIFIER_SET.verifierSetRevision ||
                verification.evaluation.verdict !== 'complete' ||
                verification.evaluation.reasonCodes.length !== 0 ||
                verification.evaluation.verifierResults.length !== requiredVerifierIds.length ||
                !requiredVerifierIds.every((id) => {
                    const matches = verification.evaluation.verifierResults.filter((entry) => entry.verifierId === id);
                    return matches.length === 1 && matches[0]!.disposition === 'passed';
                })
            )
                invalid('rp-child-result-verification-inconclusive');
            const events = store.readEvents(taskId);
            const verifyEntries = events.filter(
                (event) =>
                    event.kind === 'completion-requested' &&
                    event.reasonCode === 'request_complete' &&
                    event.revision === candidate.taskRevision,
            );
            if (verifyEntries.length !== 1) invalid();
            const childTaskUpdatedAt = verifyEntries[0]!.acceptedAt;
            const validated = store.assertCompletedCandidate({
                taskId,
                candidateRef,
                verificationResultRef,
                taskUpdatedAt: childTaskUpdatedAt,
            });
            if (validated.revision !== record.revision || validated.envelopeDigest !== record.envelopeDigest) invalid();
            const completions = events.filter((event) => event.kind === 'action-completed');
            if (completions.length !== 1 || candidate.actionWatermark !== completions[0]!.eventId) invalid();
            const actionId = completions[0]!.eventId.slice('action-completed:'.length);
            const receipt = store.readActionReceipt({ taskId, actionId });
            if (
                !receipt ||
                receipt.status !== 'observed' ||
                receipt.attemptId !== binding.childAttemptId ||
                receipt.actionContractRef !== AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT ||
                receipt.expectedRevision !== 3 ||
                receipt.appliedRevision !== 4 ||
                receipt.result === undefined ||
                receipt.settledAt === undefined ||
                receipt.observedAt === undefined ||
                receipt.actionDigest !==
                    agentLoopActionDigest({
                        actionId,
                        taskId,
                        attemptId: binding.childAttemptId,
                        expectedTaskRevision: receipt.expectedRevision,
                        actionContractRef: AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
                        args: { sourceRef },
                    })
            )
                invalid();
            const actual = readRpCharacterActionResult({ sourceAdapter, binding, sourceRef, metadata: receipt.result });
            const artifact = normalizeAgentLoopArtifactRefDescriptor(actual.artifactBundle.descriptor);
            const refs = store.readRefs(taskId);
            const expectedArtifact = normalizeAgentLoopTaskEnvelope({
                ...record.envelope,
                artifacts: [actual.artifactBundle.artifact],
            }).artifacts[0]!;
            const expectedEvidence = Object.freeze([
                ...receipt.result.evidenceRefs,
                receipt.result.payloadDigest,
                receipt.actionDigest,
            ]);
            if (
                refs.length !== 1 ||
                !same(descriptor(refs[0]!), artifact) ||
                !same(record.envelope.artifacts, [expectedArtifact]) ||
                !same(candidate.artifacts, [expectedArtifact]) ||
                !same(candidate.artifactRefs, [artifact.refId]) ||
                verification.evaluation.verifierResults.some((entry) => !same(entry.evidenceRefs, expectedEvidence)) ||
                !same(verification.evaluation.evidenceRefs, [...new Set(expectedEvidence)])
            )
                invalid();
            const base = Object.freeze({
                version: 'agent-loop-rp-child-result-evidence-v1' as const,
                parentTaskId: binding.parentTaskId,
                parentAttemptId: binding.parentAttemptId,
                childTaskId: taskId,
                childAttemptId: binding.childAttemptId,
                childRevision: record.revision,
                childEnvelopeDigest: record.envelopeDigest,
                childTaskUpdatedAt,
                candidateRef,
                candidateDigest: candidate.frozenDigest,
                verificationResultRef,
                verificationDigest: verification.verificationDigest,
                sourceBindingDigest: rpChildAnalysisDigest(binding),
                requiredVerifierIds,
                artifact,
                evidenceRefs: Object.freeze([
                    ...new Set([
                        ...expectedEvidence,
                        candidate.frozenDigest,
                        verification.verificationDigest,
                        artifact.refId,
                    ]),
                ]),
            });
            const proof = Object.freeze({ ...base, proofDigest: rpChildAnalysisDigest(base) });
            // Reread AL after the real owner readback. Concurrent changes never inherit the earlier metadata check.
            const after = store.read(taskId);
            if (!after || after.revision !== record.revision || after.envelopeDigest !== record.envelopeDigest)
                invalid();
            issued.set(proof, receipt.result);
            return proof;
        },
        /** Original AL writer lock holds: this intentionally performs no AL Store access. */
        assertSourceCurrentAtCommit(proof: RpChildResultEvidenceV1): void {
            const metadata = issued.get(proof);
            if (!metadata) invalid();
            readRpCharacterActionResult({ sourceAdapter, binding, sourceRef, metadata });
        },
    });
}
