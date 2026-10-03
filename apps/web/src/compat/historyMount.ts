/**
 * FE-05.4 历史页面轻量挂载策略（纯逻辑，可 node 直测）
 *
 * 背景：历史消息的 iframe 若一直保持挂载，每条历史都含完整文档环境，长回放时代价随消息数线性增长。
 * 本轮不引入大型虚拟列表框架，只把"哪些历史视图该挂载"抽成**可配置、可解释、可测量**的策略。
 *
 * 纪律：
 *  - **当前交互页与明确展开页**：保留挂载；
 *  - **远历史页**：允许变成静态预览并卸载视图；
 *  - **重新打开**：仍绑定原消息与原快照，恢复必要 UI 状态；
 *  - **卸载历史视图不销毁 SessionHost**（会话执行实例与历史视图是两层生命周期）；
 *  - 重新挂载**不得**触发自动发送、重复保存开局或重启会话后台。
 *
 * 策略依据只能用「距离 / 可见性 / 用户是否展开 / 是否当前交互目标」——不含卡名与业务语义。
 */

export type HistoryMountState =
  /** 保持挂载并可执行页面脚本 */
  | 'mount'
  /** 降级为静态预览（保留快照内容，卸载可执行视图） */
  | 'static-preview'
  /** 卸载视图（仅保留消息条目与锚点） */
  | 'unmount';

export interface HistoryMountOptions {
  /** 近场窗口：离底部多近以内视为"近历史"（默认 3 条） */
  nearWindow?: number;
  /** 远场阈值：超过则卸载（默认 12 条） */
  farWindow?: number;
  /** 是否允许对远历史做卸载（可配置；关闭则最差只降级为静态预览） */
  allowUnmount?: boolean;
}

export interface HistoryMountInput {
  /** 距离底部的消息条数（0 = 最新一条） */
  distanceFromBottom: number;
  /** 是否在视口内（或接近视口） */
  inViewport: boolean;
  /** 用户是否明确展开该历史消息 */
  expanded: boolean;
  /** 是否当前交互目标（最后一条助手消息 / 正在流式的消息） */
  interactive: boolean;
  /** 是否流式生成中（生成期不挂载历史可执行页面） */
  streaming?: boolean;
}

export interface HistoryMountPlan {
  state: HistoryMountState;
  reason: string;
  /** 卸载历史视图**不销毁**会话执行实例（恒为 true） */
  keepsSessionHost: true;
  /** 重新挂载必须重新绑定原消息身份与原快照（而不是刷新到最新） */
  rebind: { messageKey: true; messageId: true; snapshot: true };
  /**
   * 重新挂载时**禁止**发生的副作用（浏览器验收按此断言，防"重挂 = 重放"）。
   */
  forbiddenOnRemount: string[];
  /** 该状态下是否允许执行页面脚本（供"活跃页面数"统计） */
  executable: boolean;
}

const FORBIDDEN_ON_REMOUNT = [
  'auto-send-message',
  're-save-opening-state',
  'restart-session-background',
  'duplicate-frame-registration',
  'rebootstrap-session-host',
];

export function planHistoryMount(input: HistoryMountInput, opts: HistoryMountOptions = {}): HistoryMountPlan {
  const near = opts.nearWindow ?? 3;
  const far = opts.farWindow ?? 12;
  const allowUnmount = opts.allowUnmount !== false;
  const base = {
    keepsSessionHost: true as const,
    rebind: { messageKey: true as const, messageId: true as const, snapshot: true as const },
    forbiddenOnRemount: [...FORBIDDEN_ON_REMOUNT],
  };

  if (input.streaming) {
    return {
      ...base, state: 'static-preview', executable: false,
      reason: '流式生成中：不挂载任何可执行页面（避免生成期产生额外脚本执行）',
    };
  }
  if (input.interactive) {
    return { ...base, state: 'mount', executable: true, reason: '当前交互页：保持挂载（会话运行实例始终只启动一次）' };
  }
  if (input.expanded) {
    return { ...base, state: 'mount', executable: true, reason: '用户明确展开的历史页：保留挂载与可执行视图' };
  }
  if (!allowUnmount) {
    return {
      ...base, state: 'mount', executable: true,
      reason: '卡面保活模式：保持同一 iframe/脚本上下文，避免回看时重启前端',
    };
  }
  if (input.inViewport || input.distanceFromBottom <= near) {
    return {
      ...base, state: 'mount', executable: true,
      reason: input.inViewport ? '在视口内：保持挂载' : `近历史（距底部 ${input.distanceFromBottom} ≤ ${near}）：保持挂载`,
    };
  }
  if (input.distanceFromBottom <= far) {
    return {
      ...base, state: 'static-preview', executable: false,
      reason: `远历史（距底部 ${input.distanceFromBottom}）：降级为静态预览并卸载可执行视图（保留内容与锚点）`,
    };
  }
  return {
    ...base, state: 'unmount', executable: false,
    reason: `远历史（距底部 ${input.distanceFromBottom} > ${far}）：卸载视图，仅保留消息条目；重新打开时按原消息与原快照重绑`,
  };
}

/** 回放测量：给定整条消息序列的挂载计划，统计"活跃页面 / 需启动脚本的页面 / 需读取状态的页面" */
export function summarizeHistoryPlans(plans: HistoryMountPlan[]): {
  total: number; mounted: number; staticPreview: number; unmounted: number;
  activeExecutablePages: number; stateReads: number;
} {
  const mounted = plans.filter((p) => p.state === 'mount').length;
  return {
    total: plans.length,
    mounted,
    staticPreview: plans.filter((p) => p.state === 'static-preview').length,
    unmounted: plans.filter((p) => p.state === 'unmount').length,
    activeExecutablePages: plans.filter((p) => p.executable).length,
    // 只有挂载中的页面才需要读取自己的快照（静态预览/卸载不产生读取）
    stateReads: mounted,
  };
}

/** 便捷：按消息序列一次性规划（越靠近底部越新） */
export function planHistoryMounts(
  items: Omit<HistoryMountInput, 'distanceFromBottom'>[],
  opts: HistoryMountOptions = {},
): HistoryMountPlan[] {
  const last = items.length - 1;
  return items.map((it, i) => planHistoryMount({ ...it, distanceFromBottom: last - i }, opts));
}
