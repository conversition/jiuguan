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
  /** 注入 token 上限（provider 自报预算，超则整体丢；reducible 时超预算收缩到 cost 内保留） */
  cost: number;
  /** 优先级（越大越前保留） */
  priority: number;
  /** 可降级：over-cost 时收缩到 cost 内保留（如世界状态变量段），而非整块丢（默认 false=宁丢勿裁） */
  reducible?: boolean;
}

export interface ScheduleResult {
  /** 保留块（已按 priority 降序） */
  blocks: ContextBlock[];
  /** 被全局预算裁掉的块 id 与原因（over-cost 含被收缩的 reducible 块；对 reducible 块「收缩」不视为丢弃，仅当仍超预算才记 over-budget） */
  dropped: { id: string; reason: 'over-cost' | 'over-budget' }[];
  /** 保留块总 token 估算 */
  totalTokens: number;
  budgetTokens: number;
}

/** 全局上下文总闸（环境可覆盖）。
 *  默认 20000：适配 128k–200k 窗口模型。
 *  智能分配：窗口(~8k) + 卡/系统/预设(~2k) 直接进 prompt 基座（不经调度器），
 *  调度预算专供 记忆+长摘+世界书+世界状态 四块（cost 上限合计约 15.5k），并为模型输出预留 ≥10%。
 *  1M 窗口可经 JG_CONTEXT_BUDGET_TOKENS 上调到 30k–50k；越小窗口则相应调低。 */
export const CONTEXT_BUDGET_TOKENS = Number(process.env.JG_CONTEXT_BUDGET_TOKENS ?? 20000);

/** 块 token 估算：中文 1 字≈1.5，其余 1 字≈0.4（与 assembly.estimateTokens 同口径） */
export function blockTokens(fragment: string): number {
  const cjk = (fragment.match(/[一-鿿]/g) ?? []).length;
  return Math.ceil(cjk * 1.5 + (fragment.length - cjk) * 0.4);
}

/** 把片段收缩到 ≤budget token（保留前缀 + 截断标注）。已在 budget 内则原样返回。
 *  逐字符从尾部削减（中文按 1.5 token 估算），用于 reducible 块的 over-cost 降级。 */
export function shrinkToBudget(fragment: string, budget: number): string {
  if (blockTokens(fragment) <= budget) return fragment;
  const marker = '…(已精简)';
  // 从尾部逐字符收缩；预算主要被中文占满，按单字符粗算可收敛（最坏 O(n²)，片段通常 <2k 字可接受）
  let end = fragment.length;
  while (end > 0) {
    const candidate = fragment.slice(0, end) + marker;
    if (blockTokens(candidate) <= budget) return candidate;
    end--;
  }
  return marker;
}

/** 全局预算裁剪：priority 降序贪婪保留；单块超 cost 时——reducible 块收缩到 cost 内保留（over-cost 记 dropped 但已保留），
 *  否则整体丢（宁丢勿裁）；溢出 budget 后续整块丢。 */
export function scheduleContext(blocks: ContextBlock[], budgetTokens: number = CONTEXT_BUDGET_TOKENS): ScheduleResult {
  const ordered = [...blocks].sort((a, b) => b.priority - a.priority);
  const kept: ContextBlock[] = [];
  const dropped: ScheduleResult['dropped'] = [];
  let totalTokens = 0;
  for (const b of ordered) {
    const tokens = blockTokens(b.fragment);
    let fragment = b.fragment;
    let cost = b.cost;
    if (tokens > b.cost) {
      if (b.reducible) {
        // 可降级块：收缩到 cost 内保留，不整块丢
        fragment = shrinkToBudget(b.fragment, b.cost);
        dropped.push({ id: b.id, reason: 'over-cost' });
        cost = blockTokens(fragment);
      } else {
        dropped.push({ id: b.id, reason: 'over-cost' });
        continue;
      }
    }
    if (totalTokens + blockTokens(fragment) > budgetTokens) {
      dropped.push({ id: b.id, reason: 'over-budget' });
      continue;
    }
    kept.push({ id: b.id, fragment, cost, priority: b.priority, reducible: b.reducible });
    totalTokens += blockTokens(fragment);
  }
  return { blocks: kept, dropped, totalTokens, budgetTokens };
}