import { createHash } from 'node:crypto';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../packages/proxy/public/client.ts';
import { admissionLimitsFromBudgetProfile, agentToolSetDigest } from '../../packages/agent-policy/public/admission.ts';
import { agentBudgetProfileDigest, normalizeAgentBudgetProfile, type AgentBudgetProfileV2 }
  from '../../packages/agent-policy/public/budget-profile.ts';
import { AdmittedModelGateway, type AdmittedModelLeaseAudit } from './admitted-model-gateway.ts';
import type { AdmissionTicketBroker } from './agent-admission-broker.ts';
import type { TurnOperationPhase } from './turn-operation-runtime.ts';

export type SkillFulfillmentPhase = 'requirements' | 'verifier' | 'rewrite' | 'body-repair';
export interface SkillFulfillmentTransportBinding {
  readonly modelId: string;
  /** Already selected, fixed and arbitrated by the trusted host. */
  readonly client: ChatCompletionClient;
  readonly budgetProfile: AgentBudgetProfileV2;
}
export interface SkillFulfillmentTransportIdentity {
  readonly runId: string;
  readonly rawSessionId: string;
  readonly ticketSessionId: string;
  readonly sourceRevision: string;
  readonly sourceDigest: string;
  readonly contentMode: 'nsf' | 'nsfw';
}
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const validDigest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
function assertSync(callback: () => void): void {
  const result: unknown = callback();
  if (result !== undefined) {
    try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* fail closed */ }
    throw new Error('skill-fulfillment-authority-invalid');
  }
}

/**
 * Host-owned, single-turn transport. Requests remain bound to their source,
 * plan and candidate identities; every physical call still uses the existing
 * broker, lane controls, provider arbitration and parent operation hold.
 */
export function createSkillFulfillmentTransport(input: {
  readonly broker: AdmissionTicketBroker;
  readonly operation: { wrap(runId: string, phase: TurnOperationPhase, client: ChatCompletionClient): ChatCompletionClient;
    assertCurrent(runId: string): void; hasRun(runId: string): boolean };
  readonly identity: SkillFulfillmentTransportIdentity;
  readonly bindings: Readonly<Record<SkillFulfillmentPhase, SkillFulfillmentTransportBinding>>;
  readonly deadlineMs: number;
  readonly assertCurrent: () => void;
  readonly authorizeLease: (phase: SkillFulfillmentPhase) => boolean;
  readonly estimateCostMicrousd: (usage: NonNullable<ChatResponse['usage']>, phase: SkillFulfillmentPhase) => number | undefined;
  readonly audit: (entry: AdmittedModelLeaseAudit) => void;
}) {
  const identity = Object.freeze(structuredClone(input.identity));
  if (!identity.runId || !identity.rawSessionId || !identity.ticketSessionId || !identity.sourceRevision
    || !validDigest(identity.sourceDigest) || !['nsf', 'nsfw'].includes(identity.contentMode)
    || !Number.isSafeInteger(input.deadlineMs) || typeof input.assertCurrent !== 'function'
    || typeof input.authorizeLease !== 'function' || typeof input.estimateCostMicrousd !== 'function'
    || typeof input.audit !== 'function' || !input.operation.hasRun(identity.runId)) {
    throw new Error('skill-fulfillment-host-invalid');
  }
  const bindings = Object.freeze(Object.fromEntries((['requirements', 'verifier', 'rewrite', 'body-repair'] as const).map(phase => {
    const value = input.bindings[phase];
    const profile = normalizeAgentBudgetProfile(value.budgetProfile);
    const expectedLane = phase === 'requirements' ? 'interactive' : 'critic';
    if (!value.modelId || !value.client || profile.lane !== expectedLane || profile.maxModelCalls !== 1
      || profile.maxToolCalls !== 0 || profile.maxWrites !== 0) throw new Error('skill-fulfillment-binding-invalid');
    return [phase, Object.freeze({ modelId: value.modelId, client: value.client, budgetProfile: profile })];
  })) as Record<SkillFulfillmentPhase, SkillFulfillmentTransportBinding>);
  let requirements = false, rewritten = false, repaired = false, rewriteAfterSchema = false, inFlight = false, sequence = 0;
  let planDigest: string | null = null, candidateDigest: string | null = null, groupCount = 0;
  const groups = new Set<number>();
  const assertCurrent = () => {
    if (!input.operation.hasRun(identity.runId)) throw new Error('skill-fulfillment-operation-closed');
    input.operation.assertCurrent(identity.runId);
    assertSync(input.assertCurrent);
  };
  return Object.freeze({
    assertCurrent(phase: SkillFulfillmentPhase): void {
      assertCurrent();
      if (input.authorizeLease(phase) !== true) throw new Error('skill-fulfillment-authority-denied');
    },
    async complete(call: { readonly phase: SkillFulfillmentPhase; readonly request: ChatRequest;
      readonly sourceDigest: string; readonly planDigest?: string; readonly candidateDigest?: string;
      readonly groupIndex?: number; readonly groupCount?: number; readonly allowRewriteAfterSchemaRepair?: boolean;
      readonly signal?: AbortSignal }): Promise<ChatResponse> {
      if (inFlight || call.signal?.aborted || !Object.hasOwn(bindings, call.phase)
        || call.sourceDigest !== identity.sourceDigest) throw new Error('skill-fulfillment-call-invalid');
      const binding = bindings[call.phase];
      if (!binding || call.request.model !== binding.modelId || call.request.tools?.length)
        throw new Error('skill-fulfillment-request-invalid');
      if (call.phase === 'requirements') {
        if (requirements || planDigest !== null || call.planDigest !== undefined || call.candidateDigest !== undefined)
          throw new Error('skill-fulfillment-requirements-reused');
        requirements = true;
      } else {
        if (!validDigest(call.planDigest) || !validDigest(call.candidateDigest)) throw new Error('skill-fulfillment-identity-invalid');
        if (planDigest !== null && planDigest !== call.planDigest) throw new Error('skill-fulfillment-plan-stale');
        planDigest = call.planDigest;
        if (call.phase === 'rewrite') {
          if (rewritten || (repaired && !rewriteAfterSchema) || groups.size !== 0) throw new Error('skill-fulfillment-rewrite-exhausted');
          rewritten = true;
          candidateDigest = null;
        } else if (call.phase === 'body-repair') {
          if (repaired || (candidateDigest !== null && candidateDigest !== call.candidateDigest))
            throw new Error('skill-fulfillment-repair-exhausted');
          repaired = true; rewriteAfterSchema = call.allowRewriteAfterSchemaRepair === true; candidateDigest = call.candidateDigest;
        } else {
          if (!Number.isSafeInteger(call.groupCount) || call.groupCount! < 1 || call.groupCount! > 2
            || !Number.isSafeInteger(call.groupIndex) || call.groupIndex! < 0 || call.groupIndex! >= call.groupCount!)
            throw new Error('skill-fulfillment-verifier-group-invalid');
          if (candidateDigest !== null && candidateDigest !== call.candidateDigest) {
            if (!repaired || groups.size !== groupCount) throw new Error('skill-fulfillment-candidate-stale');
            groups.clear(); groupCount = 0;
          }
          candidateDigest = call.candidateDigest;
          if ((groupCount && groupCount !== call.groupCount) || groups.has(call.groupIndex!))
            throw new Error('skill-fulfillment-verifier-group-reused');
          groupCount = call.groupCount!; groups.add(call.groupIndex!);
        }
      }
      assertCurrent();
      if (input.authorizeLease(call.phase) !== true) throw new Error('skill-fulfillment-authority-denied');
      const request = structuredClone(call.request);
      const requestDigest = hash(request), ordinal = ++sequence;
      const taskKind = call.phase === 'requirements' ? 'interactive_prelude' as const : 'critic_revision' as const;
      const policyVersion = 'p14-skill-fulfillment-v1';
      const profile = binding.budgetProfile, profileDigest = agentBudgetProfileDigest(profile);
      const deadlineMs = Math.min(input.deadlineMs, Date.now() + profile.maxWallMs);
      if (deadlineMs <= Date.now()) throw new Error('skill-fulfillment-deadline-exhausted');
      const ticket = input.broker.issue({ runId: identity.runId, parentRunId: identity.runId,
        sessionId: identity.ticketSessionId, sourceRevision: identity.sourceRevision,
        lane: taskKind === 'critic_revision' ? 'critic' : 'interactive', taskKind,
        policyVersion, modelId: binding.modelId, budgetProfileDigest: profileDigest, toolSetDigest: agentToolSetDigest([]),
        mode: identity.contentMode, reasonCodes: ['skill-fulfillment-required'],
        evidenceDigests: [...new Set([identity.sourceDigest, ...(call.planDigest ? [call.planDigest] : []),
          ...(call.candidateDigest ? [call.candidateDigest] : [])])], noveltyDigest: requestDigest,
        expectedBenefit: call.phase === 'body-repair' ? 'draft-correction' : 'fact-verification',
        limits: admissionLimitsFromBudgetProfile(profile), deadlineMs,
        allowedTools: [], fullSkillSnapshots: [], cooldownKey: `skill-fulfillment:${hash(identity.runId).slice(-24)}`,
        idempotencyKey: `skill-fulfillment:${hash(identity.runId).slice(-32)}:${ordinal}`, fallback: 'continue-deterministic' });
      const operationPhase: TurnOperationPhase = call.phase === 'rewrite' ? 'body' : call.phase;
      const gateway = new AdmittedModelGateway(input.broker, input.operation.wrap(identity.runId, operationPhase, binding.client), {
        auditRequired: true, onLeaseClosed: input.audit,
        estimateCostMicrousd: usage => input.estimateCostMicrousd(usage, call.phase),
        prepareRequestRequired: true,
        async prepareRequest(candidate) {
          if (hash(candidate.request) !== requestDigest) return null;
          assertCurrent();
          if (input.authorizeLease(call.phase) !== true) return null;
          return { request: candidate.request, beforeDispatch() { assertCurrent(); }, succeeded() {}, discard() {} };
        },
        authorizeDispatch: () => { assertCurrent(); return input.authorizeLease(call.phase) === true; },
      });
      inFlight = true;
      try {
        return await gateway.complete({ binding: { ticketId: ticket.ticketId, runId: ticket.runId,
          parentRunId: ticket.parentRunId, sessionId: ticket.sessionId, sourceRevision: ticket.sourceRevision,
          lane: ticket.lane, taskKind: ticket.taskKind, policyVersion: ticket.policyVersion, mode: ticket.mode,
          budgetProfile: profile }, request, signal: call.signal });
      } finally { inFlight = false; }
    },
  });
}
