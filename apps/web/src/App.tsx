import React, { useState, useEffect, useRef } from 'react';
import { MemoryConsole } from './MemoryConsole.tsx';
import { ProviderPanel } from './ProviderPanel.tsx';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PluginsPanel } from './PluginsPanel.tsx';
import { SessionSetup } from './SessionSetup.tsx';
import { EditorPanel } from './EditorPanel.tsx';
import { SkillsPanel } from './SkillsPanel.tsx';
import { MarkdownMessage, StreamText } from './MarkdownMessage.tsx';
import { HtmlMessage, looksLikeHtml, extractHtmlFromCodeFence } from './HtmlMessage.tsx';
import { applyRegexRules } from '../../../packages/core/src/regex.ts';
import type { RegexRule } from '../../../packages/core/src/regex.ts';

interface Card { id: string; name: string }
interface SessionInfo { id: string; name: string; preview?: string; round?: number }
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
  m, busy, streaming, isLastAssistant, showRaw, regexRules, ops, streamingMsgRef,
}: {
  m: Message;
  busy: boolean;
  streaming: boolean;
  isLastAssistant: boolean;
  showRaw: boolean;
  regexRules: RegexRule[] | null;
  ops: MsgOps;
  streamingMsgRef: React.RefObject<HTMLDivElement>;
}) {
  const shown = showRaw || !regexRules ? m.content : applyRegexRules(m.content, regexRules, 'display').text;
  const msgHtml = !streaming && m.role === 'assistant'
    ? extractHtmlFromCodeFence(shown) ?? (looksLikeHtml(shown) ? shown : null)
    : null;
  return (
    <div className={`msg ${m.role}`} ref={streaming ? streamingMsgRef : undefined}>
      <div className="msg-body">
        {msgHtml ? (
          <HtmlMessage text={msgHtml} />
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
  const [initStage, setInitStage] = useState('');
  const [contentMode, setContentMode] = useState<'nsfw' | 'nsf'>('nsfw');
  const [tab, setTab] = useState<'setup' | 'chat' | 'memory' | 'provider' | 'assets' | 'editor' | 'plugins' | 'skills'>('setup');
  const [error, setError] = useState('');
  const [adultOk, setAdultOk] = useState<boolean>(() => localStorage.getItem('jg-adult-ok') === '1');
  const bottomRef = useRef<HTMLDivElement>(null);
  // 正则管道：对话原始标记（<think>/<UpdateVariable>/<era_data> 等）前端自动屏蔽隐藏
  const [regexRules, setRegexRules] = useState<RegexRule[] | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  // 美化：主题 / 字号 / 侧栏常驻推进槽
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('jg-theme') as Theme) || 'dark');
  const [readFs, setReadFs] = useState<number>(() => Number(localStorage.getItem('jg-read-fs')) || 16);
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
  useEffect(() => () => { if (streamRafRef.current != null) cancelAnimationFrame(streamRafRef.current); }, []);
  // 会话删除：两步内联确认
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
  useEffect(() => () => { if (genTimerRef.current) clearInterval(genTimerRef.current); }, []);

  // 主题应用到 <html data-theme>，字号写到 --read-fs 变量
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('jg-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty('--read-fs', `${readFs}px`);
    localStorage.setItem('jg-read-fs', String(readFs));
  }, [readFs]);

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

  useEffect(() => {
    // 流式生成时：钉在正在生成正文的起点，方便从头阅读；空闲/结束后回到底部
    if (busy && streamingMsgRef.current) {
      streamingMsgRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, busy, initStage]);

  /** 会话创建完成回调（SessionSetup 面板 → 进入对话） */
  const onSessionCreated = (sid: string, greeting: string, cardName: string, mode: string) => {
    setSessionId(sid);
    setContentMode(mode === 'nsf' ? 'nsf' : 'nsfw');
    setMessages([{ id: nextMsgId(), round: 0, role: 'assistant', content: `${greeting}\n\n（角色卡：${cardName} · ${mode}）` }]);
    refreshSessions();
    setTab('chat');
    fetchTurnState(sid);
  };

  /** 拉取会话历史并合并到本地（稳定 key：round+role 匹配保留前端 id） */
  const fetchHistory = async (sid: string): Promise<void> => {
    const h = await api<{ messages: { id: number; round: number; role: string; content: string }[] }>(`/api/session/${sid}/history`);
    setMessages((prev) => mergeHistory(prev, h.messages));
  };

  const resumeSession = async (sid: string) => {
    setBusy(true);
    setError('');
    try {
      await api('/api/session/resume', { method: 'POST', body: JSON.stringify({ db: `${sid}.db` }) });
      setSessionId(sid);
      await fetchHistory(sid);
      setTab('chat');
      fetchTurnState(sid);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !sessionId || busy) return;
    setInput('');
    setBusy(true);
    setError('');
    startGenTimer();
    setMessages((m) => [...m, { id: nextMsgId(), round: 0, role: 'user', content: text }]);
    const replyId = nextMsgId();
    setMessages((m) => [...m, { id: replyId, round: 0, role: 'assistant', content: '' }]);
    streamTargetRef.current = { kind: 'id', id: replyId };
    try {
      await apiStream('/api/turn', { session: sessionId, input: text, content_mode: contentMode }, (ev) => {
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          // 真流式：rAF 批合并逐帧追加（StreamText 渐进渲染，不做全量 re-parse）
          pushStream(ev.text);
        }
        if (ev.type === 'done' && typeof ev.prose === 'string') {
          // 兜底：done 携带完整 prose，整体覆盖（保证流式片段/重试后最终一致）
          stopStream();
          const prose = ev.prose;
          setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, content: prose } : x)));
        }
        if (ev.type === 'error') setError(String(ev.message ?? '回合失败'));
      });
      // 回合结束 → 刷新推进槽（侧栏常驻）+ 拉真实 round（消息操作按 round 定位）+ 会话预览
      fetchTurnState(sessionId);
      await fetchHistory(sessionId);
      refreshSessions();
    } catch (e) { setError((e as Error).message); }
    stopStream();
    stopGenTimer();
    setBusy(false);
  };

  /** 重新生成某条 AI 回复（SSE 流式原地替换目标消息内容） */
  const regenerateMessage = async (msg: Message) => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError('');
    startGenTimer();
    streamTargetRef.current = { kind: 'round', round: msg.round };
    try {
      await apiStream(`/api/session/${sessionId}/regenerate`, { round: msg.round }, (ev) => {
        if (ev.type === 'delta' && typeof ev.text === 'string') pushStream(ev.text);
        if (ev.type === 'done' && typeof ev.prose === 'string') {
          stopStream();
          const prose = ev.prose;
          setMessages((m) => m.map((x) => (x.round === msg.round && x.role === 'assistant' ? { ...x, content: prose } : x)));
        }
        if (ev.type === 'error') setError(String(ev.message ?? '重新生成失败'));
      });
      await fetchHistory(sessionId);
      fetchTurnState(sessionId);
      refreshSessions();
    } catch (e) { setError((e as Error).message); }
    stopStream();
    stopGenTimer();
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
      <aside className="sidebar">
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
              <button className="session-resume" onClick={() => { setConfirmDel(null); resumeSession(s.id); }} disabled={busy}>
                <span className="session-name">{s.name}</span>
                {s.preview && <span className="session-preview">{s.preview}</span>}
              </button>
              <button
                className={`mini-btn${confirmDel === s.id ? ' mini-btn-danger' : ''}`}
                title={confirmDel === s.id ? '再点一次确认删除（历史不可恢复）' : '删除本会话'}
                onClick={() => deleteSession(s)} disabled={busy}
              >{confirmDel === s.id ? '✓?' : '🗑'}</button>
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
            <div className="messages">
              {busy && (
                <div className="gen-timer" title="从点击发送开始计时">
                  <span className="gen-timer-spin" /> 正在生成… <b>{genSeconds.toFixed(1)}s</b>
                </div>
              )}
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
                    />
                  );
                });
              })()}
              {busy && !messages.some((m) => m.role === 'assistant' && m.content === '') && (
                <div className="msg assistant"><div className="bubble typing">思考中…</div></div>
              )}
              <div ref={bottomRef} />
            </div>
            <div className="inputbar">
              <label className="edit-check" title="显示原始文本（含 <think>/<UpdateVariable> 等标记）">
                <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
                显示原文
              </label>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={sessionId ? '输入你的行动或对话…' : '请先选择角色卡'}
                rows={2}
              />
              <button onClick={send} disabled={!sessionId || busy}>发送</button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
