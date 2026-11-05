import { createHash } from 'node:crypto';
import { admissionLimitsFromBudgetProfile, agentToolSetDigest } from '../../packages/agent-policy/public/admission.ts';
import { agentBudgetProfileDigest, normalizeAgentBudgetProfile } from '../../packages/agent-policy/public/budget-profile.ts';
import { AdmittedModelGateway, type AdmittedModelLeaseAudit } from './admitted-model-gateway.ts';
import type { AdmissionTicketBroker } from './agent-admission-broker.ts';
import type { createSchemaRepairHost } from './schema-repair-host.ts';

type Dispatch = NonNullable<Parameters<typeof createSchemaRepairHost>[0]['dispatch']>;
type Context = { readonly sessionId: string; readonly sourceRevision: string; readonly contentMode: 'nsf' | 'nsfw';
  readonly assetRevision: string; readonly worldbookSourceRevision: string };
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export function createSchemaRepairContextReader<T extends { readAgentSkillTurnContext(runId: string): Context | null }>(
  lookup: () => T | undefined, isOpen: () => boolean): (runId: string) => Context | null {
  let owner: T | undefined;
  return runId => {
    owner ??= lookup();
    return owner && lookup() === owner && isOpen() ? owner.readAgentSkillTurnContext(runId) : null;
  };
}

/** Schema recovery is an admitted, source-fenced child of the existing turn budget. */
export function createSchemaRepairAdmittedDispatcher(input: {
  readonly readContext: (runId: string) => Context | null;
  readonly admissionAvailable: () => boolean;
  readonly authorize: (sessionId: string) => boolean;
  readonly broker: AdmissionTicketBroker;
  readonly audit: (entry: AdmittedModelLeaseAudit) => void;
}): Dispatch {
  return async ({ runId, sourceRevision, candidateDigest, request, signal, operation, budget, assertCurrent: assertBinding, client }) => {
    const captured = input.readContext(runId);
    if (!captured || captured.sourceRevision !== sourceRevision || !input.admissionAvailable())
      throw new Error('schema-repair-admission-unavailable');
    const binding = budget.binding;
    const assertCurrent = () => {
      assertBinding();
      const current = input.readContext(runId);
      if (signal?.aborted || !current || JSON.stringify(current) !== JSON.stringify(captured)
        || !input.admissionAvailable() || input.authorize(captured.sessionId) !== true)
        throw new Error('schema-repair-source-stale');
    };
    assertCurrent();
    const maxInput = Math.min(binding.maxRequestInputTokens,
      binding.contextWindowTokens - binding.maxRequestOutputTokens - binding.requestSafetyMarginTokens,
      budget.hold.inputTokens);
    const maxOutput = request.max_tokens ?? 0;
    const numerator = BigInt(maxInput) * BigInt(binding.inputMicrousdPerMillionTokens)
      + BigInt(maxOutput) * BigInt(binding.outputMicrousdPerMillionTokens);
    const maxCostMicrousd = Math.min(budget.hold.costMicrousd, Number((numerator + 999_999n) / 1_000_000n));
    const profile = normalizeAgentBudgetProfile({ autonomyProfile: 'quality-beta', lane: 'critic', maxSteps: 1,
      maxModelCalls: 1, maxToolCalls: 0, maxWrites: 0, agentInputBudgetTokens: maxInput,
      agentOutputBudgetTokens: maxOutput, finalContextReserveTokens: binding.contextWindowTokens,
      finalOutputReserveTokens: 0, providerContextWindowTokens: binding.contextWindowTokens, maxCostMicrousd,
      maxWallMs: Math.max(1, budget.deadlineMs - Date.now()), maxToolResultChars: 0, maxFinalChars: 200_000, maxTraceSteps: 1 });
    const requestDigest = hash(request), policyVersion = 'p14-skill-fulfillment-v1';
    const ticket = input.broker.issue({ runId, parentRunId: runId, sessionId: captured.sessionId, sourceRevision,
      lane: 'critic', taskKind: 'critic_revision', policyVersion, modelId: binding.modelId,
      budgetProfileDigest: agentBudgetProfileDigest(profile), toolSetDigest: agentToolSetDigest([]), mode: captured.contentMode,
      reasonCodes: ['skill-fulfillment-required'], evidenceDigests: [candidateDigest], noveltyDigest: requestDigest,
      expectedBenefit: 'draft-correction', limits: admissionLimitsFromBudgetProfile(profile), deadlineMs: budget.deadlineMs,
      allowedTools: [], fullSkillSnapshots: [], cooldownKey: `schema-repair:${hash(runId).slice(-24)}`,
      idempotencyKey: `schema-repair:${hash(runId).slice(-32)}`, fallback: 'continue-deterministic' });
    const gateway = new AdmittedModelGateway(input.broker, operation ? operation.wrap(runId, 'schema-repair', client) : client, {
      auditRequired: true, onLeaseClosed: input.audit,
      estimateCostMicrousd: usage => Number((BigInt(usage.prompt_tokens) * BigInt(binding.inputMicrousdPerMillionTokens)
        + BigInt(usage.completion_tokens) * BigInt(binding.outputMicrousdPerMillionTokens) + 999_999n) / 1_000_000n),
      prepareRequestRequired: true,
      async prepareRequest(candidate) {
        if (hash(candidate.request) !== requestDigest) return null;
        assertCurrent();
        return { request: candidate.request, beforeDispatch() { assertCurrent(); }, succeeded() {}, discard() {} };
      },
      authorizeDispatch: () => { assertCurrent(); return true; },
    });
    const response = await gateway.complete({ binding: { ticketId: ticket.ticketId, runId: ticket.runId, parentRunId: ticket.parentRunId,
      sessionId: ticket.sessionId, sourceRevision: ticket.sourceRevision, lane: ticket.lane, taskKind: ticket.taskKind,
      policyVersion: ticket.policyVersion, mode: ticket.mode, budgetProfile: profile }, request, signal });
    assertCurrent();
    return response;
  };
}
