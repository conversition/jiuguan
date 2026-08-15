import React, { useState, useEffect, useRef } from 'react';
import { MemoryConsole } from './MemoryConsole.tsx';
import { ProviderPanel } from './ProviderPanel.tsx';
import { AssetsPanel } from './AssetsPanel.tsx';
import { PluginsPanel } from './PluginsPanel.tsx';
import { SessionSetup } from './SessionSetup.tsx';
import { EditorPanel } from './EditorPanel.tsx';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import { applyRegexRules } from '../../../packages/core/src/regex.ts';
import type { RegexRule } from '../../../packages/core/src/regex.ts';

interface Card { id: string; name: string }
interface SessionInfo { id: string; name: string }
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

/** SSE 流式请求：POST + 读 event stream，回调各事件 */
const apiStream = async (
  path: string,
  body: Record<string, unknown>,
  onEvent: (ev: Record<string, unknown>) => void,
): Promise<void> => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
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

const STAGE_LABEL: Record<string, string> = {
  card: '加载角色卡…',
  worldbook: '加载世界书…',
  vectorize: '向量化记忆（约 8 秒）…',
  engine: '接入 MVU 引擎…',
  ready: '就绪',
};

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [initStage, setInitStage] = useState('');
  const [contentMode, setContentMode] = useState<'nsfw' | 'nsf'>('nsfw');
  const [tab, setTab] = useState<'setup' | 'chat' | 'memory' | 'provider' | 'assets' | 'editor' | 'plugins'>('setup');
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

  // 主题应用到 <html data-theme>，字号写到 --read-fs 变量
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('jg-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.style.setProperty('--read-fs', `${readFs}px`);
    localStorage.setItem('jg-read-fs', String(readFs));
  }, [readFs]);

  /** 拉取推进槽（会话创建/恢复/每轮结束后刷新） */
  const fetchTurnState = async (sid: string) => {
    try {
      const d = await api<{ state: TurnState }>(`/api/session/${sid}/turn-state`);
      setTurnState(d.state ?? null);
    } catch { /* 侧栏状态拉取失败不影响使用 */ }
  };

  useEffect(() => {
    api<{ cards: Card[] }>('/api/cards').then((d) => setCards(d.cards)).catch((e) => setError(e.message));
    api<{ sessions: SessionInfo[] }>('/api/sessions').then((d) => setSessions(d.sessions)).catch(() => {});
    api<{ rules: RegexRule[] }>('/api/regex-rules').then((d) => setRegexRules(d.rules ?? [])).catch(() => {});
  }, []);

  /** 显示层清洗：应用 display 范围正则（显示原文开关关闭时） */
  const cleanDisplay = (text: string): string => {
    if (showRaw || !regexRules) return text;
    return applyRegexRules(text, regexRules, 'display').text;
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, initStage]);

  /** 会话创建完成回调（SessionSetup 面板 → 进入对话） */
  const onSessionCreated = (sid: string, greeting: string, cardName: string, mode: string) => {
    setSessionId(sid);
    setContentMode(mode === 'nsf' ? 'nsf' : 'nsfw');
    setMessages([{ id: nextMsgId(), round: 0, role: 'assistant', content: `${greeting}\n\n（角色卡：${cardName} · ${mode}）` }]);
    setSessions((s) => [{ id: sid, name: cardName || sid }, ...s]);
    setTab('chat');
    fetchTurnState(sid);
  };

  const resumeSession = async (sid: string) => {
    setBusy(true);
    setError('');
    try {
      await api('/api/session/resume', { method: 'POST', body: JSON.stringify({ db: `${sid}.db` }) });
      setSessionId(sid);
      const h = await api<{ messages: { id: number; round: number; role: string; content: string }[] }>(`/api/session/${sid}/history`);
      setMessages(h.messages.map((m) => ({ ...m, id: m.id ?? nextMsgId() })));
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
    setMessages((m) => [...m, { id: nextMsgId(), round: 0, role: 'user', content: text }]);
    const replyId = nextMsgId();
    setMessages((m) => [...m, { id: replyId, round: 0, role: 'assistant', content: '' }]);
    try {
      await apiStream('/api/turn', { session: sessionId, input: text, content_mode: contentMode }, (ev) => {
        if (ev.type === 'delta' && typeof ev.text === 'string') {
          setMessages((m) => m.map((x) => (x.id === replyId ? { ...x, content: x.content + ev.text } : x)));
        }
        if (ev.type === 'error') setError(String(ev.message ?? '回合失败'));
      });
      // 回合结束 → 刷新推进槽（侧栏常驻）
      fetchTurnState(sessionId);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
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
            <li key={s.id}>
              <button onClick={() => resumeSession(s.id)} disabled={busy}>↻ {s.name}</button>
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
          <button className={tab === 'plugins' ? 'tab-active' : ''} onClick={() => setTab('plugins')}>插件</button>
        </div>
        {error && <p className="error">{error}</p>}
      </aside>
      <main className="chat">
        {tab === 'setup' ? (
          <SessionSetup onCreated={onSessionCreated} />
        ) : tab === 'memory' ? (
          <MemoryConsole sessionId={sessionId} />
        ) : tab === 'provider' ? (
          <ProviderPanel />
        ) : tab === 'assets' ? (
          <AssetsPanel sessionId={sessionId} />
        ) : tab === 'editor' ? (
          <EditorPanel />
        ) : tab === 'plugins' ? (
          <PluginsPanel />
        ) : (
          <>
            <div className="messages">
              {messages.length === 0 && !busy && (
                <div className="empty">从左侧选择一张角色卡开始对话（首次需加载世界书 + 向量化，约 10 秒）</div>
              )}
              {messages.map((m, i) => {
                const streaming = busy && i === messages.length - 1 && m.role === 'assistant' && m.content.length > 0;
                return (
                  <div key={m.id} className={`msg ${m.role}`}>
                    {m.role === 'assistant' ? (
                      <div className={`bubble read${streaming ? ' streaming' : ''}`}>
                        <MarkdownMessage text={cleanDisplay(m.content)} />
                      </div>
                    ) : (
                      <div className="bubble">{cleanDisplay(m.content)}</div>
                    )}
                  </div>
                );
              })}
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
