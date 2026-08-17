/**
 * prompt 包 - 上下文调度层（L2 · 自研）
 *
 * 输入：L1 已激活的上下文块（有资格）。本层只负责「按什么顺序、花多少 token 喂」：
 *   - 每块声明 cost（token 上限）与 priority（优先级，越大越先保留）
 *   - 按 priority 降序贪婪保留 → 全局 CONTEXT_BUDGET_TOKENS 总闸裁剪
 *   - 宁丢勿裁：放不下的整块标记 dropped 并计数，不静默截断已保留块（保质量可预期）
 *
 * 成本/优先级/全局预算均非 Cordis 提供，为本层职责（07 铁律1：平台做确定性的事）。
 */
export interface ContextBlock {
  /** provider id（对齐 L1 fiber id） */
  id: string;
  /** 注入片段 */
  fragment: string;
  /** 注入 token 上限（provider 自报预算，超则整体丢） */
  cost: number;
  /** 优先级（越大越前保留） */
  priority: number;
}

export interface ScheduleResult {
  /** 保留块（已按 priority 降序） */
  blocks: ContextBlock[];
  /** 被全局预算裁掉的块 id 与原因 */
  dropped: { id: string; reason: 'over-cost' | 'over-budget' }[];
  /** 保留块总 token 估算 */
  totalTokens: number;
  budgetTokens: number;
}

/** 全局上下文总闸（环境可覆盖）；>窗口(1500)+长摘(800)+记忆(400)+世界书(1200) 单项之和的可覆盖默认 */
export const CONTEXT_BUDGET_TOKENS = Number(process.env.JG_CONTEXT_BUDGET_TOKENS ?? 3000);

/** 块 token 估算：中文 1 字≈1.5，其余 1 字≈0.4（与 assembly.estimateTokens 同口径） */
export function blockTokens(fragment: string): number {
  const cjk = (fragment.match(/[一-鿿]/g) ?? []).length;
  return Math.ceil(cjk * 1.5 + (fragment.length - cjk) * 0.4);
}

/** 全局预算裁剪：priority 降序贪婪保留；单块超 cost 整体丢；溢出 budget 后续整块丢。
 *  返回保留块 + 丢弃记录 + 总 token；丢弃不静默截断。 */
export function scheduleContext(blocks: ContextBlock[], budgetTokens: number = CONTEXT_BUDGET_TOKENS): ScheduleResult {
  const ordered = [...blocks].sort((a, b) => b.priority - a.priority);
  const kept: ContextBlock[] = [];
  const dropped: ScheduleResult['dropped'] = [];
  let totalTokens = 0;
  for (const b of ordered) {
    const tokens = blockTokens(b.fragment);
    if (tokens > b.cost) {
      dropped.push({ id: b.id, reason: 'over-cost' });
      continue;
    }
    if (totalTokens + tokens > budgetTokens) {
      dropped.push({ id: b.id, reason: 'over-budget' });
      continue;
    }
    kept.push(b);
    totalTokens += tokens;
  }
  return { blocks: kept, dropped, totalTokens, budgetTokens };
}