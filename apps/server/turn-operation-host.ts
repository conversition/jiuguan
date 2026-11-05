import type { ChatCompletionClient } from '../../packages/proxy/public/client.ts';
import { TURN_OPERATION_BUDGET_VERSION, type TurnBudgetModelBinding }
  from '../../packages/agent-policy/public/turn-operation-budget.ts';
import type { TurnBudgetHold, TurnOperationBudgetStore } from './turn-operation-budget-store.ts';
import { createTurnOperationRuntime, type TurnOperationPhase, type TurnOperationRuntimeBinding }
  from './turn-operation-runtime.ts';

export type TurnOperationHostBinding = TurnBudgetModelBinding & TurnOperationRuntimeBinding;
export interface TurnOperationHostSnapshot {
  readonly main: TurnOperationHostBinding;
  readonly agent: TurnOperationHostBinding;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostMicrousd: number;
  readonly maxModelCalls: number;
  readonly maxWallMs: number;
  readonly holds: Readonly<Record<'compiler' | 'writer' | 'repair' | 'verifier', Omit<TurnBudgetHold, 'holdId'>>>;
}

/** The legacy direct client does not invoke the Registry's adapter-dispatch fence. */
export function assertTurnOperationProviderTransport(providerSpiEnabled: boolean): void {
  if (providerSpiEnabled !== true) throw new Error('turn-operation-registry-transport-required');
}

/** Never let a caller supply prices lower than (or different from) the active rate card. */
export function assertTurnOperationRates(binding: TurnOperationRuntimeBinding,
  profile: Readonly<{ inputMicrousdPerMillionTokens?: number; outputMicrousdPerMillionTokens?: number }>,
  env: Readonly<Record<string, string | undefined>>): void {
  const hasProfileRates = profile.inputMicrousdPerMillionTokens !== undefined
    || profile.outputMicrousdPerMillionTokens !== undefined;
  const input = hasProfileRates ? profile.inputMicrousdPerMillionTokens : Number(env.JG_HARNESS_INPUT_MICROUSD_PER_MTOK);
  const output = hasProfileRates ? profile.outputMicrousdPerMillionTokens : Number(env.JG_HARNESS_OUTPUT_MICROUSD_PER_MTOK);
  if (!Number.isSafeInteger(input) || Number(input) < 1 || !Number.isSafeInteger(output) || Number(output) < 1
    || binding.inputMicrousdPerMillionTokens !== input || binding.outputMicrousdPerMillionTokens !== output) {
    throw new Error('turn-operation-rate-card-mismatch');
  }
}

/** The caller supplies an exact session scope and fully resolved configuration, never guessed defaults. */
export function createTurnOperationHost(input: {
  readonly store: TurnOperationBudgetStore;
  readonly sessionId: string;
  readonly readSnapshot: () => TurnOperationHostSnapshot;
  readonly readProviderTokens?: (snapshot: TurnOperationHostSnapshot) => readonly [object | undefined, object | undefined];
  readonly nowMs?: () => number;
}) {
  if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId === '*'
    || typeof input.readSnapshot !== 'function') throw new Error('turn-operation-host-scope-invalid');
  const sessionId = input.sessionId;
  const readSnapshot = input.readSnapshot;
  const nowMs = input.nowMs ?? Date.now;
  const runtime = createTurnOperationRuntime({ store: input.store, allowedSessionIds: new Set([sessionId]) });
  const active = new Map<string, { operation: ReturnType<typeof runtime.begin>; snapshot: TurnOperationHostSnapshot; deadlineMs: number }>();
  return Object.freeze({
    begin(request: Readonly<{ runId: string; sessionId: string; round: number }>) {
      if (request.sessionId !== sessionId || !request.runId || !Number.isSafeInteger(request.round) || request.round < 1) {
        throw new Error('turn-operation-host-scope-denied');
      }
      const runId = request.runId;
      // Private copy fixes both budget and rates for this run; rereading only detects drift.
      const snapshot = structuredClone(readSnapshot());
      const tokens = input.readProviderTokens?.(snapshot);
      if (input.readProviderTokens && (!tokens || !tokens[0] || !tokens[1]))
        throw new Error('turn-operation-provider-binding-unavailable');
      if (!Number.isSafeInteger(snapshot.maxWallMs) || snapshot.maxWallMs < 1 || snapshot.maxWallMs > 300_000
        || !Number.isSafeInteger(snapshot.maxModelCalls) || snapshot.maxModelCalls < 1 || snapshot.maxModelCalls > 12) {
        throw new Error('turn-operation-host-ceiling-invalid');
      }
      const fingerprint = JSON.stringify(snapshot);
      const assertCurrent = () => {
        if (JSON.stringify(readSnapshot()) !== fingerprint) throw new Error('turn-operation-host-configuration-stale');
        if (tokens) {
          const current = input.readProviderTokens!(snapshot);
          if (current[0] !== tokens[0] || current[1] !== tokens[1])
            throw new Error('turn-operation-provider-binding-stale');
        }
      };
      const modelBinding = ({ providerId, modelId, contextWindowTokens, maxRequestInputTokens,
        maxRequestOutputTokens, requestSafetyMarginTokens }: TurnOperationHostBinding): TurnBudgetModelBinding => ({
        providerId, modelId, contextWindowTokens, maxRequestInputTokens, maxRequestOutputTokens, requestSafetyMarginTokens,
      });
      const models = [modelBinding(snapshot.main)];
      if (snapshot.main.providerId !== snapshot.agent.providerId || snapshot.main.modelId !== snapshot.agent.modelId) {
        models.push(modelBinding(snapshot.agent));
      } else if (JSON.stringify(modelBinding(snapshot.main)) !== JSON.stringify(modelBinding(snapshot.agent))) {
        throw new Error('turn-operation-host-model-profile-conflict');
      }
      const deadlineMs = nowMs() + snapshot.maxWallMs;
      if (!Number.isSafeInteger(deadlineMs)) throw new Error('turn-operation-host-deadline-invalid');
      const operation = runtime.begin({ runId, sessionId, bindings: { main: snapshot.main, agent: snapshot.agent },
        readCurrentBinding: (role) => readSnapshot()[role], assertCurrent, holds: snapshot.holds,
        profile: { version: TURN_OPERATION_BUDGET_VERSION, operationId: runId, modelId: snapshot.main.modelId,
          deadlineMs, contextWindowTokens: snapshot.main.contextWindowTokens,
          maxRequestInputTokens: snapshot.main.maxRequestInputTokens,
          maxRequestOutputTokens: snapshot.main.maxRequestOutputTokens,
          requestSafetyMarginTokens: snapshot.main.requestSafetyMarginTokens,
          totalInputTokens: snapshot.totalInputTokens, totalOutputTokens: snapshot.totalOutputTokens,
          totalCostMicrousd: snapshot.totalCostMicrousd, maxModelCalls: snapshot.maxModelCalls, modelBindings: models } });
      active.set(runId, { operation, snapshot, deadlineMs });
      return Object.freeze({ modelId: operation.modelId, maxOutputTokens: operation.maxOutputTokens,
        assertCurrent: operation.assertCurrent,
        end(result: Readonly<{ committed: boolean; aborted: boolean }>) {
          try { operation.end(result); } finally { active.delete(runId); }
        } });
    },
    wrap(runId: string, phase: TurnOperationPhase, client: ChatCompletionClient): ChatCompletionClient {
      const entry = active.get(runId);
      if (!entry) throw new Error('turn-operation-host-run-unavailable');
      return entry.operation.wrap(phase, client);
    },
    assertCurrent(runId: string): void {
      const entry = active.get(runId);
      if (!entry) throw new Error('turn-operation-host-run-unavailable');
      entry.operation.assertCurrent();
    },
    hasRun(runId: string): boolean { return active.has(runId); },
    compilerBudget(runId: string) {
      const entry = active.get(runId);
      if (!entry) throw new Error('turn-operation-host-run-unavailable');
      entry.operation.assertCurrent();
      return Object.freeze({ hold: Object.freeze({ ...entry.snapshot.holds.compiler }),
        binding: Object.freeze({ ...entry.snapshot.agent }), deadlineMs: entry.deadlineMs });
    },
    schemaRepairBudget(runId: string) {
      const entry = active.get(runId);
      if (!entry) throw new Error('turn-operation-host-run-unavailable');
      entry.operation.assertCurrent();
      return Object.freeze({ hold: Object.freeze({ ...entry.snapshot.holds.repair }),
        binding: Object.freeze({ ...entry.snapshot.main }), deadlineMs: entry.deadlineMs });
    },
    fulfillmentBudget(runId: string, phase: 'requirements' | 'verifier' | 'rewrite' | 'body-repair') {
      const entry = active.get(runId);
      if (!entry) throw new Error('turn-operation-host-run-unavailable');
      entry.operation.assertCurrent();
      const role = phase === 'body-repair' || phase === 'rewrite' ? 'main' : 'agent';
      return Object.freeze({ binding: Object.freeze({ ...entry.snapshot[role] }), deadlineMs: entry.deadlineMs });
    },
  });
}
