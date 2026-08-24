import React, { useState, useEffect, useRef, useMemo } from 'react';
import { MemoryConsole } from './MemoryConsole.tsx';
import { ProviderPanel } from './ProviderPanel.tsx';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PluginsPanel } from './PluginsPanel.tsx';
import { SessionSetup } from './SessionSetup.tsx';
import { EditorPanel } from './EditorPanel.tsx';
import { SkillsPanel } from './SkillsPanel.tsx';
import { MarkdownMessage, StreamText } from './MarkdownMessage.tsx';
import { HtmlMessage, splitHtmlSegments, splitGalSegments } from './HtmlMessage.tsx';
import { GalPlaceholder } from './gal/GalPlaceholder.tsx';
import { isJgFrameMessage, findFrame } from './gal/bridge.ts';
import type { JgFrameMessage } from './gal/bridge.ts';
import { setGalRuntime } from './gal/rt.ts';
import type { GalRuntime } from './gal/rt.ts';
import { applyDisplayRules } from '../../../packages/core/src/regex.ts';
import type { RegexRule } from '../../../packages/core/src/regex.ts';
import { useMessageRefs, toMessageKey } from './hooks/useMessageRefs.ts';
import { useScrollToMessage } from './hooks/useScrollToMessage.ts';
import { useScrollSpy } from './hooks/useScrollSpy.ts';
import { useAutoScrollToMessage } from './hooks/useAutoScrollToMessage.ts';
import { MessageRuler } from './components/MessageRuler.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { logger } from './lib/logger.ts';
import { DirectorModal } from './DirectorModal.tsx';
import { useTextSelectionDirector } from './hooks/useTextSelectionDirector.ts';
import type { TextSelection } from './hooks/useTextSelectionDirector.ts';

/** 单回合生成超时（秒）：上游迟迟不返回/不结束 → 前端主动 abort，避免 busy 卡死、页面永久空转 */
const GENERATION_TIMEOUT_MS = 300_000;
/** 侧栏宽度（可拖动调整，localStorage jg-sidebar-w 持久化；范围 200~480） */
const SIDEBAR_DEFAULT_W = 300;
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 480;

interface Card { id: string; name: string }
interface SessionInfo { id: string; name: string; preview?: string; round?: number; start?: string; createdAt?: string }
interface Message { id: number; round: number; role: string; content: string }
/** 推进槽 / 轮次状态（/api/session/:id/turn-state，侧栏常驻） */
interface TurnState {
  bars: Record<string, number>;
  event_type: string;
  nsfw_lock: { locked: boolean; round: number };
  round: number;
}
/** 主题三档（localStorage jg-theme） */
type Theme = 'dark' | 'sepia' | 'paper';

// API 基址：VITE_API_BASE 可覆盖（生产部署），默认同源（dev 走 vite proxy）
const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

let msgSeq = 0;
const nextMsgId = () => ++msgSeq;

const api = async <T,>(path: string, opts?: RequestInit): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
};

/** SSE 流式请求：POST + 读 event stream，回调各事件；signal 用于中止（前端停止按钮） */
const apiStream = async (
  path: string,
  body: Record<string, unknown>,
  onEvent: (ev: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        onEvent(JSON.parse(t.slice(5).trim()));
      } catch { /* 忽略坏块 */ }
    }
  }
};

/** 合并服务端历史到本地消息列表（稳定 key：round+role 匹配保留前端 id，仅追加新消息分配 id）
 *  避免回合结束用后端真实 id 覆盖前端假 id 导致 React key 全部变化、DOM 重挂、动画重放 */
const mergeHistory = (prev: Message[], server: { id: number; round: number; role: string; content: string }[]): Message[] => {
  const localIds = new Map(prev.map((m) => [`${m.round}:${m.role}`, m.id]));
  return server.map((m) => ({ ...m, id: localIds.get(`${m.round}:${m.role}`) ?? nextMsgId() }));
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
}) {
  const dr = showRaw || !regexRules ? { text: m.content, gal: [] as string[] } : applyDisplayRules(m.content, regexRules);
  const shown = dr.text;
  // 分段渲染：围栏内 HTML 前端 + GLA(<gal_inface>) 场景抽为独立段，周围叙事留在气泡段
  const segs = !streaming && m.role === 'assistant' ? splitGalSegments(shown, dr.gal) : null;
  const singleText = !!segs && segs.length === 1 && segs[0].type === 'text';
  const hasHtmlSeg = !!segs && !singleText;
  const anchorKey = toMessageKey(m.round, m.role);
  // 锚点 ref 记忆化（v0.6.1）：registerAnchor(key) 每次调用都返回新函数，
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
        {hasHtmlSeg && segs ? (
          <div className="msg-segments">
            {segs.map((seg, i) =>
              seg.type === 'gal'
                ? <GalPlaceholder key={i} index={seg.index} />
                : seg.type === 'html'
                  ? <HtmlMessage key={i} text={seg.content} />
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
  && prev.m.content === next.m.content && prev.busy === next.busy
  && prev.streaming === next.streaming && prev.isLastAssistant === next.isLastAssistant
  && prev.showRaw === next.showRaw && prev.regexRules === next.regexRules
);

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // v0.6.0：一次 AI 回复生成完成信号（供"生成完成智能定位"触发跳转；每次开新生成前清 false）
  const [streamCompleted, setStreamCompleted] = useState(false);
  const [initStage, setInitStage] = useState('');
  const [contentMode, setContentMode] = useState<'nsfw' | 'nsf'>('nsfw');
  const [tab, setTab] = useState<'setup' | 'chat' | 'memory' | 'provider' | 'assets' | 'editor' | 'plugins' | 'skills'>('setup');
  const [error, setError] = useState('');
  const [adultOk, setAdultOk] = useState<boolean>(() => localStorage.getItem('jg-adult-ok') === '1');
  const bottomRef = useRef<HTMLDivElement>(null);
  // v0.6.0 消息锚点 + 楼层刻度 + 生成完成定位：滚动视口 ref / 锚点注册表 / 3 个定位 hook
  const scrollRef = useRef<HTMLDivElement>(null);
  const { refMap, register, getElement } = useMessageRefs();
  // 正则管道：对话原始标记（<think>/<UpdateVariable>/<era_data> 等）前端自动屏蔽隐藏
  const [regexRules, setRegexRules] = useState<RegexRule[] | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  // 美化：主题 / 字号 / 侧栏常驻推进槽
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('jg-theme') as Theme) || 'dark');
  const [readFs, setReadFs] = useState<number>(() => Number(localStorage.getItem('jg-read-fs')) || 16);
  // 侧栏宽度（可拖动；读 localStorage，越界则回退默认值）
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const saved = Number(localStorage.getItem('jg-sidebar-w'));
    return saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W ? saved : SIDEBAR_DEFAULT_W;
  });
  const [turnState, setTurnState] = useState<TurnState | null>(null);
  // 剧情分支索引（AI 生成，按轮缓存）
  const [storyIndex, setStoryIndex] = useState<string>('');
  const [storyBranches, setStoryBranches] = useState<string[]>([]);
  const [storyIndexRound, setStoryIndexRound] = useState<number>(-1);
  const [storyLoading, setStoryLoading] = useState(false);
  // 流式生成时钉住正文起点（从头阅读）
  const streamingMsgRef = useRef<HTMLDivElement>(null);
  // 流式批合并（rAF 节流）：delta 先累积到 buf，每帧最多一次 setMessages，避免逐字全量 map 卡死
  const streamBufRef = useRef('');
  const streamRafRef = useRef<number | null>(null);
  const streamTargetRef = useRef<{ kind: 'id'; id: number } | { kind: 'round'; round: number } | null>(null);
  // 中止生成：busy 期间持有当前回合的 AbortController（发送键变停止键 + Esc）
  const abortRef = useRef<AbortController | null>(null);
  const stopGenerating = () => { abortRef.current?.abort(); };
  // 生成超时兜底：回合迟迟不结束 → 主动中止，防止 busy 卡死 / 页面永久空转
  const genTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genTimedOutRef = useRef(false);
  const clearGenTimeout = () => {
    if (genTimeoutRef.current) { clearTimeout(genTimeoutRef.current); genTimeoutRef.current = null; }
  };
  const startGenTimeout = () => {
    clearGenTimeout();
    genTimedOutRef.current = false;
    genTimeoutRef.current = setTimeout(() => {
      genTimedOutRef.current = true;
      logger.warn('turn', '生成超时，自动中止', { timeoutMs: GENERATION_TIMEOUT_MS });
      abortRef.current?.abort();
    }, GENERATION_TIMEOUT_MS);
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
    // 生成期底部跟随（v0.6.1：事件驱动，仅确有 delta 时执行，取代原 60fps 追随循环）
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
  const startGenTimer = () => {
    setGenSeconds(0);
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    genTimerRef.current = setInterval(() => setGenSeconds((s) => s + 0.1), 100);
  };
  const stopGenTimer = () => {
    if (genTimerRef.current) { clearInterval(genTimerRef.current); genTimerRef.current = null; }
  };
  useEffect(() => () => {
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    if (genTimeoutRef.current) clearTimeout(genTimeoutRef.current);
  }, []);

  // 主题应用到 <html data-theme>，字号写到 --read-fs 变量
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('jg-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty('--read-fs', `${readFs}px`);
    localStorage.setItem('jg-read-fs', String(readFs));
  }, [readFs]);
  // 侧栏宽度持久化（与 theme/read-fs 一致：变化即写入 localStorage）
  useEffect(() => {
    localStorage.setItem('jg-sidebar-w', String(sidebarW));
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
  const fetchTurnState = async (sid: string) => {
    try {
      const d = await api<{ state: TurnState }>(`/api/session/${sid}/turn-state`);
      setTurnState(d.state ?? null);
      if (d.state && d.state.round > 0) fetchStoryIndex(sid, d.state.round);
    } catch { /* 侧栏状态拉取失败不影响使用 */ }
  };

  /** 刷新角色卡列表（导入/切换建会话面板后同步侧栏） */
  const refreshCards = async () => {
    try {
      const d = await api<{ cards: Card[] }>('/api/cards');
      setCards(d.cards ?? []);
    } catch { /* 静默 */ }
  };

  /** 拉取 AI 剧情分支索引（后端按轮缓存，重复请求零成本） */
  const fetchStoryIndex = async (sid: string, round: number) => {
    if (!sid || round < 0 || storyLoading) return;
    setStoryLoading(true);
    try {
      const d = await api<{ content: string; branches: string[]; round: number; fromCache: boolean }>(`/api/session/${sid}/story-index?round=${round}`);
      setStoryIndex(d.content ?? '');
      setStoryBranches(d.branches ?? []);
      setStoryIndexRound(d.round ?? -1);
    } catch { /* 索引失败不打扰 */ }
    setStoryLoading(false);
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
    setInput(branch);
    inputRef.current?.focus();
  };

  /** 删除会话（两步内联确认；历史全部清除 + db 移除） */
  const deleteSession = async (s: SessionInfo) => {
    if (confirmDel !== s.id) { setConfirmDel(s.id); return; } // 第一次点击 → 进入确认态
    setConfirmDel(null);
    logger.info('session', '删除会话', { session: s.id });
    try {
      await api(`/api/session/${s.id}/delete`, { method: 'POST' });
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
      if (sessionId === s.id) {
        setSessionId(null);
        setMessages([]);
        setTurnState(null);
        setStoryIndex('');
        setStoryBranches([]);
        setStoryIndexRound(-1);
        setTab('setup');
      }
    } catch (e) { setError((e as Error).message); }
  };

  useEffect(() => {
    api<{ cards: Card[] }>('/api/cards').then((d) => setCards(d.cards)).catch((e) => setError(e.message));
    refreshSessions();
    api<{ rules: RegexRule[] }>('/api/regex-rules').then((d) => setRegexRules(d.rules ?? [])).catch(() => {});
  }, []);

  // 每次切到"新建会话"面板时同步侧栏角色卡列表（导入后立即可见）
  useEffect(() => { if (tab === 'setup') refreshCards(); }, [tab]);

  // v0.6.0：楼层刻度数据源（round+role 结构串，流式期结构不变则不触发 scroll-spy 重建监听）
  const historyForSpy = useMemo(
    () => messages.map((m) => ({ round: m.round, role: m.role })),
    [messages],
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
    setSessionId(sid);
    setContentMode(mode === 'nsf' ? 'nsf' : 'nsfw');
    setMessages([{ id: nextMsgId(), round: 0, role: 'assistant', content: greeting }]);
    refreshSessions();
    setTab('chat');
    fetchTurnState(sid);
  };

  /** 拉取会话历史并合并到本地（稳定 key：round+role 匹配保留前端 id） */
  const fetchHistory = async (sid: string): Promise<void> => {
    const t0 = performance.now();
    const h = await api<{ messages: { id: number; round: number; role: string; content: string }[] }>(`/api/session/${sid}/history`);
    logger.debug('session', '拉取会话历史', { session: sid, count: h.messages?.length ?? 0, ms: Math.round(performance.now() - t0) });
    setMessages((prev) => mergeHistory(prev, h.messages));
  };

  /** 中止收尾：通知后端把已生成的部分正文落库（幂等，/turn/abort 等待进行中的 turn 完成后落库）并刷新 */
  const finalizeAbort = async (sid: string, round: number) => {
    if (round < 1) return;
    try {
      await api(`/api/session/${sid}/turn/abort`, { method: 'POST', body: JSON.stringify({ round }) });
      await fetchHistory(sid);
      fetchTurnState(sid);
      refreshSessions();
    } catch { /* 中止落库失败不阻塞后续刷新 */ }
  };

  const resumeSession = async (sid: string) => {
    logger.info('session', '恢复会话', { session: sid });
    setBusy(true);
    setError('');
    try {
      await api('/api/session/resume', { method: 'POST', body: JSON.stringify({ db: `${sid}.db` }) });
      setSessionId(sid);
      await fetchHistory(sid);
      setTab('chat');
      fetchTurnState(sid);
    } catch (e) {
      logger.error('session', '恢复会话失败', { message: (e as Error).message });
      setError((e as Error).message);
    }
    setBusy(false);
  };

  /** 公共发送路径：输入框 send 与前端卡 choice/draft 共用。
   *  mode 'send' → 直接作为用户消息发出触发 AI；'draft' → 填入输入框不自动发送（与分支按钮一致）。
   *  不清空输入框（外部调用者不应动用户输入）；输入框清空由 send() 自身处理。 */
  const sendText = async (raw: string, mode: 'send' | 'draft' = 'send') => {
    if (mode === 'draft') { applyBranch(raw); return; }
    const text = String(raw ?? '').trim();
    if (!text || !sessionId || busy) return;
    logger.info('turn', '发送消息', { session: sessionId, content_mode: contentMode, via: 'gla' });
    setBusy(true);
    setStreamCompleted(false);
    setError('');
    startGenTimer();
    startGenTimeout();
    setMessages((m) => [...m, { id: nextMsgId(), round: 0, role: 'user', content: text }]);
    const replyId = nextMsgId();
    setMessages((m) => [...m, { id: replyId, round: 0, role: 'assistant', content: '' }]);
    streamTargetRef.current = { kind: 'id', id: replyId };
    const ac = new AbortController();
    abortRef.current = ac;
    let deltaCount = 0;
    let deltaLen = 0;
    try {
      await apiStream('/api/turn', { session: sessionId, input: text, content_mode: contentMode }, (ev) => {
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
        if (ev.type === 'error') {
          logger.error('turn', '回合 SSE error', { message: ev.message });
          setError(String(ev.message ?? '回合失败'));
        }
      }, ac.signal);
      logger.info('turn', '回合 SSE 完成', { deltaCount, deltaLen, aborted: ac.signal.aborted });
      // 回合结束 → 刷新推进槽（侧栏常驻）+ 拉真实 round（消息操作按 round 定位）+ 会话预览
      fetchTurnState(sessionId);
      await fetchHistory(sessionId);
      refreshSessions();
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        logger.warn('turn', '回合被中止', { timeout: genTimedOutRef.current });
        if (genTimedOutRef.current) setError('生成超时（5 分钟），已自动中止。可重新发送。');
        // 用户停止/超时：后端已通过 req close 触发部分正文落库；此处幂等兜底 + 刷新
        try {
          const ts = await api<{ state: TurnState | null }>(`/api/session/${sessionId}/turn-state`);
          await finalizeAbort(sessionId, ts.state?.round ?? 0);
        } catch { /* 中止兜底失败不阻塞 */ }
      } else {
        logger.error('turn', '回合失败', { message: (e as Error).message });
        setError((e as Error).message);
        // 网络级异常：后端已清理失败轮孤儿 → 刷新历史移除乐观气泡（round 0 user+assistant），避免残留空回复
        try { await fetchHistory(sessionId); } catch { /* 刷新失败不阻塞报错 */ }
        fetchTurnState(sessionId);
        refreshSessions();
      }
    }
    abortRef.current = null;
    clearGenTimeout();
    genTimedOutRef.current = false;
    stopStream();
    stopGenTimer();
    setStreamCompleted(true);
    setBusy(false);
  };

  /** 输入框发送：先清空输入框再走公共发送路径（busy 守卫在 sendText 内） */
  const send = async () => {
    if (!input.trim()) return;
    setInput('');
    await sendText(input);
  };

  /** 重新生成某条 AI 回复（SSE 流式原地替换目标消息内容；可中止） */
  const regenerateMessage = async (msg: Message) => {
    if (!sessionId || busy) return;
    logger.info('turn', '重新生成回复', { session: sessionId, round: msg.round });
    setBusy(true);
    setStreamCompleted(false);
    setError('');
    startGenTimer();
    startGenTimeout();
    streamTargetRef.current = { kind: 'round', round: msg.round };
    const ac = new AbortController();
    abortRef.current = ac;
    let deltaCount = 0;
    let deltaLen = 0;
    try {
      await apiStream(`/api/session/${sessionId}/regenerate`, { round: msg.round }, (ev) => {
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          deltaCount++;
          deltaLen += ev.text.length;
          pushStream(ev.text);
        }
        if (ev.type === 'done' && typeof ev.prose === 'string') {
          stopStream();
          const prose = ev.prose;
          setMessages((m) => m.map((x) => (x.round === msg.round && x.role === 'assistant' ? { ...x, content: prose } : x)));
        }
        if (ev.type === 'error') {
          logger.error('turn', '重新生成 SSE error', { message: ev.message });
          setError(String(ev.message ?? '重新生成失败'));
        }
      }, ac.signal);
      logger.info('turn', '重新生成 SSE 完成', { round: msg.round, deltaCount, deltaLen, aborted: ac.signal.aborted });
      await fetchHistory(sessionId);
      fetchTurnState(sessionId);
      refreshSessions();
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        if (genTimedOutRef.current) setError('生成超时（5 分钟），已自动中止。可重试。');
        // 用户停止/超时重新生成：round 已知，幂等兜底落库 + 刷新
        await finalizeAbort(sessionId, msg.round);
      } else {
        logger.error('turn', '重新生成失败', { message: (e as Error).message });
        setError((e as Error).message);
        // 网络级异常：后端已写占位 assistant → 刷新历史对齐，避免前后端状态漂移
        try { await fetchHistory(sessionId); } catch { /* 刷新失败不阻塞报错 */ }
        fetchTurnState(sessionId);
        refreshSessions();
      }
    }
    abortRef.current = null;
    clearGenTimeout();
    genTimedOutRef.current = false;
    stopStream();
    stopGenTimer();
    setStreamCompleted(true);
    setBusy(false);
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
    const frame = findFrame(e.source);
    const reply = (result?: unknown, error?: string) => frame?.post({ __jgfh: 'rpc', id: d.id, ok: !error, result, error });
    if (d.ns === 'message' && d.op === 'send') {
      const p = (d.payload ?? {}) as { text?: string; draft?: boolean };
      if (typeof p.text === 'string') { if (p.draft === true) applyBranch(p.text); else sendText(p.text); }
      return reply({ ok: true });
    }
    if (d.ns === 'theme' && d.op === 'get') return reply({ theme });
    if (d.ns === 'viewport' && d.op === 'get') return reply({ w: window.innerWidth, h: window.innerHeight });
    if (d.ns === 'asset' && d.op === 'resolve') return reply({ status: 'miss' }); // 资源解析在资产模块落地后填充
    return reply(undefined, `未知 rpc ${d.ns}.${d.op}`);
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
      if ('__jgfh_h' in d) return; // height/size 由 HtmlMessage 组件级处理测高
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
      {!adultOk && (
        <div className="adult-overlay">
          <div className="adult-box">
            <h2>内容提示</h2>
            <p>本应用包含<b>成年向（NSFW）</b>内容分支，仅限 18 岁以上用户使用。</p>
            <p>所有内容均为虚构，用户自担风险。NSF 纯净分支不含露骨内容。</p>
            <div className="adult-actions">
              <button onClick={() => { localStorage.setItem('jg-adult-ok', '1'); setAdultOk(true); }}>我已成年，进入</button>
              <button className="adult-decline" onClick={() => { setContentMode('nsf'); localStorage.setItem('jg-adult-ok', '1'); setAdultOk(true); }}>切换到纯净分支进入</button>
            </div>
          </div>
        </div>
      )}
      <aside className="sidebar" style={{ width: sidebarW }}>
        <div className="sidebar-top">
          <h1>jiuguan</h1>
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
          <select value={contentMode} onChange={(e) => setContentMode(e.target.value as 'nsfw' | 'nsf')}>
            <option value="nsfw">NSFW</option>
            <option value="nsf">NSF</option>
          </select>
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
        {(storyIndex || storyBranches.length > 0) && (
          <div className="status-box story-box">
            <div className="status-head">
              <span className="status-round">剧情分支索引</span>
              <span className="status-event">R{storyIndexRound}</span>
              <button className="mini-btn" title="重新生成剧情索引" onClick={() => { if (sessionId) fetchStoryIndex(sessionId, Math.max(storyIndexRound, turnState?.round ?? 0)); }} disabled={storyLoading}>↻</button>
            </div>
            {storyIndex && <div className="story-index">{storyIndex}</div>}
            {storyBranches.length > 0 && (
              <div className="story-branches">
                {storyBranches.map((b, i) => (
                  <button key={i} className="branch-btn" onClick={() => applyBranch(b)} disabled={busy}>{b}</button>
                ))}
              </div>
            )}
            <p className="story-hint">AI 生成 · 点击分支填入输入框</p>
          </div>
        )}
        <h2>角色卡</h2>
        <ul>
          <li><button onClick={() => setTab('setup')} disabled={busy}>＋ 新建会话（选卡/世界书/预设）</button></li>
          {cards.map((c) => (
            <li key={c.id}>
              <button onClick={() => { setTab('setup'); setError(''); }} disabled={busy}>{c.name.replace(/\.json$/, '')}</button>
            </li>
          ))}
        </ul>
        <h2>会话</h2>
        <ul>
          {sessions.map((s) => (
            <li key={s.id} className="session-row">
              <button
                className={`session-del${confirmDel === s.id ? ' session-del-confirm' : ''}`}
                title={confirmDel === s.id ? '再点一次确认删除（历史不可恢复）' : '删除本会话'}
                onClick={() => deleteSession(s)} disabled={busy}
              >{confirmDel === s.id ? '✕' : '🗑'}</button>
              <button className="session-resume" onClick={() => { setConfirmDel(null); resumeSession(s.id); }} disabled={busy}>
                <span className="session-name">{s.name}</span>
                {(s.start || s.preview) && <span className="session-start">{s.start || s.preview}</span>}
                <span className="session-meta">
                  {s.round !== undefined && s.round > 0 && <span className="session-round">R{s.round}</span>}
                  {s.createdAt && <span className="session-time">{formatSessionTime(s.createdAt)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {initStage && <p className="progress">{STAGE_LABEL[initStage] ?? initStage}</p>}
        <h2>面板</h2>
        <div className="tabbar">
          <button className={tab === 'chat' ? 'tab-active' : ''} onClick={() => setTab('chat')}>对话</button>
          <button className={tab === 'memory' ? 'tab-active' : ''} onClick={() => setTab('memory')}>记忆</button>
          <button className={tab === 'provider' ? 'tab-active' : ''} onClick={() => setTab('provider')}>Provider</button>
          <button className={tab === 'assets' ? 'tab-active' : ''} onClick={() => setTab('assets')}>资产</button>
          <button className={tab === 'editor' ? 'tab-active' : ''} onClick={() => setTab('editor')}>编辑</button>
          <button className={tab === 'skills' ? 'tab-active' : ''} onClick={() => setTab('skills')}>技能</button>
          <button className={tab === 'plugins' ? 'tab-active' : ''} onClick={() => setTab('plugins')}>插件</button>
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
      <main className="chat">
        {tab === 'setup' ? (
          <SessionSetup onCreated={onSessionCreated} onCardsChanged={refreshCards} />
        ) : tab === 'memory' ? (
          <MemoryConsole sessionId={sessionId} />
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
        ) : (
          <>
            <div className="messages" ref={scrollRef}>
              {busy && (
                <div className="gen-timer" title="从点击发送开始计时">
                  <span className="gen-timer-spin" /> 正在生成… <b>{genSeconds.toFixed(1)}s</b>
                </div>
              )}
              <ErrorBoundary scope="render" onReset={() => setMessages([])}>
              {messages.length === 0 && !busy && (
                <div className="empty">从左侧选择一张角色卡开始对话（首次需加载世界书 + 向量化，约 10 秒）</div>
              )}
              {(() => {
                const target = streamTargetRef.current;
                const lastAssistantRound = messages.reduce((mx, x) => (x.role === 'assistant' ? Math.max(mx, x.round) : mx), 0);
                return messages.map((m, i) => {
                  const streaming = busy && !!target && !!m.content
                    && ((target.kind === 'id' && m.id === target.id)
                        || (target.kind === 'round' && m.round === target.round && m.role === 'assistant'));
                  const isLastAssistant = m.role === 'assistant' && lastAssistantRound > 0 && m.round === lastAssistantRound;
                  return (
                    <MessageRow
                      key={m.id}
                      m={m}
                      busy={busy}
                      streaming={streaming}
                      isLastAssistant={isLastAssistant}
                      showRaw={showRaw}
                      regexRules={regexRules}
                      ops={msgOpsRef.current}
                      streamingMsgRef={streamingMsgRef}
                      registerAnchor={register}
                    />
                  );
                });
              })()}
              </ErrorBoundary>
              {busy && !messages.some((m) => m.role === 'assistant' && m.content === '') && (
                <div className="msg assistant"><div className="bubble typing">思考中…</div></div>
              )}
              <div ref={bottomRef} />
            </div>
            <MessageRuler messages={historyForSpy} activeKey={activeKey} onJump={scrollToKey} />
            {messages.length > 0 && showJumpButton && jumpKey && (
              <button
                className="jump-to-latest"
                onClick={() => { scrollToKey(jumpKey); dismissJump(); }}
              >
                查看新回复 ↓
              </button>
            )}
            <div className="inputbar">
              <label className="edit-check" title="显示原始文本（含 <think>/<UpdateVariable> 等标记）">
                <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
                显示原文
              </label>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                  if (e.key === 'Escape' && busy) { e.preventDefault(); stopGenerating(); }
                }}
                placeholder={sessionId ? '输入你的行动或对话…' : '请先选择角色卡'}
                rows={2}
              />
              <button
                className={busy ? 'btn-stop' : ''}
                onClick={busy ? stopGenerating : send}
                disabled={!sessionId}
              >
                {busy ? '停止' : '发送'}
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
