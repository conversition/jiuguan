import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { authFetch } from './authClient.ts';
import {
  MemoryPanelSync, type MemoryPanelData, type MemoryPanelPhase,
} from './compat/memoryPanelSync.ts';
import { subscribePanelEvents } from './compat/panelProjection.ts';

interface SearchHit { code: string; category: string; source: string; score: number; confidence: string; content: string }
interface StateRow { entity_type: string; entity_id: string; state_json: string; updated_round: number }
interface ArcRow { code: string; chapter: string; title: string; summary: string; status: string }
interface ScanEntry { comment: string; matchType: string; content: string; constant: boolean }
interface TurnState { bars: Record<string, number>; event_type: string; nsfw_lock: { locked: boolean; round: number }; round: number }
interface VarDecl { name: string; type: string; expr: string }
interface TopFact { value: unknown; status: string; factKind: string; sceneId?: string }
interface RelationshipRow { relationshipId: string; fromCharacterId: string; toCharacterId: string; type: string; perspective: string; status: string; derived?: boolean }
interface CharacterProjection {
  characterId: string; entityVersion: number;
  head: { snapshotId: string; headRevision: number; asOfMessageId?: string };
  scope: { sessionId: string; stateInstanceId: string; historyEpoch: number };
  identity: { name: string; aliases: string[] };
  profile: Record<string, TopFact>; facts: Record<string, TopFact>;
  relationships: RelationshipRow[];
  history: { field: string; value: unknown; factKind: string; status: string; reason: string }[];
  unresolved: string[];
}
/** AM-07 人物临时层：已出现、未到促升阈值的候选（**尚无任何权威事实**） */
interface PoolEntry {
  mentionKey: string;
  entityType: string;
  displayName?: string;
  nameCandidates: string[];
  rounds: number[];
  pending: { field: string; round?: number; messageId?: number; value: unknown }[];
  firstRound?: number;
  lastRound?: number;
  promotedCharacterId?: string;
}

const CAT_LABEL: Record<string, string> = { arc: '大纲', summary: '总结', event: '事件', state: '状态', lore: '世界书' };
const EVENT_LABEL: Record<string, string> = { normal: '普通', fused: '多事件融合', shadow: '暗线转移', nsfw: 'NSFW 锁定' };
const PHASE_LABEL: Record<MemoryPanelPhase, string> = {
  idle: '未就绪（等待会话）', loading: '加载中…', ready: '已就绪', empty: '已就绪（本会话无记忆数据）',
  error: '读取失败', pending: '已就绪（含待核对项）',
};

/** 只读 JSON 取回（统一判 res.ok；非 2xx 抛错，**不**把错误体洗成空数组冒充"没数据"） */
const getJson = async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
  const res = await authFetch(path, { signal });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
};

/** 单一只读加载入口：首开 / 再次打开 / 手动刷新 / 提交后同步全部走它 */
const loadMemoryPanelData = async (sessionId: string, signal?: AbortSignal): Promise<MemoryPanelData> => {
  const base = `/api/session/${sessionId}`;
  const [states, arcs, meta, turnState, variables, chars] = await Promise.all([
    getJson<{ states?: StateRow[]; headVersion?: number }>(`${base}/memory-state`, signal),
    getJson<{ arcs?: ArcRow[]; headVersion?: number }>(`${base}/memory-arc`, signal),
    getJson<{ meta?: unknown; headVersion?: number }>(`${base}/memory-meta`, signal),
    getJson<{ state?: unknown; headVersion?: number }>(`${base}/turn-state`, signal),
    getJson<{ decls?: VarDecl[]; values?: Record<string, string | number | boolean>; layers?: string[][]; headVersion?: number }>(`${base}/variables`, signal),
    getJson<{
      characters?: CharacterProjection[]; pending?: string[];
      pool?: { threshold?: number; entries?: PoolEntry[] }; headVersion?: number;
    }>(`${base}/characters`, signal),
  ]);
  const headVersion = Math.max(
    states.headVersion ?? 0, arcs.headVersion ?? 0, meta.headVersion ?? 0,
    turnState.headVersion ?? 0, variables.headVersion ?? 0, chars.headVersion ?? 0,
  );
  return {
    states: states.states ?? [],
    arcs: arcs.arcs ?? [],
    meta: meta.meta ?? null,
    turnState: turnState.state ?? null,
    variables: { decls: variables.decls ?? [], values: variables.values ?? {}, layers: variables.layers ?? [] },
    characters: chars.characters ?? [],
    headVersion,
    pending: chars.pending ?? [],
    // 后端没给（旧版本服务端）就当空池，**不伪造**阈值
    pool: { threshold: chars.pool?.threshold ?? 0, entries: chars.pool?.entries ?? [] },
  };
};

/**
 * 记忆控制台。
 *
 * AM-05：数据不再挂在"刷新按钮"上。
 *  · 面板真实可见 **且** 会话就绪 → 自动读取（`setVisibility`）；
 *  · 关闭 → 取消面板自己的在途读取 + 退订；
 *  · 再次打开 → 主动核对版本（不只等未来事件）；
 *  · 真实记忆/状态提交 → 由宿主事件触发同作用域重读，旧响应按 headVersion 拒绝；
 *  · 手动刷新保留为**人工重试**，不是正常工作前提。
 *  全部只读：不调模型、不写记忆、不重建向量（无 setTimeout / reload / srcdoc / 强制重挂载）。
 */
export function MemoryConsole({ sessionId, sessionReady = true, visible = true }: {
  sessionId: string | null;
  /** 会话是否就绪（宿主注入；缺省视为就绪，兼容旧调用方） */
  sessionReady?: boolean;
  /** 面板是否真实可见（缺省视为可见；App 用 tab 条件渲染时由挂载本身表达可见） */
  visible?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [scanEntries, setScanEntries] = useState<ScanEntry[] | null>(null);
  const [scanStats, setScanStats] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [layerStats, setLayerStats] = useState<Record<string, number> | null>(null);

  // 会话运行实例：用于过滤"已失效运行实例"的事件（不参与权威写入）
  const runIdRef = useRef<string>('');
  const sync = useMemo(
    () => new MemoryPanelSync({
      load: (sid, signal) => loadMemoryPanelData(sid, signal),
      panelId: 'memory-console',
    }),
    [],
  );
  const state = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);

  // 可见性/就绪 → 自动读取（挂载即打开；卸载即关闭）
  useEffect(() => {
    void sync.setVisibility({ visible, sessionReady, sessionRunId: runIdRef.current }, sessionId);
    return () => { sync.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionReady, visible]);

  // 真实提交事件 → 同作用域重读（重复/旧通知不重复读取，更不写记忆）
  useEffect(() => subscribePanelEvents((ev) => {
    if (ev.sessionId && ev.sessionId !== sessionId) return;
    sync.onCommitted({ sessionId: ev.sessionId, purpose: ev.purpose });
  }), [sessionId, sync]);

  const data = state.data;
  const meta = data?.meta as { plot_round: number; bars: string; stage: string } | null | undefined;
  const turnState = data?.turnState as TurnState | null | undefined;
  const vars = data?.variables as { decls: VarDecl[]; values: Record<string, string | number | boolean>; layers: string[][] } | undefined;
  const characters = (data?.characters ?? []) as CharacterProjection[];
  const poolEntries = (data?.pool?.entries ?? []) as PoolEntry[];
  const poolThreshold = data?.pool?.threshold ?? 0;
  /** 促升未到阈值的行（已促升的行留在池里只为对账，不再算"排队中"） */
  const queued = poolEntries.filter((p) => !p.promotedCharacterId);
  const promoted = poolEntries.filter((p) => p.promotedCharacterId);
  const states = (data?.states ?? []) as StateRow[];
  const arcs = (data?.arcs ?? []) as ArcRow[];
  const loaded = state.phase === 'ready' || state.phase === 'empty' || state.phase === 'pending';

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q || !sessionId) return;
    setBusy(true); setActionError('');
    try {
      const res = await authFetch(`/api/session/${sessionId}/memory-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const d = await res.json() as { hits?: SearchHit[]; layerStats?: Record<string, number>; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setHits(d.hits ?? []);
      setLayerStats(d.layerStats ?? null);
    } catch (e) { setActionError((e as Error).message); }
    setBusy(false);
  }, [query, sessionId]);

  const scanLorebook = useCallback(async () => {
    const text = scanInput.trim();
    if (!text || !sessionId) return;
    setBusy(true); setActionError('');
    try {
      const res = await authFetch(`/api/session/${sessionId}/lorebook-scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text }),
      });
      const d = await res.json() as { activated?: ScanEntry[]; stats?: Record<string, number>; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setScanEntries(d.activated ?? []);
      setScanStats(d.stats ?? null);
    } catch (e) { setActionError((e as Error).message); }
    setBusy(false);
  }, [scanInput, sessionId]);

  if (!sessionId) {
    return <div className="console-empty">先创建/恢复会话，再查看记忆</div>;
  }

  const diag = sync.diagnostics();

  return (
    <div className="console">
      <div className="console-bar">
        <button onClick={() => void sync.refreshManually()} disabled={busy || state.phase === 'loading'}>刷新状态表</button>
        <span className="console-meta">
          状态 {PHASE_LABEL[state.phase]} · 头版本 {state.headVersion}
          {state.phase === 'pending' ? ` · 待核对 ${data?.pending.length ?? 0}` : ''}
          {queued.length > 0 ? ` · 排队中 ${queued.length}` : ''}
          {diag.subscribed ? ' · 已订阅' : ' · 未订阅'}
        </span>
        {meta && (
          <span className="console-meta">
            轮次 {meta.plot_round} · {meta.stage} · 推进槽 {meta.bars}
          </span>
        )}
      </div>

      {state.phase === 'error' && (
        <p className="error">读取失败：{state.error}（点「刷新状态表」重试；显示的是上次成功数据）</p>
      )}
      {state.phase === 'loading' && <p className="console-none">加载中…（首次读取或版本核对）</p>}
      {state.phase === 'pending' && data && data.pending.length > 0 && (
        <p className="console-none">待核对（不冒充已确认）：{data.pending.slice(0, 6).join(', ')}{data.pending.length > 6 ? ` …共 ${data.pending.length}` : ''}</p>
      )}
      {state.phase === 'empty' && <p className="console-none">（本会话暂无记忆数据）</p>}

      <section className="console-section">
        <h3>人物投影（稳定 ID / 当前事实 / 关系）</h3>
        {!loaded && <p className="console-none">面板打开后自动读取（无需手动刷新）</p>}
        {loaded && characters.length === 0 && <p className="console-none">（本会话还没有已准入的人物事实）</p>}
        {characters.length > 0 && (
          <table className="console-table">
            <thead><tr><th>ID</th><th>人物</th><th>版本</th><th>当前事实</th><th>关系</th></tr></thead>
            <tbody>
              {characters.map((c) => (
                <tr key={c.characterId}>
                  <td>{c.characterId}</td>
                  <td>{c.identity.name}{c.identity.aliases.length > 0 ? `（${c.identity.aliases.join('/')}）` : ''}</td>
                  <td>v{c.entityVersion}<br /><span className="cell-state">rev{c.head.headRevision} · epoch {c.scope.historyEpoch}</span></td>
                  <td className="cell-state">
                    {Object.entries(c.facts).map(([f, v]) => (
                      <div key={f}>{f}={String(typeof v.value === 'object' ? JSON.stringify(v.value) : v.value)} <em>[{v.status}/{v.factKind}]</em></div>
                    ))}
                    {Object.keys(c.facts).length === 0 && '（无当前字段）'}
                    {c.history.length > 0 && (
                      <div className="cell-state">历史(不冒充当前)：{c.history.slice(-2).map((h) => `${h.field}=${String(h.value)}(${h.factKind})`).join('; ')}</div>
                    )}
                  </td>
                  <td className="cell-state">
                    {c.relationships.map((r) => (
                      <div key={r.relationshipId}>
                        {r.fromCharacterId}→{r.toCharacterId}:{r.type}({r.perspective}/{r.status}{r.derived ? '/派生' : ''})
                      </div>
                    ))}
                    {c.relationships.length === 0 && '（无）'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="console-section">
        <h3>人物录入状态（临时层：已出现但未达促升阈值）</h3>
        <p className="console-none">
          判据是<b>持续性</b>而非名字形态：同一实体在 ≥{poolThreshold || 'N'} 个<b>不同轮次</b>出现且带可读名才建人。
          这里的人<b>尚无任何权威事实</b>，也不进 prompt（每轮 0 token）。
        </p>
        {!loaded && <p className="console-none">面板打开后自动读取（无需手动刷新）</p>}
        {loaded && poolEntries.length === 0 && (
          <p className="console-none">（临时层为空：没有"已出现但未到阈值"的新人物，也没有刚促升待对账的行）</p>
        )}
        {poolEntries.length > 0 && (
          <table className="console-table">
            <thead>
              <tr><th>名字</th><th>类型</th><th>已累计轮次</th><th>首/末轮</th><th>待转字段</th><th>状态</th></tr>
            </thead>
            <tbody>
              {poolEntries.map((p) => {
                const hits = p.rounds.length;
                const short = Math.max(0, poolThreshold - hits);
                return (
                  <tr key={p.mentionKey}>
                    <td>
                      {p.displayName ?? p.mentionKey}
                      {p.displayName && p.displayName !== p.mentionKey && (
                        <span className="cell-state"><br />键={p.mentionKey}</span>
                      )}
                    </td>
                    <td>{p.entityType}</td>
                    <td>
                      <b>{hits}/{poolThreshold || '?'}</b>
                      {p.rounds.length > 0 && (
                        <span className="cell-state"><br />轮 {p.rounds.join(', ')}</span>
                      )}
                    </td>
                    <td className="cell-state">
                      {p.firstRound ?? '—'} – {p.lastRound ?? '—'}
                    </td>
                    <td className="cell-state">
                      {p.pending.map((f) => (
                        <div key={f.field}>
                          {f.field}={String(typeof f.value === 'object' ? JSON.stringify(f.value) : f.value)}
                          {f.round !== undefined ? ` (轮${f.round})` : ''}
                        </div>
                      ))}
                      {p.pending.length === 0 && '（无）'}
                    </td>
                    <td className="cell-state">
                      {p.promotedCharacterId
                        ? `已促升 → ${p.promotedCharacterId}`
                        : `排队中${short > 0 ? `（再出现 ${short} 个轮次促升）` : '（待促升：无可用读出名）'}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {loaded && promoted.length > 0 && (
          <p className="console-none">
            本会话已由临时层促升 {promoted.length} 人：
            {promoted.map((p) => `${p.displayName ?? p.mentionKey}→${p.promotedCharacterId}`).join('、')}
          </p>
        )}
      </section>

      <section className="console-section">
        <h3>双通道检索测试（BM25 ∥ vec ∥ RRF）</h3>
        <div className="console-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder="输入查询，如：偷窥 / 催眠 / AM01" />
          <button onClick={() => void search()} disabled={busy}>检索</button>
        </div>
        {layerStats && (
          <div className="console-stats">
            {Object.entries(layerStats).map(([k, v]) => (<span key={k} className="stat">{k}: {v}</span>))}
          </div>
        )}
        {hits && hits.length === 0 && <p className="console-none">（无高置信命中）</p>}
        {hits && hits.length > 0 && (
          <ul className="console-hits">
            {hits.map((h, i) => (
              <li key={i} className={`hit ${h.confidence === 'low' ? 'hit-low' : ''}`}>
                <span className="hit-tag">[{h.code || 'ROW'}|{CAT_LABEL[h.category] ?? h.category}|{h.score}|{h.source}]</span>
                {h.confidence === 'low' && <span className="hit-warn"> [存疑]</span>}
                <span className="hit-content">{h.content}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="console-section">
        <h3>回合状态（推进槽 / 事件 / NSFW 锁定）</h3>
        {turnState && (
          <div className="turn-state">
            <div className="bars">
              {Object.entries(turnState.bars).map(([k, v]) => (
                <div key={k} className="bar-row">
                  <span className="bar-label">{k}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, v)}%` }} /></div>
                  <span className="bar-val">{v}/100</span>
                </div>
              ))}
            </div>
            <div className="state-tags">
              <span className="tag">事件: {EVENT_LABEL[turnState.event_type] ?? turnState.event_type}</span>
              <span className={`tag ${turnState.nsfw_lock.locked ? 'tag-locked' : ''}`}>
                NSFW 锁定: {turnState.nsfw_lock.locked ? `是（轮 ${turnState.nsfw_lock.round}）` : '否'}
              </span>
              <span className="tag">轮次: {turnState.round}</span>
            </div>
          </div>
        )}
        {loaded && !turnState && <p className="console-none">（本会话无回合状态）</p>}
        {!loaded && <p className="console-none">面板打开后自动读取</p>}
      </section>

      <section className="console-section">
        <h3>世界书激活调试（关键词/概率扫描）</h3>
        <div className="console-search">
          <input value={scanInput} onChange={(e) => setScanInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void scanLorebook()} placeholder="输入剧情文本，测试哪些世界书条目会被激活" />
          <button onClick={() => void scanLorebook()} disabled={busy}>扫描</button>
        </div>
        {scanStats && (
          <div className="console-stats">
            {Object.entries(scanStats).map(([k, v]) => (<span key={k} className="stat">{k}: {v}</span>))}
          </div>
        )}
        {scanEntries && scanEntries.length === 0 && <p className="console-none">（无激活条目）</p>}
        {scanEntries && scanEntries.length > 0 && (
          <ul className="console-hits">
            {scanEntries.map((e, i) => (
              <li key={i} className="hit">
                <span className="hit-tag">[{e.matchType}{e.constant ? '|恒定' : ''}]</span>
                <span className="hit-content">{e.comment}: {e.content}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="console-section">
        <h3>变量（VMS：三源注册表 + 依赖分层）</h3>
        {loaded && (!vars || vars.decls.length === 0) && <p className="console-none">（无注册变量）</p>}
        {vars && vars.decls.length > 0 && (
          <>
            {vars.layers.length > 0 && (
              <div className="var-layers">
                {vars.layers.map((layer, i) => (
                  <div key={i} className="var-layer">
                    <span className="var-layer-label">L{i}</span>
                    {layer.map((n) => {
                      const short = n.split(':').pop() ?? n;
                      const val = vars.values?.[n];
                      return (
                        <span key={n} className="var-chip" title={n}>
                          {short}={typeof val === 'string' && val.length > 12 ? `${val.slice(0, 12)}…` : String(val ?? '')}
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            <table className="console-table">
              <thead><tr><th>变量</th><th>类型</th><th>表达式/值</th><th>求值</th></tr></thead>
              <tbody>
                {vars.decls.slice(0, 30).map((d, i) => (
                  <tr key={i}>
                    <td>{d.name}</td>
                    <td>{d.type}</td>
                    <td className="cell-state">{d.expr.slice(0, 30)}</td>
                    <td className="cell-state">{String(vars.values?.[d.name] ?? '').slice(0, 20)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {vars.decls.length > 30 && <p className="console-none">…共 {vars.decls.length} 个（显示前 30）</p>}
          </>
        )}
      </section>

      <section className="console-section">
        <h3>状态表（表0-5）</h3>
        {loaded && states.length === 0 && <p className="console-none">（空）</p>}
        {!loaded && <p className="console-none">面板打开后自动读取</p>}
        {states.length > 0 && (
          <table className="console-table">
            <thead><tr><th>类型</th><th>实体</th><th>状态</th><th>轮</th></tr></thead>
            <tbody>
              {states.map((s, i) => (
                <tr key={i}>
                  <td>{s.entity_type}</td>
                  <td>{s.entity_id}</td>
                  <td className="cell-state">{s.state_json.slice(0, 60)}</td>
                  <td>{s.updated_round}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="console-section">
        <h3>大纲表（AM 码）</h3>
        {loaded && arcs.length === 0 && <p className="console-none">（空）</p>}
        {arcs.length > 0 && (
          <ul className="console-arcs">
            {arcs.map((a, i) => (
              <li key={i} className="arc">
                <span className="arc-code">{a.code}</span>
                <span className="arc-status">{a.status}</span>
                <span className="arc-summary">{a.summary.slice(0, 50)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(actionError || state.error) && <p className="error">{actionError || state.error}</p>}
      <p className="console-none">
        只读面板诊断：读取 {diag.reads} 次 · 版本核对 {diag.versionChecks} 次 · 缓冲更新 {diag.bufferedUpdates} 次 ·
        拒绝旧响应 {diag.rejectedStale} 次 · 模型调用 {diag.modelCalls} 次 · 记忆写入 {diag.memoryWrites} 次
      </p>
    </div>
  );
}
