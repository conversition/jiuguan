import { createHash } from 'node:crypto';

export const CONTEXT_BUDGET_PLAN_VERSION = 'context-budget-plan-v1' as const;

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
    if (!Number.isFinite(block.priority)) throw new TypeError(`blocks[${index}].priority must be finite`);
    return {
      index,
      id,
      sourceDigest: nonEmpty(block.sourceDigest, `blocks[${index}].sourceDigest`),
      budgetClass: block.budgetClass,
      tokens,
      priority: block.priority,
      minTokens,
      required: block.required === true,
    };
  });

  const allocated = new Map<string, ContextBudgetDecision>();
  let remaining = elasticBudgetTokens;
  const ordered = [...normalized].sort((a, b) => b.priority - a.priority || a.index - b.index);
  for (const block of ordered) {
    let targetTokens = 0;
    let action: ContextPlanAction = 'drop';
    let reasonCode = 'elastic-budget-exhausted';
    if (block.tokens <= remaining) {
      targetTokens = block.tokens;
      action = 'keep';
      reasonCode = 'within-budget';
    } else if (block.budgetClass === 'elastic' && remaining >= block.minTokens && remaining > 0) {
      targetTokens = remaining;
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

  const elasticDecisions = normalized.map((block) => allocated.get(block.id)!);
  const decisions = [...pinnedDecisions, ...elasticDecisions];
  const reasonCodes: string[] = [];
  if (pinnedTokens > inputBudgetTokens) reasonCodes.push('pinned-core-exceeds-input-budget');
  if (pinnedTokens + toolSchemaTokens > inputBudgetTokens) reasonCodes.push('tool-schema-exceeds-budget');
  if (elasticDecisions.some((decision) => decision.action !== 'keep')) {
    reasonCodes.push('elastic-context-recovery-required');
  }
  if (elasticDecisions.some((decision) => decision.action === 'conflict')) {
    reasonCodes.push('required-elastic-minimum-unmet');
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

