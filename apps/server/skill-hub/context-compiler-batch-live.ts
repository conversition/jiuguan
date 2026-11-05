import { createHash } from 'node:crypto';
import type { ChatRequest, ChatResponse } from '../../../packages/proxy/public/client.ts';
import { estimateTokens } from '../../../packages/prompt/public/assembly.ts';
import { CONTEXT_COMPILER_INPUT_VERSION, parseContextCompilerInput, contextCompilerInputManifest }
  from '../../../packages/agent-policy/public/context-compiler-input.ts';
import { createContextCompilerSkillSourceReceiptV3, CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V3 }
  from '../../../packages/memory/public/context-compiler-skill-source.ts';
import { buildContextCompilerModelRequest, buildContextCompilerRepairRequest, classifyContextCompilerRepair,
  parseAndRenderCompactContextCapsule, type ContextCompilerRepairIssue }
  from '../../../packages/harness/context-compiler.ts';
import { planContextCompilerBatches, buildContextCompilerMergeRequest, buildContextCompilerMergeRepairRequest,
  validateContextCompilerMergedCapsule } from '../../../packages/harness/context-compiler-batch.ts';
import type { AgentSkillConsumptionOutboxPayloadV1 } from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';
import type { AgentSkillClosureAttributionV1 } from '../../../packages/agent-closure/index.ts';
import { contextCompilerClosureOperationId } from '../agent-closure-recorder.ts';
import { createServerAgentSkillLiveCallGroup } from './live-request.ts';
import { assertForegroundSourcePacketSize } from './foreground-source-packet.ts';
import type { ContextCompilerSkillConsumptionIdentity } from './context-compiler-live.ts';

const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
type Phase = 'compile' | 'repair' | 'merge';

/** One frozen source plan and one claimed Skill lease; only host-built requests can enter it. */
export function createContextCompilerSkillLiveBatchCall(input: {
  readonly broker: Parameters<typeof createServerAgentSkillLiveCallGroup>[0]['broker'];
  readonly authority: Parameters<typeof createServerAgentSkillLiveCallGroup>[0]['authority'];
  readonly identity: Omit<ContextCompilerSkillConsumptionIdentity, 'capsuleDigest' | 'tokenCount'>;
  readonly executionClass: 'operational-replay' | 'fixture';
  readonly sourceInput: Parameters<typeof planContextCompilerBatches>[0];
  readonly maxInputTokens: number; readonly maxOutputTokens: number; readonly model: string;
  readonly nowMs?: () => number;
}) {
  const now = input.nowMs ?? Date.now;
  const source = parseContextCompilerInput({ version: CONTEXT_COMPILER_INPUT_VERSION,
    sources: input.sourceInput.sources, targetTokens: input.sourceInput.targetTokens });
  const manifest = contextCompilerInputManifest(source);
  if (manifest.sourceDigest !== input.identity.sourceDigest) throw new Error('context-compiler-skill-source-invalid');
  const plan = planContextCompilerBatches({ ...input.sourceInput, sources: source.sources });
  const policyVersion = 'p14-q9r-context-compiler-v2' as const;
  const attempts: Array<{ phase: Phase; responseDigest: string; validation: 'accepted' | 'rejected' }> = [];
  const capsules: Array<ReturnType<typeof parseAndRenderCompactContextCapsule>['capsule']> = [];
  const call = createServerAgentSkillLiveCallGroup({ ...input, policyVersion, consumerId: 'context.compiler',
    runId: input.identity.runId, parentRunId: input.identity.runId, sourceRevision: input.identity.sourceRevision });
  const payloadFor = (used: ContextCompilerSkillConsumptionIdentity & { renderDigest: string }, success: {
    admittedAt: string; executedAt: string; attribution: AgentSkillClosureAttributionV1; requestDigests: readonly string[];
  }, outcomes: readonly typeof attempts[number][], validatedAt: string, occurredAt: string): AgentSkillConsumptionOutboxPayloadV1 => ({
    run: { operationId: contextCompilerClosureOperationId(used), runId: used.runId, sessionId: used.rawSessionId,
      capability: 'context.compiler', lane: 'interactive', kind: 'advisory', executionClass: input.executionClass,
      sourceRevision: used.sourceRevision, policyVersion, evidenceDigest: used.sourceDigest, admittedAt: success.admittedAt },
    event: { type: 'context-consumed', idempotencyKey: `consumed-${used.runId}`, occurredAt,
      artifactDigest: used.capsuleDigest, sourceRevision: used.sourceRevision, consumerRunId: used.runId,
      contextBlock: 'contextCapsule', tokenCount: used.tokenCount, skillAttribution: success.attribution },
    prerequisites: [{ type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: success.executedAt,
      sourceRevision: used.sourceRevision }, { type: 'artifact-validated', idempotencyKey: 'artifact-validated',
      occurredAt: validatedAt, sourceRevision: used.sourceRevision, artifactDigest: used.capsuleDigest }],
    contextCompilerSource: createContextCompilerSkillSourceReceiptV3({ version: CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V3,
      manifest, sessionId: used.rawSessionId, runId: used.runId, sourceRevision: used.sourceRevision, policyVersion,
      attempts: outcomes.map((entry, index) => ({ ordinal: index + 1, ...entry, requestDigest: success.requestDigests[index]! })),
      requestDigest: success.requestDigests.at(-1)!, capsuleDigest: used.capsuleDigest, renderDigest: used.renderDigest,
      fragmentDigest: plan.fragmentDigest, fragments: plan.fragments }),
  });
  assertForegroundSourcePacketSize(input.identity.runId, ({ digest: sample, timestamp, count, attribution }) => {
    const phases: Phase[] = plan.batches.length === 2 ? ['compile', 'repair', 'compile', 'merge'] : ['compile', 'repair'];
    const requestDigests = phases.map((_, index) => `sha256:${String(index + 1).repeat(64)}`);
    const outcomes = phases.map((phase, index) => ({ phase, responseDigest: sample,
      validation: index === 0 ? 'rejected' as const : 'accepted' as const }));
    return payloadFor({ ...input.identity, capsuleDigest: sample, renderDigest: sample, tokenCount: count },
      { admittedAt: timestamp, executedAt: timestamp, attribution, requestDigests }, outcomes, timestamp, timestamp);
  }, 'context-compiler-skill-source-too-large');
  let logical: 'compile' | 'merge' = 'compile';
  let phase: Phase = 'compile', expectedRequest = '', issued = false, repairs = 0;
  let rejected: { content: string; issue: ContextCompilerRepairIssue } | null = null;
  let final: ReturnType<typeof parseAndRenderCompactContextCapsule> | null = null;
  let validatedAt: string | null = null;
  const compileInput = () => ({ sources: plan.batches[capsules.length]!, targetTokens: source.targetTokens,
    maxInputTokens: input.maxInputTokens, maxOutputTokens: input.maxOutputTokens });
  const mergeInput = () => ({ sources: source.sources, targetTokens: source.targetTokens,
    maxInputTokens: input.maxInputTokens, maxOutputTokens: input.maxOutputTokens, fragments: plan.fragments, capsules });
  const nextRequest = (): ChatRequest => {
    if (issued || final || attempts.length >= (plan.batches.length === 2 ? 4 : 2)) throw new Error('context-compiler-series-invalid');
    let request: ChatRequest;
    if (rejected) {
      if (repairs >= 1) throw new Error('context-compiler-repair-exhausted');
      repairs++; phase = 'repair';
      request = logical === 'compile' ? buildContextCompilerRepairRequest({ ...compileInput(), previousContent: rejected.content,
        issue: rejected.issue }).request : buildContextCompilerMergeRepairRequest({ ...mergeInput(),
        previousContent: rejected.content, issue: rejected.issue });
    } else if (capsules.length < plan.batches.length) {
      logical = 'compile'; phase = 'compile'; request = buildContextCompilerModelRequest(compileInput()).request;
    } else {
      logical = 'merge'; phase = 'merge'; request = buildContextCompilerMergeRequest(mergeInput()).request;
    }
    rejected = null;
    const captured = Object.freeze({ ...request, model: input.model });
    expectedRequest = digest(captured);
    return captured;
  };
  return Object.freeze({
    batchCount: plan.batches.length,
    nextRequest,
    prepareRequest: (candidate: Parameters<typeof call.prepareRequest>[0]) => {
      const request = structuredClone(candidate.request);
      if (issued || !expectedRequest || digest(request) !== expectedRequest) { call.abandon(); throw new Error('context-compiler-skill-request-source-mismatch'); }
      issued = true; expectedRequest = '';
      return call.prepareRequest({ ...candidate, request });
    },
    recordResponse(response: ChatResponse): boolean {
      if (!issued || response.finishReason !== 'stop' || response.toolCalls.length !== 0)
        throw new Error('context-compiler-output-incomplete');
      issued = false;
      const expectation = logical === 'compile' ? buildContextCompilerModelRequest(compileInput()).expectation
        : buildContextCompilerMergeRequest(mergeInput()).expectation;
      let parsed: ReturnType<typeof parseAndRenderCompactContextCapsule>;
      try {
        parsed = parseAndRenderCompactContextCapsule({ content: response.content ?? '', expectation,
          maxStructuredTokens: input.maxOutputTokens,
          maxRenderedTokens: logical === 'compile' && plan.batches.length === 2 ? 8_000 : source.targetTokens
            + estimateTokens('<上下文胶囊 version="context-capsule-v2">\n\n</上下文胶囊>') });
      } catch (error) {
        const issue = classifyContextCompilerRepair(error);
        if (!issue || repairs >= 1) throw error;
        attempts.push({ phase, responseDigest: digest(response), validation: 'rejected' });
        rejected = { content: response.content ?? '', issue };
        return false;
      }
      if (logical === 'merge') validateContextCompilerMergedCapsule({ content: response.content ?? '', expectation,
        fragments: plan.fragments, capsules });
      attempts.push({ phase, responseDigest: digest(response), validation: 'accepted' });
      if (logical === 'compile' && plan.batches.length === 2) { capsules.push(parsed.capsule); return false; }
      final = parsed; validatedAt = new Date(now()).toISOString();
      return true;
    },
    result() {
      if (!final) throw new Error('context-compiler-series-incomplete');
      return Object.freeze({ version: 'context-compiler-compact-result-v2' as const, ...final });
    },
    prepareConsumption(used: ContextCompilerSkillConsumptionIdentity & { renderDigest?: string }): AgentSkillConsumptionOutboxPayloadV1 | null {
      const success = call.seal();
      if (!success || !final || !validatedAt || used.rawSessionId !== input.identity.rawSessionId || used.runId !== input.identity.runId
        || used.sourceRevision !== input.identity.sourceRevision || used.sourceDigest !== input.identity.sourceDigest
        || used.inputDigest !== manifest.inputDigest || used.capsuleDigest !== final.capsuleDigest || used.renderDigest !== final.renderDigest
        || success.requestDigests.length !== attempts.length || success.attribution.selectedManifestDigests.length > 1
        || success.attribution.activeCandidateDigests.length !== 0) return null;
      return payloadFor({ ...used, renderDigest: final.renderDigest }, success, attempts, validatedAt, new Date(now()).toISOString());
    },
    abandon: call.abandon,
  });
}
