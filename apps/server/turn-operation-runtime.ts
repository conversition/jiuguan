import { randomUUID } from 'node:crypto';
import type { ChatCompletionClient, ChatProviderCall, ChatRequest, ChatResponse, ChatToolArgumentDelta }
  from '../../packages/proxy/public/client.ts';
import { normalizeTurnOperationBudget, type TurnOperationBudgetV3 }
  from '../../packages/agent-policy/public/turn-operation-budget.ts';
import { createTurnOperationBudgetClient } from './turn-operation-budget-client.ts';
import type { TurnBudgetHold, TurnOperationBudgetStore } from './turn-operation-budget-store.ts';

export type TurnOperationPhase = 'requirements' | 'compiler' | 'prelude' | 'summary' | 'body' | 'schema-repair' | 'body-repair' | 'critic' | 'verifier';
type BindingRole = 'main' | 'agent';

/** Host-owned provider identity and rates; configurationDigest must not contain credentials. */
export interface TurnOperationRuntimeBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly configurationDigest: string;
  readonly inputMicrousdPerMillionTokens: number;
  readonly outputMicrousdPerMillionTokens: number;
}

export interface TurnOperationRuntimeBegin {
  readonly runId: string;
  readonly sessionId: string;
  readonly profile: TurnOperationBudgetV3;
  readonly bindings: Readonly<Record<BindingRole, TurnOperationRuntimeBinding>>;
  /** Called synchronously at reservation and physical-dispatch boundaries. */
  readonly readCurrentBinding: (role: BindingRole) => TurnOperationRuntimeBinding;
  readonly assertCurrent: () => void;
  /** The host must calculate these pools before performing any model call. */
  readonly holds: Readonly<Record<'compiler' | 'writer' | 'repair' | 'verifier', Omit<TurnBudgetHold, 'holdId'>>>;
}

const phaseBindings: Readonly<Record<TurnOperationPhase, BindingRole>> = Object.freeze({
  requirements: 'agent', compiler: 'agent', prelude: 'agent', summary: 'agent', body: 'main', 'schema-repair': 'main', 'body-repair': 'main', critic: 'agent', verifier: 'agent',
});
const phaseHolds: Readonly<Partial<Record<TurnOperationPhase, 'compiler' | 'writer' | 'repair' | 'verifier'>>> = Object.freeze({
  compiler: 'compiler', body: 'writer', 'schema-repair': 'repair', 'body-repair': 'repair', critic: 'repair', verifier: 'verifier',
});

function captureBinding(value: TurnOperationRuntimeBinding): TurnOperationRuntimeBinding {
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || !value.providerId
    || typeof value.modelId !== 'string' || !value.modelId
    || typeof value.configurationDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.configurationDigest)
    || !Number.isSafeInteger(value.inputMicrousdPerMillionTokens) || value.inputMicrousdPerMillionTokens < 1
    || !Number.isSafeInteger(value.outputMicrousdPerMillionTokens) || value.outputMicrousdPerMillionTokens < 1) {
    throw new Error('turn-operation-runtime-binding-invalid');
  }
  return Object.freeze({ providerId: value.providerId, modelId: value.modelId,
    configurationDigest: value.configurationDigest,
    inputMicrousdPerMillionTokens: value.inputMicrousdPerMillionTokens,
    outputMicrousdPerMillionTokens: value.outputMicrousdPerMillionTokens });
}

function cost(binding: TurnOperationRuntimeBinding, usage: Readonly<{ inputTokens: number; outputTokens: number }>): number {
  const numerator = BigInt(usage.inputTokens) * BigInt(binding.inputMicrousdPerMillionTokens)
    + BigInt(usage.outputTokens) * BigInt(binding.outputMicrousdPerMillionTokens);
  const rounded = (numerator + 999_999n) / 1_000_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('turn-operation-runtime-cost-invalid');
  return Number(rounded);
}

function fence(callback: (() => void) | undefined): void {
  if (!callback) return;
  const result: unknown = callback();
  if (result !== undefined) {
    try { void Promise.prototype.then.call(result, () => {}, () => {}); } catch { /* reject all non-void results */ }
    throw new Error('turn-operation-runtime-fence-invalid');
  }
}

/** A host-owned session scope; no model call is performed by this constructor or begin(). */
export function createTurnOperationRuntime(input: {
  readonly store: TurnOperationBudgetStore;
  readonly allowedSessionIds: ReadonlySet<string>;
}) {
  const allowed = new Set(input.allowedSessionIds);
  if (!allowed.size || [...allowed].some((id) => !id || id === '*')) throw new Error('turn-operation-runtime-scope-invalid');
  const active = new Map<string, object>();
  return Object.freeze({
    begin(options: TurnOperationRuntimeBegin) {
      if (!options.runId || !allowed.has(options.sessionId) || options.profile.operationId !== options.runId
        || typeof options.readCurrentBinding !== 'function' || typeof options.assertCurrent !== 'function') {
        throw new Error('turn-operation-runtime-scope-denied');
      }
      if (active.has(options.runId)) throw new Error('turn-operation-runtime-already-open');
      const runId = options.runId;
      const readCurrentBinding = options.readCurrentBinding;
      const assertCurrent = options.assertCurrent;
      const profile = normalizeTurnOperationBudget(options.profile);
      const bindings = Object.freeze({ main: captureBinding(options.bindings.main), agent: captureBinding(options.bindings.agent) });
      for (const binding of Object.values(bindings)) {
        if (!profile.modelBindings?.some((entry) => entry.providerId === binding.providerId && entry.modelId === binding.modelId)) {
          throw new Error('turn-operation-runtime-profile-binding-mismatch');
        }
      }
      const main = profile.modelBindings!.find((entry) => entry.providerId === bindings.main.providerId
        && entry.modelId === bindings.main.modelId)!;
      const holdIds = ['compiler', 'writer', 'repair', 'verifier'] as const;
      const holds = holdIds.map((holdId) => ({ holdId, ...options.holds[holdId] }));
      fence(assertCurrent);
      for (const role of ['main', 'agent'] as const) {
        if (JSON.stringify(captureBinding(readCurrentBinding(role))) !== JSON.stringify(bindings[role])) {
          throw new Error('turn-operation-runtime-binding-stale');
        }
      }
      input.store.createWithHolds(profile, holds);
      const owner = {};
      active.set(runId, owner);
      let ended = false;
      let repairAttemptUsed = false;
      let schemaRepairAttemptUsed = false;
      const assertActive = (role: BindingRole) => {
        if (ended || active.get(runId) !== owner) throw new Error('turn-operation-runtime-closed');
        fence(assertCurrent);
        if (JSON.stringify(captureBinding(readCurrentBinding(role))) !== JSON.stringify(bindings[role])) {
          throw new Error('turn-operation-runtime-binding-stale');
        }
      };
      const wrap = (phase: TurnOperationPhase, client: ChatCompletionClient): ChatCompletionClient => {
        const role = phaseBindings[phase];
        if (!role) throw new Error('turn-operation-runtime-phase-invalid');
        const binding = bindings[role];
        const invoke = <T>(request: ChatRequest, signal: AbortSignal | undefined, call: ChatProviderCall | undefined,
          work: (wrapped: ChatCompletionClient, guarded: ChatProviderCall) => Promise<T>): Promise<T> => {
          assertActive(role);
          if (call?.runId !== undefined && call.runId !== runId) throw new Error('turn-operation-runtime-run-mismatch');
          if (phase === 'schema-repair') {
            if (schemaRepairAttemptUsed) throw new Error('turn-operation-schema-repair-exhausted');
            schemaRepairAttemptUsed = true;
          }
          if (phase === 'body-repair' || phase === 'critic') {
            if (repairAttemptUsed) throw new Error('turn-operation-repair-exhausted');
            repairAttemptUsed = true;
          }
          const wrapped = createTurnOperationBudgetClient({ client, store: input.store, operationId: runId,
            attemptId: randomUUID(), providerId: binding.providerId, modelId: binding.modelId,
            ...(phaseHolds[phase] ? { holdId: phaseHolds[phase] } : {}),
            estimateCostMicrousd: (usage) => cost(binding, usage) });
          const requestedDeadline = call?.deadlineAt === undefined ? profile.deadlineMs : Date.parse(call.deadlineAt);
          if (!Number.isFinite(requestedDeadline)) throw new Error('turn-operation-runtime-deadline-invalid');
          const guarded: ChatProviderCall = { ...call, runId,
            deadlineAt: new Date(Math.min(profile.deadlineMs, requestedDeadline)).toISOString(),
            beforeDispatch: () => { assertActive(role); fence(call?.beforeDispatch); },
            beforeAdapterDispatch: () => { assertActive(role); fence(call?.beforeAdapterDispatch); } };
          return work(wrapped, guarded);
        };
        return {
          complete: (request: ChatRequest, signal?: AbortSignal, call?: ChatProviderCall) =>
            invoke(request, signal, call, (wrapped, guarded) => wrapped.complete(request, signal, guarded)),
          stream: (request: ChatRequest, onDelta: (delta: string) => void,
            onToolArg?: (name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void,
            signal?: AbortSignal, call?: ChatProviderCall) =>
            invoke(request, signal, call, (wrapped, guarded) => wrapped.stream(request, onDelta, onToolArg, signal, guarded)),
          ...(client.capabilities ? { capabilities: client.capabilities.bind(client) } : {}),
          modelName: () => binding.modelId,
          ...(client.listModels ? { listModels: client.listModels.bind(client) } : {}),
        };
      };
      return Object.freeze({
        modelId: bindings.main.modelId,
        maxOutputTokens: main.maxRequestOutputTokens,
        wrap,
        assertCurrent: () => { assertActive('main'); assertActive('agent'); },
        releaseHold(hold: 'compiler' | 'writer' | 'repair' | 'verifier') {
          assertActive('main');
          if (!holdIds.includes(hold)) throw new Error('turn-operation-runtime-hold-invalid');
          input.store.releaseHold(runId, hold);
        },
        end(_result: { readonly committed: boolean; readonly aborted: boolean }) {
          if (ended) throw new Error('turn-operation-runtime-closed');
          try { input.store.end(runId); }
          finally {
            ended = true;
            if (active.get(runId) === owner) active.delete(runId);
          }
        },
      });
    },
  });
}
