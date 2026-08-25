/**
 * prompt 包 - 回合奖励塑形（AQL M2）
 *
 * RL 奖励函数的本场映射（无权重训练，仅系统级策略塑形）：
 *  - AccuracyReward  → 隐式代理："用户未重发/未中止/未删即推进" = 该轮成功（retryIndex==0 → acc=1）
 *  - LengthPenalty   → 成本塑形：RP 长正文是资产，绝不惩罚正文长度；惩罚的是重试链叠加的 token 开销
 *  - StepReward      → 结构完整度弱加成：plan 含 roadmap/key_events/bars_delta 给小额正奖励；不奖励冗长
 * 输出存 turn_ledger.reward（JSON），供归因聚合与阈值决策。
 */
export interface ShapeInput {
  /** 用户重发计数（0=首次生成，1=第 1 次重发…） */
  retryIndex: number;
  aborted?: boolean;
  deleted?: boolean;
  failed?: boolean;
  /** 本回合近似 token 成本（上下文估算） */
  tokenCost?: number;
  /** 契约校验通过（safeParse+normalize+validate 全绿） */
  planOk?: boolean;
  /** 结构完整度 0..1（roadmap/key_events/bars_delta 齐备程度） */
  planStructureScore?: number;
}

export interface ShapeOutput {
  /** 合成奖励（clamp [0,1]） */
  score: number;
  /** 隐式正确性项 */
  acc: number;
  /** 成本塑形项（≤0） */
  cost: number;
  /** 结构加成项（≥0） */
  step: number;
}

/** 回合 token 预算（超出才扣成本分；可 env 覆盖） */
export function qualityTurnBudget(): number {
  return Number(process.env.JG_QUALITY_TURN_BUDGET ?? 6000);
}

/** 超预算惩罚系数（每超 1 token 扣分值；可 env 覆盖） */
export function qualityCostPenalty(): number {
  return Number(process.env.JG_QUALITY_COST_PENALTY ?? 0.0002);
}

/** 结构加成系数（plan 完整度每 1.0 加分；可 env 覆盖） */
export function qualityStepBonus(): number {
  return Number(process.env.JG_QUALITY_STEP_BONUS ?? 0.05);
}

/** 单轮奖励塑形（纯函数，无副作用） */
export function shapeTurnOutcome(i: ShapeInput): ShapeOutput {
  const degraded = Boolean(i.aborted || i.deleted || i.failed);
  // 隐式正确性：未降级且不求助重发 → 1；重发 1 次→0.7、2 次→0.4、3 次→0.1、≥4 次→0（线性衰减）
  const acc = degraded
    ? 0
    : i.retryIndex <= 0 ? 1 : Math.max(0, 1 - 0.3 * i.retryIndex);
  // 成本塑形：仅超预算时扣（重试链叠加 token 开销），绝不惩罚正文长度
  const over = Math.max(0, (i.tokenCost ?? 0) - qualityTurnBudget());
  const cost = -qualityCostPenalty() * over;
  // 结构加成：契约绿 且 plan 结构齐备 → 小额正奖励
  const step = i.planOk && (i.planStructureScore ?? 0) > 0
    ? qualityStepBonus() * Math.min(i.planStructureScore ?? 0, 1)
    : 0;
  const score = Math.max(0, Math.min(1, acc + cost + step));
  return { score, acc, cost, step };
}

/** 从 game_turn plan 估算结构完整度（0..1）：roadmap / key_events / bars_delta 三项占比 */
export function planStructureScore(plan: unknown): number {
  if (!plan || typeof plan !== 'object') return 0;
  const p = plan as Record<string, unknown>;
  const roadmapOk = typeof p.roadmap === 'object' && p.roadmap !== null
    && Boolean((p.roadmap as Record<string, unknown>).current_arc || (p.roadmap as Record<string, unknown>).current_stage);
  const eventsOk = Array.isArray(p.key_events) && (p.key_events as unknown[]).length >= 1;
  const barsOk = typeof p.bars_delta === 'object' && p.bars_delta !== null;
  return (Number(roadmapOk) + Number(eventsOk) + Number(barsOk)) / 3;
}