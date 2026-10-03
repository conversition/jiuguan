/**
 * FE-04.1 消息视图契约（纯逻辑，可 node 直测）
 *
 * 目的：让**所有渲染路线**（普通文本 / 原生场景 / 卡内 HTML / 外部前端页）共用同一份
 * 「消息上下文 + 渲染选择结果」，并把选择依据写清楚（可解释），而不是散落在 App / HtmlMessage / GalSegment。
 *
 * 纪律：
 *  - 选择依据只有 **内容格式、启用规则、所需能力、用户配置**；**不含卡名**。
 *  - 同一内容区段只由**一个**渲染器消费（避免原生解析器拿走占位符后，卡片正则再生成第二个面板）。
 *  - 多展示区段的消息可分别渲染，但每个区段的归属必须明确（`reason` 逐段给出）。
 *  - **不在前端重算楼层**：messageId / messageIndex / floor 由 C1 的唯一翻译点负责，这里只承载与传递。
 *
 * 本模块不引入新的渲染框架：内部复用既有 `splitGalSegments`（行为不变），只增加**可解释的决策层**。
 */
import { looksLikeFullDoc, splitGalSegments, type HtmlSegment } from './htmlCore.ts';

/** 渲染路线（协议适配层识别的**格式**，不是卡片身份） */
export type MessageRenderer =
  /** 普通文本 / Markdown（含用户消息） */
  | 'text'
  /** 原生场景（GLA 指令序列，由宿主原生舞台渲染） */
  | 'native-scene'
  /** 卡内 HTML 前端（气泡内嵌前端） */
  | 'card-html'
  /** 卡自带外部前端页（服务端代理抓页 → 沙箱 iframe） */
  | 'external-page';

/** 卡内 HTML 的两种档位（由内容形态决定，非卡片偏好） */
export type CardHtmlMode = 'iframe' | 'shadow';

/** 消息上下文（FE-04.1 统一契约）：所有渲染器共用同一份目标与状态引用 */
export interface MessageViewContext {
  sessionId: string;
  /** 会话运行实例（一次有效会话运行周期；新增消息**不**轮换，见 FE-04.3） */
  sessionRunId: string;
  /** 稳定消息键（round + role；前端锚点与目标绑定用） */
  messageKey: string;
  /** 内部稳定消息身份（chat_log.id；由 C1 唯一翻译点解析） */
  messageId?: number;
  /** 外部回合楼层 */
  floor: number;
  /** 回复版本（重生成时变化；FE-04.3 用于页面身份） */
  revision?: string;
  /** StateStore 状态引用：本条消息自己的快照（**找不到不回退最新状态**） */
  state?: { exists: boolean; stateVersion?: number };
  /** 当前页面权限（沿用既有帧/会话/写入保护） */
  permissions: { draft: boolean; send: boolean; writeState: boolean };
}

/** 区段视图：一个区段 = 一个渲染器 + 决策原因 */
export interface MessageSegmentView {
  renderer: MessageRenderer;
  /** 交给该渲染器的原始内容（原生场景为 GLA 脚本，卡内 HTML 为 HTML 文本） */
  content: string;
  /** 决策原因（可解释；换卡不需要新增分支） */
  reason: string;
  /** card-html 专用：档位与原因 */
  cardHtml?: { mode: CardHtmlMode; reason: string };
  /** 是否需要为该区段注入会话级共享脚本运行时（决定「可执行页面」） */
  executable: boolean;
}

export interface MessageViewPlan {
  segments: MessageSegmentView[];
  /** 整体决策摘要（诊断/报告） */
  reason: string;
  /** 本条消息是否可执行页面脚本（任一区段 executable） */
  executable: boolean;
}

export interface MessageViewInput {
  content: string;
  role: 'user' | 'assistant' | 'system' | string;
  /** 卡片已启用规则派生出的显示结果（applyDisplayRules） */
  display: { text: string; gal: string[] | null | undefined };
  /** 原始视图（用户显式要求） */
  showRaw?: boolean;
  /** 是否正在流式生成（流式期间不挂载可执行页面） */
  streaming?: boolean;
  /** 卡片「前端界面」规则的外链引擎 URL（存在则可走 external-page） */
  externalUrl?: string;
  /** 用户配置的界面偏好（默认原生） */
  preferredSceneUi?: 'native' | 'external';
  /** 平台是否允许执行卡片/外部页脚本；Android bundled v1 固定 false。 */
  scriptedCards?: boolean;
}

/** 卡内 HTML 档位判定（与 HtmlMessage 既有规则一致，集中到契约层） */
export function chooseCardHtmlMode(html: string): { mode: CardHtmlMode; reason: string } {
  if (looksLikeFullDoc(html) || /<script[\s>]/i.test(html)) {
    return {
      mode: 'iframe',
      reason: '完整文档或含脚本 → 沙箱 srcdoc iframe（脚本需隔离；文档语义完整）',
    };
  }
  return { mode: 'shadow', reason: '片段（无脚本）→ Shadow DOM（样式隔离，宿主同源，脚本剥离）' };
}

/**
 * 渲染选择（可解释）：只依 **格式 / 启用规则 / 能力 / 用户配置**。
 * 与旧行为等价（内部复用 splitGalSegments），但每一段都给出决策原因与归属。
 */
export function planMessageView(input: MessageViewInput): MessageViewPlan {
  const {
    role, content, display, showRaw, streaming, externalUrl, preferredSceneUi,
    scriptedCards = true,
  } = input;

  // 1) 流式期间只显示正文（不挂载可执行页面，不产生额外脚本执行）
  if (streaming) {
    return {
      segments: [{ renderer: 'text', content: display.text, reason: '流式生成中：仅显示正文，消息完成后才挂载页面', executable: false }],
      reason: 'streaming',
      executable: false,
    };
  }
  // 2) 用户消息 / 显式原始视图 / 无启用规则 → 普通文本
  if (role !== 'assistant') {
    return {
      segments: [{ renderer: 'text', content, reason: '非助手消息：按纯文本渲染', executable: false }],
      reason: 'non-assistant',
      executable: false,
    };
  }
  if (showRaw) {
    return {
      segments: [{ renderer: 'text', content, reason: '用户选择原始视图：不应用显示规则', executable: false }],
      reason: 'raw-view',
      executable: false,
    };
  }

  // 3) 按启用规则分段（复用既有实现，行为不变），逐段给出归属
  const raw: HtmlSegment[] = splitGalSegments(display.text, display.gal);
  if (raw.length === 0) {
    return {
      segments: [{ renderer: 'text', content: display.text, reason: '无区段（空内容）', executable: false }],
      reason: 'empty',
      executable: false,
    };
  }
  // 单段纯文本 → 直接文本（等价旧 singleText 快路径）
  if (raw.length === 1 && raw[0].type === 'text') {
    return {
      segments: [{ renderer: 'text', content: raw[0].content, reason: '单段正文（无前端/场景区段）', executable: false }],
      reason: 'single-text',
      executable: false,
    };
  }

  const segments: MessageSegmentView[] = raw.map((seg) => {
    if (seg.type === 'gal') {
      // 原生场景 vs 外部前端页：由**用户配置**决定（默认原生，保留可访问性兜底）
      if (scriptedCards && externalUrl && preferredSceneUi === 'external') {
        return {
          renderer: 'external-page' as const,
          content: seg.content,
          reason: `用户选择「卡自带前端」+ 卡片存在启用中的前端界面规则 → 外部页（服务端代理抓页 → 沙箱 iframe）`,
          executable: true,
        };
      }
      return {
        renderer: 'native-scene' as const,
        content: seg.content,
        reason: externalUrl
          ? '场景区段按原生舞台渲染（用户未切换到卡自带前端）'
          : '场景区段按原生舞台渲染（卡片无启用中的前端界面规则）',
        executable: false,
      };
    }
    if (seg.type === 'html') {
      if (!scriptedCards) {
        return {
          renderer: 'card-html' as const,
          content: seg.content,
          reason: '当前平台禁用脚本卡面 → 清洗后静态 Shadow DOM',
          cardHtml: {
            mode: 'shadow' as const,
            reason: 'scriptedCards=false：移除 script/iframe/事件处理器',
          },
          executable: false,
        };
      }
      const { mode, reason } = chooseCardHtmlMode(seg.content);
      return {
        renderer: 'card-html' as const,
        content: seg.content,
        reason,
        cardHtml: { mode, reason },
        executable: mode === 'iframe',
      };
    }
    return { renderer: 'text' as const, content: seg.content, reason: '正文区段', executable: false };
  });

  return {
    segments,
    reason: `按启用显示规则分为 ${segments.length} 段：${[...new Set(segments.map((s) => s.renderer))].join(' / ')}`,
    executable: segments.some((s) => s.executable),
  };
}

/**
 * 视图上下文摘要（诊断/报告用）：把「这条消息为什么用这个渲染器 / 读哪份状态」一次说清。
 * 只读上下文与计划，不触发任何业务。
 */
export function describeMessageView(ctx: MessageViewContext, plan: MessageViewPlan): string {
  const target = ctx.messageId !== undefined
    ? `messageId=${ctx.messageId}`
    : `messageKey=${ctx.messageKey}`;
  const state = ctx.state
    ? (ctx.state.exists ? `快照存在(v${ctx.state.stateVersion ?? '?'})` : '**本条消息无快照**（不回退最新状态）')
    : '未请求状态';
  return `${target} floor=${ctx.floor} revision=${ctx.revision ?? '-'} run=${ctx.sessionRunId} | 状态：${state} | 渲染：${plan.reason}`;
}

// ────────────────────────── 视图登记（诊断/浏览器验证用，纯内存、不触达后端） ──────────────────────────

/** 已渲染消息的「上下文 + 渲染决策」登记：回答"这条消息为什么用这个渲染器、读哪份状态" */
const viewRegistry = new Map<string, { context: MessageViewContext; plan: MessageViewPlan; summary: string }>();

export function recordMessageView(context: MessageViewContext, plan: MessageViewPlan): void {
  viewRegistry.set(`${context.messageKey}@${context.revision ?? '-'}`, {
    context,
    plan,
    summary: describeMessageView(context, plan),
  });
}

export function unrecordMessageView(messageKey: string, revision?: string): void {
  viewRegistry.delete(`${messageKey}@${revision ?? '-'}`);
}

export function listMessageViews(): { messageKey: string; renderers: MessageRenderer[]; executable: boolean; summary: string }[] {
  return [...viewRegistry.values()].map((v) => ({
    messageKey: v.context.messageKey,
    renderers: [...new Set(v.plan.segments.map((s) => s.renderer))],
    executable: v.plan.executable,
    summary: v.summary,
  }));
}

export function clearMessageViews(): void { viewRegistry.clear(); }

/** 暴露给浏览器探针（只读；供真实浏览器验收读取"为什么这样渲染"） */
export function installMessageViewProbe(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__jgMessageViews = () => listMessageViews();
}
