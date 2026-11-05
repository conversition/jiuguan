import type { AgentSkillConsumptionOutboxPayloadV1 }
  from '../../../packages/memory/public/agent-skill-consumption-outbox.ts';
import { createHash } from 'node:crypto';
import type { ChatRequest, ChatResponse } from '../../../packages/proxy/public/client.ts';
import { parseContextCompilerInputManifest, type ContextCompilerInputManifestV1, type ContextCompilerInputV1 }
  from '../../../packages/agent-policy/public/context-compiler-input.ts';
import { createContextCompilerSkillSourceReceipt, CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION,
  createContextCompilerSkillSourceReceiptV2, CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2 }
  from '../../../packages/memory/public/context-compiler-skill-source.ts';
import { buildContextCompilerRepairRequest, type ContextCompilerRepairIssue }
  from '../../../packages/harness/context-compiler.ts';
import { CONTEXT_COMPILER_INPUT_VERSION, parseContextCompilerInput, contextCompilerInputManifest }
  from '../../../packages/agent-policy/public/context-compiler-input.ts';
import type { AgentClosureExecutionClass, AgentSkillClosureAttributionV1 } from '../../../packages/agent-closure/index.ts';
import { contextCompilerClosureOperationId } from '../agent-closure-recorder.ts';
import { createServerAgentSkillLiveRequest, createServerAgentSkillLiveCallGroup } from './live-request.ts';
import { assertForegroundSourcePacketSize } from './foreground-source-packet.ts';

export { agentSkillLiveEnabled as contextCompilerSkillLiveEnabled } from './live-request.ts';

export interface ContextCompilerSkillConsumptionIdentity {
  readonly rawSessionId: string;
  readonly runId: string;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly capsuleDigest: string;
  readonly tokenCount: number;
  readonly inputDigest?: string;
}

/** V2 owns a fixed source and accepts only the first request and its host-built repair. */
export function createContextCompilerSkillLiveRecoveryCall(input: {
  readonly broker: Parameters<typeof createServerAgentSkillLiveRequest>[0]['broker'];
  readonly policyVersion: 'p14-q9r-context-compiler-v2';
  readonly identity: Omit<ContextCompilerSkillConsumptionIdentity, 'capsuleDigest' | 'tokenCount'>;
  readonly executionClass: AgentClosureExecutionClass;
  readonly authority: Parameters<typeof createServerAgentSkillLiveRequest>[0]['authority'];
  readonly sourceManifest: ContextCompilerInputManifestV1;
  readonly sourceRequest: ChatRequest;
  readonly sourceInput: Pick<ContextCompilerInputV1, 'sources' | 'targetTokens'>;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly nowMs?: () => number;
}) {
  const nowMs = input.nowMs ?? Date.now;
  const source = parseContextCompilerInput({ version: CONTEXT_COMPILER_INPUT_VERSION,
    sources: input.sourceInput.sources, targetTokens: input.sourceInput.targetTokens });
  const manifest = parseContextCompilerInputManifest(input.sourceManifest);
  if (JSON.stringify(contextCompilerInputManifest(source)) !== JSON.stringify(manifest)
    || manifest.sourceDigest !== input.identity.sourceDigest || input.sourceRequest.model !== input.model) {
    throw new Error('context-compiler-skill-source-invalid');
  }
  const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  assertForegroundSourcePacketSize(input.identity.runId, ({ digest: sampleDigest, timestamp, count, attribution }) => {
    const secondDigest = `sha256:${'f'.repeat(64)}`;
    return {
      run: { operationId: contextCompilerClosureOperationId(input.identity), runId: input.identity.runId,
        sessionId: input.identity.rawSessionId, capability: 'context.compiler', lane: 'interactive', kind: 'advisory',
        executionClass: input.executionClass, sourceRevision: input.identity.sourceRevision,
        policyVersion: input.policyVersion, evidenceDigest: input.identity.sourceDigest, admittedAt: timestamp },
      event: { type: 'context-consumed', idempotencyKey: `consumed-${input.identity.runId}`, occurredAt: timestamp,
        artifactDigest: sampleDigest, sourceRevision: input.identity.sourceRevision, consumerRunId: input.identity.runId,
        contextBlock: 'contextCapsule', tokenCount: count, skillAttribution: attribution },
      prerequisites: [
        { type: 'execution-completed', idempotencyKey: 'execution-completed', occurredAt: timestamp,
          sourceRevision: input.identity.sourceRevision },
        { type: 'artifact-validated', idempotencyKey: 'artifact-validated', occurredAt: timestamp,
          sourceRevision: input.identity.sourceRevision, artifactDigest: sampleDigest },
      ],
      contextCompilerSource: createContextCompilerSkillSourceReceiptV2({
        version: CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2, manifest, sessionId: input.identity.rawSessionId,
        runId: input.identity.runId, sourceRevision: input.identity.sourceRevision, policyVersion: input.policyVersion,
        attempts: [
          { ordinal: 1, phase: 'compile', requestDigest: sampleDigest, responseDigest: sampleDigest, validation: 'rejected' },
          { ordinal: 2, phase: 'repair', requestDigest: secondDigest, responseDigest: sampleDigest, validation: 'accepted' },
        ], requestDigest: secondDigest, capsuleDigest: sampleDigest,
      }),
    };
  }, 'context-compiler-skill-source-too-large');
  let expectedRequest = digest(structuredClone(input.sourceRequest));
  let issued = 0;
  let rejectedContentDigest: string | null = null;
  let repairPrepared = false;
  const outcomes: Array<{ phase: 'compile' | 'repair'; responseDigest: string; validation: 'accepted' | 'rejected' }> = [];
  const call = createServerAgentSkillLiveCallGroup({ ...input, consumerId: 'context.compiler',
    runId: input.identity.runId, parentRunId: input.identity.runId, sourceRevision: input.identity.sourceRevision });
  let capsuleDigest: string | null = null;
  let validatedAt: string | null = null;
  return Object.freeze({
    prepareRequest: (candidate: Parameters<typeof call.prepareRequest>[0]) => {
      let request: ChatRequest;
      try { request = structuredClone(candidate.request); } catch { call.abandon(); throw new Error('context-compiler-skill-request-source-mismatch'); }
      if (issued >= 2 || issued !== outcomes.length || digest(request) !== expectedRequest) {
        call.abandon(); throw new Error('context-compiler-skill-request-source-mismatch');
      }
      issued++;
      return call.prepareRequest({ ...candidate, request });
    },
    recordAttempt(response: ChatResponse, validation: 'accepted' | 'rejected'): void {
      if (issued !== outcomes.length + 1 || (validation !== 'accepted' && validation !== 'rejected')) {
        call.abandon(); throw new Error('context-compiler-skill-attempt-invalid');
      }
      outcomes.push(Object.freeze({ phase: issued === 1 ? 'compile' : 'repair', responseDigest: digest(response), validation }));
      if (issued === 1 && validation === 'rejected') rejectedContentDigest = digest(response.content ?? '');
    },
    buildRepair(previousContent: string, issue: ContextCompilerRepairIssue): ChatRequest {
      if (issued !== 1 || outcomes.length !== 1 || outcomes[0]!.validation !== 'rejected'
        || repairPrepared || digest(previousContent) !== rejectedContentDigest) {
        call.abandon(); throw new Error('context-compiler-skill-repair-invalid');
      }
      const repair = buildContextCompilerRepairRequest({ sources: source.sources, targetTokens: source.targetTokens,
        maxInputTokens: input.maxInputTokens, maxOutputTokens: input.maxOutputTokens, previousContent, issue });
      const request = Object.freeze({ ...repair.request, model: input.model });
      repairPrepared = true;
      expectedRequest = digest(request);
      return request;
    },
    bindValidatedCapsule(value: string): void {
      if (!/^sha256:[a-f0-9]{64}$/u.test(value) || capsuleDigest !== null || outcomes.at(-1)?.validation !== 'accepted') {
        call.abandon(); throw new Error('skill-live-capsule-binding-invalid');
      }
      capsuleDigest = value;
      validatedAt = new Date(nowMs()).toISOString();
    },
    prepareConsumption(used: ContextCompilerSkillConsumptionIdentity): AgentSkillConsumptionOutboxPayloadV1 | null {
      const success = call.seal();
      if (!success || !validatedAt || used.rawSessionId !== input.identity.rawSessionId
        || used.runId !== input.identity.runId || used.sourceRevision !== input.identity.sourceRevision
        || used.sourceDigest !== input.identity.sourceDigest || used.capsuleDigest !== capsuleDigest
        || used.inputDigest !== manifest.inputDigest || success.requestDigests.length !== outcomes.length
        || success.attribution.selectedManifestDigests.length > 1 || success.attribution.activeCandidateDigests.length !== 0) return null;
      const attempts = outcomes.map((entry, index) => Object.freeze({ ordinal: index + 1, ...entry,
        requestDigest: success.requestDigests[index]! }));
      return Object.freeze({
        run: Object.freeze({ operationId: contextCompilerClosureOperationId(used), runId: used.runId, sessionId: used.rawSessionId,
          capability: 'context.compiler', lane: 'interactive', kind: 'advisory', executionClass: input.executionClass,
          sourceRevision: used.sourceRevision, policyVersion: input.policyVersion, evidenceDigest: used.sourceDigest,
          admittedAt: success.admittedAt }),
        event: Object.freeze({ type: 'context-consumed', idempotencyKey: `consumed-${used.runId}`,
          occurredAt: new Date(nowMs()).toISOString(), artifactDigest: used.capsuleDigest, sourceRevision: used.sourceRevision,
          consumerRunId: used.runId, contextBlock: 'contextCapsule', tokenCount: used.tokenCount, skillAttribution: success.attribution }),
        prerequisites: Object.freeze([
          Object.freeze({ type: 'execution-completed', idempotencyKey: 'execution-completed',
            occurredAt: success.executedAt, sourceRevision: used.sourceRevision }),
          Object.freeze({ type: 'artifact-validated', idempotencyKey: 'artifact-validated',
            occurredAt: validatedAt, sourceRevision: used.sourceRevision, artifactDigest: used.capsuleDigest }),
        ]),
        contextCompilerSource: createContextCompilerSkillSourceReceiptV2({
          version: CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION_V2, manifest, sessionId: used.rawSessionId,
          runId: used.runId, sourceRevision: used.sourceRevision, policyVersion: input.policyVersion,
          attempts, requestDigest: success.requestDigests.at(-1)!, capsuleDigest: used.capsuleDigest,
        }),
      });
    },
    abandon: call.abandon,
  });
}

/** One real compilation, one exact capsule, one final-turn handoff. No text is retained here. */
export function createContextCompilerSkillLiveCall(input: {
  readonly broker: Parameters<typeof createServerAgentSkillLiveRequest>[0]['broker'];
  readonly policyVersion: string;
  readonly identity: Omit<ContextCompilerSkillConsumptionIdentity, 'capsuleDigest' | 'tokenCount'>;
  readonly executionClass: AgentClosureExecutionClass;
  readonly authority: Parameters<typeof createServerAgentSkillLiveRequest>[0]['authority'];
  readonly nowMs?: () => number;
  /** Omitted only by historical callers; the deployed live route always supplies both. */
  readonly sourceManifest?: ContextCompilerInputManifestV1;
  readonly sourceRequest?: ChatRequest;
}) {
  const nowMs = input.nowMs ?? Date.now;
  const manifest = input.sourceManifest === undefined ? null : parseContextCompilerInputManifest(input.sourceManifest);
  const requestDigest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  if ((manifest === null) !== (input.sourceRequest === undefined)
    || (manifest && manifest.sourceDigest !== input.identity.sourceDigest)) {
    throw new Error('context-compiler-skill-source-invalid');
  }
  const payloadFor = (used: ContextCompilerSkillConsumptionIdentity, success: {
    readonly admittedAt: string; readonly executedAt: string;
    readonly attribution: AgentSkillClosureAttributionV1; readonly requestDigests: readonly string[];
  }, validatedAt: string, occurredAt: string): AgentSkillConsumptionOutboxPayloadV1 => Object.freeze({
    run: Object.freeze({ operationId: contextCompilerClosureOperationId(used), runId: used.runId, sessionId: used.rawSessionId,
      capability: 'context.compiler', lane: 'interactive', kind: 'advisory', executionClass: input.executionClass,
      sourceRevision: used.sourceRevision, policyVersion: input.policyVersion, evidenceDigest: used.sourceDigest,
      admittedAt: success.admittedAt }),
    event: Object.freeze({ type: 'context-consumed', idempotencyKey: `consumed-${used.runId}`,
      occurredAt, artifactDigest: used.capsuleDigest,
      sourceRevision: used.sourceRevision, consumerRunId: used.runId, contextBlock: 'contextCapsule',
      tokenCount: used.tokenCount, skillAttribution: success.attribution }),
    prerequisites: Object.freeze([
      Object.freeze({ type: 'execution-completed', idempotencyKey: 'execution-completed',
        occurredAt: success.executedAt, sourceRevision: used.sourceRevision }),
      Object.freeze({ type: 'artifact-validated', idempotencyKey: 'artifact-validated',
        occurredAt: validatedAt, sourceRevision: used.sourceRevision, artifactDigest: used.capsuleDigest }),
    ]),
    ...(manifest ? { contextCompilerSource: createContextCompilerSkillSourceReceipt({
      version: CONTEXT_COMPILER_SKILL_SOURCE_RECEIPT_VERSION, manifest,
      sessionId: used.rawSessionId, runId: used.runId, sourceRevision: used.sourceRevision,
      policyVersion: input.policyVersion, requestDigest: success.requestDigests[0]!, capsuleDigest: used.capsuleDigest,
    }) } : {}),
  });
  if (manifest) {
    assertForegroundSourcePacketSize(input.identity.runId, ({ digest, timestamp, count, attribution }) =>
      payloadFor({ ...input.identity, capsuleDigest: digest, tokenCount: count },
        { admittedAt: timestamp, executedAt: timestamp, attribution, requestDigests: [digest] }, timestamp, timestamp),
    'context-compiler-skill-source-too-large');
  }
  const expectedRequestDigest = manifest ? requestDigest(input.sourceRequest) : null;
  const call = createServerAgentSkillLiveRequest({ ...input, consumerId: 'context.compiler',
    runId: input.identity.runId, parentRunId: input.identity.runId, sourceRevision: input.identity.sourceRevision });
  let capsuleDigest: string | null = null;
  let validatedAt: string | null = null;
  return Object.freeze({
    prepareRequest: (candidate: Parameters<typeof call.prepareRequest>[0]) => {
      if (expectedRequestDigest) {
        // Admission may await catalog/body assembly. Keep the verified request private to
        // this call so mutation of the caller's original messages cannot change its source.
        let captured: ChatRequest;
        try { captured = structuredClone(candidate.request); }
        catch {
          call.takeSuccessfulCall(); throw new Error('context-compiler-skill-request-source-mismatch');
        }
        if (requestDigest(captured) !== expectedRequestDigest) {
          call.takeSuccessfulCall(); throw new Error('context-compiler-skill-request-source-mismatch');
        }
        return call.prepareRequest({ ...candidate, request: captured });
      }
      return call.prepareRequest(candidate);
    },
    bindValidatedCapsule(digest: string): void {
      if (!/^sha256:[a-f0-9]{64}$/u.test(digest) || capsuleDigest !== null) {
        call.takeSuccessfulCall(); throw new Error('skill-live-capsule-binding-invalid');
      }
      capsuleDigest = digest;
      validatedAt = new Date(nowMs()).toISOString();
    },
    prepareConsumption(used: ContextCompilerSkillConsumptionIdentity): AgentSkillConsumptionOutboxPayloadV1 | null {
      const success = call.takeSuccessfulCall();
      if (!success || !validatedAt || used.rawSessionId !== input.identity.rawSessionId
        || used.runId !== input.identity.runId || used.sourceRevision !== input.identity.sourceRevision
        || used.sourceDigest !== input.identity.sourceDigest || used.capsuleDigest !== capsuleDigest
        || (manifest && (used.inputDigest !== manifest.inputDigest || success.requestDigests.length !== 1
          || success.attribution.selectedManifestDigests.length > 1 || success.attribution.activeCandidateDigests.length !== 0))) return null;
      return payloadFor(used, success, validatedAt, new Date(nowMs()).toISOString());
    },
  });
}
