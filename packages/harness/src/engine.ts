/** P13-A：只供离线评测使用的有界循环，不定义生产 API。 */
import {
  createBudgetLedger,
  type HarnessBudgetLimit,
  type HarnessBudgetPolicy,
  type HarnessClock,
  type HarnessMessage,
  type HarnessModel,
  type HarnessResult,
  type HarnessTerminationReason,
  type HarnessTool,
  type ToolCall,
  type TraceKind,
  type TraceRecorder,
  type TraceStep,
} from './types.ts';
import type { HarnessStore } from './store.ts';

export interface TraceImpl extends TraceRecorder {
  readonly steps: TraceStep[];
}

export function createTrace(clock: HarnessClock, maxSteps = 128): TraceImpl {
  const steps: TraceStep[] = [];
  return {
    steps,
    push(step) {
      if (steps.length >= maxSteps) return;
      steps.push({ index: steps.length, atMs: clock.nowMs(), ...step });
    },
  };
}

export interface HarnessLoopInput {
  readonly model: HarnessModel;
  readonly tools: ReadonlyMap<string, HarnessTool<never>>;
  readonly budget: HarnessBudgetPolicy;
  readonly clock: HarnessClock;
  readonly system: string;
  readonly userMessage: string;
  readonly seededState: Record<string, unknown>;
  readonly store?: HarnessStore;
  /** 可选观测 sink；引擎始终保留自己的有界、脱敏 trace。sink 异常不得影响执行。 */
  readonly trace?: Pick<TraceRecorder, 'push'>;
  readonly signal?: AbortSignal;
  readonly maxInvalidModelSteps?: number;
  /**
   * A successful call to one of these trusted tools is itself a complete result.
   * The tool must still pass schema validation, execute successfully and consume
   * any required write budget before the loop can terminate.
   */
  readonly terminalTools?: ReadonlySet<string>;
  /** P13-C 调用账本身份；离线评测与 P13-B 可省略。 */
  readonly runId?: string;
  readonly inputRevision?: string;
}

type ParsedDecision =
  | { readonly kind: 'final'; readonly final: string }
  | { readonly kind: 'tool'; readonly tool: ToolCall };

function parseDecision(output: string, maxFinalChars: number): ParsedDecision | null {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hasFinal = Object.hasOwn(record, 'final');
  const hasTool = Object.hasOwn(record, 'tool');
  if (hasFinal === hasTool) return null;
  if (hasFinal) {
    return typeof record.final === 'string' && record.final.length > 0
      && record.final.length <= maxFinalChars
      ? { kind: 'final', final: record.final }
      : null;
  }
  if (typeof record.tool !== 'object' || record.tool === null || Array.isArray(record.tool)) return null;
  const tool = record.tool as Record<string, unknown>;
  if (typeof tool.name !== 'string' || tool.name.length === 0 || !Object.hasOwn(tool, 'args')) return null;
  return { kind: 'tool', tool: { name: tool.name, args: tool.args } };
}

function replaceState(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(source));
}

function stateChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean | null {
  try { return JSON.stringify(before) !== JSON.stringify(after); }
  catch { return null; }
}

function safeToolMessage(value: string, maxChars: number): string {
  const clipped = value.length > maxChars ? `${value.slice(0, maxChars)}\n[TRUNCATED]` : value;
  return `UNTRUSTED_TOOL_RESULT\n${clipped}`;
}

const SAFE_MODEL_ERROR_CODES = new Set([
  'provider-rate-limited',
  'provider-timeout',
  'provider-upstream-unavailable',
  'provider-transport-failed',
  'provider-stream-failed',
  'provider-stream-incomplete',
]);

const BUDGET_MODEL_ERROR_CODES = new Map<string, HarnessTerminationReason>([
  ['gateway-model-call-budget-exhausted', 'budget-model-call-exhausted'],
  ['gateway-input-budget-exhausted', 'budget-input-token-exhausted'],
  ['gateway-output-budget-exhausted', 'budget-output-token-exhausted'],
  ['gateway-cost-budget-exhausted', 'budget-cost-exhausted'],
  ['gateway-wall-budget-exhausted', 'budget-wall-time-exhausted'],
  ['maintenance-output-budget-exhausted', 'budget-output-token-exhausted'],
]);

function errorCode(error: unknown): HarnessTerminationReason {
  if (error instanceof DOMException && error.name === 'AbortError') return 'model-failed';
  if (error && typeof error === 'object') {
    let diagnosticCode: unknown;
    try { diagnosticCode = (error as { diagnosticCode?: unknown }).diagnosticCode; }
    catch { diagnosticCode = undefined; }
    if (typeof diagnosticCode === 'string' && SAFE_MODEL_ERROR_CODES.has(diagnosticCode)) {
      return diagnosticCode as HarnessTerminationReason;
    }
    let code: unknown;
    try { code = (error as { code?: unknown }).code; }
    catch { code = undefined; }
    if (typeof code === 'string') {
      const reason = BUDGET_MODEL_ERROR_CODES.get(code);
      if (reason) return reason;
    }
    let message: unknown;
    try { message = (error as { message?: unknown }).message; }
    catch { message = undefined; }
    if (typeof message === 'string') {
      const reason = BUDGET_MODEL_ERROR_CODES.get(message);
      if (reason) return reason;
    }
  }
  return 'model-failed';
}

function isBudgetTermination(
  reason: HarnessTerminationReason,
): reason is `budget-${HarnessBudgetLimit}-exhausted` {
  return reason.startsWith('budget-') && reason.endsWith('-exhausted');
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function budgetTermination(limit: HarnessBudgetLimit): HarnessTerminationReason {
  return `budget-${limit}-exhausted`;
}

export async function runBoundedLoop(input: HarnessLoopInput): Promise<HarnessResult> {
  const budget = createBudgetLedger(input.budget, input.clock);
  const internalTrace = createTrace(input.clock, input.budget.maxTraceSteps);
  const trace: TraceImpl = {
    steps: internalTrace.steps,
    push(step) {
      internalTrace.push(step);
      try { input.trace?.push(step); } catch { /* 观测器不得改变执行语义 */ }
    },
  };
  const state = structuredClone(input.store?.load() ?? input.seededState);
  if (input.store !== undefined) trace.push({ kind: 'store-load', detail: 'store-loaded' });
  const messages: HarnessMessage[] = [{ role: 'user', content: input.userMessage }];
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  input.signal?.addEventListener('abort', externalAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  // 不能 unref：即使模型 Promise 永不 settle，deadline 也必须保持事件循环直到完成拒绝。
  const deadline = setTimeout(() => controller.abort(), input.budget.maxWallMs);
  let invalidSteps = 0;
  const maxInvalid = input.maxInvalidModelSteps ?? 2;
  if (!Number.isSafeInteger(maxInvalid) || maxInvalid < 0) {
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', externalAbort);
    throw new Error('invalid-max-invalid-model-steps');
  }

  const finish = (
    status: HarnessResult['status'],
    finalAnswer: string | null,
    terminationReason: HarnessTerminationReason,
    detail?: { kind: TraceKind; detail: string },
  ): HarnessResult => {
    if (detail) trace.push(detail);
    let committed = false;
    let finalStatus = status;
    let answer = finalAnswer;
    let finalReason = terminationReason;
    if (status === 'final-answer' && input.store !== undefined) {
      try {
        input.store.save(state);
        committed = true;
        trace.push({ kind: 'store-commit', detail: 'store-committed' });
      } catch {
        finalStatus = 'model-error';
        answer = null;
        finalReason = 'store-commit-failed';
        trace.push({ kind: 'model-error', detail: 'store-commit-failed' });
      }
    }
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', externalAbort);
    return {
      status: finalStatus,
      terminationReason: finalReason,
      finalAnswer: answer,
      state: structuredClone(state),
      trace: [...trace.steps],
      budget: budget.snapshot(input.clock),
      committed,
    };
  };

  const stopped = (): HarnessResult | null => {
    if (input.signal?.aborted) return finish(
      'cancelled', null, 'external-cancelled', { kind: 'cancelled', detail: 'external-cancel' },
    );
    if (controller.signal.aborted) return finish(
      'budget-exhausted', null, 'budget-wall-time-exhausted',
      { kind: 'budget-exhausted', detail: 'budget-wall-time-exhausted' },
    );
    const hardLimit = budget.hardLimitReason(input.clock);
    if (hardLimit) return finish(
      'budget-exhausted', null, budgetTermination(hardLimit),
      { kind: 'budget-exhausted', detail: budgetTermination(hardLimit) },
    );
    const exhaustedLimit = budget.exhaustedLimitReason(input.clock);
    if (exhaustedLimit) return finish(
      'budget-exhausted', null, budgetTermination(exhaustedLimit),
      { kind: 'budget-exhausted', detail: budgetTermination(exhaustedLimit) },
    );
    if (!budget.canContinue(input.clock)) return finish(
      'budget-exhausted', null, 'budget-step-exhausted',
      { kind: 'budget-exhausted', detail: 'budget-step-exhausted' },
    );
    return null;
  };

  for (;;) {
    const stop = stopped();
    if (stop) return stop;
    if (!budget.consumeStep(input.clock)) return finish(
      'budget-exhausted', null, budgetTermination(budget.hardLimitReason(input.clock) ?? 'step'),
      { kind: 'budget-exhausted', detail: budgetTermination(budget.hardLimitReason(input.clock) ?? 'step') },
    );
    if (!budget.consumeModel(input.clock)) return finish(
      'budget-exhausted', null, budgetTermination(budget.hardLimitReason(input.clock) ?? 'model-call'),
      { kind: 'budget-exhausted', detail: budgetTermination(budget.hardLimitReason(input.clock) ?? 'model-call') },
    );
    const remainingOutputTokens = budget.remainingOutputTokens();
    if (remainingOutputTokens < 1) {
      const snapshot = budget.snapshot(input.clock);
      const outputLimit = input.budget.maxOutputTokens ?? input.budget.maxTokens;
      const limit: HarnessBudgetLimit = snapshot.outputTokens >= outputLimit ? 'output-token' : 'token';
      return finish('budget-exhausted', null, budgetTermination(limit), {
        kind: 'budget-exhausted', detail: budgetTermination(limit),
      });
    }
    trace.push({ kind: 'model', detail: 'model-call' });
    let completion;
    try {
      completion = await raceWithAbort(input.model.complete({
        system: input.system,
        messages: [...messages],
        maxOutputTokens: remainingOutputTokens,
        signal: controller.signal,
      }), controller.signal);
    } catch (error) {
      if (input.signal?.aborted) return finish(
        'cancelled', null, 'external-cancelled', { kind: 'cancelled', detail: 'external-cancel' },
      );
      if (controller.signal.aborted) {
        return finish('budget-exhausted', null, 'budget-wall-time-exhausted', {
          kind: 'budget-exhausted', detail: 'budget-wall-time-exhausted',
        });
      }
      const reason = errorCode(error);
      if (isBudgetTermination(reason)) return finish('budget-exhausted', null, reason, {
        kind: 'budget-exhausted', detail: reason,
      });
      return finish('model-error', null, reason, { kind: 'model-error', detail: reason });
    }
    if (typeof completion?.content !== 'string' || completion.usage === undefined) {
      return finish('model-error', null, 'invalid-model-completion', {
        kind: 'model-error', detail: 'invalid-model-completion',
      });
    }
    if (!budget.addUsage(completion.usage, input.clock)) {
      const hardLimit = budget.hardLimitReason(input.clock);
      if (!hardLimit) return finish('model-error', null, 'invalid-model-usage', {
        kind: 'model-error', detail: 'invalid-model-usage',
      });
      return finish('budget-exhausted', null, budgetTermination(hardLimit), {
        kind: 'budget-exhausted', detail: budgetTermination(hardLimit),
      });
    }

    const decision = parseDecision(completion.content, input.budget.maxFinalChars);
    if (decision === null) {
      invalidSteps += 1;
      trace.push({ kind: 'model-invalid', detail: 'invalid-protocol' });
      messages.push({ role: 'user', content: '协议错误：仅可返回合法 tool 或 final JSON。' });
      if (invalidSteps > maxInvalid) {
        return finish('budget-exhausted', null, 'invalid-protocol-limit', {
          kind: 'budget-exhausted', detail: 'invalid-protocol-limit',
        });
      }
      continue;
    }
    if (decision.kind === 'final') {
      return finish('final-answer', decision.final, 'completed-final', {
        kind: 'final', detail: 'final-answer',
      });
    }

    if (!budget.consumeTool(input.clock)) {
      const reason = budgetTermination(budget.hardLimitReason(input.clock) ?? 'tool-call');
      return finish('budget-exhausted', null, reason, { kind: 'budget-exhausted', detail: reason });
    }
    const tool = input.tools.get(decision.tool.name) as HarnessTool<never> | undefined;
    if (!tool) {
      invalidSteps += 1;
      trace.push({ kind: 'tool-invalid', detail: 'tool-not-allowed' });
      messages.push({ role: 'tool', content: 'UNTRUSTED_TOOL_RESULT\ntool-not-allowed', toolCallId: 'rejected' });
      if (invalidSteps > maxInvalid) {
        return finish('budget-exhausted', null, 'invalid-protocol-limit', {
          kind: 'budget-exhausted', detail: 'invalid-protocol-limit',
        });
      }
      continue;
    }
    const validated = tool.validate(decision.tool.args);
    if (!validated.ok) {
      invalidSteps += 1;
      trace.push({ kind: 'tool-invalid', detail: `schema-rejected:${tool.name}` });
      messages.push({ role: 'tool', content: 'UNTRUSTED_TOOL_RESULT\nschema-rejected', toolCallId: tool.name });
      if (invalidSteps > maxInvalid) {
        return finish('budget-exhausted', null, 'invalid-protocol-limit', {
          kind: 'budget-exhausted', detail: 'invalid-protocol-limit',
        });
      }
      continue;
    }

    const draft = structuredClone(state);
    const budgetAtCall = budget.snapshot(input.clock);
    let outcome;
    try {
      outcome = await raceWithAbort(tool.execute(validated.value, {
        state: draft,
        signal: controller.signal,
        call: input.runId ? {
          runId: input.runId,
          stepIndex: budgetAtCall.stepsUsed,
          toolCallId: `tool-${budgetAtCall.toolCallsUsed}`,
          inputRevision: input.inputRevision ?? '',
        } : undefined,
      }), controller.signal);
    } catch (error) {
      if (input.signal?.aborted) return finish(
        'cancelled', null, 'external-cancelled', { kind: 'cancelled', detail: 'external-cancel' },
      );
      if (controller.signal.aborted) return finish('budget-exhausted', null, 'budget-wall-time-exhausted', {
        kind: 'budget-exhausted', detail: 'budget-wall-time-exhausted',
      });
      const hardLimit = budget.hardLimitReason(input.clock);
      if (hardLimit) return finish('budget-exhausted', null, budgetTermination(hardLimit), {
        kind: 'budget-exhausted', detail: budgetTermination(hardLimit),
      });
      trace.push({ kind: 'tool-error', detail: `execute-failed:${tool.name}:${errorCode(error)}` });
      messages.push({ role: 'tool', content: 'UNTRUSTED_TOOL_RESULT\nexecute-failed', toolCallId: tool.name });
      continue;
    }
    const hardLimit = budget.hardLimitReason(input.clock);
    if (hardLimit) return finish('budget-exhausted', null, budgetTermination(hardLimit), {
      kind: 'budget-exhausted', detail: budgetTermination(hardLimit),
    });
    if (typeof outcome !== 'object' || outcome === null || typeof outcome.ok !== 'boolean') {
      trace.push({ kind: 'tool-error', detail: `invalid-outcome:${tool.name}` });
      messages.push({ role: 'tool', content: 'UNTRUSTED_TOOL_RESULT\ninvalid-outcome', toolCallId: tool.name });
      continue;
    }
    if (!outcome.ok || typeof outcome.result !== 'string') {
      trace.push({ kind: 'tool-error', detail: `tool-failed:${tool.name}` });
      messages.push({ role: 'tool', content: 'UNTRUSTED_TOOL_RESULT\ntool-failed', toolCallId: tool.name });
      continue;
    }
    const changed = stateChanged(state, draft);
    if (changed === null) {
      trace.push({ kind: 'tool-error', detail: `invalid-state:${tool.name}` });
      messages.push({ role: 'tool', content: 'UNTRUSTED_TOOL_RESULT\ninvalid-state', toolCallId: tool.name });
      continue;
    }
    if (changed) {
      if (!budget.consumeWrite(input.clock)) {
        const reason = budgetTermination(budget.hardLimitReason(input.clock) ?? 'write');
        return finish('budget-exhausted', null, reason, { kind: 'budget-exhausted', detail: reason });
      }
      replaceState(state, draft);
    }
    invalidSteps = 0;
    trace.push({ kind: 'tool-ok', detail: `tool-ok:${tool.name}` });
    messages.push({
      role: 'assistant',
      content: JSON.stringify({ tool: { name: tool.name, args: decision.tool.args } }),
    });
    messages.push({
      role: 'tool',
      content: safeToolMessage(outcome.result, input.budget.maxToolResultChars),
      toolCallId: tool.name,
    });
    if (input.terminalTools?.has(tool.name)) {
      return finish(
        'final-answer',
        'tool-complete'.slice(0, input.budget.maxFinalChars),
        'completed-terminal-tool',
        { kind: 'final', detail: `terminal-tool:${tool.name}` },
      );
    }
  }
}
