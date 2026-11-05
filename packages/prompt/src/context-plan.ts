import { createHash } from 'node:crypto';

export const CONTEXT_BUDGET_PLAN_VERSION = 'context-budget-plan-v1' as const;

/**
 * **出站硬阻断码**（闭集）。命中任意一个即表示「这一轮无论怎么裁剪都放不进去」：
 * 受保护块自身超预算、工具 schema 超预算、或必需 elastic 块连最低保留都放不下。
 * 这类冲突不能再靠丢上下文缓解 —— 继续发送只会让上游按长度失败，
 * 再被兜底清理孤儿行、回退轮次（用户看到的就是「第二轮过不去」）。
 *
 * 调用方必须在**任何 Provider 调用之前**据此拒绝，并把 `planDigest` 一起记进证据。
 */
export const CONTEXT_PLAN_BLOCKING_REASON_CODES = Object.freeze([
    'pinned-core-exceeds-input-budget',
    'tool-schema-exceeds-budget',
    'required-elastic-minimum-unmet',
] as const);

export type ContextPlanBlockingReasonCode = typeof CONTEXT_PLAN_BLOCKING_REASON_CODES[number];

/** 从计划里挑出阻断码（保持码点序，便于 digest 与日志稳定）。 */
export function contextPlanBlockingReasonCodes(
    plan: Readonly<{ reasonCodes: readonly string[] }>,
): readonly ContextPlanBlockingReasonCode[] {
    const blocking = new Set<string>(CONTEXT_PLAN_BLOCKING_REASON_CODES);
    return Object.freeze(
        [...new Set(plan.reasonCodes.filter((code) => blocking.has(code)))].sort(),
    ) as readonly ContextPlanBlockingReasonCode[];
}


export interface ContextModelProfile {
  readonly modelContextTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyMarginTokens: number;
}

export interface ContextPlanBlock {
  readonly id: string;
  readonly sourceDigest: string;
  readonly budgetClass: 'elastic' | 'droppable';
  readonly tokens: number;
  readonly priority: number;
  readonly minTokens?: number;
  /** Optional soft first-pass allocation; unclaimed capacity may be borrowed up to tokens. */
  readonly preferredTokens?: number;
  /** A required elastic block enters recovery instead of being silently dropped below its minimum. */
  readonly required?: boolean;
}

export interface ContextPlanSnapshot {
  readonly pinnedBlocks: readonly {
    readonly id: string;
    readonly sourceDigest: string;
    readonly tokens: number;
  }[];
  readonly toolSchemaTokens: number;
  readonly blocks: readonly ContextPlanBlock[];
}

export interface ContextPlanSkills {
  readonly admitted: readonly {
    readonly digest: string;
    readonly tokens: number;
  }[];
  readonly rejectedAutoSkillDigests?: readonly string[];
}

export type ContextPlanAction = 'keep' | 'reduce' | 'drop' | 'conflict';

export interface ContextBudgetDecision {
  readonly id: string;
  readonly sourceDigest: string;
  readonly budgetClass: 'pinned' | 'elastic' | 'droppable';
  readonly priority: number;
  readonly minTokens: number;
  readonly tokens: number;
  readonly targetTokens: number;
  readonly action: ContextPlanAction;
  readonly reasonCode: string;
}

export interface ContextBudgetPlan {
  readonly version: typeof CONTEXT_BUDGET_PLAN_VERSION;
  readonly planDigest: string;
  readonly modelContextTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyMarginTokens: number;
  readonly inputBudgetTokens: number;
  readonly pinnedTokens: number;
  readonly elasticBudgetTokens: number;
  readonly toolSchemaTokens: number;
  readonly decisions: readonly ContextBudgetDecision[];
  readonly admittedSkillDigests: readonly string[];
  readonly rejectedAutoSkillDigests: readonly string[];
  readonly predictedPromptTokens: number;
  readonly recoveryRequired: boolean;
  readonly reasonCodes: readonly string[];
}

function integer(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be non-empty`);
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function digestPlan(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

/**
 * Pure token planner. It never receives prompt text and never mutates business state.
 * Callers must apply targetTokens with deterministic reducers or enter the recovery chain.
 */
export function planTurnContextBudget(
  snapshot: ContextPlanSnapshot,
  modelProfile: ContextModelProfile,
  skills: ContextPlanSkills,
): ContextBudgetPlan {
  const modelContextTokens = integer(modelProfile.modelContextTokens, 'modelContextTokens', 1);
  const outputReserveTokens = integer(modelProfile.outputReserveTokens, 'outputReserveTokens', 1);
  const safetyMarginTokens = integer(modelProfile.safetyMarginTokens, 'safetyMarginTokens');
  if (outputReserveTokens + safetyMarginTokens >= modelContextTokens) {
    throw new TypeError('output reserve plus safety margin must be smaller than model context');
  }
  const inputBudgetTokens = modelContextTokens - outputReserveTokens - safetyMarginTokens;
  const toolSchemaTokens = integer(snapshot.toolSchemaTokens, 'toolSchemaTokens');

  const seenIds = new Set<string>();
  const pinnedDecisions: ContextBudgetDecision[] = snapshot.pinnedBlocks.map((block, index) => {
    const id = nonEmpty(block.id, `pinnedBlocks[${index}].id`);
    if (seenIds.has(id)) throw new TypeError(`duplicate context block id: ${id}`);
    seenIds.add(id);
    return {
      id,
      sourceDigest: nonEmpty(block.sourceDigest, `pinnedBlocks[${index}].sourceDigest`),
      budgetClass: 'pinned',
      priority: Number.MAX_SAFE_INTEGER,
      minTokens: integer(block.tokens, `pinnedBlocks[${index}].tokens`),
      tokens: integer(block.tokens, `pinnedBlocks[${index}].tokens`),
      targetTokens: integer(block.tokens, `pinnedBlocks[${index}].tokens`),
      action: 'keep',
      reasonCode: 'pinned-core',
    };
  });

  const admittedByDigest = new Map<string, number>();
  for (const [index, skill] of skills.admitted.entries()) {
    const digest = nonEmpty(skill.digest, `skills.admitted[${index}].digest`);
    const tokens = integer(skill.tokens, `skills.admitted[${index}].tokens`);
    const previous = admittedByDigest.get(digest);
    if (previous !== undefined && previous !== tokens) {
      throw new TypeError(`duplicate Skill digest has conflicting tokens: ${digest}`);
    }
    admittedByDigest.set(digest, tokens);
  }
  const admittedSkillDigests = [...admittedByDigest.keys()].sort((a, b) => a.localeCompare(b));
  const skillTokens = [...admittedByDigest.values()].reduce((sum, tokens) => sum + tokens, 0);
  const pinnedTokens = pinnedDecisions.reduce((sum, block) => sum + block.tokens, 0) + skillTokens;
  const elasticBudgetTokens = Math.max(0, inputBudgetTokens - pinnedTokens - toolSchemaTokens);

  const normalized = snapshot.blocks.map((block, index) => {
    const id = nonEmpty(block.id, `blocks[${index}].id`);
    if (seenIds.has(id)) throw new TypeError(`duplicate context block id: ${id}`);
    seenIds.add(id);
    const tokens = integer(block.tokens, `blocks[${index}].tokens`);
    const minTokens = integer(block.minTokens ?? 0, `blocks[${index}].minTokens`);
    if (minTokens > tokens) throw new TypeError(`blocks[${index}].minTokens cannot exceed tokens`);
    const preferredTokens = integer(block.preferredTokens ?? tokens, `blocks[${index}].preferredTokens`);
    if (preferredTokens < minTokens || preferredTokens > tokens) {
      throw new TypeError(`blocks[${index}].preferredTokens must be between minTokens and tokens`);
    }
    if (!Number.isFinite(block.priority)) throw new TypeError(`blocks[${index}].priority must be finite`);
    return {
      index,
      id,
      sourceDigest: nonEmpty(block.sourceDigest, `blocks[${index}].sourceDigest`),
      budgetClass: block.budgetClass,
      tokens,
      priority: block.priority,
      minTokens,
      preferredTokens,
      required: block.required === true,
    };
  });

  const allocated = new Map<string, ContextBudgetDecision>();
  let remaining = elasticBudgetTokens;
  const ordered = [...normalized].sort((a, b) => b.priority - a.priority || a.index - b.index);
  let requiredMinimum = ordered.reduce((sum, block) => sum + (block.required ? block.minTokens : 0), 0);
  for (const block of ordered) {
    requiredMinimum -= block.required ? block.minTokens : 0;
    // A higher-priority optional block cannot consume a later required block's minimum.
    const available = Math.max(0, remaining - requiredMinimum);
    let targetTokens = 0;
    let action: ContextPlanAction = 'drop';
    let reasonCode = 'elastic-budget-exhausted';
    if (block.tokens <= available) {
      targetTokens = block.preferredTokens;
      action = targetTokens === block.tokens ? 'keep' : 'reduce';
      reasonCode = targetTokens === block.tokens ? 'within-budget' : 'elastic-target-reduced';
    } else if (block.budgetClass === 'elastic' && available >= block.minTokens && available > 0) {
      targetTokens = Math.min(available, block.preferredTokens);
      action = 'reduce';
      reasonCode = 'elastic-target-reduced';
    } else if (block.required) {
      action = 'conflict';
      reasonCode = 'required-elastic-minimum-unmet';
    } else if (block.budgetClass === 'droppable') {
      reasonCode = 'optional-block-rejected';
    }
    remaining -= targetTokens;
    allocated.set(block.id, {
      id: block.id,
      sourceDigest: block.sourceDigest,
      budgetClass: block.budgetClass,
      priority: block.priority,
      minTokens: block.minTokens,
      tokens: block.tokens,
      targetTokens,
      action,
      reasonCode,
    });
  }

  // Only explicit soft targets participate in borrowing; legacy plans retain their first-pass behavior.
  for (const block of ordered) {
    if (block.preferredTokens === block.tokens || remaining === 0) continue;
    const decision = allocated.get(block.id)!;
    if (decision.action === 'conflict') continue;
    const borrowed = Math.min(remaining, block.tokens - decision.targetTokens);
    if (borrowed === 0) continue;
    remaining -= borrowed;
    const targetTokens = decision.targetTokens + borrowed;
    allocated.set(block.id, {
      ...decision,
      targetTokens,
      action: targetTokens === block.tokens ? 'keep' : 'reduce',
      reasonCode: targetTokens === block.tokens ? 'within-budget' : 'elastic-target-reduced',
    });
  }

  const elasticDecisions = normalized.map((block) => allocated.get(block.id)!);
  const decisions = [...pinnedDecisions, ...elasticDecisions];
  const reasonCodes: string[] = [];
  const [PINNED_BLOCKING, TOOL_BLOCKING, REQUIRED_BLOCKING] = CONTEXT_PLAN_BLOCKING_REASON_CODES;
  if (pinnedTokens > inputBudgetTokens) reasonCodes.push(PINNED_BLOCKING);
  if (pinnedTokens + toolSchemaTokens > inputBudgetTokens) reasonCodes.push(TOOL_BLOCKING);
  if (elasticDecisions.some((decision) => decision.action !== 'keep')) {
    reasonCodes.push('elastic-context-recovery-required');
  }
  if (elasticDecisions.some((decision) => decision.action === 'conflict')) {
    reasonCodes.push(REQUIRED_BLOCKING);
  }
  const predictedPromptTokens = pinnedTokens + toolSchemaTokens
    + elasticDecisions.reduce((sum, decision) => sum + decision.targetTokens, 0);
  const rejectedAutoSkillDigests = uniqueStrings(skills.rejectedAutoSkillDigests ?? []);
  const stable = {
    version: CONTEXT_BUDGET_PLAN_VERSION,
    modelContextTokens,
    outputReserveTokens,
    safetyMarginTokens,
    inputBudgetTokens,
    pinnedTokens,
    elasticBudgetTokens,
    toolSchemaTokens,
    decisions,
    admittedSkillDigests,
    rejectedAutoSkillDigests,
    predictedPromptTokens,
    recoveryRequired: reasonCodes.length > 0,
    reasonCodes: uniqueStrings(reasonCodes),
  };
  return Object.freeze({ ...stable, planDigest: digestPlan(stable) });
}

