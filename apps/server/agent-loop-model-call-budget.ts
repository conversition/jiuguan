/** Pure per-invocation ceiling calculation. No grant, reservation, retry, Ticket or execution. */
import {
  AGENT_LOOP_TASK_BUDGET_KEYS, type AgentLoopTaskBudgetProjectionV1, type AgentLoopTaskBudgetKey,
} from '@jiuguan/agent-loop-contract';
import {
  normalizeAgentBudgetProfile, type AgentBudgetProfileV2,
} from '../../packages/agent-policy/public/budget-profile.ts';

export interface AgentLoopModelCallBudgetInput {
  readonly budget: AgentLoopTaskBudgetProjectionV1;
  readonly hostProfile: Parameters<typeof normalizeAgentBudgetProfile>[0];
  /** One trusted absolute deadline, not now + a refreshed per-call duration. */
  readonly deadlineAtMs: number;
  readonly nowMs: number;
}
const REJECTED = 'agent-loop-model-call-budget-rejected';
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
function reject(): never { throw new Error(REJECTED); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) reject();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) reject();
  return value as Record<string, unknown>;
}
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject();
  return value as number;
}
function epoch(value: unknown): number {
  const result = nonnegative(value);
  if (!Number.isFinite(new Date(result).getTime())) reject();
  return result;
}

/** The result is only a bounded Model profile, never authority for its preserved tool/write fields.
 * maxSteps retains the host's logical ceiling; physical Provider retry slots do not become steps.
 * The caller must persist/revalidate the absolute deadline separately at actual Ticket issuance.
 */
export function deriveAgentLoopModelCallBudget(input: AgentLoopModelCallBudgetInput): AgentBudgetProfileV2 {
  try {
    exact(input, ['budget', 'hostProfile', 'deadlineAtMs', 'nowMs']);
    const budget = exact(input.budget, ['policyRef', 'granted', 'reserved', 'spent']);
    if (typeof budget.policyRef !== 'string' || !TOKEN.test(budget.policyRef)) reject();
    const granted = exact(budget.granted, AGENT_LOOP_TASK_BUDGET_KEYS);
    const reserved = exact(budget.reserved, AGENT_LOOP_TASK_BUDGET_KEYS);
    const spent = exact(budget.spent, AGENT_LOOP_TASK_BUDGET_KEYS);
    const remaining = Object.fromEntries(AGENT_LOOP_TASK_BUDGET_KEYS.map((key) => {
      const grant = nonnegative(granted[key]), reservation = nonnegative(reserved[key]), used = nonnegative(spent[key]);
      const occupied = reservation + used;
      if (!Number.isSafeInteger(occupied) || occupied > grant) reject();
      return [key, grant - occupied];
    })) as Record<AgentLoopTaskBudgetKey, number>;
    const host = normalizeAgentBudgetProfile(input.hostProfile);
    const deadline = epoch(input.deadlineAtMs), now = epoch(input.nowMs), timeLeft = deadline - now;
    if (!Number.isSafeInteger(timeLeft) || timeLeft < 1 || host.maxModelCalls < 1 || remaining.modelCalls < 1) reject();
    const agentInputBudgetTokens = Math.min(host.agentInputBudgetTokens, remaining.inputTokens);
    const agentOutputBudgetTokens = Math.min(host.agentOutputBudgetTokens, remaining.outputTokens);
    const maxCostMicrousd = Math.min(host.maxCostMicrousd, remaining.costMicrousd);
    const maxWallMs = Math.min(host.maxWallMs, remaining.wallMs, timeLeft);
    // A zero cost ceiling is not an assertion that this unknown future call is free.
    if ([agentInputBudgetTokens, agentOutputBudgetTokens, maxCostMicrousd, maxWallMs].some((value) => value < 1)) reject();
    return normalizeAgentBudgetProfile({ ...host, maxModelCalls: 1, agentInputBudgetTokens,
      agentOutputBudgetTokens, maxCostMicrousd, maxWallMs });
  } catch { return reject(); }
}
