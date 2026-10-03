import React, { useState, useEffect, useRef, useMemo } from 'react';
import { authFetch, eventUrl } from './authClient.ts';
import { MemoryConsole } from './MemoryConsole.tsx';
import { ProviderPanel } from './ProviderPanel.tsx';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PluginsPanel } from './PluginsPanel.tsx';
import { DshWidgetLoader } from './DshWidgetLoader.tsx';
import { SessionSetup } from './SessionSetup.tsx';
import { EditorPanel } from './EditorPanel.tsx';
import { responseJson, revisionHeaders } from './revisionApi.ts';
import { SkillsPanel } from './SkillsPanel.tsx';
import { QualityPanel } from './QualityPanel.tsx';
import { MarkdownMessage, StreamText } from './MarkdownMessage.tsx';
import { HtmlMessage, splitGalSegments } from './HtmlMessage.tsx';
import { loadSharedBundle, resetSharedBundle } from './compat/bundleStore.ts';
import { EMPTY_BUNDLE, resetSharedStatus } from './compat/sharedRuntime.ts';
import { resolveIfacePolicy, buildStubReturner } from './compat/interfacePolicy.ts';
import { planMessageView, recordMessageView, unrecordMessageView, installMessageViewProbe, type MessageViewContext } from './messageView.ts';
import { SessionHost } from './compat/SessionHost.tsx';
import { planSessionHost } from './compat/sessionHost.ts';
import { getSharedBundle, subscribeSharedBundle } from './compat/bundleStore.ts';
import { subscribeSharedStatus, getLastSharedStatus } from './compat/sharedRuntime.ts';
import { SurfaceHost } from './compat/SurfaceHost.tsx';
import { TestPanel, installTestPanelProbe, type TestPanelResult } from './compat/TestPanel.tsx';
import {
  registerSurface, openSurface, closeSurface, destroySurface, destroySurfacesForRun, listSurfaces, subscribeSurfaces,
  type PanelDeclaration,
} from './compat/surfaceRegistry.ts';
import { resolvePanelActionMode, type PanelCapabilities } from './compat/actionModes.ts';
import {
  planAgentAction, trackPlan, trackDelivery, routeActionResult, installActionBridgeProbe,
  canCancelAction, recordEffect, type HostActionContext,
} from './compat/agentActionBridge.ts';
import {
  buildPanelProjection, loadViewPrefs, saveViewPrefs, loadPanelUi, savePanelUi,
  subscribePanel, unsubscribePanel, isPanelSubscribed, dispatchPanelEvent, installPanelSubProbe,
} from './compat/panelProjection.ts';
import { planHistoryMount, type HistoryMountPlan } from './compat/historyMount.ts';
import { evaluatePreload, installPreloadProbe } from './compat/preloadStatus.ts';
import { ExternalPage } from './gal/ExternalPage.tsx';
import { GalSegment } from './gal/GalSegment.tsx';
import { isJgFrameMessage, findFrame, broadcastToFrames } from './gal/bridge.ts';
import type { JgFrameMessage } from './gal/bridge.ts';
import { setGalRuntime } from './gal/rt.ts';
import type { GalRuntime } from './gal/rt.ts';
import { applyDisplayRules } from '../../../packages/core/src/regex.ts';
import type { RegexRule } from '../../../packages/core/src/regex.ts';
import type { AssetKind } from '../../../packages/assets/src/asset-types.ts';
import type { ClientStorageNamespace } from '../../../packages/client-runtime/src/index.ts';
import { resolveNamedAsset } from './assetCapabilities.ts';
import { useMessageRefs, toMessageKey } from './hooks/useMessageRefs.ts';
import { useScrollToMessage } from './hooks/useScrollToMessage.ts';
import { useScrollSpy } from './hooks/useScrollSpy.ts';
import { useAutoScrollToMessage } from './hooks/useAutoScrollToMessage.ts';
import { MessageRuler } from './components/MessageRuler.tsx';
import { StoryIndexPanel } from './components/StoryIndexPanel.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';
import { logger } from './lib/logger.ts';
import { DirectorModal } from './DirectorModal.tsx';
import { useTextSelectionDirector } from './hooks/useTextSelectionDirector.ts';
import type { TextSelection } from './hooks/useTextSelectionDirector.ts';
import {
  GenerationOperationGate,
  createClientRunId,
  elapsedGenerationSeconds,
  type GenerationLease,
} from './generationClock.ts';
import { mergeMessageHistory, nextOptimisticRound, parseHistoryPayload } from './messageHistory.ts';
import { useMobileDrawer } from './hooks/useMobileDrawer.ts';
import { useOnlineStatus } from './hooks/useOnlineStatus.ts';
import { setGenerationActivity, touchGenerationActivity } from './generationActivity.ts';
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from './draftRecovery.ts';
import { fetchWithInactivityTimeout, NetworkInactivityTimeoutError } from './activityTimeout.ts';
import { AgentStatusPanel } from './AgentStatusPanel.tsx';

/**
 * 回合传输空闲窗口：只衡量“多久没有收到 SSE 字节/成功状态轮询”，不是回合总时长。
 * 长回合只要 15s 心跳、正文增量或后台状态仍可达就无限续租，不因慢 Tailnet 被误取消。
 */
const GENERATION_INACTIVITY_TIMEOUT_MS = 300_000;
/** Slow Tailnet links may keep progressing for minutes; only 120s of complete silence is failure. */
const SESSION_RESOURCE_TIMEOUT_MS = 120_000;
/** Control-plane reads must fail fast when the local API event loop is unavailable. */
const CONTROL_REQUEST_TIMEOUT_MS = 4_000;
/** History has no total deadline: every received body chunk refreshes this inactivity window. */
const HISTORY_REQUEST_TIMEOUT_MS = 120_000;

function isLegacyGenericStoryFallback(branches: readonly string[]): boolean {
  return branches.length === 3
    && branches[0]?.startsWith('调查并核实「') === true
    && branches.includes('与当前在场角色交谈，确认各自掌握的信息')
    && branches.includes('根据当前目标采取一个能够推进局势的具体行动');
}
/** After Stop, never keep the page-wide generation gate forever waiting for a dead backend. */
const ABORT_FINALIZE_DEADLINE_MS = 12_000;
/** 侧栏宽度（可拖动调整，按 server/client namespace 持久化；范围 200~480） */
const SIDEBAR_DEFAULT_W = 300;
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 480;
/** FE-06.1：标准测试面板仅隔离测试装载（生产默认不登记） */
const TEST_PANEL_ENABLED = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('jgTestPanel') === '1';
const TEST_PANEL_ID = 'std-test-panel';

interface Card { id: string; name: string }
interface SessionInfo {
  id: string;
  name: string;
  preview?: string;
  round?: number;
  start?: string;
  createdAt?: string;
  revision: string | null;
  snapshotToken: string | null;
}
interface Message {
  /** 前端行身份（React key / 锚点用；与后端 id 解耦以避免 DOM 重挂） */
  id: number;
  /** **稳定内部身份**（chat_log.id）—— StateStore 与事件目标一律用它，绝不用前端行身份 */
  serverId?: number;
  round: number;
  role: string;
  content: string;
}

interface PendingImage {
  id: string;
  kind: 'image';
  name: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  size: number;
  dataUrl: string;
}
/** 推进槽 / 轮次状态（/api/session/:id/turn-state，侧栏常驻） */
interface TurnState {
  bars: Record<string, number>;
  event_type: string;
  nsfw_lock: { locked: boolean; round: number };
  round: number;
}
interface GenerationState {
  active: boolean;
  round?: number;
  runId?: string;
  startedAt?: number;
}
interface TurnStatePayload {
  state: TurnState | null;
  generation?: GenerationState;
}

/**
 * SSE 错误在本机模式使用顶层 code；secured 模式会把它净化到
 * error.details.reasonCode。两种形态都只读取稳定枚举，不展示上游原始异常。
 */
function sseFailureCode(event: Record<string, unknown>): string | undefined {
  if (typeof event.code === 'string') return event.code;
  const error = event.error && typeof event.error === 'object'
    ? event.error as Record<string, unknown>
    : undefined;
  const details = error?.details && typeof error.details === 'object'
    ? error.details as Record<string, unknown>
    : undefined;
  return typeof details?.reasonCode === 'string' ? details.reasonCode : undefined;
}

function sseFailureMessage(event: Record<string, unknown>, fallback: string): string {
  switch (sseFailureCode(event)) {
    case 'provider_failed': return '模型服务调用失败，请稍后重试';
    case 'provider_not_configured': return '模型服务尚未配置，请在电脑端检查 Provider 设置';
    case 'provider_unavailable': return '当前模型 Provider 不可用，请检查内置插件是否启用';
    case 'provider_capability_unavailable': return '当前模型 Provider 不支持本次请求';
    case 'provider_reloaded': return '模型 Provider 正在重载，请稍后重试';
    case 'provider_interrupted': return '模型服务调用被中断，请重试';
    case 'execution_lease_lost': return '生成任务执行权已失效，请重试';
    case 'skill_context_conflict': return '完整 Skill 与必需上下文超出模型容量，请调整上下文配置';
    default: return typeof event.message === 'string' && event.message.trim().length > 0
      ? event.message
      : fallback;
  }
}
interface AbortTurnResult {
  ok: boolean;
  aborted: boolean;
  alreadyFinished?: boolean;
  round: number | null;
  runId?: string | null;
  kept: boolean;
  waited: boolean;
  settled?: boolean;
  cancelledBeforeStart?: boolean;
}
/** 主题三档（按 server/client namespace 持久化） */
type Theme = 'dark' | 'sepia' | 'paper';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;

let msgSeq = 0;
const nextMsgId = () => ++msgSeq;

const api = async <T,>(path: string, opts?: RequestInit, timeoutMs = 0): Promise<T> => {
  try {
    const headers = new Headers(opts?.headers);
    if (opts?.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const res = await fetchWithInactivityTimeout(
      (signal) => authFetch(path, { ...opts, headers, signal }),
      timeoutMs,
      opts?.signal ?? undefined,
    );
    return await responseJson<T>(res);
  } catch (e) {
    if (e instanceof NetworkInactivityTimeoutError && !opts?.signal?.aborted) {
      throw new Error(`网络连续 ${timeoutMs}ms 未收到任何数据，请检查连接后重试`);
    }
    throw e;
  }
};

/** SSE 流式请求：POST + 读 event stream，回调各事件；signal 用于中止（前端停止按钮） */
class PrematureSseEnd extends Error {
  override name = 'PrematureSseEnd';
}

const apiStream = async (
  path: string,
  body: Record<string, unknown>,
  onEvent: (ev: Record<string, unknown>) => void,
  signal?: AbortSignal,
  onActivity?: () => void,
): Promise<void> => {
  const res = await authFetch(eventUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  onActivity?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawTerminal = false;
  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;
    } catch {
      return; // 忽略坏块
    }
    if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error') sawTerminal = true;
    // Callback failures are application failures and must reach sendText's catch;
    // do not swallow them as if the SSE chunk were malformed.
    onEvent(ev);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }
  buf += decoder.decode();
  if (buf.trim()) handleLine(buf);
  // error 是服务端明确给出的终态，由业务回调展示并收尾；只有缺少任何终态的 EOF
  // 才代表连接意外中断。不得把 terminal error 二次抛成“后台仍在运行”。
  if (!sawTerminal) throw new PrematureSseEnd('流式连接在收到结束事件前断开');
};

/** 合并服务端历史到本地消息列表，同时由 App 的统一序列分配新 React key。 */
const mergeHistory = (prev: Message[], server: { id: number; round: number; role: string; content: string }[]): Message[] => {
  return mergeMessageHistory(prev, server, nextMsgId);
};

/** 会话时间显示：当天 HH:MM，当年 MM-DD，跨年 YYYY-MM-DD */
const formatSessionTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const STAGE_LABEL: Record<string, string> = {
  card: '加载角色卡…',
  worldbook: '加载世界书…',
  vectorize: '向量化记忆（约 8 秒）…',
  engine: '接入 MVU 引擎…',
  ready: '就绪',
};

/** 消息行操作（稳定容器：App 每渲染更新字段，引用不变 → memo 不因回调新建而失效） */
interface MsgOps {
  regenerate: (m: Message) => void;
  deleteRound: (round: number) => void;
  deleteFromHere: (round: number) => void;
}

/** 单条消息行（memo：流式期旧消息 content 不变则不重渲染，避免全量 re-parse 卡死）
 *  仅比较渲染相关字段，忽略 ops/streamingMsgRef 等稳定引用 */
const MessageRow = React.memo(function MessageRow({
  m, busy, streaming, isLastAssistant, showRaw, regexRules, ops, streamingMsgRef, registerAnchor,
  sessionId, sessionRunId, preferredSceneUi, mountPlan, onExpandHistory,
}: {
  m: Message;
  busy: boolean;
  streaming: boolean;
  isLastAssistant: boolean;
  showRaw: boolean;
  regexRules: RegexRule[] | null;
  ops: MsgOps;
  streamingMsgRef: React.RefObject<HTMLDivElement>;
  registerAnchor: (key: string) => (el: HTMLDivElement | null) => void;
  sessionId: string | null;
  /** 会话运行实例（FE-04.3：一次有效会话运行周期；新增消息**不**轮换） */
  sessionRunId: string;
  /** FE-05.4：场景区段默认渲染路线（用户配置；**不按卡名强制**） */
  preferredSceneUi: 'native' | 'external';
  /** FE-05.4：历史页面轻量挂载策略（仅对含有可执行区段的消息生效） */
  mountPlan?: HistoryMountPlan;
  onExpandHistory?: (key: string) => void;
}) {
  const dr = showRaw || !regexRules ? { text: m.content, gal: [] as string[] } : applyDisplayRules(m.content, regexRules);
  const shown = dr.text;
  // 卡片"前端界面"规则的外链引擎 URL（存在 → 场景段提供「原生/外部前端」切换）
  const galExternalUrl = regexRules?.find((r) => r.galExternalUrl)?.galExternalUrl;
  const anchorKey = toMessageKey(m.round, m.role);
  // FE-04.1 统一视图契约：渲染选择集中到 planMessageView（只依格式/启用规则/能力/用户配置，不含卡名）
  const viewPlan = planMessageView({
    content: m.content, role: m.role, display: dr, showRaw, streaming,
    externalUrl: galExternalUrl,
    preferredSceneUi,
    scriptedCards: WEB_CLIENT_PROFILE.scriptedCards,
  });
  const singleText = viewPlan.segments.length === 1 && viewPlan.segments[0].renderer === 'text';
  const hasSegments = !singleText;
  // FE-05.4：只有"含可执行区段"的消息才受历史挂载策略影响（纯文本总是挂载，成本可忽略）
  const mountState = (viewPlan.executable || hasSegments) && mountPlan ? mountPlan.state : 'mount';
  // FE-04-A：本条消息**自己的**状态快照（存在性/版本/溯源）。找不到 → 明确无状态，绝不用"最新"顶替。
  const [stateInfo, setStateInfo] = useState<{ exists: boolean; stateVersion?: number; source?: string; note?: string } | null>(null);
  useEffect(() => {
    if (!sessionId || !m.serverId || streaming) { setStateInfo(null); return; }
    let alive = true;
    api<{ resolved: boolean; exists: boolean; stateVersion: number; source?: string; note?: string }>(
      `/api/session/${sessionId}/state?scope=message&message_id=${m.serverId}`,
    ).then((r) => { if (alive) setStateInfo({ exists: !!(r.resolved && r.exists), stateVersion: r.stateVersion, source: r.source, note: r.note }); })
      .catch(() => { if (alive) setStateInfo({ exists: false }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, m.serverId, streaming]);

  // 视图登记（诊断/浏览器验证：回答"这条消息为什么用这个渲染器、读哪份状态"）
  const viewCtx: MessageViewContext = {
    sessionId: sessionId ?? '', sessionRunId: sessionRunId ?? '', messageKey: anchorKey,
    messageId: m.serverId, floor: m.round, revision: undefined,
    state: stateInfo ? { exists: stateInfo.exists, stateVersion: stateInfo.stateVersion } : undefined,
    permissions: { draft: !busy, send: !busy, writeState: true },
  };
  useEffect(() => {
    recordMessageView(viewCtx, viewPlan);
    return () => unrecordMessageView(anchorKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPlan.reason, anchorKey, streaming, m.serverId, stateInfo?.exists, stateInfo?.stateVersion]);
  // 锚点 ref 记忆化（v0.1.0）：registerAnchor(key) 每次调用都返回新函数，
  // 直接内联会导致非流式行每渲染触发 ref 解绑/重绑、锚点 Map 反复增删（抖动）。
  // 按 anchorKey 记住同一引用，key 不变则 ref 引用稳定。
  const anchorRefCache = useRef<{ key: string; fn: ((el: HTMLDivElement | null) => void) | null }>({ key: '', fn: null });
  if (anchorRefCache.current.key !== anchorKey) {
    anchorRefCache.current = { key: anchorKey, fn: registerAnchor(anchorKey) };
  }
  return (
    <div
      className={`msg ${m.role}`}
      ref={streaming ? streamingMsgRef : anchorRefCache.current.fn}
      data-message-key={anchorKey}
    >
      <div className="msg-body">
        {mountState === 'unmount' ? (
          // 远历史：卸载可执行视图，仅保留消息条目 + 展开入口（重新展开时绑定原消息与原快照）
          <div className="bubble history-collapsed" data-mount-state="unmount">
            <button className="op-btn" onClick={() => onExpandHistory?.(anchorKey)}>展开历史页面（重新绑定原消息快照）</button>
          </div>
        ) : mountState === 'static-preview' ? (
          // 降级为静态预览：保留内容与锚点，但不挂载可执行页面（不启动脚本、不读状态）
          <div className="bubble read" data-mount-state="static-preview">
            <MarkdownMessage text={shown} />
            <div className="history-preview-note">
              <button className="op-btn" onClick={() => onExpandHistory?.(anchorKey)}>展开页面</button>
              <span>静态预览（未挂载可执行视图）</span>
            </div>
          </div>
        ) : hasSegments ? (
          <div className="msg-segments">
            {viewPlan.segments.map((seg, i) =>
              seg.renderer === 'native-scene' || seg.renderer === 'external-page'
                ? <GalSegment
                  key={i}
                  script={seg.content}
                  busy={busy}
                  externalUrl={WEB_CLIENT_PROFILE.scriptedCards ? galExternalUrl : undefined}
                  preferredMode={preferredSceneUi}
                  target={{ sessionId: sessionId ?? '', sessionRunId, messageKey: anchorKey, messageId: m.serverId, floor: m.round }}
                />
                : seg.renderer === 'card-html'
                  ? <HtmlMessage key={i} text={seg.content} target={{ sessionId: sessionId ?? '', sessionRunId, messageKey: anchorKey, messageId: m.serverId, floor: m.round }} />
                  : <div key={i} className="bubble read"><MarkdownMessage text={seg.content} /></div>
            )}
          </div>
        ) : m.role === 'assistant' ? (
          <div className={`bubble read${streaming ? ' streaming' : ''}`}>
            {streaming ? <StreamText text={shown} /> : <MarkdownMessage text={shown} />}
          </div>
        ) : (
          <div className="bubble">{shown}</div>
        )}
        <div className="msg-ops">
          {m.round > 0 && (
            <>
              {m.role === 'assistant' && isLastAssistant && (
                <button className="op-btn" title="重新生成上一条 AI 回复" onClick={() => ops.regenerate(m)} disabled={busy}>↻</button>
              )}
              <button className="op-btn" title="删除本轮（用户消息 + AI 回复）" onClick={() => ops.deleteRound(m.round)} disabled={busy}>✕</button>
              <button className="op-btn" title="从本轮删到结尾" onClick={() => ops.deleteFromHere(m.round)} disabled={busy}>⧗</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}, (prev, next) =>
  prev.m.id === next.m.id && prev.m.round === next.m.round && prev.m.role === next.m.role
  && prev.m.content === next.m.content && prev.m.serverId === next.m.serverId
  && prev.busy === next.busy && prev.sessionId === next.sessionId && prev.sessionRunId === next.sessionRunId
  && prev.streaming === next.streaming && prev.isLastAssistant === next.isLastAssistant
  && prev.showRaw === next.showRaw && prev.regexRules === next.regexRules
  && prev.preferredSceneUi === next.preferredSceneUi
  && prev.mountPlan?.state === next.mountPlan?.state
);

export function App({ storageNamespace }: { storageNamespace: ClientStorageNamespace }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  /** TavernHelper 世界书桥最近一次成功读取的实体 revision；写回必须消费同一快照。 */
  const worldbookRevisionRef = useRef<Map<string, string>>(new Map());
  const activationEpochRef = useRef(0);
  activeSessionRef.current = sessionId;
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [dragImageOver, setDragImageOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const online = useOnlineStatus();
  const loadedDraftSessionRef = useRef<string | null>(null);
  const submittedDraftSessionRef = useRef<string | null>(null);
  const skipDraftPersistRef = useRef(false);
  // v0.6.0：一次 AI 回复生成完成信号（供"生成完成智能定位"触发跳转；每次开新生成前清 false）
  const [streamCompleted, setStreamCompleted] = useState(false);
  const [initStage, setInitStage] = useState('');
  const [contentMode, setContentMode] = useState<'nsfw' | 'nsf'>('nsfw');
  const [tab, setTab] = useState<'setup' | 'chat' | 'memory' | 'provider' | 'assets' | 'editor' | 'plugins' | 'skills' | 'quality'>('setup');
  const [error, setError] = useState('');
  // AQL：重规划建议卡（override 建议方向；不进对话，仅在重发 ≥replanK 后本会话内展示，可手动关闭）
  const [replanSuggestion, setReplanSuggestion] = useState('');
  const [adultOk, setAdultOk] = useState<boolean>(
    () => localStorage.getItem(storageNamespace.preferenceKey('adult-ok')) === '1',
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  // v0.6.0 消息锚点 + 楼层刻度 + 生成完成定位：滚动视口 ref / 锚点注册表 / 3 个定位 hook
  const scrollRef = useRef<HTMLDivElement>(null);
  const { refMap, register, getElement } = useMessageRefs();
  // 正则管道：对话原始标记（<think>/<UpdateVariable>/<era_data> 等）前端自动屏蔽隐藏
  const [globalRegexRules, setGlobalRegexRules] = useState<RegexRule[] | null>(null);
  const [sessionRegexRules, setSessionRegexRules] = useState<RegexRule[] | null>(null);
  const [sessionRuleOwner, setSessionRuleOwner] = useState('');
  const [sharedBundleOwner, setSharedBundleOwner] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  // 美化：主题 / 字号 / 侧栏常驻推进槽
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageNamespace.preferenceKey('theme')) as Theme) || 'dark',
  );
  const [readFs, setReadFs] = useState<number>(
    () => Number(localStorage.getItem(storageNamespace.preferenceKey('read-font-size'))) || 16,
  );
  // 侧栏宽度（可拖动；读 localStorage，越界则回退默认值）
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageNamespace.preferenceKey('sidebar-width')));
    return saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W ? saved : SIDEBAR_DEFAULT_W;
  });
  const {
    open: mobileNavOpen,
    mobile: mobileLayout,
    openDrawer: openMobileNav,
    closeDrawer: closeMobileNav,
  } = useMobileDrawer();
  const {
    open: mobileStoryOpen,
    openDrawer: openMobileStory,
    closeDrawer: closeMobileStory,
  } = useMobileDrawer('__jiuguanStoryIndex');
  const mobileNavToggleRef = useRef<HTMLButtonElement>(null);
  const mobileNavCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavPanelRef = useRef<HTMLElement>(null);
  const mobileMainRef = useRef<HTMLElement>(null);
  const mobileStoryToggleRef = useRef<HTMLButtonElement>(null);
  const mobileStoryCloseRef = useRef<HTMLButtonElement>(null);
  const mobileNavWasOpenRef = useRef(false);
  const mobileStoryWasOpenRef = useRef(false);
  const mobileStoryRestoreFocusRef = useRef(true);
  useEffect(() => {
    if (mobileNavOpen) mobileNavCloseRef.current?.focus();
    else if (mobileNavWasOpenRef.current) mobileNavToggleRef.current?.focus();
    mobileNavWasOpenRef.current = mobileNavOpen;
  }, [mobileNavOpen]);
  useEffect(() => {
    if (mobileStoryOpen) mobileStoryCloseRef.current?.focus();
    else if (mobileStoryWasOpenRef.current && mobileStoryRestoreFocusRef.current) {
      mobileStoryToggleRef.current?.focus();
    }
    if (!mobileStoryOpen) mobileStoryRestoreFocusRef.current = true;
    mobileStoryWasOpenRef.current = mobileStoryOpen;
  }, [mobileStoryOpen]);
  useEffect(() => setGenerationActivity(busy), [busy]);
  useEffect(() => () => setGenerationActivity(false), []);
  useEffect(() => {
    skipDraftPersistRef.current = true;
    if (!sessionId) {
      loadedDraftSessionRef.current = null;
      submittedDraftSessionRef.current = null;
      setInput('');
      return;
    }
    const draft = readComposerDraft(localStorage, storageNamespace.draftKey(sessionId, 'composer'));
    loadedDraftSessionRef.current = sessionId;
    if (!draft) {
      submittedDraftSessionRef.current = null;
      setInput('');
      return;
    }
    if (draft.state === 'submitted') {
      submittedDraftSessionRef.current = sessionId;
      setInput('');
      setRecoveryNotice('检测到上次未收尾的发送，正在与电脑端任务状态核对。');
      return;
    }
    submittedDraftSessionRef.current = null;
    setInput(draft.text);
    setRecoveryNotice('已恢复此会话尚未发送的草稿。');
  }, [sessionId, storageNamespace]);
  useEffect(() => {
    if (!sessionId || loadedDraftSessionRef.current !== sessionId) return;
    // 会话切换的同一 effect 批次仍携带旧输入；等待 setInput 的下一次 render，禁止串写新会话。
    if (skipDraftPersistRef.current) {
      skipDraftPersistRef.current = false;
      return;
    }
    const key = storageNamespace.draftKey(sessionId, 'composer');
    if (input) {
      submittedDraftSessionRef.current = null;
      writeComposerDraft(localStorage, key, input, 'editing');
    } else if (submittedDraftSessionRef.current !== sessionId) {
      clearComposerDraft(localStorage, key);
    }
  }, [input, sessionId, storageNamespace]);
  useEffect(() => {
    if (!recoveryNotice) return;
    const timer = window.setTimeout(() => setRecoveryNotice(''), 6_000);
    return () => window.clearTimeout(timer);
  }, [recoveryNotice]);

  const clearSubmittedDraft = (sid: string, force = false): void => {
    // 卡面/插件可在用户正编辑 composer 时独立发送；只有本 composer 已标记 submitted 才能清理。
    if (!force && submittedDraftSessionRef.current !== sid) return;
    clearComposerDraft(localStorage, storageNamespace.draftKey(sid, 'composer'));
    if (submittedDraftSessionRef.current === sid) submittedDraftSessionRef.current = null;
  };
  const selectMobileTab = (next: typeof tab) => {
    setTab(next);
    closeMobileNav();
  };
  const [turnState, setTurnState] = useState<TurnState | null>(null);
  // 剧情分支索引（AI 生成，按轮缓存）
  const [storyIndex, setStoryIndex] = useState<string>('');
  const [storyBranches, setStoryBranches] = useState<string[]>([]);
  const [storyBranchIds, setStoryBranchIds] = useState<string[]>([]);
  const [storyIndexRound, setStoryIndexRound] = useState<number>(-1);
  const [storyStaleSourceRound, setStoryStaleSourceRound] = useState<number | null>(null);
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyError, setStoryError] = useState('');
  const storyRequestRef = useRef(0);
  const pendingBranchSelectionRef = useRef<{
    sessionId: string; round: number; branchId: string;
  } | null>(null);
  // 流式生成时钉住正文起点（从头阅读）
  const streamingMsgRef = useRef<HTMLDivElement>(null);
  // 流式批合并（rAF 节流）：delta 先累积到 buf，每帧最多一次 setMessages，避免逐字全量 map 卡死
  const streamBufRef = useRef('');
  const streamRafRef = useRef<number | null>(null);
  const streamTargetRef = useRef<{ kind: 'id'; id: number } | { kind: 'round'; round: number } | null>(null);
  const resumeSeqRef = useRef(0);
  const generationMonitorSeqRef = useRef(0);
  const generationGateRef = useRef(new GenerationOperationGate());
  const generationGate = generationGateRef.current;
  const activateSession = (sid: string | null) => {
    if (activeSessionRef.current !== sid) {
      closeMobileStory();
      setStoryIndex('');
      setStoryBranches([]);
      setStoryBranchIds([]);
      setStoryIndexRound(-1);
      setStoryStaleSourceRound(null);
      setStoryError('');
      pendingBranchSelectionRef.current = null;
    }
    activationEpochRef.current += 1;
    activeSessionRef.current = sid;
    setSessionId(sid);
  };
  // 中止生成：busy 期间持有当前回合的 AbortController（发送键变停止键 + Esc）
  const abortRef = useRef<AbortController | null>(null);
  const generationTargetRef = useRef<{ sessionId: string; round?: number; runId: string; startedAt: number } | null>(null);
  const stopRequestRef = useRef<{ sessionId: string; runId: string; promise: Promise<AbortTurnResult> } | null>(null);
  const stoppingRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  const requestServerAbort = (
    sid: string,
    target?: { round?: number; runId?: string },
  ): Promise<AbortTurnResult> => api<AbortTurnResult>(
    `/api/session/${sid}/turn/abort`,
    {
      method: 'POST',
      // 独立请求绝不复用正在被 abort 的流 signal。
      body: JSON.stringify({
        ...(target?.round ? { round: target.round } : {}),
        ...(target?.runId ? { runId: target.runId } : {}),
      }),
    },
    CONTROL_REQUEST_TIMEOUT_MS,
  );

  /** 停止以服务端活动回合为准；本地 controller 只负责立刻停止读取当前 SSE。 */
  const stopGenerating = () => {
    const target = generationTargetRef.current;
    if (!target || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    const promise = requestServerAbort(target.sessionId, target);
    stopRequestRef.current = { sessionId: target.sessionId, runId: target.runId, promise };
    void promise.catch((e) => {
      logger.warn('turn', '服务端停止请求失败', { message: (e as Error).message });
      // A failed transport/stale response must not permanently disable Stop.
      // The stream catch or detached monitor keeps reconciling the active run.
      if (stopRequestRef.current?.promise === promise) {
        stopRequestRef.current = null;
        stoppingRef.current = false;
        setStopping(false);
      }
    });
    abortRef.current?.abort();
  };
  // 传输静默兜底：只断开本页 SSE 并转入状态恢复；绝不把慢网等同于用户取消。
  const genTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genTimedOutRef = useRef(false);
  const clearGenTimeout = () => {
    if (genTimeoutRef.current) { clearTimeout(genTimeoutRef.current); genTimeoutRef.current = null; }
  };
  const startGenTimeout = (_startedAt = Date.now()) => {
    clearGenTimeout();
    genTimedOutRef.current = false;
    touchGenerationActivity();
    genTimeoutRef.current = setTimeout(() => {
      genTimedOutRef.current = true;
      logger.warn('turn', '生成传输长期无活动，切换后台状态恢复', {
        timeoutMs: GENERATION_INACTIVITY_TIMEOUT_MS,
      });
      // 这里只关闭本页 reader。catch 会进入 monitorDetachedGeneration；服务端任务继续。
      abortRef.current?.abort();
    }, GENERATION_INACTIVITY_TIMEOUT_MS);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && busy) stopGenerating(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);
  const flushStream = () => {
    streamRafRef.current = null;
    const chunk = streamBufRef.current;
    streamBufRef.current = '';
    const target = streamTargetRef.current;
    if (!chunk || !target) return;
    setMessages((m) => m.map((x) => (
      (target.kind === 'id' && x.id === target.id)
      || (target.kind === 'round' && x.round === target.round && x.role === 'assistant')
        ? { ...x, content: x.content + chunk }
        : x
    )));
    // 生成期底部跟随（v0.1.0：事件驱动，仅确有 delta 时执行，取代原 60fps 追随循环）
    // 未上滚读旧文 → 钉住底部让新内容持续可见；已上滚 → 不动，等用户回到底部后恢复
    if (userScrolledUpRef.current) return;
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  };
  const pushStream = (text: string) => {
    streamBufRef.current += text;
    if (streamRafRef.current == null) {
      streamRafRef.current = requestAnimationFrame(flushStream);
    }
  };
  const stopStream = () => {
    if (streamRafRef.current != null) { cancelAnimationFrame(streamRafRef.current); streamRafRef.current = null; }
    flushStream();
    streamTargetRef.current = null;
  };
  useEffect(() => () => { if (streamRafRef.current != null) cancelAnimationFrame(streamRafRef.current); }, []);  // 会话删除：两步内联确认
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 生成计时器
  const [genSeconds, setGenSeconds] = useState(0);
  const genTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const genStartedAtRef = useRef<number | null>(null);
  const syncGenTimer = () => {
    if (genStartedAtRef.current != null) {
      setGenSeconds(elapsedGenerationSeconds(genStartedAtRef.current));
    }
  };
  const startGenTimer = (startedAt = Date.now()) => {
    genStartedAtRef.current = startedAt;
    setGenSeconds(elapsedGenerationSeconds(startedAt));
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    genTimerRef.current = setInterval(syncGenTimer, 100);
  };
  const stopGenTimer = () => {
    syncGenTimer();
    if (genTimerRef.current) { clearInterval(genTimerRef.current); genTimerRef.current = null; }
    genStartedAtRef.current = null;
  };
  useEffect(() => {
    // 后台标签页的 interval 会被节流；恢复可见/焦点时立即按墙钟校正。
    const sync = () => syncGenTimer();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('pageshow', sync);
      if (genTimerRef.current) clearInterval(genTimerRef.current);
      if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current);
    };
  }, []);

  // 主题应用到 <html data-theme>，字号写到 --read-fs 变量
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(storageNamespace.preferenceKey('theme'), theme);
  }, [theme]);
  // 主题同步到已注册 iframe/外部页（__jgfh:host）
  useEffect(() => { broadcastToFrames({ __jgfh: 'host', op: 'theme', value: theme }); }, [theme]);
  // FE-06.0：宿主 → 页面 的真实事件通道（页面订阅 Mvu.on / eventSource.on 时确实收到）
  // 仅转发**已提交**的事实，不伪造提交事件（未提交成功不会广播）。
  const notifyHostEvent = (op: 'state' | 'session-state' | 'message', value: Record<string, unknown>, target?: Record<string, unknown>) => {
    // FE-04.2：事件**绑定目标** —— 页面侧按 __jgViewTarget 过滤，只更新相关视图
    broadcastToFrames({ __jgfh: 'host', op, value, target });
    // FE-06.1：同一事件按**用途**派发给已订阅的面板（正确目标收到更新；退订后不再收到）
    const purpose = op === 'state' ? 'message-state' : op === 'session-state' ? 'session-state' : 'message';
    // 三层账本：Agent 正常业务产生的助手消息（与"动作直接影响"分开记账）
    if (op === 'message' && (value as { event?: string }).event === 'MESSAGE_RECEIVED') {
      recordEffect('agent-business', 'assistant-message');
    }
    const decisions = dispatchPanelEvent({
      purpose,
      target: target as never,
      sessionId: sessionId ?? '',
      sessionRunId,
    });
    if (decisions.length > 0) {
      logger.info('ui', `面板事件派发 ${purpose}`, decisions);
    }
  };
  // FE-B2：会话级共享脚本包 —— 会话切换时重置并重新拉取（切会话不串包）
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setSharedBundleOwner('');
    if (!sessionId) {
      resetSharedBundle('');
      resetSharedStatus();
      return () => { alive = false; controller.abort(); };
    }
    resetSharedStatus();
    const fetchBundle = <T,>(path: string) => api<T>(
      path,
      { signal: controller.signal },
      SESSION_RESOURCE_TIMEOUT_MS,
    );
    void loadSharedBundle(sessionId, fetchBundle).then(() => {
      if (alive && activeSessionRef.current === sessionId) setSharedBundleOwner(sessionId);
    });
    return () => { alive = false; controller.abort(); };
  }, [sessionId]);
  useEffect(() => {
    document.documentElement.style.setProperty('--read-fs', `${readFs}px`);
    localStorage.setItem(storageNamespace.preferenceKey('read-font-size'), String(readFs));
  }, [readFs]);
  // 侧栏宽度持久化（与 theme/read-fs 一致：变化即写入 localStorage）
  useEffect(() => {
    localStorage.setItem(storageNamespace.preferenceKey('sidebar-width'), String(sidebarW));
  }, [sidebarW]);

  // 侧栏右缘拖把：mousedown 后在 document 级监听移动，宽度 clamp 到 [MIN,MAX]；松手清理
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const startSidebarDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarW };
    document.body.style.userSelect = 'none'; // 拖动时禁止选中文本，避免拖出选区/闪烁
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const d = sidebarDragRef.current;
      if (!d) return;
      const w = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, d.startW + ev.clientX - d.startX));
      setSidebarW(w);
    };
    const onUp = () => {
      sidebarDragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  /** 拉取推进槽（会话创建/恢复/每轮结束后刷新）；顺带按轮拉取剧情分支索引（round>0 才拉，避免开场白空转一次 AI） */
  const loadTurnState = (sid: string) => api<TurnStatePayload>(
    `/api/session/${sid}/turn-state`,
    undefined,
    CONTROL_REQUEST_TIMEOUT_MS,
  );
  const fetchTurnState = async (sid: string, activation = activationEpochRef.current) => {
    try {
      const d = await loadTurnState(sid);
      if (activeSessionRef.current !== sid || activationEpochRef.current !== activation) return;
      setTurnState(d.state ?? null);
      if (d.state && d.state.round > 0) void fetchStoryIndex(sid, d.state.round);
    } catch { /* 侧栏状态拉取失败不影响使用 */ }
  };

  /** 刷新角色卡列表（导入/切换建会话面板后同步侧栏） */
  const refreshCards = async () => {
    try {
      const d = await api<{ cards: Card[] }>('/api/cards');
      setCards(d.cards ?? []);
    } catch { /* 静默 */ }
  };

  /** 拉取 AI 剧情分支索引（后端按轮缓存，重复请求零成本；force=true 跳过缓存强制重建） */
  const fetchStoryIndex = async (sid: string, round: number, force = false) => {
    if (!sid || round < 1) return;
    const request = ++storyRequestRef.current;
    const activation = activationEpochRef.current;
    setStoryLoading(true);
    setStoryError('');
    try {
      const d = await api<{
        content: string; branches: string[]; branchIds?: string[]; round: number; fromCache: boolean;
        stale?: boolean; sourceRound?: number; failureCode?: string; retryAfterSeconds?: number;
      }>(
        `/api/session/${sid}/story-index`,
        {
          method: 'POST',
          body: JSON.stringify({ round, force }),
        },
      );
      if (
        request !== storyRequestRef.current
        || activeSessionRef.current !== sid
        || activationEpochRef.current !== activation
      ) return;
      setStoryIndex(d.content ?? '');
      setStoryBranches(d.branches ?? []);
      setStoryBranchIds(d.branchIds ?? []);
      setStoryIndexRound(d.round ?? -1);
      setStoryStaleSourceRound(d.stale === true && Number.isSafeInteger(d.sourceRound)
        ? Number(d.sourceRound)
        : null);
      if (d.stale === true || pendingBranchSelectionRef.current?.round !== d.round) {
        pendingBranchSelectionRef.current = null;
      }
    } catch (e) {
      if (
        request === storyRequestRef.current
        && activeSessionRef.current === sid
        && activationEpochRef.current === activation
      ) {
        setStoryError((e as Error).message || '剧情索引读取失败');
        if (isLegacyGenericStoryFallback(storyBranches)) {
          setStoryIndex('');
          setStoryBranches([]);
          setStoryBranchIds([]);
          setStoryStaleSourceRound(null);
        }
      }
    }
    finally {
      if (request === storyRequestRef.current) setStoryLoading(false);
    }
  };

  /** 刷新会话列表（标题/最新消息预览/轮次，来自服务端） */
  const refreshSessions = async () => {
    try {
      const d = await api<{ sessions: SessionInfo[] }>('/api/sessions');
      setSessions(d.sessions ?? []);
    } catch { /* 静默 */ }
  };

  /** 剧情分支按钮：填入输入框并聚焦 */
  const applyBranch = (branch: string) => {
    const index = storyBranches.indexOf(branch);
    const branchId = index >= 0 ? storyBranchIds[index] : undefined;
    pendingBranchSelectionRef.current = branchId && sessionId && storyIndexRound > 0
      ? { sessionId, round: storyIndexRound, branchId }
      : null;
    setInput(branch);
    inputRef.current?.focus();
  };
  const applyMobileBranch = (branch: string) => {
    const index = storyBranches.indexOf(branch);
    const branchId = index >= 0 ? storyBranchIds[index] : undefined;
    pendingBranchSelectionRef.current = branchId && sessionId && storyIndexRound > 0
      ? { sessionId, round: storyIndexRound, branchId }
      : null;
    mobileStoryRestoreFocusRef.current = false;
    closeMobileStory();
    setInput(branch);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const storyAvailable = Boolean(sessionId && (turnState?.round ?? 0) > 0);
  const mobileStoryEffectiveOpen = mobileStoryOpen && storyAvailable;
  const storyDisplayRound = storyIndexRound > 0 ? storyIndexRound : (turnState?.round ?? -1);
  useEffect(() => {
    if (mobileStoryOpen && !storyAvailable) closeMobileStory();
  }, [closeMobileStory, mobileStoryOpen, storyAvailable]);
  useEffect(() => {
    if (mobileNavPanelRef.current) {
      mobileNavPanelRef.current.inert = mobileLayout && !mobileNavOpen;
    }
    if (mobileMainRef.current) {
      mobileMainRef.current.inert = mobileLayout && (mobileNavOpen || mobileStoryEffectiveOpen);
    }
  }, [mobileLayout, mobileNavOpen, mobileStoryEffectiveOpen]);
  const containMobileStoryFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  const refreshStoryIndex = () => {
    if (!sessionId || storyDisplayRound < 1) return;
    void fetchStoryIndex(sessionId, storyDisplayRound, true);
  };

  /** 删除会话（两步内联确认；历史全部清除 + db 移除） */
  const deleteSession = async (s: SessionInfo) => {
    if (!s.revision) {
      setError('会话快照暂时不可用，已拒绝删除以保护本地数据');
      return;
    }
    if (confirmDel !== s.id) { setConfirmDel(s.id); return; } // 第一次点击 → 进入确认态
    setConfirmDel(null);
    logger.info('session', '删除会话', { session: s.id });
    try {
      await api(`/api/session/${s.id}/delete`, {
        method: 'POST',
        headers: revisionHeaders(s.revision),
      });
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
      if (resumingSessionId === s.id) {
        resumeSeqRef.current += 1;
        setResumeLoading(false);
        setResumingSessionId(null);
      }
      if (sessionId === s.id) {
        generationMonitorSeqRef.current += 1;
        storyRequestRef.current += 1;
        activateSession(null);
        setMessages([]);
        setTurnState(null);
        setStoryIndex('');
        setStoryBranches([]);
        setStoryIndexRound(-1);
        setStoryStaleSourceRound(null);
        setTab('setup');
      }
    } catch (e) {
      setError((e as Error).message);
      await refreshSessions();
    }
  };

  useEffect(() => {
    api<{ cards: Card[] }>('/api/cards').then((d) => setCards(d.cards)).catch((e) => setError(e.message));
    refreshSessions();
    api<{ rules: RegexRule[] }>('/api/regex-rules').then((d) => setGlobalRegexRules(d.rules ?? [])).catch(() => {});
  }, []);

  /**
   * FE-06.0 有效规则来源：带 session 拉取时后端会按**当前卡版本**重算作者真值并返回来源诊断。
   * 只把 `effectiveIds` 里的规则交给渲染 —— 冲突未确认（pending-confirmation）的规则不自动运行。
   * 拉取失败/无会话时退回全局规则集（不改变既有行为）。
   */
  const [ruleProvenance, setRuleProvenance] = useState<{
    entries: { ruleId: string; name: string; status: string; reason: string; section: string; authorEnabled?: boolean; currentEnabled: boolean }[];
    effectiveIds: string[];
    pendingIds: string[];
    ambiguities: { section: string; candidates: { ruleId: string; name: string; origin: string }[]; reason: string }[];
    sessionCard?: string;
  } | null>(null);
  useEffect(() => {
    setSessionRuleOwner('');
    setSessionRegexRules(null);
    setRuleProvenance(null);
    if (!sessionId) return;
    let alive = true;
    const controller = new AbortController();
    api<{ rules: RegexRule[]; provenance?: typeof ruleProvenance }>(
      `/api/regex-rules?session=${encodeURIComponent(sessionId)}`,
      { signal: controller.signal },
      SESSION_RESOURCE_TIMEOUT_MS,
    )
      .then((d) => {
        if (!alive || activeSessionRef.current !== sessionId) return;
        setSessionRegexRules(d.rules ?? []);
        setRuleProvenance(d.provenance ?? null);
        setSessionRuleOwner(sessionId);
      })
      .catch(() => {
        // 请求失败时宁可无规则降级，也绝不把上一张卡/全局其它卡的规则串进当前会话。
        if (alive && activeSessionRef.current === sessionId) {
          setSessionRegexRules([]);
          setSessionRuleOwner(sessionId);
        }
      })
    return () => { alive = false; controller.abort(); };
  }, [sessionId]);

  /** 渲染用规则集：有来源诊断时只取"可运行"的规则（含历史未标记数据，已报告为诊断缺口） */
  const renderRules = useMemo(() => {
    const ownedRules = sessionId
      ? (sessionRuleOwner === sessionId ? sessionRegexRules : null)
      : globalRegexRules;
    if (!ownedRules) return null;
    if (!ruleProvenance) return ownedRules;
    const ok = new Set(ruleProvenance.effectiveIds);
    return ownedRules.filter((r) => ok.has(r.id));
  }, [sessionId, sessionRuleOwner, sessionRegexRules, globalRegexRules, ruleProvenance]);
  const sessionResourcesReady = Boolean(
    sessionId && sharedBundleOwner === sessionId && sessionRuleOwner === sessionId,
  );

  // 探针（只读）：回答"这条规则为什么生效 / 为什么没生效"
  useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>).__jgRuleProvenance = () => ruleProvenance;
  }, [ruleProvenance]);

  // 每次切到"新建会话"面板时同步侧栏角色卡列表（导入后立即可见）
  useEffect(() => { if (tab === 'setup') refreshCards(); }, [tab]);

  // v0.6.0：楼层刻度数据源（round+role 结构串，流式期结构不变则不触发 scroll-spy 重建监听）
  const historyStructureKey = messages.map((m) => `${m.id}:${m.round}:${m.role}`).join('|');
  const historyForSpy = useMemo(
    () => messages.map((m) => ({ round: m.round, role: m.role })),
    // Streaming text changes do not rebuild IntersectionObserver/scroll-spy subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyStructureKey],
  );
  // 最新一条 AI 回复所在轮的锚点键（供生成完成智能定位跳到该回复开头）
  const lastAssistantAnchorKey = useMemo(() => {
    let lastRound = -1;
    for (const m of messages) {
      if (m.role === 'assistant' && m.round > lastRound) lastRound = m.round;
    }
    return lastRound >= 0 ? toMessageKey(lastRound, 'assistant') : null;
  }, [messages]);

  // v0.6.0：当前楼层检测（scroll-spy）——监听视口滚动定位当前所在轮
  const activeKey = useScrollSpy(scrollRef, refMap, historyForSpy);

  // v0.6.0：手动滚动定位（点击刻度跳转）
  const scrollToKey = useScrollToMessage(getElement, scrollRef);

  // 生成完成智能定位：未上滚 → 滚到新 AI 回复开头；上滚读旧内容 → 显示"查看新回复"浮窗
  // 生成期底部跟随由 flushStream（有 delta 的 rAF 帧）执行，userScrolledUpRef 表示用户是否上滚
  const { showJumpButton, jumpKey, dismissJump, userScrolledUpRef } = useAutoScrollToMessage(
    scrollRef,
    getElement,
    lastAssistantAnchorKey,
    busy,
    streamCompleted,
  );

  /** 会话创建完成回调（SessionSetup 面板 → 进入对话） */
  const onSessionCreated = (sid: string, greeting: string, cardName: string, mode: string) => {
    logger.info('session', '会话创建', { session: sid, card: cardName, mode });
    resumeSeqRef.current += 1;
    generationMonitorSeqRef.current += 1;
    storyRequestRef.current += 1;
    setSharedBundleOwner('');
    setSessionRuleOwner('');
    activateSession(sid);
    setContentMode(mode === 'nsf' ? 'nsf' : 'nsfw');
    setMessages([{ id: nextMsgId(), round: 0, role: 'assistant', content: greeting }]);
    refreshSessions();
    setTab('chat');
    fetchTurnState(sid);
  };

  const loadHistory = async (sid: string) => {
    const t0 = performance.now();
    const raw = await api<unknown>(
      `/api/session/${sid}/history`,
      undefined,
      HISTORY_REQUEST_TIMEOUT_MS,
    );
    const h = parseHistoryPayload(raw);
    logger.debug('session', '拉取会话历史', { session: sid, count: h.messages.length, ms: Math.round(performance.now() - t0) });
    return h;
  };

  /** 拉取会话历史并合并到本地（稳定 key：round+role 匹配保留前端 id） */
  const fetchHistory = async (sid: string, activation = activationEpochRef.current): Promise<void> => {
    const h = await loadHistory(sid);
    if (activeSessionRef.current !== sid || activationEpochRef.current !== activation) return;
    setMessages((prev) => mergeHistory(prev, h.messages));
  };

  const finishGenerationUi = (lease: GenerationLease) => {
    if (!generationGate.release(lease)) return false;
    generationTargetRef.current = null;
    stopRequestRef.current = null;
    abortRef.current = null;
    stoppingRef.current = false;
    setStopping(false);
    clearGenTimeout();
    genTimedOutRef.current = false;
    stopStream();
    stopGenTimer();
    setStreamCompleted(true);
    setBusy(false);
    return true;
  };

  /**
   * 中止收尾以 turn-state 的终态为准。服务端返回 202/连接失败时保持 stopping，
  * 避免后台回合仍活跃但前端已经放开下一次发送。
  */
  const finalizeAbort = async (sid: string, round: number | undefined, runId: string, lease: GenerationLease) => {
    const deadlineAt = Date.now() + ABORT_FINALIZE_DEADLINE_MS;
    try {
      const pending = stopRequestRef.current;
      if (pending?.sessionId === sid && pending.runId === runId) await pending.promise;
      else await requestServerAbort(sid, { round, runId });
    } catch (e) {
      logger.warn('turn', '停止请求未确认，继续按回合身份核对服务端状态', { runId, message: (e as Error).message });
    }

    let confirmedIdle = false;
    while (
      generationGate.owns(lease)
      && activeSessionRef.current === sid
      && Date.now() < deadlineAt
    ) {
      let turn: TurnStatePayload;
      try {
        turn = await loadTurnState(sid);
      } catch {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
        continue;
      }
      const active = turn.generation;
      if (!active?.active) {
        confirmedIdle = true;
        break;
      }
      if (active.runId && active.runId !== runId && active.startedAt != null) {
        // 另一标签页已经启动了新回合：采用它，而不是把“runId 变化”误判为空闲。
        lease.runId = active.runId;
        generationTargetRef.current = {
          sessionId: sid,
          round: active.round,
          runId: active.runId,
          startedAt: active.startedAt,
        };
        stopRequestRef.current = null;
        stoppingRef.current = false;
        setStopping(false);
        startGenTimer(active.startedAt);
        startGenTimeout(active.startedAt);
        void monitorDetachedGeneration(sid, active.runId, lease);
        return false;
      }
      const remaining = deadlineAt - Date.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(400, remaining)));
    }

    if (
      !confirmedIdle
      && generationGate.owns(lease)
      && activeSessionRef.current === sid
      && Date.now() >= deadlineAt
    ) {
      logger.error('turn', '后端停止确认超时，解除本页生成锁', { runId, timeoutMs: ABORT_FINALIZE_DEADLINE_MS });
      setError('后端无响应，已解除本页卡住状态。本轮可能仍在服务端运行，请重启软件后恢复会话。');
      return true;
    }

    try {
      await fetchHistory(sid);
      void fetchTurnState(sid);
      void refreshSessions();
    } catch { /* 中止落库/读回失败不阻塞 UI 收尾 */ }
    return true;
  };

  /** 页面重挂载后没有原 SSE reader：轮询稳定 runId，完成/停止后自动读回，不要求刷新页面。 */
  const monitorDetachedGeneration = async (sid: string, runId: string, lease: GenerationLease) => {
    const monitor = ++generationMonitorSeqRef.current;
    let currentRunId = runId;
    let lastReachableAt = Date.now();
    while (
      monitor === generationMonitorSeqRef.current
      && activeSessionRef.current === sid
      && generationGate.owns(lease)
      && Date.now() - lastReachableAt < GENERATION_INACTIVITY_TIMEOUT_MS + ABORT_FINALIZE_DEADLINE_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      let d: TurnStatePayload;
      try { d = await loadTurnState(sid); } catch { continue; }
      lastReachableAt = Date.now();
      startGenTimeout();
      if (!d.generation?.active) break;
      if (d.generation.runId && d.generation.runId !== currentRunId && d.generation.startedAt != null) {
        currentRunId = d.generation.runId;
        lease.runId = currentRunId;
        generationTargetRef.current = {
          sessionId: sid,
          round: d.generation.round,
          runId: currentRunId,
          startedAt: d.generation.startedAt,
        };
        stopRequestRef.current = null;
        stoppingRef.current = false;
        setStopping(false);
        startGenTimer(d.generation.startedAt);
        startGenTimeout(d.generation.startedAt);
      }
      syncGenTimer();
    }
    if (monitor !== generationMonitorSeqRef.current || activeSessionRef.current !== sid) return;
    if (!generationGate.owns(lease) || generationTargetRef.current?.runId !== currentRunId) return;
    if (Date.now() - lastReachableAt >= GENERATION_INACTIVITY_TIMEOUT_MS + ABORT_FINALIZE_DEADLINE_MS) {
      logger.error('turn', '后台回合状态长期不可达，解除本页生成锁', { runId: currentRunId });
      setError('后端长时间无响应，已解除本页卡住状态。请重启软件后恢复会话。');
      const draft = readComposerDraft(localStorage, storageNamespace.draftKey(sid, 'composer'));
      if (draft?.state === 'submitted') {
        writeComposerDraft(localStorage, storageNamespace.draftKey(sid, 'composer'), draft.text, 'editing');
        submittedDraftSessionRef.current = null;
        setInput(draft.text);
        setRecoveryNotice('未能确认后台任务，已把发送内容恢复为草稿。');
      }
      finishGenerationUi(lease);
      return;
    }
    try { await fetchHistory(sid); } catch { /* 保留现有消息，稍后手动刷新仍可恢复 */ }
    void fetchTurnState(sid);
    void refreshSessions();
    clearSubmittedDraft(sid);
    setRecoveryNotice('后台生成任务已恢复并同步最新结果。');
    finishGenerationUi(lease);
  };

  const resumeSession = async (sid: string) => {
    logger.info('session', '恢复会话', { session: sid });
    // 不占用 busy：busy 语义 = 生成中（按钮变「停止」）。恢复期间 abortRef 为空，假 busy 会展示一个点了无效的停止键
    const seq = ++resumeSeqRef.current;
    generationMonitorSeqRef.current += 1;
    storyRequestRef.current += 1;
    setResumeLoading(true);
    setResumingSessionId(sid);
    setError('');
    // 先卸载旧会话卡面并展示明确 loading；服务端 resume 完成前绝不触发新会话的 bundle/规则/状态请求。
    activateSession(null);
    setSharedBundleOwner('');
    setSessionRuleOwner('');
    setMessages([]);
    setTurnState(null);
    setStoryIndex('');
    setStoryBranches([]);
    setStoryIndexRound(-1);
    setStoryStaleSourceRound(null);
    setPendingImages([]);
    setStreamCompleted(false);
    setTab('chat');
    try {
      await api(
        '/api/session/resume',
        { method: 'POST', body: JSON.stringify({ db: `${sid}.db` }) },
        SESSION_RESOURCE_TIMEOUT_MS,
      );
      if (seq !== resumeSeqRef.current) return;
      const history = await loadHistory(sid);
      const turn = await loadTurnState(sid).catch((): TurnStatePayload => ({ state: null }));
      if (seq !== resumeSeqRef.current) return;
      // 历史与状态都已绑定目标 sid，统一提交；旧会话的迟到响应没有写状态的机会。
      activateSession(sid);
      setMessages(mergeHistory([], history.messages));
      setTurnState(turn.state ?? null);
      if (turn.state && turn.state.round > 0) void fetchStoryIndex(sid, turn.state.round);
      const running = turn.generation;
      if (running?.active && running.runId && running.startedAt != null) {
        const lease = generationGate.claim(sid, running.runId);
        if (!lease) throw new Error('已有本地生成操作正在收尾，请稍候');
        generationTargetRef.current = {
          sessionId: sid,
          round: running.round,
          runId: running.runId,
          startedAt: running.startedAt,
        };
        setBusy(true);
        startGenTimer(running.startedAt);
        startGenTimeout(running.startedAt);
        setRecoveryNotice('已接续电脑端正在运行的生成任务，可继续等待结果。');
        void monitorDetachedGeneration(sid, running.runId, lease);
      } else {
        generationTargetRef.current = null;
        setBusy(false);
        const draft = readComposerDraft(localStorage, storageNamespace.draftKey(sid, 'composer'));
        if (draft?.state === 'submitted') {
          const committed = history.messages.some((message) => message.role === 'user' && message.content.includes(draft.text));
          if (committed) {
            clearSubmittedDraft(sid, true);
            setRecoveryNotice('已确认上次发送内容并同步会话历史。');
          } else {
            writeComposerDraft(localStorage, storageNamespace.draftKey(sid, 'composer'), draft.text, 'editing');
            submittedDraftSessionRef.current = null;
            setInput(draft.text);
            setRecoveryNotice('上次发送未被电脑端确认，已恢复为可编辑草稿。');
          }
        }
      }
    } catch (e) {
      if (seq !== resumeSeqRef.current) return;
      logger.error('session', '恢复会话失败', { message: (e as Error).message });
      setError((e as Error).message);
      activateSession(null);
      setMessages([]);
    } finally {
      if (seq === resumeSeqRef.current) {
        setResumeLoading(false);
        setResumingSessionId(null);
      }
    }
  };

  const fileToPendingImage = (file: File): Promise<PendingImage> => new Promise((resolve, reject) => {
    if (!IMAGE_MIMES.has(file.type)) {
      reject(new Error(`不支持的图片类型: ${file.type || file.name}`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: 'image',
      name: file.name || 'image',
      mime: file.type as PendingImage['mime'],
      size: file.size,
      dataUrl: String(reader.result ?? ''),
    });
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });

  const addImageFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const room = MAX_IMAGE_COUNT - pendingImages.length;
    if (room <= 0) {
      setError(`单轮最多发送 ${MAX_IMAGE_COUNT} 张图片`);
      return;
    }
    try {
      const next = await Promise.all(images.slice(0, room).map(fileToPendingImage));
      setPendingImages((prev) => [...prev, ...next].slice(0, MAX_IMAGE_COUNT));
      if (images.length > room) setError(`已添加前 ${room} 张图片，单轮最多 ${MAX_IMAGE_COUNT} 张`);
      else setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 公共发送路径：输入框 send 与前端卡 choice/draft 共用。
   *  mode 'send' → 直接作为用户消息发出触发 AI；'draft' → 填入输入框不自动发送（与分支按钮一致）。
   *  不清空输入框（外部调用者不应动用户输入）；输入框清空由 send() 自身处理。 */
  const sendText = async (raw: string, mode: 'send' | 'draft' = 'send', attachments: PendingImage[] = []) => {
    if (mode === 'draft') { applyBranch(raw); return; }
    const text = String(raw ?? '').trim();
    if (!text && attachments.length === 0) return;
    if (!sessionId) {
      setError('请先选择或恢复一个会话。');
      return;
    }
    if (!sessionResourcesReady) {
      setError('当前会话资源仍在加载，请稍候再发送。');
      return;
    }
    if (busy || generationGate.active) {
      setError('上一轮仍在生成或收尾，请等待“正在生成”状态结束后再发送。');
      return;
    }
    const sid = sessionId;
    const startedAt = Date.now();
    const runId = createClientRunId(startedAt);
    const lease = generationGate.claim(sid, runId);
    if (!lease) return;
    // 开场白是 round 0；正式发送必须从下一轮开始。若仍写 0，会与开场卡面共用
    // round+role 身份，历史读回时让临时回复夺走开场 iframe 的 React key。
    const optimisticRound = nextOptimisticRound(messagesRef.current, turnState?.round);
    const userId = nextMsgId();
    const replyId = nextMsgId();
    const ac = new AbortController();
    abortRef.current = ac;
    generationTargetRef.current = { sessionId: sid, round: optimisticRound, runId, startedAt };
    logger.info('turn', '发送消息', { session: sid, content_mode: contentMode, via: 'gla', images: attachments.length });
    setBusy(true);
    setStreamCompleted(false);
    setError('');
    startGenTimer(startedAt);
    startGenTimeout(startedAt);
    const imageLines = attachments.map((a, i) => `[图片${attachments.length > 1 ? i + 1 : ''}: ${a.name}]`);
    const shownText = [text, ...imageLines].filter(Boolean).join('\n');
    setMessages((m) => [
      ...m,
      { id: userId, round: optimisticRound, role: 'user', content: shownText },
      { id: replyId, round: optimisticRound, role: 'assistant', content: '' },
    ]);
    notifyHostEvent('message', { event: 'MESSAGE_SENT', role: 'user' }, { sessionId: sid, sessionRunId });
    streamTargetRef.current = { kind: 'id', id: replyId };
    let deltaCount = 0;
    let deltaLen = 0;
    let mayFinish = true;
    let terminalFailure: string | null = null;
    const pendingBranch = pendingBranchSelectionRef.current;
    const branchSelection = pendingBranch?.sessionId === sid
      && raw === input
      ? { round: pendingBranch.round, branchId: pendingBranch.branchId }
      : undefined;
    try {
      await apiStream('/api/turn', { session: sid, runId, input: text,
        content_mode: contentMode,
        attachments,
        ...(branchSelection ? { branchSelection } : {}),
      }, (ev) => {
        if (!generationGate.owns(lease)) return;
        if (ev.type === 'status') {
          const target = generationTargetRef.current;
          if (target?.sessionId === sid) {
            // P7：客户端预生成的 runId 只作兼容幂等键；首个 status 后切换为
            // 服务端权威 runId，后续 cancel/轮询都不得继续使用临时身份。
            if (typeof ev.runId === 'string' && ev.runId.length > 0 && target.runId !== ev.runId) {
              target.runId = ev.runId;
              lease.runId = ev.runId;
            }
            if (typeof ev.round === 'number' && target.round !== ev.round) {
              target.round = ev.round;
              // 多标签页等情况下服务端轮次可能高于本地预测；在正文卡面出现前校正
              // 同一对乐观消息，React key 不变，仅更新其真实楼层身份。
              setMessages((items) => items.map((message) => (
                message.id === userId || message.id === replyId
                  ? { ...message, round: ev.round as number }
                  : message
              )));
            }
            if (typeof ev.startedAt === 'number') {
              target.startedAt = ev.startedAt;
              startGenTimer(ev.startedAt);
              startGenTimeout(ev.startedAt);
            }
          }
        }
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          // 真流式：rAF 批合并逐帧追加（StreamText 渐进渲染，不做全量 re-parse）
          deltaCount++;
          deltaLen += ev.text.length;
          pushStream(ev.text);
        }
        if (ev.type === 'done' && typeof ev.prose === 'string') {
          // 兜底：done 携带完整 prose，整体覆盖（保证流式片段/重试后最终一致）
          stopStream();
          const prose = ev.prose;
          setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, content: prose } : x)));
        }
        if (ev.type === 'state') {
          // FE-04-A/B：把**已提交**的状态事实发给**目标消息**的页面（不伪造；未提交不发）
          if (ev.committed && typeof ev.messageId === 'number') {
            notifyHostEvent(
              'state',
              { messageId: ev.messageId, stateVersion: ev.stateVersion ?? null, source: ev.source ?? null, note: ev.note ?? null },
              { sessionId: sid, sessionRunId, messageId: ev.messageId },
            );
          } else {
            logger.debug('turn', '本回合无状态提交（页面按「无状态」显示）', { note: ev.note });
          }
        }
        if (ev.type === 'memory') {
          // AM-05：真实**记忆提交**（人物投影）的通知 —— 与"正文流结束"分开。
          // 面板据此在同作用域内重读并按 headVersion 拒绝旧响应；重复通知不额外触发业务写入。
          notifyHostEvent(
            'session-state',
            {
              headVersion: ev.headVersion ?? null,
              committed: ev.committed === true,
              characters: ev.characters ?? [],
              pending: ev.pending ?? [],
            },
            { sessionId: sid, sessionRunId },
          );
        }
        if (ev.type === 'error') {
          terminalFailure = sseFailureMessage(ev, '回合失败');
          logger.error('turn', '回合 SSE error', { message: terminalFailure });
          setError(`生成失败，本轮未写入：${terminalFailure}。发送内容已恢复，可直接重试。`);
        }
      }, ac.signal, startGenTimeout);
      logger.info('turn', '回合 SSE 完成', { deltaCount, deltaLen, aborted: ac.signal.aborted });
      // 回合结束 → 刷新推进槽（侧栏常驻）+ 拉真实 round（消息操作按 round 定位）+ 会话预览
      void fetchTurnState(sid);
      await fetchHistory(sid);
      void refreshSessions();
    } catch (e) {
      if (terminalFailure) {
        // SSE 已明确失败；其后的历史刷新即使失败，也不能改写成“连接断开/任务仍运行”。
        logger.warn('turn', '失败终态后的刷新未完成，保留服务端失败结果', { message: (e as Error).message });
      } else if ((e as { name?: string }).name === 'AbortError') {
        logger.warn('turn', '回合被中止', { timeout: genTimedOutRef.current });
        const target = generationTargetRef.current;
        if (genTimedOutRef.current && target?.sessionId === sid) {
          setError('连接连续 5 分钟未收到数据；不会取消电脑端任务，正在后台核对并等待结果。');
          void monitorDetachedGeneration(sid, target.runId, lease);
          mayFinish = false;
        } else {
          // 用户主动停止时，独立 /turn/abort 已发出；等待服务端落库定局并读回。
          mayFinish = await finalizeAbort(sid, target?.round, target?.runId ?? runId, lease);
        }
      } else {
        logger.error('turn', '回合失败', { message: (e as Error).message });
        const target = generationTargetRef.current;
        if (target?.sessionId === sid && generationGate.owns(lease)) {
          setError(e instanceof PrematureSseEnd
            ? '连接已中断，服务端仍在继续生成；正在后台恢复结果。'
            : `连接异常，正在核对服务端任务状态：${(e as Error).message}`);
          void monitorDetachedGeneration(sid, target.runId, lease);
          mayFinish = false;
        }
      }
    }
    if (!mayFinish || !finishGenerationUi(lease)) return;
    // FE-04-A：回合结束刷新历史 → 取得**稳定内部身份**（chat_log.id）。
    // 前端行身份与后端 id 解耦，但状态读取/事件目标必须用后端身份，否则页面目标对不上。
    if (activeSessionRef.current === sid) { try { await fetchHistory(sid); } catch { /* 刷新失败不阻塞 */ } }
    if (terminalFailure) {
      writeComposerDraft(localStorage, storageNamespace.draftKey(sid, 'composer'), text, 'editing');
      submittedDraftSessionRef.current = null;
      setInput((current) => current.trim().length > 0 ? current : text);
      setPendingImages((current) => current.length > 0 ? current : attachments);
      setRecoveryNotice('模型服务未完成本轮生成，发送内容已恢复为草稿。');
      return;
    }
    clearSubmittedDraft(sid);
    pendingBranchSelectionRef.current = null;
    // 回合结束 → 通知已挂载页面（MESSAGE_RECEIVED）；页面据此刷新视图，不额外触发业务更新
    notifyHostEvent('message', { event: 'MESSAGE_RECEIVED', role: 'assistant' }, { sessionId: sid, sessionRunId });
  };

  /** 输入框发送：先清空输入框再走公共发送路径（busy 守卫在 sendText 内） */
  const send = async () => {
    if (!input.trim() && pendingImages.length === 0) return;
    if (!sessionId || !sessionResourcesReady || busy || generationGate.active) {
      await sendText(input, 'send', pendingImages);
      return;
    }
    const attachments = pendingImages;
    writeComposerDraft(localStorage, storageNamespace.draftKey(sessionId, 'composer'), input, 'submitted');
    submittedDraftSessionRef.current = sessionId;
    setInput('');
    setPendingImages([]);
    setReplanSuggestion(''); // 新对话开始时清掉旧建议卡
    await sendText(input, 'send', attachments);
  };

  /** 重新生成某条 AI 回复（SSE 流式原地替换目标消息内容；可中止） */
  const regenerateMessage = async (msg: Message) => {
    if (!sessionId || !sessionResourcesReady || busy || generationGate.active) return;
    const sid = sessionId;
    const startedAt = Date.now();
    const runId = createClientRunId(startedAt);
    const lease = generationGate.claim(sid, runId);
    if (!lease) return;
    const ac = new AbortController();
    abortRef.current = ac;
    generationTargetRef.current = { sessionId: sid, round: msg.round, runId, startedAt };
    logger.info('turn', '重新生成回复', { session: sid, round: msg.round });
    setReplanSuggestion('');
    setBusy(true);
    setStreamCompleted(false);
    setError('');
    startGenTimer(startedAt);
    startGenTimeout(startedAt);
    streamTargetRef.current = { kind: 'round', round: msg.round };
    let deltaCount = 0;
    let deltaLen = 0;
    let mayFinish = true;
    let terminalFailure: string | null = null;
    try {
      await apiStream(`/api/session/${sid}/regenerate`, { round: msg.round, runId }, (ev) => {
        if (!generationGate.owns(lease)) return;
        if (ev.type === 'status') {
          const target = generationTargetRef.current;
          if (target?.sessionId === sid) {
            if (typeof ev.runId === 'string' && ev.runId.length > 0 && target.runId !== ev.runId) {
              target.runId = ev.runId;
              lease.runId = ev.runId;
            }
            if (typeof ev.startedAt === 'number') {
              target.startedAt = ev.startedAt;
              startGenTimer(ev.startedAt);
              startGenTimeout(ev.startedAt);
            }
          }
        }
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          deltaCount++;
          deltaLen += ev.text.length;
          pushStream(ev.text);
        }
        if (ev.type === 'done' && typeof ev.prose === 'string') {
          stopStream();
          const prose = ev.prose;
          setMessages((m) => m.map((x) => (x.round === msg.round && x.role === 'assistant' ? { ...x, content: prose } : x)));
          // AQL：重规划建议卡（后端在重试 ≥ replanK 时附带）
          if (typeof ev.replanSuggestion === 'string' && ev.replanSuggestion.length > 0) {
            setReplanSuggestion(ev.replanSuggestion);
          }
        }
        if (ev.type === 'error') {
          terminalFailure = sseFailureMessage(ev, '重新生成失败');
          logger.error('turn', '重新生成 SSE error', { message: terminalFailure });
          setError(terminalFailure);
        }
      }, ac.signal, startGenTimeout);
      logger.info('turn', '重新生成 SSE 完成', { round: msg.round, deltaCount, deltaLen, aborted: ac.signal.aborted });
      await fetchHistory(sid);
      void fetchTurnState(sid);
      void refreshSessions();
    } catch (e) {
      if (terminalFailure) {
        logger.warn('turn', '重新生成失败终态后的刷新未完成，保留服务端失败结果', { message: (e as Error).message });
      } else if ((e as { name?: string }).name === 'AbortError') {
        const target = generationTargetRef.current;
        if (genTimedOutRef.current && target?.sessionId === sid) {
          setError('连接连续 5 分钟未收到数据；不会取消电脑端重新生成任务，正在后台核对。');
          void monitorDetachedGeneration(sid, target.runId, lease);
          mayFinish = false;
        } else {
          mayFinish = await finalizeAbort(sid, msg.round, target?.runId ?? runId, lease);
        }
      } else {
        logger.error('turn', '重新生成失败', { message: (e as Error).message });
        const target = generationTargetRef.current;
        if (target?.sessionId === sid && generationGate.owns(lease)) {
          setError(e instanceof PrematureSseEnd
            ? '连接已中断，服务端仍在继续重新生成；正在后台恢复结果。'
            : `连接异常，正在核对服务端任务状态：${(e as Error).message}`);
          void monitorDetachedGeneration(sid, target.runId, lease);
          mayFinish = false;
        }
      }
    }
    if (!mayFinish) return;
    finishGenerationUi(lease);
  };

  /** 删除消息（round 整轮 / fromHere 从该轮到末尾），成功后刷新历史与状态 */
  const deleteMessagesOp = async (round: number, mode: 'round' | 'fromHere') => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/session/${sessionId}/message/delete`, {
        method: 'POST',
        body: JSON.stringify({ round, mode }),
      });
      await fetchHistory(sessionId);
      fetchTurnState(sessionId);
      refreshSessions();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  // 会话级共享运行包（会话打开时由 App 拉取；此处消费给会话宿主）
  const [sessionBundle, setSessionBundle] = useState(getSharedBundle());
  useEffect(() => subscribeSharedBundle(() => setSessionBundle(getSharedBundle())), []);
  // effect 启动新包请求前的首帧也要隔离旧会话脚本。
  const ownedSessionBundle = sharedBundleOwner === sessionId ? sessionBundle : EMPTY_BUNDLE;

  // FE-06.0：会话实例舞台容器是否需要以"抽屉形态"呈现（纯展示状态，不影响实例存活）
  // FE-04.3：会话运行实例（一次有效会话运行周期）。新增消息**不**轮换，只有切会话才换。
  const sessionRunRef = useRef<{ sessionId: string; runId: string }>({ sessionId: '', runId: '' });
  if (sessionRunRef.current.sessionId !== (sessionId ?? '')) {
    sessionRunRef.current = {
      sessionId: sessionId ?? '',
      runId: sessionId ? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` : '',
    };
  }
  const sessionRunId = sessionRunRef.current.runId;
  // Only the current run may control the persistent runtime stage.
  const runtimeStageOpen = listSurfaces().some(
    (e) => e.visible
      && e.declaration.content.kind === 'session-runtime'
      && e.declaration.sessionRunId === sessionRunId,
  );
  // 视图登记探针（只读；供真实浏览器验收读取"为什么这样渲染"）
  useEffect(() => { installMessageViewProbe(); }, []);
  useEffect(() => { installActionBridgeProbe(); }, []);

  // ─────────────── FE-05 通用交互面板 / Agent 动作桥 / 历史挂载 ───────────────
  // 界面偏好：场景区段默认走原生舞台还是卡自带前端（**由用户配置决定，不按卡名强制**）
  const [viewPrefs, setViewPrefs] = useState(() => loadViewPrefs(storageNamespace));
  // 面板可见性变化时强制刷新（surfaceRegistry 是纯内存表，不引入第二份状态）
  const [surfaceTick, setSurfaceTick] = useState(0);
  useEffect(() => subscribeSurfaces(() => setSurfaceTick((n) => n + 1)), []);
  // 用户明确展开的历史页（展开后该页重新挂载并绑定原消息）
  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());
  // 可执行卡面没有通用 view-state 恢复契约，始终保活同一个 iframe/Window。
  const [visibleMessageKeys, setVisibleMessageKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setVisibleMessageKeys(new Set());
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      setVisibleMessageKeys((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.messageKey;
          if (!key) continue;
          if (entry.isIntersecting && !next.has(key)) { next.add(key); changed = true; }
          if (!entry.isIntersecting && next.delete(key)) changed = true;
        }
        return changed ? next : prev;
      });
    }, { root: scrollRef.current, rootMargin: '320px 0px' });
    for (const el of refMap.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [historyForSpy, sessionRunId, refMap, sessionResourcesReady]);
  // 面板数据投影（render-plan 面板用；只读、不重新计算剧情）
  const [projections, setProjections] = useState<Record<string, ReturnType<typeof buildPanelProjection>>>({});
  const projectionRequestRef = useRef(0);
  // FE-06.1：标准测试面板的可见结果与订阅态（**UI 状态**，不是业务状态）
  const [testResults, setTestResults] = useState<TestPanelResult[]>([]);
  const [panelSubVersion, setPanelSubVersion] = useState(0);
  const pushTestResult = (action: string, ok: boolean, detail: string) => {
    setTestResults((prev) => [...prev.slice(-19), { action, ok, detail, at: Date.now() }]);
  };
  useEffect(() => { installPanelSubProbe(); }, []);
  const testResultsRef = useRef<TestPanelResult[]>([]);
  testResultsRef.current = testResults;
  useEffect(() => { if (TEST_PANEL_ENABLED) installTestPanelProbe(() => testResultsRef.current); }, []);

  /**
   * FE-05.0：实际能力模式表 —— 由**真实可用入口**决定，不由声明猜测。
   * 注意：`ai.generate` 是辅助静默生成入口，**不等于**面板拥有独立会话（见 actionModes）。
   */
  const panelCaps: PanelCapabilities = {
    hasAuxTaskEntry: Boolean(sessionId),   // /quiet 需要活动会话
    hasMainChatEntry: Boolean(sessionId),  // 主对话发送入口
    hasDraftEntry: true,                    // 草稿环（填主输入框）
  };

  /** FE-05.1：面板登记 —— 由卡片**启用中的显示规则**推导（不含卡名判断） */
  /**
   * 卡自带前端外链（FE-06.0）：只在**来源可解释**的有效规则里选，并且：
   *  - 唯一候选 → 直接采用（这就是"原卡默认前端"的可靠来源）；
   *  - 多候选且来源诊断报告**歧义**（无裁决依据）→ **不自动取第一条**，标记为不可用并如实报告；
   *  - 候选来自冲突未确认（pending-confirmation）的规则 → 已不在 renderRules 里，自然不会命中。
   * 不按规则名做任何特判（不做"含测试字样就跳过"这类字符串判断）。
   */
  const galFrontRules = (renderRules ?? []).filter((r) => r.galExternalUrl);
  const galFrontAmbiguity = ruleProvenance?.ambiguities.find((a) => a.section === 'frontend:gal-external');
  const galFrontBlocked = Boolean(galFrontAmbiguity) || galFrontRules.length > 1;
  const galFrontUrl = galFrontBlocked ? undefined : galFrontRules[0]?.galExternalUrl;
  useEffect(() => {
    if (galFrontAmbiguity) {
      logger.warn('ui', `前端区段存在歧义，未自动选择：${galFrontAmbiguity.candidates.map((c) => c.name).join(' | ')}`);
    } else if (galFrontRules.length > 1) {
      logger.warn('ui', `前端区段有 ${galFrontRules.length} 条有效候选且来源诊断未给出裁决 → 不自动选择`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galFrontRules.length, galFrontBlocked]);
  // 会话切换：上一个运行实例的面板在**登记逻辑内**先销毁再登记本实例的，
  // 顺序确定（不受 effect 清理顺序影响；StrictMode 双调用也不会把刚登记的面板清掉）。
  const lastSurfaceRunRef = useRef<string>('');
  useEffect(() => {
    if (!sessionId || !sessionRunId) {
      if (lastSurfaceRunRef.current) destroySurfacesForRun(lastSurfaceRunRef.current);
      lastSurfaceRunRef.current = '';
      return;
    }
    if (lastSurfaceRunRef.current && lastSurfaceRunRef.current !== sessionRunId) {
      const n = destroySurfacesForRun(lastSurfaceRunRef.current);
      if (n) logger.info('ui', `会话切换：销毁上一运行实例的 ${n} 个面板`);
    }
    lastSurfaceRunRef.current = sessionRunId;
    const decls: PanelDeclaration[] = [];
    // ① 卡自带前端页：仅在卡片**启用中**的「前端界面」规则提供外链时才登记（协议适配视图）
    if (galFrontUrl) {
      decls.push({
        panelId: 'frontend-external', moduleId: 'protocol-adapter:frontend', title: '卡自带前端',
        lifecycle: 'session', sessionId, sessionRunId, slot: 'drawer',
        target: { sessionId, sessionRunId },
        content: {
          kind: 'external-page', url: galFrontUrl,
          reason: `来源可解释的「前端界面」规则提供外链引擎页（规则：${galFrontRules[0]?.name ?? '-'}`
            + `；候选数 ${galFrontRules.length}，来源诊断判定的歧义已在启动日志中报告）`,
        },
        dataNeeds: ['session.getContext', 'mvu.get'],
        actions: ['panel.send-to-main-chat', 'panel.inject-draft'],
        actionMode: resolvePanelActionMode(panelCaps, 'send').mode,
        permissions: { draft: true, send: true, writeState: false },
      });
    }
    // ② 通用状态面板（render-plan）：证明同一组接口可服务**另一种数据结构**的面板
    decls.push({
      panelId: 'session-state-view', moduleId: 'common-core:state-view', title: '会话状态',
      lifecycle: 'session', sessionId, sessionRunId, slot: 'drawer',
      target: { sessionId, sessionRunId },
      content: { kind: 'render-plan', planRef: 'session-state', reason: '通用只读投影（不重新计算剧情）' },
      dataNeeds: ['mvu.get(scope=session)'],
      actions: ['panel.read-session-state'],
      actionMode: resolvePanelActionMode(panelCaps, 'read').mode,
      permissions: { draft: false, send: false, writeState: false },
    });
    // ③ 会话运行实例（session-runtime）：仅当本会话确实需要会话宿主时登记。
    //    打开面板 = 把**同一个**会话实例 iframe 停靠进可见容器（DOM 移动，不重设 srcdoc、不新建运行时）。
    if (WEB_CLIENT_PROFILE.scriptedCards && planSessionHost(ownedSessionBundle).needed) {
      decls.push({
        panelId: 'session-runtime', moduleId: 'common-core:session-host', title: '会话运行实例',
        lifecycle: 'session', sessionId, sessionRunId, slot: 'drawer',
        target: { sessionId, sessionRunId },
        content: { kind: 'session-runtime', reason: '复用唯一会话执行实例（停靠同一 iframe，浏览上下文保留）' },
        dataNeeds: ['session-host:status'],
        actions: ['panel.read-session-state'],
        actionMode: resolvePanelActionMode(panelCaps, 'read').mode,
        permissions: { draft: false, send: false, writeState: false },
      });
    }
    // ④ 标准测试面板（**仅隔离测试装载**：URL `?jgTestPanel=1`）。
    //    与真实面板走同一 registry / SurfaceHost / actionBridge / 权限 / 生产路由；本身不含业务实现。
    if (TEST_PANEL_ENABLED) {
      decls.push({
        panelId: 'std-test-panel', moduleId: 'test:standard-panel', title: '标准测试面板',
        lifecycle: 'session', sessionId, sessionRunId, slot: 'drawer',
        target: { sessionId, sessionRunId },
        content: { kind: 'render-plan', planRef: 'std-test-panel', reason: '隔离验收用标准面板样本（同一生产路由）' },
        dataNeeds: ['mvu.get', 'message.send', 'ai.generate', 'mvu.replace', 'message.cancel'],
        actions: [
          'panel.inject-draft', 'panel.send-to-main-chat', 'panel.assist-generate',
          'panel.commit-session-state', 'panel.cancel-action',
          'panel.subscribe-state', 'panel.unsubscribe-state',
        ],
        actionMode: resolvePanelActionMode(panelCaps, 'draft').mode,
        permissions: { draft: true, send: true, writeState: true },
      });
    }
    // 同一 run 做完整 reconcile：新规则不再声明的旧面板必须销毁，不能残留上一张卡的前端。
    const expectedPanels = new Set(decls.map((d) => d.panelId));
    for (const existing of listSurfaces().filter((e) => e.declaration.sessionRunId === sessionRunId)) {
      if (!expectedPanels.has(existing.declaration.panelId)) destroySurface(existing.declaration.panelId);
    }
    for (const d of decls) {
      const r = registerSurface(d);
      if (!r.ok) { console.warn(`[可见表面] 登记被拒：${d.panelId} — ${r.errors.join('；')}`); continue; }
      // UI 偏好恢复：面板可见性是**偏好**（按会话 + 模块隔离存储），不混入剧情变量。
      // 恢复的只是"可见/隐藏"，不会重新运行会话脚本（打开 = 改可见性）。
      if (loadPanelUi(storageNamespace, sessionId, d.moduleId).drawerOpen === true) openSurface(d.panelId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionRunId, galFrontUrl, ownedSessionBundle.manifestHash]);

  /**
   * 读取会话级状态并刷新数据面板投影（**只读**：不写权威状态、不生成、不记忆）。
   * 供 ① 面板可见时的投影刷新；② 面板"只读查看"动作（经动作桥到 mvu.get）复用同一条读取路径。
   */
  const readSessionStateProjection = async (
    sid = sessionId,
    runId = sessionRunId,
  ): Promise<void> => {
    const request = ++projectionRequestRef.current;
    if (!sid) { setProjections({}); return; }
    try {
      const r = await api<{ resolved: boolean; exists: boolean; state: Record<string, unknown>; stateVersion: number; source?: string; note?: string }>(
        `/api/session/${sid}/state?scope=session`,
      );
      if (
        request !== projectionRequestRef.current
        || activeSessionRef.current !== sid
        || sessionRunRef.current.runId !== runId
      ) return;
      const allowed = [{ action: 'panel.read-session-state', mode: resolvePanelActionMode(panelCaps, 'read').mode, label: '只读查看' }];
      const proj = buildPanelProjection({
        target: { sessionId: sid, sessionRunId: runId },
        scope: 'session',
        state: { exists: !!(r.resolved && r.exists), source: r.source, note: r.note, stateVersion: r.stateVersion, values: r.state },
        messages: [],
        objects: [],
        allowedActions: allowed as never,
        includeAllStateFields: true,
        ui: {},
      });
      setProjections((p) => ({ ...p, 'session-state-view': proj }));
    } catch {
      // 旧会话请求失败也不得清空新会话已经成功的投影。
      if (
        request === projectionRequestRef.current
        && activeSessionRef.current === sid
        && sessionRunRef.current.runId === runId
      ) {
        setProjections((p) => {
          const next = { ...p };
          delete next['session-state-view'];
          return next;
        });
      }
    }
  };

  // 投影刷新：会话状态面板读取既有状态（只读投影，不产生任何写入）
  useEffect(() => {
    projectionRequestRef.current += 1;
    setProjections({});
    if (!sessionId) return;
    const want = listSurfaces().some((e) => (
      e.declaration.panelId === 'session-state-view'
      && e.declaration.sessionRunId === sessionRunId
      && e.visible
    ));
    if (!want) return;
    void readSessionStateProjection(sessionId, sessionRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionRunId, surfaceTick]);

  /**
   * FE-05.0：资源预载状态收口 —— 把「入口执行过」与「缓存实际预热完成」分开取证。
   * 证据来自：① 会话宿主的脚本执行结果；② /api/assets/status 的**真实缓存读回**。
   */
  const [preloadVerdict, setPreloadVerdict] = useState<string>('');
  useEffect(() => {
    const evaluate = async () => {
      const st = getLastSharedStatus();
      if (!st) return;
      const bundle = getSharedBundle();
      const scripts = (st.coreScripts.items ?? []).map((i) => ({
        name: i.name, executed: true, ok: i.ok, error: i.error ?? undefined,
        capabilities: bundle.scripts.find((s) => s.name === i.name)?.capabilities ?? [],
      }));
      let cache: Parameters<typeof evaluatePreload>[1] = null;
      try {
        const ast = await api<{ entries?: unknown[]; overrides?: Record<string, string> }>('/api/assets/status');
        cache = { cachedCount: (ast.entries ?? []).length, source: 'GET /api/assets/status', readAt: Date.now() };
      } catch { cache = null; }
      const v = evaluatePreload(scripts, cache);
      installPreloadProbe(v);
      setPreloadVerdict(`${v.mode}：${v.reason}`);
      logger.info('session', `资源预载判定=${v.mode}（入口=${v.entryExecuted} 缓存=${v.cacheWarm}）`, v.evidence);
    };
    const off = subscribeSharedStatus(() => { void evaluate(); });
    void evaluate();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionRunId]);

  /**
   * FE-05.1/05.3 + FE-06.1：面板操作入口 —— 打开/关闭只改可见性；业务动作走动作桥转发到**现有**入口。
   * 所有面板共用**同一套**操作身份/目标校验/提交结果/恢复规则（不按面板各写一种重试）。
   * 副作用按三层记账：动作直接影响 / Agent 正常业务影响 / 兼容层额外影响。
   */
  const handleSurfaceAction = (panelId: string, action: string, payload?: Record<string, unknown>) => {
    const decl = listSurfaces().find((s) => s.declaration.panelId === panelId)?.declaration;
    if (action === 'surface.open') {
      const r = openSurface(panelId);
      if (decl) savePanelUi(storageNamespace, decl.sessionId, decl.moduleId, { drawerOpen: true }); // UI 偏好单独写入
      if (decl?.content.kind === 'render-plan') {
        void readSessionStateProjection(decl.sessionId, decl.sessionRunId);
      }
      logger.info('ui', `打开面板 ${panelId}`, r);
      return;
    }
    if (action === 'surface.close') {
      const r = closeSurface(panelId);
      if (decl) savePanelUi(storageNamespace, decl.sessionId, decl.moduleId, { drawerOpen: false });
      logger.info('ui', `关闭面板 ${panelId}`, r);
      return;
    }
    // 宿主侧核验用上下文：帧绑定表由真实帧注册（findFrame/registerFrame）提供，
    // 面板侧动作默认来自主应用自身（无外部帧），等价于"已绑定"。
    const frameBindings: Record<string, string> = {};
    const ctx: HostActionContext = { currentSessionId: sessionId, currentSessionRunId: sessionRunId, frameBindings };
    const req = { panelId, moduleId: decl?.moduleId ?? '', action, payload, sessionId: sessionId ?? '', sessionRunId, target: { sessionId: sessionId ?? '', sessionRunId } };
    const plan = planAgentAction(req, ctx);
    trackPlan(req, plan);
    if (plan.status === 'rejected') {
      setError(plan.reason);
      pushTestResult(action, false, plan.reason);
      return;
    }
    if (plan.status === 'noop') {
      logger.info('ui', `重复后台空操作：${action}`, plan.reason);
      pushTestResult(action, true, `标准空操作（业务由 ${plan.supersededBy} 接管）`);
      return;
    }
    // 真实桥接：调用**已有** Agent 入口（不新增客户端/队列）
    const p = (payload ?? {}) as { text?: string; prompt?: string; draft?: boolean; values?: Record<string, unknown> };
    if (plan.call.name === 'message.send') {
      if (typeof p.text === 'string' && p.text) {
        if (p.draft === true || action === 'panel.inject-draft') {
          // 面板"填草稿"语义：**保留用户已有文字、只追加一次、绝不自动发送**
          // （重复点击同一文本不再追加；去重依据是"草稿内容是否已在输入框内"，不是操作身份）
          const already = (input ?? '').includes(p.text);
          if (already) {
            recordEffect('action-direct', 'draft-deduped');
            pushTestResult(action, true, '草稿已存在（未重复追加，未发送）');
          } else {
            const draftText = p.text ?? "";
            setInput((cur) => (cur ? `${cur}\n${draftText}` : draftText));
            recordEffect('action-direct', 'draft-write');
            pushTestResult(action, true, `已追加到草稿（保留原有文字 ${(input ?? '').length} 字；未发送）`);
          }
          setError('');
        } else {
          recordEffect('action-direct', 'turn-request');
          sendText(p.text);
          pushTestResult(action, true, '已发起主对话回合（结果进入正常 Agent 流程）');
        }
      } else {
        pushTestResult(action, false, '缺少文本');
      }
      trackDelivery(routeActionResult({ identity: plan.identity, ok: true, result: { ok: true } }, ctx));
      return;
    }
    if (plan.call.name === 'ai.generate') {
      const prompt = String(p.prompt ?? '').trim();
      if (!prompt) { setError('动作缺少生成提示词'); pushTestResult(action, false, '缺少生成提示词'); return; }
      recordEffect('action-direct', 'aux-request');
      (async () => {
        try {
          const r = await api<{ text: string }>(`/api/session/${sessionId}/quiet`, { method: 'POST', body: JSON.stringify({ prompt, content_mode: contentMode }) });
          const d = routeActionResult({ identity: plan.identity, ok: true, result: r }, ctx);
          trackDelivery(d);
          // 结果只回发起面板：不写聊天记录、不进后续主对话上下文
          pushTestResult(action, true, `辅助结果已回本面板（${String(r.text ?? '').slice(0, 40)}…）；未写入对话记录`);
          recordEffect('action-direct', 'aux-result-delivered');
        } catch (err) {
          // 真实失败由界面接住，不伪造成功
          setError((err as Error).message);
          pushTestResult(action, false, (err as Error).message);
          trackDelivery(routeActionResult({ identity: plan.identity, ok: false, error: (err as Error).message }, ctx));
        }
      })();
      return;
    }
    // mvu.get：面板的**只读**动作 —— 复用既有读取路径刷新投影（不写权威状态、不生成、不记忆）
    if (plan.call.name === 'mvu.get') {
      (async () => {
        await readSessionStateProjection();
        trackDelivery(routeActionResult({ identity: plan.identity, ok: true, result: { refreshed: true } }, ctx));
        pushTestResult(action, true, '已重新读取会话状态（只读）');
      })();
      return;
    }
    // mvu.replace：用户明确保存（真实写入口）→ **写后读回**，真实失败交给界面
    if (plan.call.name === 'mvu.replace') {
      const values = p.values as unknown;
      // 输入校验先行：非法提交必须**明确失败**（不能因 `?? {}` 把 null 洗成空对象后假成功）
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values as object).length === 0) {
        const reason = '提交被拒：values 必须是至少含一个键的对象（非法输入不写入权威状态）';
        setError(reason);
        pushTestResult(action, false, reason);
        trackDelivery(routeActionResult({ identity: plan.identity, ok: false, error: reason }, ctx));
        return;
      }
      recordEffect('action-direct', 'state-commit-request');
      (async () => {
        try {
          const r = await api<{ stateVersion: number; changed: string[]; deduped: boolean }>(
            `/api/session/${sessionId}/state`,
            { method: 'POST', body: JSON.stringify({ state: values, scope: 'session', operationId: plan.identity.operationId }) },
          );
          const readBack = await api<{ exists: boolean; stateVersion: number; state: Record<string, unknown> }>(
            `/api/session/${sessionId}/state?scope=session`,
          );
          trackDelivery(routeActionResult({ identity: plan.identity, ok: true, result: r }, ctx));
          recordEffect('agent-business', 'state-commit');
          pushTestResult(action, true, `已提交并读回：v${readBack.stateVersion}（changed=${r.changed?.length ?? 0}${r.deduped ? ' 幂等去重' : ''}）`);
        } catch (err) {
          setError((err as Error).message);
          pushTestResult(action, false, (err as Error).message);
          trackDelivery(routeActionResult({ identity: plan.identity, ok: false, error: (err as Error).message }, ctx));
        }
      })();
      return;
    }
    // message.cancel：只对**声明可取消**的任务生效（当前仅主对话发送的在途回合）
    if (plan.call.name === 'message.cancel') {
      const c = canCancelAction('panel.send-to-main-chat', { turnInFlight: busy });
      if (!c.ok) {
        pushTestResult(action, false, c.reason);
        setError(c.reason);
        return;
      }
      recordEffect('action-direct', 'cancel-request');
      stopGenerating(); // 与主界面「停止」同一个入口；最终以服务端落库定局为准
      pushTestResult(action, true, '已发出中止（以服务端落库结果为准，不假装已取消）');
      return;
    }
    // 事件订阅/退订：纯本地订阅表操作（不触达后端、不重启脚本）
    if (plan.call.name === 'Mvu.on') {
      subscribePanel(panelId, {
        purposes: ['session-state', 'message', 'message-state'],
        target: { sessionId: sessionId ?? '', sessionRunId },
        watchMessages: true,
      });
      setPanelSubVersion((n) => n + 1);
      pushTestResult(action, true, '已订阅会话状态/消息更新');
      return;
    }
    if (plan.call.name === 'Mvu.off') {
      const done = unsubscribePanel(panelId);
      setPanelSubVersion((n) => n + 1);
      pushTestResult(action, done, done ? '已退订（此后不再收到通知）' : '未处于订阅态');
      return;
    }
    logger.warn('ui', `动作 ${action} 的接口 ${plan.call.name} 尚无面板侧实现（不静默放行）`);
    pushTestResult(action, false, `接口 ${plan.call.name} 尚无面板侧实现（不静默放行）`);
  };

  /** FE-05.4：历史页面轻量挂载策略（仅影响含可执行区段的消息） */
  const historyMountOpts = useMemo(
    () => ({ nearWindow: 3, farWindow: 12, allowUnmount: false }),
    [],
  );


  // 消息行操作稳定容器（引用不变 → React.memo 生效；字段每次渲染更新为最新闭包）
  const msgOpsRef = useRef<MsgOps>({ regenerate: () => {}, deleteRound: () => {}, deleteFromHere: () => {} });
  msgOpsRef.current = {
    regenerate: regenerateMessage,
    deleteRound: (r) => deleteMessagesOp(r, 'round'),
    deleteFromHere: (r) => deleteMessagesOp(r, 'fromHere'),
  };

  // ── GLA 交互桥：__jgfh 协议（iframe ⇄ 宿主） ──
  //  rpc：iframe/外部页经 ns.op 远程调用宿主能力，回发结果给来源帧；所有回复都必须定向到 findFrame(来源)
  const handleRpcMessage = (e: MessageEvent, d: Extract<JgFrameMessage, { __jgfh: 'rpc' }>) => {
    if (!d.token) return;
    const frame = findFrame(e.source, d.token);
    if (!frame) return;
    const reply = (result?: unknown, error?: string) => frame.post({ __jgfh: 'rpc', id: d.id, ok: !error, result, error });
    const unsupported = (name: string) => reply(undefined, `unsupported host capability: ${name}`);
    // ── FE-06.0 最小接口策略：noop 短路 ──
    // 反例（**不得**这么做）：把 replaceMvuData / replaceVariables 全局改空操作。
    // 它们是用户保存路径（bridge）；重复后台停用的是**来源脚本**（执行清单），不是这个函数。
    const policy = resolveIfacePolicy('rpc', `${d.ns}.${d.op}`);
    if (policy.mode === 'noop' && policy.rule?.shape) {
      // 形状正确：同步仍同步、异步正常 resolve；不触达后端、不排队、不重试、不新增模型请求
      return reply(buildStubReturner(policy.rule.shape)());
    }
    if (d.ns === 'message' && d.op === 'send') {
      const p = (d.payload ?? {}) as { text?: string; draft?: boolean };
      if (typeof p.text === 'string') { if (p.draft === true) applyBranch(p.text); else sendText(p.text); }
      return reply({ ok: true });
    }
    // message.cancel：显式中止在途回合（与面板取消动作共用同一判定；只对声明可取消的任务生效）
    if (d.ns === 'message' && d.op === 'cancel') {
      const p = (d.payload ?? {}) as { target?: string };
      const c = canCancelAction(String(p.target ?? 'panel.send-to-main-chat'), { turnInFlight: busy });
      if (!c.ok) return reply(undefined, c.reason);
      stopGenerating();
      return reply({ ok: true, note: '已发出中止；最终以服务端落库定局为准' });
    }
    if (d.ns === 'theme' && d.op === 'get') return reply({ theme });
    if (d.ns === 'viewport' && d.op === 'get') return reply({ w: window.innerWidth, h: window.innerHeight });
    // ai.generate：ST 前端 generateQuietPrompt → 宿主 /quiet 静默生成（不落 chat_log），回真实文本
    if (d.ns === 'ai' && d.op === 'generate') {
      const p = (d.payload ?? {}) as { prompt?: string };
      const prompt = String(p.prompt ?? '').trim();
      if (!prompt) return reply(undefined, 'empty generation prompt');
      if (!sessionId) return reply(undefined, 'no active session');
      (async () => {
        try {
          const r = await api<{ text: string }>(`/api/session/${sessionId}/quiet`, {
            method: 'POST',
            body: JSON.stringify({ prompt, content_mode: contentMode }),
          });
          reply({ text: r.text });
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    // session.getContext：ST 卡回填 name1/name2/character/chat（会话真实数据快照）
    if (d.ns === 'session' && d.op === 'getContext') {
      (async () => {
        let cardName = '';
        let worldbooks: string[] = [];
        try {
          const cfg = await api<{ config: { card: string; worldbooks?: string[] } }>(`/api/session/${sessionId}/config`);
          cardName = cfg.config?.card ?? '';
          worldbooks = Array.isArray(cfg.config?.worldbooks) ? cfg.config.worldbooks : [];
        } catch { /* no active session: keep empty defaults */ }
        reply({
          name1: '',
          name2: cardName,
          character: cardName ? { name: cardName } : null,
          chat: messages.map((m) => ({ id: m.id, round: m.round, role: m.role, content: m.content })),
          worldbooks,
        });
      })();
      return;
    }
    if (d.ns === 'variables' && d.op === 'get') {
      if (!sessionId) return reply(undefined, 'no active session');
      (async () => {
        try {
          const v = await api<{ values: Record<string, string | number | boolean> }>(`/api/session/${sessionId}/variables`);
          reply({ values: v.values ?? {} });
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    // FE-01/FE-02：世界书读写 / 变量写入 / MVU 读写 —— 全部为真实宿主能力（不再返回 unsupported 哨兵）
    if (d.ns === 'variables' && d.op === 'replace') {
      if (!sessionId) return reply(undefined, 'no active session');
      const p = (d.payload ?? {}) as { values?: Record<string, unknown> };
      if (!p.values || typeof p.values !== 'object') return reply(undefined, 'values required');
      (async () => {
        try {
          const r = await api<{ ok: boolean; values: Record<string, unknown> }>(`/api/session/${sessionId}/variables-replace`, {
            method: 'POST', body: JSON.stringify({ values: p.values }),
          });
          reply({ values: r.values ?? {} });
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    if (d.ns === 'prompt' && d.op === 'setExtensionPrompt') return unsupported('prompt.setExtensionPrompt');
    if (d.ns === 'message' && d.op === 'lastId') {
      return reply({ id: messages.reduce((max, m) => Math.max(max, m.id), 0) });
    }
    if (d.ns === 'worldbook' && d.op === 'names') {
      if (!sessionId) return reply(undefined, 'no active session');
      (async () => {
        try {
          const cfg = await api<{ config: { worldbooks?: string[] } }>(`/api/session/${sessionId}/config`);
          const selected = Array.isArray(cfg.config?.worldbooks) ? cfg.config.worldbooks : [];
          reply({ primary: selected[0] ?? null, selected });
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    if (d.ns === 'worldbook' && d.op === 'get') {
      if (!sessionId) return reply(undefined, 'no active session');
      const p = (d.payload ?? {}) as { name?: string };
      (async () => {
        try {
          const cfg = await api<{ config: { worldbooks?: string[] } }>(`/api/session/${sessionId}/config`);
          const selected = Array.isArray(cfg.config?.worldbooks) ? cfg.config.worldbooks : [];
          const file = String(p.name ?? selected[0] ?? '').trim();
          if (!file) return reply({ file: '', entries: [] });
          const wb = await api<{ file: string; entries: unknown[]; revision: string }>(`/api/session/${sessionId}/worldbook-entries?name=${encodeURIComponent(file)}`);
          worldbookRevisionRef.current.set(`${sessionId}:${wb.file}`, wb.revision);
          reply({ file: wb.file, entries: wb.entries ?? [], revision: wb.revision });
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    if (d.ns === 'worldbook' && d.op === 'update') {
      if (!sessionId) return reply(undefined, 'no active session');
      const p = (d.payload ?? {}) as { name?: string; changed?: unknown[] };
      const changed = Array.isArray(p.changed) ? p.changed : [];
      if (changed.length === 0) return reply(undefined, 'changed is empty');
      (async () => {
        try {
          const cfg = await api<{ config: { worldbooks?: string[] } }>(`/api/session/${sessionId}/config`);
          const selected = Array.isArray(cfg.config?.worldbooks) ? cfg.config.worldbooks : [];
          const file = String(p.name ?? selected[0] ?? '').trim();
          const cacheKey = `${sessionId}:${file}`;
          let revision = worldbookRevisionRef.current.get(cacheKey);
          if (!revision) {
            const snapshot = await api<{ revision: string }>(`/api/session/${sessionId}/worldbook-entries?name=${encodeURIComponent(file)}`);
            revision = snapshot.revision;
            worldbookRevisionRef.current.set(cacheKey, revision);
          }
          const r = await api<{ file: string; applied: number; missed: string[]; entries: unknown[]; revision: string }>(`/api/session/${sessionId}/worldbook-update`, {
            method: 'POST',
            headers: revisionHeaders(revision),
            body: JSON.stringify({ name: file, changed }),
          });
          worldbookRevisionRef.current.set(cacheKey, r.revision);
          // 一条都没落库 → 明确报错，避免「界面提示保存成功但实际没写」
          if (!r.applied) return reply(undefined, `worldbook update applied 0 entries (missed: ${(r.missed ?? []).join(',')})`);
          reply({ file: r.file, applied: r.applied, missed: r.missed, entries: r.entries ?? [], revision: r.revision });
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    if (d.ns === 'mvu' && d.op === 'get') {
      if (!sessionId) return reply(undefined, 'no active session');
      const p = (d.payload ?? {}) as { type?: string; message_id?: number };
      (async () => {
        try {
          // FE-C1：把 ST 的 {type,message_id} 作用域**如实映射**到内部快照作用域。
          // 提供 message_id → 按稳定消息身份读该楼层；未提供 → 会话级权威状态（不臆造"最新楼层"）。
          // ST 的 message_id 是**0 基消息下标**（协议层语义），不是内部 id ——
          // 这里只做透传，翻译在后端**唯一翻译点**完成（各调用方不得自己换算）。
          const mid = typeof p.message_id === 'number' ? p.message_id : undefined;
          const useMessage = mid !== undefined && p.type !== 'global';
          const qs = useMessage ? `scope=message&message_index=${mid}` : 'scope=session';
          const snap = await api<{ resolved: boolean; exists: boolean; state: Record<string, unknown>; stateVersion: number }>(
            `/api/session/${sessionId}/state?${qs}`,
          );
          // stat_data 保持 ST 形状；**同时**回传 exists/resolved 让调用方可区分「未初始化」「楼层不存在」
          reply({
            data: {
              stat_data: snap.exists ? (snap.state ?? {}) : {},
              exists: snap.exists, resolved: snap.resolved,
              stateVersion: snap.stateVersion,
              scope: useMessage ? 'message' : 'session',
              message_id: useMessage ? mid : undefined,
            },
          });
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    if (d.ns === 'mvu' && d.op === 'replace') {
      if (!sessionId) return reply(undefined, 'no active session');
      const p = (d.payload ?? {}) as { type?: string; message_id?: number; data?: { stat_data?: Record<string, unknown> } };
      const stat = p.data?.stat_data;
      if (!stat || typeof stat !== 'object') return reply(undefined, 'data.stat_data required');
      (async () => {
        try {
          const mid = typeof p.message_id === 'number' ? p.message_id : undefined;
          const useMessage = mid !== undefined && p.type !== 'global';
          const body: Record<string, unknown> = { state: stat, scope: useMessage ? 'message' : 'session' };
          if (useMessage) body.message_index = mid; // ST 0 基下标 → 后端唯一翻译点换算
          const r = await api<{ stateVersion: number; changed: string[]; deduped: boolean; messageId?: number }>(
            `/api/session/${sessionId}/state`,
            { method: 'POST', body: JSON.stringify(body) },
          );
          // 已提交 → 通知已挂载页面（Mvu.on('VARIABLE_UPDATE_ENDED') 真实收到）
          // FE-04-B：按**用途**分流 —— 消息作用域的提交发 `state`（带消息身份）；
          // 会话作用域的提交发 `session-state`（不冒充历史楼层）。
          if (body.scope === 'session') {
            notifyHostEvent(
              'session-state',
              { stateVersion: r.stateVersion, deduped: r.deduped === true },
              { sessionId: sessionId ?? '', sessionRunId },
            );
          } else {
            notifyHostEvent(
              'state',
              { messageId: r.messageId ?? null, stateVersion: r.stateVersion, deduped: r.deduped === true },
              { sessionId: sessionId ?? '', sessionRunId, messageId: r.messageId ?? undefined },
            );
          }
          reply(r);
        } catch (err) { reply(undefined, (err as Error).message.slice(0, 120)); }
      })();
      return;
    }
    // asset.resolve: asset index lookup and local proxy URL.

    if (d.ns === 'asset' && d.op === 'resolve') {
      const p = (d.payload ?? {}) as { kind?: string; name?: string };
      const kind = String(p.kind ?? '').trim() as AssetKind;
      const name = String(p.name ?? '').trim();
      if (!kind || !name) return reply({ status: 'miss', kind: p.kind, name: p.name });
      (async () => {
        try {
          const resolved = await resolveNamedAsset(kind, name);
          if (resolved.status !== 'ok') return reply({ status: 'miss', kind: p.kind, name: p.name });
          reply(resolved);
        } catch { reply({ status: 'miss', kind: p.kind, name: p.name }); }
      })();
      return;
    }
    // local：纯前端状态（上方分支已实现者优先）；未实现的分支回落到表中声明的形状（不触达后端）
    if (policy.mode === 'local' && policy.rule?.shape) return reply(policy.rule.shape.value);
    // bridge：表中声明为桥接却没有实现 → 明确报错（**不静默放行、不假装成功**）
    return reply(undefined, policy.mode === 'unclaimed'
      ? `未登记 rpc ${d.ns}.${d.op}（FE-06.0 接口策略默认拒绝）`
      : `rpc ${d.ns}.${d.op} 声明为 ${policy.mode} 但未实现（不静默放行）`);
  };
  const frameMsgHandlerRef = useRef({ sendText, applyBranch, handleRpc: handleRpcMessage });
  frameMsgHandlerRef.current = { sendText, applyBranch, handleRpc: handleRpcMessage };
  // 模块单例：GalStage/ChoiceOverlay 经 getGalRuntime() 取稳定发送入口（不破 memo）
  const galRuntimeRef = useRef<GalRuntime>({ busy: false, sessionId: null, sendText: () => {} });
  galRuntimeRef.current = { busy, sessionId, sendText };
  setGalRuntime(galRuntimeRef.current);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!isJgFrameMessage(e.data)) return;
      const d: JgFrameMessage = e.data;
      if (!d.token) return;
      if ('__jgfh_h' in d) return; // height/size 由 HtmlMessage 组件级处理测高
      if (!findFrame(e.source, d.token)) return;
      const h = frameMsgHandlerRef.current;
      if (d.__jgfh === 'choice') h.sendText(d.text, d.mode === 'draft' ? 'draft' : 'send');
      else if (d.__jgfh === 'draft') h.applyBranch(d.text);
      else if (d.__jgfh === 'rpc') h.handleRpc(e, d);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 导演模式：文本选区浮动按钮（启用条件=已有会话）+ 探窗目标（点击 🎬 时快照选区传入弹窗）
  const { sel: directorSel, dismiss: dismissDirector } = useTextSelectionDirector(Boolean(sessionId));
  const [directorTarget, setDirectorTarget] = useState<TextSelection | null>(null);

  return (
    <div className="layout">
      {/* DSH 插件可视化加载器：发现的启用 DSH UI 插件自动注入其 widget.js（常驻，不随 tab 切换卸载） */}
      {WEB_CLIENT_PROFILE.remoteWidgets ? <DshWidgetLoader /> : null}
      {/* FE-04-C 会话级执行宿主：唯一的会话脚本持有者（不随消息轮换；切会话才重建）。
          FE-06.0：iframe **固定挂载**在这个舞台容器里（绝不迁移 DOM）—— 实测 DOM 迁移会让子文档被重建。
          需要"抽屉形态"时只切换外层容器的 data-open（显示/定位/尺寸由 CSS 表现），实例始终存活。 */}
      <div className="jg-surface-stage" data-open={runtimeStageOpen ? '1' : '0'} data-stage="session-host">
        <div className="jg-surface-stage-head">会话运行实例（固定挂载 · 打开/关闭只改外层容器）</div>
        {WEB_CLIENT_PROFILE.scriptedCards
          ? <SessionHost sessionId={sessionId} sessionRunId={sessionRunId} bundle={ownedSessionBundle} />
          : null}
      </div>
      {/* FE-05.1 通用可见表面：同一会话运行实例上的受控面板（打开/关闭只切可见性） */}
      <SurfaceHost
        sessionId={sessionId}
        sessionRunId={sessionRunId}
        projections={projections}
        onAction={handleSurfaceAction}
        renderContent={(d, active) => {
          if (d.content.kind === 'external-page' && WEB_CLIENT_PROFILE.scriptedCards) {
            return (
              <ExternalPage
                url={d.content.url}
                target={{ sessionId: d.sessionId, sessionRunId: d.sessionRunId }}
                active={active}
              />
            );
          }
          // 标准测试面板（仅 ?jgTestPanel=1 时登记）——按钮全部走同一 action bridge 与生产路由
          if (d.panelId === TEST_PANEL_ID) {
            return (
              <TestPanel
                panelId={d.panelId}
                onAction={handleSurfaceAction}
                busy={busy}
                subscribed={isPanelSubscribed(d.panelId)}
                results={testResults}
              />
            );
          }
          return null;
        }}
      />
      {!adultOk && (
        <div className="adult-overlay">
          <div className="adult-box">
            <h2>内容提示</h2>
            <p>本应用包含<b>成年向（NSFW）</b>内容分支，仅限 18 岁以上用户使用。</p>
            <p>所有内容均为虚构，用户自担风险。NSF 纯净分支不含露骨内容。</p>
            <div className="adult-actions">
              <button onClick={() => { localStorage.setItem(storageNamespace.preferenceKey('adult-ok'), '1'); setAdultOk(true); }}>我已成年，进入</button>
              <button className="adult-decline" onClick={() => { setContentMode('nsf'); localStorage.setItem(storageNamespace.preferenceKey('adult-ok'), '1'); setAdultOk(true); }}>切换到纯净分支进入</button>
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        ref={mobileNavToggleRef}
        className="mobile-nav-toggle"
        aria-label="打开导航"
        aria-controls="primary-navigation"
        aria-expanded={mobileNavOpen}
        disabled={mobileNavOpen || mobileStoryEffectiveOpen}
        onClick={openMobileNav}
      >
        <span aria-hidden="true">☰</span>
      </button>
      {mobileNavOpen && (
        <button
          type="button"
          className="mobile-nav-backdrop"
          aria-label="关闭导航"
          onClick={() => closeMobileNav()}
        />
      )}
      {storyAvailable && (
        <button
          type="button"
          ref={mobileStoryToggleRef}
          className="mobile-story-toggle"
          aria-label={`打开剧情索引，第 ${storyDisplayRound} 轮`}
          aria-controls="mobile-story-sheet"
          aria-expanded={mobileStoryEffectiveOpen}
          disabled={mobileStoryOpen || mobileNavOpen}
          data-loading={storyLoading ? '1' : '0'}
          data-error={storyError ? '1' : '0'}
          onClick={openMobileStory}
        >
          <span>剧情</span>
          <small>R{storyDisplayRound}</small>
        </button>
      )}
      {mobileStoryEffectiveOpen && (
        <>
          <button
            type="button"
            className="story-sheet-backdrop"
            aria-label="关闭剧情索引"
            onClick={() => closeMobileStory()}
          />
          <div
            id="mobile-story-sheet"
            className="story-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="剧情分支索引"
            onKeyDown={containMobileStoryFocus}
          >
            <StoryIndexPanel
              className="story-box--mobile"
              content={storyIndex}
              branches={storyBranches}
              round={storyDisplayRound}
              loading={storyLoading}
              error={storyError}
              staleSourceRound={storyStaleSourceRound}
              busy={busy}
              onRefresh={refreshStoryIndex}
              onSelect={applyMobileBranch}
              onClose={() => closeMobileStory()}
              closeButtonRef={mobileStoryCloseRef}
            />
          </div>
        </>
      )}
      <aside
        ref={mobileNavPanelRef}
        id="primary-navigation"
        className="sidebar"
        data-mobile-open={mobileNavOpen ? '1' : '0'}
        aria-hidden={mobileLayout && !mobileNavOpen ? true : undefined}
        aria-modal={mobileLayout && mobileNavOpen ? true : undefined}
        role={mobileLayout ? 'dialog' : undefined}
        style={{ width: sidebarW }}
      >
        <div className="sidebar-top">
          <div className="sidebar-title-row">
            <h1>jiuguan</h1>
            <button
              type="button"
              ref={mobileNavCloseRef}
              className="mobile-nav-close"
              aria-label="关闭导航"
              onClick={() => closeMobileNav()}
            >×</button>
          </div>
          <div className="theme-controls">
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} title="主题">
              <option value="dark">🌙 深色</option>
              <option value="sepia">📜 米黄</option>
              <option value="paper">📄 纸白</option>
            </select>
            <button onClick={() => setReadFs((f) => Math.max(14, f - 1))} title="减小字号">A-</button>
            <button onClick={() => setReadFs((f) => Math.min(22, f + 1))} title="增大字号">A+</button>
            <button onClick={() => logger.download()} title="下载前端日志（.log）">📄</button>
          </div>
        </div>
        <div className="modebar">
          <label>模式</label>
          <select value={contentMode} data-pref="content-mode" onChange={(e) => setContentMode(e.target.value as 'nsfw' | 'nsf')}>
            <option value="nsfw">NSFW</option>
            <option value="nsf">NSF</option>
          </select>
        </div>
        {/* FE-05.4：界面偏好（**用户配置决定渲染路线**，不按卡名强制；与剧情变量分离存储） */}
        <div className="modebar">
          <label title="场景区段默认渲染路线（通用偏好，不针对特定卡片）">界面</label>
          <select
            value={viewPrefs.sceneUi}
            data-pref="scene-ui"
            onChange={(e) => setViewPrefs(saveViewPrefs(storageNamespace, { sceneUi: e.target.value as 'native' | 'external' }))}
            title="原生舞台 / 卡自带前端页"
          >
            <option value="native">原生引擎</option>
            <option value="external">卡自带前端</option>
          </select>
          <label className="edit-check" title="可执行卡面保持同一浏览上下文，防止标签、滚动和脚本状态被重置">
            <input type="checkbox" checked disabled readOnly />
            卡面保活
          </label>
        </div>
        {turnState && (
          <div className="status-box">
            <div className="status-head">
              <span className="status-round">第 {turnState.round} 轮</span>
              <span className="status-event">{turnState.event_type}</span>
              {turnState.nsfw_lock.locked && <span className="tag tag-locked">NSFW 锁定 · R{turnState.nsfw_lock.round}</span>}
            </div>
            <div className="bars bars-compact">
              {(['personal', 'accident', 'main', 'erotic'] as const).map((k) => (
                <div key={k} className="bar-row">
                  <span className="bar-label">{k === 'personal' ? '个人' : k === 'accident' ? '意外' : k === 'main' ? '主线' : '情欲'}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(turnState.bars[k] ?? 0)}%` }} /></div>
                  <span className="bar-val">{turnState.bars[k] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {storyAvailable && (
          <StoryIndexPanel
            className="story-box--desktop"
            content={storyIndex}
            branches={storyBranches}
            round={storyDisplayRound}
            loading={storyLoading}
            error={storyError}
            staleSourceRound={storyStaleSourceRound}
            busy={busy}
            onRefresh={refreshStoryIndex}
            onSelect={applyBranch}
          />
        )}
        <AgentStatusPanel
          sessionId={sessionId}
          refreshKey={`${turnState?.round ?? 0}:${busy ? 'busy' : 'idle'}`}
        />
        <h2>角色卡</h2>
        <ul>
          <li><button onClick={() => selectMobileTab('setup')} disabled={busy}>＋ 新建会话（选卡/世界书/预设）</button></li>
          {cards.map((c) => (
            <li key={c.id}>
              <button onClick={() => { selectMobileTab('setup'); setError(''); }} disabled={busy}>{c.name.replace(/\.json$/, '')}</button>
            </li>
          ))}
        </ul>
        <h2>会话</h2>
        <ul>
          {sessions.map((s) => (
            <li key={s.id} className="session-row">
              <button
                className={`session-del${confirmDel === s.id ? ' session-del-confirm' : ''}`}
                title={!s.revision ? '会话快照不可用，暂不能删除' : (confirmDel === s.id ? '再点一次确认删除（历史不可恢复）' : '删除本会话')}
                onClick={() => deleteSession(s)} disabled={busy || !s.revision}
              >{confirmDel === s.id ? '✕' : '🗑'}</button>
              <button className="session-resume" onClick={() => { setConfirmDel(null); closeMobileNav(); resumeSession(s.id); }} disabled={busy || resumingSessionId === s.id}>
                <span className="session-name">{s.name}</span>
                {(s.start || s.preview) && <span className="session-start">{s.start || s.preview}</span>}
                <span className="session-meta">
                  {s.round !== undefined && s.round > 0 && <span className="session-round">R{s.round}</span>}
                  {s.createdAt && <span className="session-time">{formatSessionTime(s.createdAt)}</span>}
                  {resumingSessionId === s.id && <span className="session-round">恢复中</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {initStage && <p className="progress">{STAGE_LABEL[initStage] ?? initStage}</p>}
        <h2>面板</h2>
        <div className="tabbar">
          <button className={tab === 'chat' ? 'tab-active' : ''} onClick={() => selectMobileTab('chat')}>对话</button>
          <button className={tab === 'memory' ? 'tab-active' : ''} onClick={() => selectMobileTab('memory')}>记忆</button>
          <button className={tab === 'provider' ? 'tab-active' : ''} onClick={() => selectMobileTab('provider')}>Provider</button>
          <button className={tab === 'assets' ? 'tab-active' : ''} onClick={() => selectMobileTab('assets')}>资产</button>
          <button className={tab === 'editor' ? 'tab-active' : ''} onClick={() => selectMobileTab('editor')}>编辑</button>
          <button className={tab === 'skills' ? 'tab-active' : ''} onClick={() => selectMobileTab('skills')}>技能</button>
          <button className={tab === 'plugins' ? 'tab-active' : ''} onClick={() => selectMobileTab('plugins')}>插件</button>
          <button className={tab === 'quality' ? 'tab-active' : ''} onClick={() => selectMobileTab('quality')}>质量</button>
        </div>
        {error && <p className="error">{error}</p>}
      </aside>
      {/* 侧栏右缘拖把：绝对定位于 layout，left 由 React 内联（sidebarW-3 使中心对准边框线） */}
      <div
        className="sidebar-resizer"
        style={{ left: sidebarW - 3 }}
        onMouseDown={startSidebarDrag}
        title="拖动调整侧栏宽度"
      />
      <main ref={mobileMainRef} className="chat">
        {(!online || recoveryNotice) && (
          <div className={`connection-recovery${online ? '' : ' connection-recovery--offline'}`} role="status" aria-live="polite">
            {!online ? '手机当前离线；草稿保留在本设备，联网后可继续。' : recoveryNotice}
          </div>
        )}
        {tab === 'setup' ? (
          <SessionSetup storageNamespace={storageNamespace} onCreated={onSessionCreated} onCardsChanged={refreshCards} />
        ) : tab === 'memory' ? (
          // AM-05：面板真实可见 + 会话就绪 → 自动读取（无需手动刷新）；
          // 挂载即"打开"、卸载即"关闭"（关闭时面板自行取消在途读取与订阅）
          <MemoryConsole
            sessionId={sessionId}
            sessionReady={!!sessionId}
            visible={tab === 'memory'}
          />
        ) : tab === 'provider' ? (
          <ProviderPanel />
        ) : tab === 'assets' ? (
          <AssetsPanel sessionId={sessionId} />
        ) : tab === 'editor' ? (
          <EditorPanel />
        ) : tab === 'skills' ? (
          <SkillsPanel />
        ) : tab === 'plugins' ? (
          <PluginsPanel />
        ) : tab === 'quality' ? (
          <QualityPanel sessionId={sessionId} />
        ) : (
          <>
            <div className="messages" ref={scrollRef}>
              {busy && (
                <div className="gen-timer" title="从点击发送开始计时">
                  <span className="gen-timer-spin" /> 正在生成… <b>{genSeconds.toFixed(1)}s</b>
                </div>
              )}
              <ErrorBoundary scope="render" onReset={() => { if (sessionId) void fetchHistory(sessionId); }}>
              {(resumeLoading || (sessionId && !sessionResourcesReady)) && (
                <div className='empty'>{resumeLoading ? '正在恢复会话…' : '正在加载当前会话卡面资源…'}</div>
              )}
              {!resumeLoading && !sessionId && (
                <div className='empty'>从左侧选择一张角色卡开始对话</div>
              )}
              {!resumeLoading && sessionResourcesReady && messages.length === 0 && !busy && (
                <div className="empty">{resumeLoading ? '正在恢复会话…' : '从左侧选择一张角色卡开始对话'}</div>
              )}
              {sessionResourcesReady && (() => {
                const target = streamTargetRef.current;
                const lastAssistantRound = messages.reduce((mx, x) => (x.role === 'assistant' ? Math.max(mx, x.round) : mx), 0);
                const lastIdx = messages.length - 1;
                return messages.map((m, i) => {
                  const streaming = busy && !!target && !!m.content
                    && ((target.kind === 'id' && m.id === target.id)
                        || (target.kind === 'round' && m.round === target.round && m.role === 'assistant'));
                  const isLastAssistant = m.role === 'assistant' && lastAssistantRound > 0 && m.round === lastAssistantRound;
                  const key = toMessageKey(m.round, m.role);
                  // FE-05.4：历史页面轻量挂载策略（距离底部 / 展开 / 当前交互目标）
                  const mountPlan = planHistoryMount({
                    distanceFromBottom: lastIdx - i,
                    inViewport: visibleMessageKeys.has(key),
                    expanded: expandedMsgs.has(key),
                    interactive: streaming || isLastAssistant,
                    streaming,
                  }, historyMountOpts);
                  return (
                    <ErrorBoundary key={m.id} scope={'message-' + key}>
                      <MessageRow
                        m={m}
                        busy={busy}
                        streaming={streaming}
                        isLastAssistant={isLastAssistant}
                        showRaw={showRaw}
                        regexRules={renderRules}
                        ops={msgOpsRef.current}
                        streamingMsgRef={streamingMsgRef}
                        registerAnchor={register}
                        sessionId={sessionId}
                        sessionRunId={sessionRunId}
                        preferredSceneUi={viewPrefs.sceneUi}
                        mountPlan={mountPlan}
                        onExpandHistory={(k) => setExpandedMsgs((prev) => new Set(prev).add(k))}
                      />
                    </ErrorBoundary>
                  );
                });
              })()}
              </ErrorBoundary>
              {busy && !messages.some((m) => m.role === 'assistant' && m.content === '') && (
                <div className="msg assistant"><div className="bubble typing">思考中…</div></div>
              )}
              <div ref={bottomRef} />
            </div>
            <MessageRuler
              messages={historyForSpy}
              activeKey={activeKey}
              sessionKey={sessionId}
              onJump={scrollToKey}
            />
            {messages.length > 0 && showJumpButton && jumpKey && (
              <button
                className="jump-to-latest"
                onClick={() => { scrollToKey(jumpKey); dismissJump(); }}
              >
                查看新回复 ↓
              </button>
            )}
            {replanSuggestion && (
              <div className="replan-card">
                <strong>🎬 重写方向建议</strong>
                <span>{replanSuggestion}</span>
                <button className="op-btn" onClick={() => setReplanSuggestion('')}>收起</button>
              </div>
            )}
            <div
              className={`inputbar${dragImageOver ? ' inputbar-drag' : ''}`}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer.items).some((it) => it.type.startsWith('image/'))) {
                  e.preventDefault();
                  setDragImageOver(true);
                }
              }}
              onDragLeave={() => setDragImageOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragImageOver(false);
                void addImageFiles(e.dataTransfer.files);
              }}
            >
              <label className="edit-check" title="显示原始文本（含 <think>/<UpdateVariable> 等标记）">
                <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
                显示原文
              </label>
              <div className="composer">
                {pendingImages.length > 0 && (
                  <div className="image-tray">
                    {pendingImages.map((img) => (
                      <div className="image-chip" key={img.id}>
                        <img src={img.dataUrl} alt={img.name} />
                        <span>{img.name}</span>
                        <button type="button" title="移除图片" onClick={() => setPendingImages((xs) => xs.filter((x) => x.id !== img.id))}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
                  if (files.length > 0) {
                    e.preventDefault();
                    void addImageFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                  if (e.key === 'Escape' && busy) { e.preventDefault(); stopGenerating(); }
                }}
                placeholder={sessionId ? '输入你的行动或对话…' : '请先选择角色卡'}
                rows={2}
              />
              </div>
              <button
                className={busy ? 'btn-stop' : ''}
                onClick={busy ? stopGenerating : send}
                disabled={!sessionId || (!busy && !sessionResourcesReady) || stopping}
              >
                {busy ? (stopping ? '停止中…' : '停止') : '发送'}
              </button>
            </div>
          </>
        )}
      </main>

      {directorSel && !busy && (
        <button
          className="director-float"
          style={{ left: directorSel.x, top: directorSel.y }}
          onClick={() => { setDirectorTarget(directorSel); dismissDirector(); }}
          title="🎬 导演模式：基于该片段 + 剧情上下文生成分镜"
        >🎬</button>
      )}

      <DirectorModal
        open={Boolean(directorTarget && sessionId)}
        sessionId={sessionId}
        selection={directorTarget}
        onClose={() => setDirectorTarget(null)}
        onSaved={refreshSessions}
      />
    </div>
  );
}
