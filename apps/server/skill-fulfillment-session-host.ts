import { normalizeAgentBudgetProfile } from '../../packages/agent-policy/public/budget-profile.ts';
import type { ChatCompletionClient } from '../../packages/proxy/public/client.ts';
import type { SkillSourceInput } from '../../packages/harness/public/skill-fulfillment-plan.ts';
import type { AdmissionTicketBroker } from './agent-admission-broker.ts';
import type { AdmittedModelLeaseAudit } from './admitted-model-gateway.ts';
import type { createTurnOperationHost } from './turn-operation-host.ts';
import { createSkillFulfillmentHost } from './skill-fulfillment-host.ts';
import { bindSkillFulfillmentStages } from './skill-fulfillment-stages.ts';
import type { SkillFulfillmentPhase } from './skill-fulfillment-transport.ts';

type Selection = { readonly providerId: string; readonly model: string };
type TurnContext = { readonly sessionId: string; readonly sourceRevision: string; readonly contentMode: 'nsf' | 'nsfw';
  readonly assetRevision: string; readonly worldbookSourceRevision: string };
type SessionPort = { readAgentSkillTurnContext(runId: string): TurnContext | null };

/** Dependencies are supplied by the same server runtime which owns admission and provider arbitration. */
export interface SkillFulfillmentSessionHostDependencies {
  readonly getSession: (sessionId: string) => SessionPort | undefined;
  readonly admissionAvailable: () => boolean;
  readonly sessionDeletionAdmissionOpen: (sessionId: string) => boolean;
  readonly readStages: () => string | undefined;
  readonly agentModelBinding: (selection?: Selection) => { readonly selection: Selection; readonly client: ChatCompletionClient };
  readonly mainSelection: () => Selection;
  readonly arbitratedAgentClient: (client: ChatCompletionClient, selection: Selection,
    entry: 'interactive-prelude' | 'critic-revision' | 'interactive-final') => ChatCompletionClient;
  readonly broker: AdmissionTicketBroker;
  readonly authorizeLease: (sessionId: string, phase: SkillFulfillmentPhase) => boolean;
  readonly audit: (entry: AdmittedModelLeaseAudit) => void;
}

export function createSkillFulfillmentSessionHost(deps: SkillFulfillmentSessionHostDependencies,
  rawSessionId: string, operation: ReturnType<typeof createTurnOperationHost>) {
  const started = new Set<string>();
  return Object.freeze({
    begin(value: { readonly runId: string; readonly rawSessionId: string; readonly ticketSessionId: string;
      readonly sourceRevision: string; readonly contentMode: 'nsf' | 'nsfw'; readonly userInput: string;
      readonly skills: readonly SkillSourceInput[]; readonly signal?: AbortSignal }) {
      if (value.rawSessionId !== rawSessionId || !operation.hasRun(value.runId) || !deps.admissionAvailable())
        throw new Error('skill-fulfillment-host-unavailable');
      for (const runId of started) if (!operation.hasRun(runId)) started.delete(runId);
      if (started.has(value.runId)) throw new Error('skill-fulfillment-run-reused');
      started.add(value.runId);
      const session = deps.getSession(rawSessionId);
      const capturedTurn = session?.readAgentSkillTurnContext(value.runId);
      if (!session || !capturedTurn || capturedTurn.sessionId !== value.ticketSessionId
        || capturedTurn.sourceRevision !== value.sourceRevision || capturedTurn.contentMode !== value.contentMode
        || !deps.sessionDeletionAdmissionOpen(rawSessionId)) throw new Error('skill-fulfillment-source-stale');
      const stageConfig = deps.readStages();
      const skills = bindSkillFulfillmentStages(value.skills, stageConfig);
      const agent = deps.agentModelBinding();
      const main = deps.agentModelBinding(deps.mainSelection());
      const selections = { requirements: agent, verifier: agent, rewrite: main, 'body-repair': main } as const;
      const phases = ['requirements', 'verifier', 'rewrite', 'body-repair'] as const;
      const budgets = Object.fromEntries(phases.map(phase => [phase, operation.fulfillmentBudget(value.runId, phase)])) as
        Record<SkillFulfillmentPhase, ReturnType<typeof operation.fulfillmentBudget>>;
      const bindings = Object.fromEntries(phases.map(phase => {
        const selection = selections[phase], budget = budgets[phase], frozen = budget.binding;
        if (selection.selection.providerId !== frozen.providerId || selection.selection.model !== frozen.modelId)
          throw new Error('skill-fulfillment-model-stale');
        const output = frozen.maxRequestOutputTokens;
        const input = Math.min(frozen.maxRequestInputTokens,
          frozen.contextWindowTokens - output - frozen.requestSafetyMarginTokens);
        if (!Number.isSafeInteger(input) || input < 1) throw new Error('skill-fulfillment-window-invalid');
        const numerator = BigInt(input) * BigInt(frozen.inputMicrousdPerMillionTokens)
          + BigInt(output) * BigInt(frozen.outputMicrousdPerMillionTokens);
        const maxCostMicrousd = Number((numerator + 999_999n) / 1_000_000n);
        if (!Number.isSafeInteger(maxCostMicrousd)) throw new Error('skill-fulfillment-cost-invalid');
        const budgetProfile = normalizeAgentBudgetProfile({ autonomyProfile: 'quality-beta',
          lane: phase === 'requirements' ? 'interactive' : 'critic', maxSteps: 1, maxModelCalls: 1,
          maxToolCalls: 0, maxWrites: 0, agentInputBudgetTokens: input, agentOutputBudgetTokens: output,
          finalContextReserveTokens: frozen.contextWindowTokens, finalOutputReserveTokens: 0,
          providerContextWindowTokens: frozen.contextWindowTokens, maxCostMicrousd,
          maxWallMs: Math.max(1, budget.deadlineMs - Date.now()), maxToolResultChars: 0, maxFinalChars: 200_000, maxTraceSteps: 1 });
        const entry = phase === 'requirements' ? 'interactive-prelude' : phase === 'verifier' ? 'critic-revision' : 'interactive-final';
        return [phase, { modelId: frozen.modelId, client: deps.arbitratedAgentClient(selection.client, selection.selection, entry), budgetProfile }];
      })) as Parameters<typeof createSkillFulfillmentHost>[0]['transport']['bindings'];
      const assertCurrent = () => {
        operation.assertCurrent(value.runId);
        const current = session.readAgentSkillTurnContext(value.runId);
        if (value.signal?.aborted || deps.getSession(rawSessionId) !== session || !deps.sessionDeletionAdmissionOpen(rawSessionId)
          || deps.readStages() !== stageConfig || !current
          || current.sessionId !== capturedTurn.sessionId || current.sourceRevision !== capturedTurn.sourceRevision
          || current.contentMode !== capturedTurn.contentMode || current.assetRevision !== capturedTurn.assetRevision
          || current.worldbookSourceRevision !== capturedTurn.worldbookSourceRevision)
          throw new Error('skill-fulfillment-source-stale');
      };
      return createSkillFulfillmentHost({ identity: { runId: value.runId, rawSessionId, ticketSessionId: value.ticketSessionId,
        sourceRevision: value.sourceRevision, contentMode: value.contentMode }, userInput: value.userInput, skills, signal: value.signal,
        transport: { broker: deps.broker, operation, bindings, deadlineMs: budgets.requirements.deadlineMs, assertCurrent,
          authorizeLease: phase => deps.authorizeLease(value.ticketSessionId, phase),
          estimateCostMicrousd: (usage, phase) => {
            const binding = budgets[phase].binding;
            const numerator = BigInt(usage.prompt_tokens) * BigInt(binding.inputMicrousdPerMillionTokens)
              + BigInt(usage.completion_tokens) * BigInt(binding.outputMicrousdPerMillionTokens);
            const cost = Number((numerator + 999_999n) / 1_000_000n);
            return Number.isSafeInteger(cost) ? cost : undefined;
          }, audit: deps.audit } });
    },
  });
}
