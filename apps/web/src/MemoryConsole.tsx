import React, { useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface SearchHit { code: string; category: string; source: string; score: number; confidence: string; content: string }
interface StateRow { entity_type: string; entity_id: string; state_json: string; updated_round: number }
interface ArcRow { code: string; chapter: string; title: string; summary: string; status: string }
interface ScanEntry { comment: string; matchType: string; content: string; constant: boolean }
interface TurnState { bars: Record<string, number>; event_type: string; nsfw_lock: { locked: boolean; round: number }; round: number }
interface VarDecl { name: string; type: string; expr: string }

const CAT_LABEL: Record<string, string> = { arc: '大纲', summary: '总结', event: '事件', state: '状态', lore: '世界书' };
const EVENT_LABEL: Record<string, string> = { normal: '普通', fused: '多事件融合', shadow: '暗线转移', nsfw: 'NSFW 锁定' };

export function MemoryConsole({ sessionId }: { sessionId: string | null }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [states, setStates] = useState<StateRow[] | null>(null);
  const [arcs, setArcs] = useState<ArcRow[] | null>(null);
  const [meta, setMeta] = useState<{ plot_round: number; bars: string; stage: string } | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [scanEntries, setScanEntries] = useState<ScanEntry[] | null>(null);
  const [scanStats, setScanStats] = useState<Record<string, number> | null>(null);
  const [turnState, setTurnState] = useState<TurnState | null>(null);
  const [varDecls, setVarDecls] = useState<VarDecl[] | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string | number | boolean> | null>(null);
  const [varLayers, setVarLayers] = useState<string[][] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!sessionId) {
    return <div className="console-empty">先创建/恢复会话，再查看记忆</div>;
  }

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/session/${sessionId}/memory-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setHits(d.hits);
      setStats(d.layerStats);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const loadTables = async () => {
    setBusy(true);
    setError('');
    try {
      const [s, a, m, t, v] = await Promise.all([
        fetch(`${API}/api/session/${sessionId}/memory-state`).then((r) => r.json()),
        fetch(`${API}/api/session/${sessionId}/memory-arc`).then((r) => r.json()),
        fetch(`${API}/api/session/${sessionId}/memory-meta`).then((r) => r.json()),
        fetch(`${API}/api/session/${sessionId}/turn-state`).then((r) => r.json()),
        fetch(`${API}/api/session/${sessionId}/variables`).then((r) => r.json()),
      ]);
      setStates(s.states ?? []);
      setArcs(a.arcs ?? []);
      setMeta(m.meta ?? null);
      setTurnState(t.state ?? null);
      setVarDecls(v.decls ?? []);
      setVarValues(v.values ?? {});
      setVarLayers(v.layers ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const scanLorebook = async () => {
    const text = scanInput.trim();
    if (!text) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/session/${sessionId}/lorebook-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setScanEntries(d.activated ?? []);
      setScanStats(d.stats ?? null);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="console">
      <div className="console-bar">
        <button onClick={loadTables} disabled={busy}>刷新状态表</button>
        {meta && (
          <span className="console-meta">
            轮次 {meta.plot_round} · {meta.stage} · 推进槽 {meta.bars}
          </span>
        )}
      </div>

      <section className="console-section">
        <h3>双通道检索测试（BM25 ∥ vec ∥ RRF）</h3>
        <div className="console-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="输入查询，如：偷窥 / 催眠 / AM01" />
          <button onClick={search} disabled={busy}>检索</button>
        </div>
        {stats && (
          <div className="console-stats">
            {Object.entries(stats).map(([k, v]) => (
              <span key={k} className="stat">{k}: {v}</span>
            ))}
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
        {!turnState && <p className="console-none">点「刷新状态表」加载</p>}
      </section>

      <section className="console-section">
        <h3>世界书激活调试（关键词/概率扫描）</h3>
        <div className="console-search">
          <input value={scanInput} onChange={(e) => setScanInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && scanLorebook()} placeholder="输入剧情文本，测试哪些世界书条目会被激活" />
          <button onClick={scanLorebook} disabled={busy}>扫描</button>
        </div>
        {scanStats && (
          <div className="console-stats">
            {Object.entries(scanStats).map(([k, v]) => (
              <span key={k} className="stat">{k}: {v}</span>
            ))}
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
        {varDecls === null && <p className="console-none">点「刷新状态表」加载</p>}
        {varDecls && varDecls.length === 0 && <p className="console-none">（无注册变量）</p>}
        {varDecls && varDecls.length > 0 && (
          <>
            {varLayers && varLayers.length > 0 && (
              <div className="var-layers">
                {varLayers.map((layer, i) => (
                  <div key={i} className="var-layer">
                    <span className="var-layer-label">L{i}</span>
                    {layer.map((n) => {
                      const short = n.split(':').pop() ?? n;
                      const val = varValues?.[n];
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
                {varDecls.slice(0, 30).map((d, i) => (
                  <tr key={i}>
                    <td>{d.name}</td>
                    <td>{d.type}</td>
                    <td className="cell-state">{d.expr.slice(0, 30)}</td>
                    <td className="cell-state">{String(varValues?.[d.name] ?? '').slice(0, 20)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {varDecls.length > 30 && <p className="console-none">…共 {varDecls.length} 个（显示前 30）</p>}
          </>
        )}
      </section>

      <section className="console-section">
        <h3>状态表（表0-5）</h3>
        {states === null && <p className="console-none">点「刷新状态表」加载</p>}
        {states && states.length === 0 && <p className="console-none">（空）</p>}
        {states && states.length > 0 && (
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
        {arcs === null && <p className="console-none">点「刷新状态表」加载</p>}
        {arcs && arcs.length === 0 && <p className="console-none">（空）</p>}
        {arcs && arcs.length > 0 && (
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

      {error && <p className="error">{error}</p>}
    </div>
  );
}
