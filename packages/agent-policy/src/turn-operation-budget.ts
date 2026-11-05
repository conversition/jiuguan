import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { normalizeAgentBudgetProfile, type AgentBudgetProfileInput } from './budget-profile.ts';

export const TURN_OPERATION_BUDGET_VERSION = 'turn-operation-budget-v3' as const;

export interface TurnBudgetModelBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly maxRequestInputTokens: number;
  readonly maxRequestOutputTokens: number;
  readonly requestSafetyMarginTokens: number;
}

/** The per-request limits and the cumulative operation limits are independent. */
export interface TurnOperationBudgetV3 {
  readonly version: typeof TURN_OPERATION_BUDGET_VERSION;
  readonly operationId: string;
  readonly modelId: string;
  readonly deadlineMs: number;
  readonly contextWindowTokens: number;
  readonly maxRequestInputTokens: number;
  readonly maxRequestOutputTokens: number;
  readonly requestSafetyMarginTokens: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostMicrousd: number;
  readonly maxModelCalls: number;
  /** When present, every request must name an exact provider/model binding. */
  readonly modelBindings?: readonly TurnBudgetModelBinding[];
}

const keys = ['version', 'operationId', 'modelId', 'deadlineMs', 'contextWindowTokens',
  'maxRequestInputTokens', 'maxRequestOutputTokens', 'requestSafetyMarginTokens',
  'totalInputTokens', 'totalOutputTokens', 'totalCostMicrousd', 'maxModelCalls'] as const;
const bindingKeys = ['providerId', 'modelId', 'contextWindowTokens', 'maxRequestInputTokens',
  'maxRequestOutputTokens', 'requestSafetyMarginTokens'] as const;

function number(value: unknown, name: string, min = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new TypeError(`turn-budget-${name}-invalid`);
  return value as number;
}

function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`turn-budget-${name}-invalid`);
  }
  return value;
}

function validateWindow(value: Pick<TurnBudgetModelBinding, 'maxRequestInputTokens' | 'maxRequestOutputTokens'
  | 'requestSafetyMarginTokens' | 'contextWindowTokens'>): void {
  const inputWindow = value.maxRequestInputTokens + value.requestSafetyMarginTokens;
  const outputWindow = value.maxRequestOutputTokens + value.requestSafetyMarginTokens;
  if (!Number.isSafeInteger(inputWindow) || !Number.isSafeInteger(outputWindow)
    || inputWindow >= value.contextWindowTokens || outputWindow >= value.contextWindowTokens) {
    throw new TypeError('turn-budget-request-window-exceeded');
  }
}

function normalizeBindings(value: readonly TurnBudgetModelBinding[]): readonly TurnBudgetModelBinding[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length < 1 || value.length > 2
    || Reflect.ownKeys(value).some((key) => key !== 'length' && key !== '0' && !(value.length === 2 && key === '1'))) {
    throw new TypeError('turn-budget-model-bindings-invalid');
  }
  const seen = new Set<string>();
  const result: TurnBudgetModelBinding[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('turn-budget-model-bindings-invalid');
    const row = descriptor.value as TurnBudgetModelBinding;
    if (!row || typeof row !== 'object' || types.isProxy(row) || Array.isArray(row)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
      || Reflect.ownKeys(row).some((key) => typeof key !== 'string' || !bindingKeys.includes(key as typeof bindingKeys[number]))
      || bindingKeys.some((key) => !Object.getOwnPropertyDescriptor(row, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(row, key)!, 'value'))) {
      throw new TypeError('turn-budget-model-bindings-invalid');
    }
    const binding: TurnBudgetModelBinding = { providerId: token(row.providerId, 'provider-id'),
      modelId: token(row.modelId, 'model-id'), contextWindowTokens: number(row.contextWindowTokens, 'context-window'),
      maxRequestInputTokens: number(row.maxRequestInputTokens, 'request-input'),
      maxRequestOutputTokens: number(row.maxRequestOutputTokens, 'request-output'),
      requestSafetyMarginTokens: number(row.requestSafetyMarginTokens, 'safety-margin', 0) };
    validateWindow(binding);
    const id = JSON.stringify([binding.providerId, binding.modelId]);
    if (seen.has(id)) throw new TypeError('turn-budget-model-binding-duplicate');
    seen.add(id); result.push(Object.freeze(binding));
  }
  return Object.freeze(result);
}

export function normalizeTurnOperationBudget(value: TurnOperationBudgetV3): TurnOperationBudgetV3 {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || (key !== 'modelBindings' && !keys.includes(key as typeof keys[number])))
    || keys.some((key) => !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
    || (Object.hasOwn(value, 'modelBindings') && (!Object.getOwnPropertyDescriptor(value, 'modelBindings')?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, 'modelBindings')!, 'value')))) {
    throw new TypeError('turn-budget-fields-invalid');
  }
  if (value.version !== TURN_OPERATION_BUDGET_VERSION) throw new TypeError('turn-budget-version-invalid');
  const result: TurnOperationBudgetV3 = {
    version: TURN_OPERATION_BUDGET_VERSION,
    operationId: token(value.operationId, 'operation-id'),
    modelId: token(value.modelId, 'model-id'),
    deadlineMs: number(value.deadlineMs, 'deadline'),
    contextWindowTokens: number(value.contextWindowTokens, 'context-window'),
    maxRequestInputTokens: number(value.maxRequestInputTokens, 'request-input'),
    maxRequestOutputTokens: number(value.maxRequestOutputTokens, 'request-output'),
    requestSafetyMarginTokens: number(value.requestSafetyMarginTokens, 'safety-margin', 0),
    totalInputTokens: number(value.totalInputTokens, 'total-input'),
    totalOutputTokens: number(value.totalOutputTokens, 'total-output'),
    totalCostMicrousd: number(value.totalCostMicrousd, 'total-cost'),
    maxModelCalls: number(value.maxModelCalls, 'calls'),
    ...(Object.hasOwn(value, 'modelBindings') ? { modelBindings: normalizeBindings(value.modelBindings!) } : {}),
  };
  // Maximum input and maximum output need not occur in the same request. The actual
  // combination is checked when reserving each call; do not clamp valid alternatives.
  validateWindow(result);
  if (result.modelBindings && !result.modelBindings.some((binding) => binding.modelId === result.modelId
    && binding.contextWindowTokens === result.contextWindowTokens && binding.maxRequestInputTokens === result.maxRequestInputTokens
    && binding.maxRequestOutputTokens === result.maxRequestOutputTokens
    && binding.requestSafetyMarginTokens === result.requestSafetyMarginTokens)) {
    throw new TypeError('turn-budget-primary-model-mismatch');
  }
  if (!result.modelBindings && (result.maxRequestInputTokens > result.totalInputTokens || result.maxRequestOutputTokens > result.totalOutputTokens)) {
    throw new TypeError('turn-budget-request-exceeds-total');
  }
  return Object.freeze(result);
}

export function turnOperationBudgetDigest(value: TurnOperationBudgetV3): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(normalizeTurnOperationBudget(value))).digest('hex')}`;
}

/** V2 adaptation never multiplies legacy aggregate limits by its call count. */
export function turnOperationBudgetFromV2(input: AgentBudgetProfileInput, identity: {
  operationId: string; modelId: string; deadlineMs: number;
}): TurnOperationBudgetV3 {
  if (!identity || typeof identity !== 'object' || types.isProxy(identity) || Array.isArray(identity)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(identity))
    || Reflect.ownKeys(identity).some((key) => typeof key !== 'string' || !['operationId', 'modelId', 'deadlineMs'].includes(key))
    || ['operationId', 'modelId', 'deadlineMs'].some((key) => !Object.getOwnPropertyDescriptor(identity, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(identity, key)!, 'value'))) {
    throw new TypeError('turn-budget-identity-invalid');
  }
  const v2 = normalizeAgentBudgetProfile(input);
  return normalizeTurnOperationBudget({ version: TURN_OPERATION_BUDGET_VERSION, ...identity,
    contextWindowTokens: v2.providerContextWindowTokens,
    maxRequestInputTokens: v2.agentInputBudgetTokens, maxRequestOutputTokens: v2.agentOutputBudgetTokens,
    requestSafetyMarginTokens: 0, totalInputTokens: v2.agentInputBudgetTokens,
    totalOutputTokens: v2.agentOutputBudgetTokens, totalCostMicrousd: v2.maxCostMicrousd,
    maxModelCalls: v2.maxModelCalls });
}
