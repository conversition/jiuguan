/**
 * FE-05.0 面板动作映射与执行模式（通用核心，纯逻辑可 node 直测）
 *
 * 目标：把「面板请求的动作」如实映射到**已经存在的** Agent 入口，并把副作用说清楚。
 *  **不新增第二个能力字典**：本表只按名字引用 `interfacePolicy.ts`（唯一真源）里已登记的接口，
 *  由 `assertActionMapConsistency()` 在测试中断言"本表引用的每个接口都已登记"，杜绝两套表漂移。
 *
 * 三条纪律：
 *  1. **存在 ≠ 语义**：`ai.generate` 在策略表里是 bridge，**不等于**已经提供「手机独立会话 /
 *     旁路生成」语义。本模块用 `independentConversation` 明确否掉这种推断（见 `resolvePanelActionMode`）。
 *  2. **不抹平差别**：不允许用一个 `supported: true` 把「辅助生成 / 发送到主对话 / 填入草稿 / 只读」
 *     压成同一件事；没有匹配入口就必须落到草稿或只读。
 *  3. **副作用必须可数**：每个动作声明 `writesMessage` / `writesState` / `cancellable`；
 *     纯展示面板的动作必须全部为 false，供「纯展示副作用为零」验收读取。
 *
 * 分层：通用核心（本文件）不出现任何卡名、联系人名、某角色的变量字段路径。
 */
import { INTERFACE_RULES, type IfaceKind } from './interfacePolicy.ts';

/** 动作实际影响谁（不是"面板属于谁"） */
export type ActionEffect =
  /** 影响主对话（产生/追加正式消息，进入 chat_log 与后续回合上下文） */
  | 'main-chat'
  /** 影响辅助任务（静默生成，不落对话记录，不进入后续回合上下文） */
  | 'aux-task'
  /** 只影响输入框草稿（用户尚未发送） */
  | 'draft'
  /** 只读 */
  | 'read-only';

/** 面板可提供的模式（如实反映 Agent 实际能力） */
export type PanelActionMode =
  /** 真实桥接辅助任务（有匹配的辅助入口） */
  | 'assist-generate'
  /** 明确标注"发送到主对话"（只有主对话生成） */
  | 'main-chat-send'
  /** 填入主对话草稿（不适合直接生成 / 未支持） */
  | 'inject-draft'
  /** 只读 */
  | 'readonly'
  /** 没有匹配入口且不能降级（明确不支持，不假装） */
  | 'unsupported';

export interface PanelActionMapping {
  /** 面板请求的**通用语义**动作名（不含卡片业务名） */
  action: string;
  /** 对应现有接口（必须已在 interfacePolicy 登记） */
  iface: { kind: IfaceKind; name: string };
  effect: ActionEffect;
  writesMessage: boolean;
  writesState: boolean;
  cancellable: boolean;
  /** 结果如何回到发起面板（可审计；不是"结果就绪"的声明） */
  resultPath: string;
  /** 语义边界说明 */
  note?: string;
}

/**
 * 面板真实使用的动作清单（通用语义 → 现有接口）。
 * **新增动作必须先在此登记，并在 interfacePolicy 里登记对应接口**，否则测试失败。
 */
export const PANEL_ACTION_MAP: PanelActionMapping[] = [
  {
    action: 'panel.send-to-main-chat',
    iface: { kind: 'rpc', name: 'message.send' },
    effect: 'main-chat', writesMessage: true, writesState: false, cancellable: true,
    resultPath: '宿主定向 reply{ok} → 发起面板；正文由普通回合 SSE 回到同会话消息列表',
    note: '与主输入框同一个发送入口；发出后进入正常回合链路，可被「停止生成」中止（已生成正文保留落库）',
  },
  {
    action: 'panel.inject-draft',
    iface: { kind: 'rpc', name: 'message.send' },
    effect: 'draft', writesMessage: false, writesState: false, cancellable: false,
    resultPath: '宿主定向 reply{ok} → 发起面板；草稿出现在主输入框，等用户自己发送',
    note: 'payload.draft === true 走草稿环；**界面必须显示"已填入草稿"，不得显示"已发送"**',
  },
  {
    action: 'panel.assist-generate',
    iface: { kind: 'rpc', name: 'ai.generate' },
    effect: 'aux-task', writesMessage: false, writesState: false, cancellable: false,
    resultPath: 'reply{text} → 发起面板（await 兑现）；不落 chat_log、不进后续回合上下文',
    note: '**辅助静默生成 ≠ 手机独立会话**：该入口无会话身份、无历史累积、无取消。'
      + '独立会话语义需要被显式拒绝（independentConversation=false）',
  },
  {
    action: 'panel.read-message-state',
    iface: { kind: 'rpc', name: 'mvu.get' },
    effect: 'read-only', writesMessage: false, writesState: false, cancellable: false,
    resultPath: 'reply{data{stat_data,exists,resolved,stateVersion,scope,message_id}} → 发起面板',
    note: '按稳定消息身份读该楼层快照；未初始化时 exists:false，**不回退最新状态**',
  },
  {
    action: 'panel.read-session-state',
    iface: { kind: 'rpc', name: 'mvu.get' },
    effect: 'read-only', writesMessage: false, writesState: false, cancellable: false,
    resultPath: 'reply{data{...,scope:"session"}} → 发起面板',
    note: '读会话级权威状态（不冒充某一楼层）',
  },
  {
    action: 'panel.subscribe-state',
    iface: { kind: 'event', name: 'Mvu.on' },
    effect: 'read-only', writesMessage: false, writesState: false, cancellable: true,
    resultPath: '宿主 state/session-state 事件按目标过滤后推给订阅面板',
    note: '按**用途**订阅：某条消息的快照变化用 state；当前会话状态变化用 session-state',
  },
  {
    action: 'panel.subscribe-message',
    iface: { kind: 'event', name: 'eventSource.on' },
    effect: 'read-only', writesMessage: false, writesState: false, cancellable: true,
    resultPath: '宿主 message 事件（MESSAGE_SENT / MESSAGE_RECEIVED）推给订阅面板',
    note: '列表 / 未读 / 消息提示用这个；**不得**用它触发变量重读',
  },
  {
    action: 'panel.unsubscribe-state',
    iface: { kind: 'event', name: 'Mvu.off' },
    effect: 'read-only', writesMessage: false, writesState: false, cancellable: false,
    resultPath: '本地取消订阅（纯前端订阅表操作，不触达后端）',
    note: '退订后不再收到任何事件（不产生"重复通知"）；不需要重新运行任何脚本',
  },
  {
    action: 'panel.commit-session-state',
    iface: { kind: 'rpc', name: 'mvu.replace' },
    effect: 'main-chat', writesMessage: false, writesState: true, cancellable: false,
    resultPath: 'reply{stateVersion,changed,deduped} → 发起面板 + 已提交事实广播',
    note: '**用户明确保存**路径（如保存开局）；applied=0 / 版本冲突必须报错，不得当成成功',
  },
  {
    action: 'panel.cancel-action',
    iface: { kind: 'rpc', name: 'message.cancel' },
    effect: 'main-chat', writesMessage: false, writesState: false, cancellable: false,
    resultPath: 'reply{ok,aborted,...} → 发起面板；**以服务端落库定局为准**（不假装已取消）',
    note: '只对**声明为可取消**的任务生效（当前仅"主对话发送"在途回合，复用既有 /turn/abort 与落库定局）；'
      + '辅助生成明确不可取消 —— 不为测试完整而新建不存在的取消后台',
  },
];

const ACTION_INDEX = new Map(PANEL_ACTION_MAP.map((m) => [m.action, m]));

export function resolvePanelAction(action: string): PanelActionMapping | undefined {
  return ACTION_INDEX.get(action);
}

/**
 * 一致性自检：本表引用的接口是否都已在 `interfacePolicy` 登记。
 * 未登记 → 返回失败项（测试据此失败，**不允许静默新增第二份字典**）。
 */
export function assertActionMapConsistency(): { action: string; ok: boolean; reason: string }[] {
  const registered = new Set(INTERFACE_RULES.map((r) => `${r.kind}:${r.name}`));
  return PANEL_ACTION_MAP.map((m) => {
    const key = `${m.iface.kind}:${m.iface.name}`;
    const hit = registered.has(key);
    return {
      action: m.action, ok: hit,
      reason: hit ? `接口 ${key} 已在 interfacePolicy 登记` : `接口 ${key} 未登记（禁止另建能力字典）`,
    };
  });
}

// ────────────────────────── 模式判定 ──────────────────────────

/** 面板/来源模块**实际可用**的 Agent 入口（由探测得到，不是声明出来的） */
export interface PanelCapabilities {
  /** 辅助静默生成入口可用（后端 /quiet 真实可达） */
  hasAuxTaskEntry: boolean;
  /** 主对话发送入口可用 */
  hasMainChatEntry: boolean;
  /** 草稿环可用（填主输入框，不发送） */
  hasDraftEntry: boolean;
}

/** 面板请求的意图（通用语义） */
export type PanelIntent = 'generate' | 'send' | 'draft' | 'read';

export interface PanelModeDecision {
  mode: PanelActionMode;
  /** **界面文案**（用户看到的按钮语义；不得与真实副作用不符） */
  label: string;
  reason: string;
  /** 该模式实际会产生的副作用 */
  effect: ActionEffect;
  writesMessage: boolean;
  writesState: boolean;
  cancellable: boolean;
  /**
   * 该模式是否等价于「面板拥有独立会话」。
   * **恒为 false**：本平台没有面板独立会话/旁路会话语义，禁止用 supported:true 冒充。
   */
  independentConversation: false;
  /** 结果归属目标（发起面板 + 会话运行实例；防切换后串台） */
  deliveryTarget: { panelScoped: true; needsHostValidation: true };
}

/**
 * 由**实际能力**决定面板可提供的模式。
 * 绝不用一个 supported:true 抹平「辅助 / 主对话 / 草稿 / 只读」的差别。
 */
export function resolvePanelActionMode(caps: PanelCapabilities, intent: PanelIntent): PanelModeDecision {
  const base = {
    independentConversation: false as const,
    deliveryTarget: { panelScoped: true as const, needsHostValidation: true as const },
  };
  const unsupported = (reason: string): PanelModeDecision => ({
    ...base, mode: 'unsupported', label: '不支持', reason,
    effect: 'read-only', writesMessage: false, writesState: false, cancellable: false,
  });

  if (intent === 'read') {
    return {
      ...base, mode: 'readonly', label: '只读查看', reason: '只读取既有状态与消息，不产生生成或写入',
      effect: 'read-only', writesMessage: false, writesState: false, cancellable: false,
    };
  }
  if (intent === 'draft') {
    if (!caps.hasDraftEntry) return unsupported('草稿环不可用：无法把内容填入主对话草稿');
    return {
      ...base, mode: 'inject-draft', label: '填入主对话草稿（需你手动发送）',
      reason: '该动作改写输入框草稿、不发送；界面必须明确"已填入草稿"而不是"已发送"',
      effect: 'draft', writesMessage: false, writesState: false, cancellable: false,
    };
  }
  if (intent === 'send') {
    if (!caps.hasMainChatEntry) return unsupported('主对话入口不可用：无法把消息送入正式回合');
    return {
      ...base, mode: 'main-chat-send', label: '发送到主对话',
      reason: '面板只驱动主对话正式发送入口；消息进入 chat_log 与后续回合上下文',
      effect: 'main-chat', writesMessage: true, writesState: false, cancellable: true,
    };
  }
  // intent === 'generate'
  if (caps.hasAuxTaskEntry) {
    return {
      ...base, mode: 'assist-generate', label: '辅助生成（结果只回本面板，不进对话）',
      reason: '存在匹配的辅助任务入口 → 真实桥接；该入口无会话身份、无历史累积、不可取消，'
        + '**不构成"面板独立会话"**',
      effect: 'aux-task', writesMessage: false, writesState: false, cancellable: false,
    };
  }
  if (caps.hasMainChatEntry) {
    return {
      ...base, mode: 'main-chat-send', label: '发送到主对话（无辅助入口，只能走主对话）',
      reason: '没有匹配的辅助生成入口 → 不冒充旁路生成，如实降级为主对话发送',
      effect: 'main-chat', writesMessage: true, writesState: false, cancellable: true,
    };
  }
  if (caps.hasDraftEntry) {
    return {
      ...base, mode: 'inject-draft', label: '填入主对话草稿（暂不支持直接生成）',
      reason: '无生成入口可用 → 交付草稿，由用户决定何时发送',
      effect: 'draft', writesMessage: false, writesState: false, cancellable: false,
    };
  }
  return unsupported('没有任何可用生成/发送入口：仅保留只读展示');
}

/** 报告用：动作映射表摘要 */
export function describeActionMap(): string[] {
  return PANEL_ACTION_MAP.map((m) => {
    const flags = [
      m.writesMessage ? '写消息' : '不写消息',
      m.writesState ? '写状态' : '不写状态',
      m.cancellable ? '可取消' : '不可取消',
    ].join('/');
    return `${m.action} → ${m.iface.kind}:${m.iface.name} | 影响=${m.effect} | ${flags}`;
  });
}

// ────────────────────── 重复后台：空操作且停用来源 ──────────────────────

/**
 * 重复后台动作（旧自动生成 / 重复记忆 / 重复变量更新）。
 * 由 Agent 接管的业务 → 返回**中性空结果**，同时其调度来源由脚本执行清单停用。
 * 注意：这不是"接口不存在"，而是"来源不该再发出该调用"。
 */
export interface NoopBackgroundEntry {
  action: string;
  /** 对应已登记接口（用于确认不是凭空造接口） */
  iface: { kind: IfaceKind; name: string };
  /** 中性返回（形状正确、不抛错、不排队、不重试） */
  neutral: { async: boolean; value: unknown };
  supersededBy: string;
  sourceDeactivatedBy: string;
}

export const NOOP_BACKGROUND_ACTIONS: NoopBackgroundEntry[] = [
  {
    action: 'bg.auto-generate', iface: { kind: 'host-api', name: 'session.addOneMessage' },
    neutral: { async: true, value: { ok: false, unsupported: 'message.addOneMessage' } },
    supersededBy: 'Agent 消息入口',
    sourceDeactivatedBy: '旧消息/自动生成后台由脚本执行清单停用（deferred，不进执行序）',
  },
  {
    action: 'bg.batch-insert-messages', iface: { kind: 'host-api', name: 'session.addMessages' },
    neutral: { async: true, value: { ok: false, unsupported: 'message.addMessages' } },
    supersededBy: 'Agent 消息入口',
    sourceDeactivatedBy: '同上（批量变体）',
  },
  {
    action: 'bg.prompt-reinject', iface: { kind: 'host-api', name: 'session.setExtensionPrompt' },
    neutral: { async: true, value: { ok: false, unsupported: 'prompt.setExtensionPrompt' } },
    supersededBy: 'Agent 提示词组装入口',
    sourceDeactivatedBy: '旧提示词后台由脚本执行清单停用',
  },
];

/** 执行重复后台动作：**恒返回中性结果**（不报错、不排队、不写权威数据、不伪造提交事件） */
export function runNoopBackgroundAction(action: string): { hit: boolean; value: unknown } {
  const e = NOOP_BACKGROUND_ACTIONS.find((x) => x.action === action);
  if (!e) return { hit: false, value: undefined };
  return { hit: true, value: e.neutral.async ? Promise.resolve(e.neutral.value) : e.neutral.value };
}

/** 报告用：空操作后台清单与停用依据（证据仍来自脚本执行清单，本表只是声明） */
export function describeNoopBackground(): string[] {
  return NOOP_BACKGROUND_ACTIONS.map((e) => `${e.action} → 中性返回；业务由「${e.supersededBy}」接管；停用依据：${e.sourceDeactivatedBy}`);
}
