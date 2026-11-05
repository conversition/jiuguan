/** @author Codex @date 2026-10-26 @version 1.0
 * One readonly Character Action; task-result persistence belongs to the Session owner, not Memory facts.
 */
import {
    normalizeRpChildAnalysisBinding,
    normalizeRpChildAnalysisResult,
    rpChildAnalysisDigest,
    type RpChildAnalysisBindingV1,
    type RpChildAnalysisResultV1,
} from '../../packages/memory/public/rp-child-analysis.ts';
import {
    agentLoopActionDigest,
    type AgentLoopActionGatewayPorts,
    type AgentLoopActionRequest,
} from './agent-loop-action-gateway.ts';
import {
    AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
    AGENT_LOOP_RP_CHARACTER_EXPANSION_BUDGET_TOKENS,
    normalizeAgentLoopActionObject,
    normalizeAgentLoopActionResult,
    type AgentLoopActionResultMetadata,
} from './agent-loop-action-receipt.ts';
import type { AgentLoopActionArtifactBundle } from './agent-loop-action-outcome.ts';
import {
    isRpAnalysisSourceAdapter,
    readRpAnalysisSourceBinding,
    type RpAnalysisSourceAdapter,
} from './agent-loop-rp-analysis-source.ts';

export type { RpAnalysisSourceAdapter } from './agent-loop-rp-analysis-source.ts';
export const RP_CHARACTER_ACTION_MAX_RESULT_BYTES = AGENT_LOOP_RP_CHARACTER_EXPANSION_BUDGET_TOKENS;

function invalid(): never {
    throw new Error('rp-character-action-invalid');
}

function assertSourceBinding(source: RpAnalysisSourceAdapter, binding: RpChildAnalysisBindingV1): void {
    const actual = readRpAnalysisSourceBinding(source);
    if (
        !isRpAnalysisSourceAdapter(source) ||
        !actual ||
        rpChildAnalysisDigest(actual) !== rpChildAnalysisDigest(binding)
    )
        invalid();
}

function ownData<T>(input: T): T {
    rpChildAnalysisDigest(input);
    return JSON.parse(JSON.stringify(input)) as T;
}

function soleSource(result: RpChildAnalysisResultV1, binding: RpChildAnalysisBindingV1, sourceRef: string) {
    if (
        result.templateId !== binding.templateId ||
        result.sourceWatermarks.length !== 1 ||
        result.sourceWatermarks[0]!.sourceRef !== sourceRef ||
        rpChildAnalysisDigest(result.sourceWatermarks) !== binding.sourceDigest ||
        result.conclusions.some((item) => item.evidenceRefs.some((ref) => ref !== sourceRef))
    )
        invalid();
    return result.sourceWatermarks[0]!;
}

/** Actual owner readback, not data copied out of the draft or Observation. */
export function readRpCharacterActionResult(
    input: Readonly<{
        sourceAdapter: RpAnalysisSourceAdapter;
        binding: RpChildAnalysisBindingV1;
        sourceRef: string;
        metadata: AgentLoopActionResultMetadata;
    }>,
): Readonly<{ result: RpChildAnalysisResultV1; artifactBundle: AgentLoopActionArtifactBundle }> {
    const binding = normalizeRpChildAnalysisBinding(input.binding);
    assertSourceBinding(input.sourceAdapter, binding);
    const metadata = normalizeAgentLoopActionResult(input.metadata, AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT);
    if (
        metadata.sourceRef !== input.sourceRef ||
        metadata.evidenceRefs[0] !== binding.sourceRevision ||
        metadata.evidenceRefs[3] !== binding.sourceDigest ||
        metadata.evidenceRefs[4] !== rpChildAnalysisDigest(binding) ||
        input.sourceAdapter.ownerRef !== `rp-analysis-owner:${binding.sessionId}`
    )
        invalid();
    const payloadRef = metadata.evidenceRefs[5]!;
    const resolved = input.sourceAdapter.resolve({
        refId: payloadRef,
        kind: 'session-artifact',
        ownerRef: input.sourceAdapter.ownerRef,
        expectedDigest: metadata.payloadDigest,
        expectedRevision: binding.sourceRevision,
    });
    if (
        resolved.status !== 'found' ||
        resolved.digest !== metadata.payloadDigest ||
        resolved.revision !== binding.sourceRevision ||
        resolved.expandable === undefined ||
        resolved.expandable.tokens > RP_CHARACTER_ACTION_MAX_RESULT_BYTES
    )
        invalid();
    const expanded = input.sourceAdapter.expand({
        loaderRef: resolved.expandable.loaderRef,
        budgetTokens: RP_CHARACTER_ACTION_MAX_RESULT_BYTES,
    });
    if (expanded.status !== 'found') invalid();
    const result = normalizeRpChildAnalysisResult(expanded.result);
    const source = soleSource(result, binding, input.sourceRef);
    if (
        rpChildAnalysisDigest(result) !== metadata.payloadDigest ||
        metadata.completeness !== 'complete' ||
        source.revision !== metadata.evidenceRefs[1] ||
        source.digest !== metadata.evidenceRefs[2]
    )
        invalid();
    const artifactBundle: AgentLoopActionArtifactBundle = Object.freeze({
        artifact: Object.freeze({
            artifactRef: payloadRef,
            kind: 'rp-child-analysis',
            status: 'available',
            evidenceRefs: metadata.evidenceRefs,
        }),
        descriptor: Object.freeze({
            refId: payloadRef,
            kind: 'session-artifact',
            ownerRef: input.sourceAdapter.ownerRef,
            expectedDigest: metadata.payloadDigest,
            expectedRevision: binding.sourceRevision,
            policy: 'required',
            aclClass: 'restricted',
            expandBudgetTokens: RP_CHARACTER_ACTION_MAX_RESULT_BYTES,
        }),
    });
    return Object.freeze({ result, artifactBundle });
}

/** Trusted host port only. It neither constructs a Gateway nor grants task/lease/Model execution authority. */
export function createRpCharacterAction(
    options: Readonly<{
        sourceAdapter: RpAnalysisSourceAdapter;
        binding: RpChildAnalysisBindingV1;
        sourceRef: string;
        readDraft: (request: AgentLoopActionRequest) => unknown;
        clock: () => number;
    }>,
) {
    const binding = normalizeRpChildAnalysisBinding(options.binding);
    const { sourceAdapter, sourceRef, readDraft, clock } = options;
    assertSourceBinding(sourceAdapter, binding);
    if (
        typeof readDraft !== 'function' ||
        typeof clock !== 'function' ||
        !/^rp-character:sha256:[a-f0-9]{64}$/u.test(sourceRef) ||
        sourceAdapter.ownerRef !== `rp-analysis-owner:${binding.sessionId}`
    )
        invalid();
    const assertRequest = (input: AgentLoopActionRequest): AgentLoopActionRequest => {
        const request = ownData(input);
        const args = normalizeAgentLoopActionObject(request.args, ['sourceRef']);
        if (
            request.taskId !== binding.childTaskId ||
            request.attemptId !== binding.childAttemptId ||
            request.taskKind !== 'rp.child-analysis' ||
            request.taskContractRef !== 'task.rp-child-analysis.v1' ||
            request.actionContractRef !== AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT ||
            args.sourceRef !== sourceRef
        )
            invalid();
        return Object.freeze(request);
    };
    const execute: AgentLoopActionGatewayPorts['execute'] = async (input) => {
        const request = assertRequest(input.request);
        if (input.contentMode !== 'nsf' || input.actionDigest !== agentLoopActionDigest(request)) invalid();
        const startedAt = clock();
        if (!Number.isSafeInteger(startedAt) || startedAt < 0) invalid();
        const result = normalizeRpChildAnalysisResult(readDraft(request));
        const source = soleSource(result, binding, sourceRef);
        // saveResult performs exactly one real Character read for this sole-source Action,
        // rechecks ACL/source/epoch/mode and appends through the original Session artifact owner.
        const artifact = sourceAdapter.saveResult(result);
        const finishedAt = clock();
        if (!Number.isSafeInteger(finishedAt) || finishedAt < startedAt) invalid();
        const metadata = normalizeAgentLoopActionResult(
            {
                sourceKind: 'tool',
                sourceRef,
                payloadDigest: artifact.payloadDigest,
                // This describes the completed physical read/owner receipt, not the analysis material coverage.
                completeness: 'complete',
                evidenceRefs: [
                    binding.sourceRevision,
                    source.revision,
                    source.digest,
                    binding.sourceDigest,
                    rpChildAnalysisDigest(binding),
                    artifact.payloadRef,
                ],
                usage: {
                    modelCalls: 0,
                    toolCalls: 1,
                    writes: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    costMicrousd: 0,
                    wallMs: finishedAt - startedAt,
                    highRiskActions: 0,
                },
            },
            AGENT_LOOP_RP_CHARACTER_READ_ACTION_CONTRACT,
        );
        readRpCharacterActionResult({ sourceAdapter, binding, sourceRef, metadata });
        return Object.freeze({ receiptRef: `receipt:${request.actionId}`, ...metadata });
    };
    return Object.freeze({
        execute,
        /** Called only after the original Gateway has durably completed/settled its receipt. */
        readArtifactBundle(request: AgentLoopActionRequest, metadata: AgentLoopActionResultMetadata) {
            assertRequest(request);
            return readRpCharacterActionResult({ sourceAdapter, binding, sourceRef, metadata }).artifactBundle;
        },
    });
}
