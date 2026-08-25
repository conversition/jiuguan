import React, { useEffect, useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface EntryStat { id: number; label: string; appeared: number; negative: number; rate: number; miss: number; missNegative: number }
interface Suggestion { dimension: string; risk: string; target: string; action: string; sample: number; confidence: string }
interface ReportItem {
  sessionId: string; rounds: number; negativeRounds: number; retryRate: number;
  entries: EntryStat[]; suggestions: Suggestion[];
}
interface AdaptiveConfig {
  retrieval?: { boostIds?: number[]; dropThreshold?: number; weights?: Record<string, number> };
  archive?: { aliasAdditions?: { alias: string; entityName: string; note?: string }[] };
  summary?: { roundsDelta?: number; longtermTokensDelta?: number; windowTokensDelta?: number };
  replan?: { narrowK?: number; replanK?: number };
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

/** AQL 质量面板：遥测归因弱项榜 + 半自动改进建议（一键应用高风险项 + 重置，全部可回滚） */
export function QualityPanel({ sessionId }: { sessionId: string | null }) {
  const [reports, setReports] = useState<ReportItem[] | null>(null);
  const [config, setConfig] = useState<AdaptiveConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const loadReport = async () => {
    try {
      const d = await fetch(`${API}/api/quality/report`).then((r) => r.json());
      setReports(Array.isArray(d.reports) ? d.reports.filter((r: ReportItem) => r.entries.length || r.suggestions.length || r.rounds > 0) : []);
      setError('');
    } catch (e) { setError((e as Error).message); }
  };
  const loadConfig = async () => {
    try {
      const d = await fetch(`${API}/api/quality/overrides`).then((r) => r.json());
      setConfig(d.config ?? {});
    } catch (e) { setError((e as Error).message); }
  };
  const reloadAll = async () => { setBusy(true); await Promise.all([loadReport(), loadConfig()]); setBusy(false); };
  useEffect(() => { reloadAll(); }, []);

  const applyOne = async (s: Suggestion) => {
    setBusy(true); setMsg(''); setError('');
    try {
      const patch: Record<string, unknown> = {};
      const boost = /^(lore|alias)#(\d+)$/.exec(s.target ?? '');
      if (boost) patch.retrieval = { boostIds: [...(config?.retrieval?.boostIds ?? []), Number(boost[2])] };
      if (s.dimension === 'summary') {
        patch.summary = {
          ...(config?.summary ?? {}),
          roundsDelta: Math.max(-5, (config?.summary?.roundsDelta ?? 0) - 2),
          longtermTokensDelta: (config?.summary?.longtermTokensDelta ?? 0) + 300,
        };
      }
      if (s.dimension === 'budget') {
        patch.summary = { ...(config?.summary ?? {}), windowTokensDelta: (config?.summary?.windowTokensDelta ?? 0) + 1000 };
      }
      if (Object.keys(patch).length === 0) { setMsg('该建议无可自动应用的参数（model 类仅展示，请在 Provider 面板调模型）'); return; }
      const res = await fetch(`${API}/api/quality/overrides`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setConfig(d.config ?? {});
      setMsg('已应用（低风险自动 / 高风险由你确认；可随时重置回滚）');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const resetOverrides = async () => {
    setBusy(true); setMsg(''); setError('');
    try {
      const res = await fetch(`${API}/api/quality/overrides`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setConfig(d.config ?? {});
      setMsg('已重置 → 全部行为回落 env/默认');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="panel">
      <h2>质量（AQL 自适应闭环）</h2>
      {error && <p className="error">{error}</p>}
      {msg && <p className="progress">{msg}</p>}
      <p className="hint">
        「重试/中止/删除」会被采集为隐式反馈，据此归因到 RAG 词条、纪要摘要、窗口、模型并产出建议。
        低风险自动、高风险需你一键应用；全部可回滚。当前会话{sessionId ?? '（未选择）'}。
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button className="op-btn" onClick={reloadAll} disabled={busy}>刷新</button>
        <button className="op-btn" onClick={resetOverrides} disabled={busy}>重置全部覆盖</button>
      </div>

      {config && (
        <details open>
          <summary>当前自适应覆盖（adaptive-config）</summary>
          <pre className="mono" style={{ fontSize: 12, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(config, null, 2)}
          </pre>
        </details>
      )}

      {reports === null ? <p className="progress">加载中…</p> : reports.length === 0 ? (
        <p className="hint">尚无回合遥测数据（需先跑若干轮对话，含重发/中止/删除才有信号）。</p>
      ) : (
        reports.map((rp) => (
          <section key={rp.sessionId} className="panel-block">
            <h3>
              会话 {rp.sessionId.slice(-8)} — {rp.rounds} 轮 / 负反馈 {rp.negativeRounds}（{pct(rp.retryRate)}）
            </h3>

            {rp.entries.filter((e) => e.negative >= 2).length > 0 && (
              <table className="tbl">
                <thead><tr><th>词条</th><th>重试/出现</th><th>率</th><th>miss</th></tr></thead>
                <tbody>
                  {rp.entries.filter((e) => e.negative >= 2).slice(0, 8).map((e) => (
                    <tr key={e.id}>
                      <td>{e.label}</td><td>{e.negative}/{e.appeared}</td>
                      <td>{pct(e.rate)}</td><td>{e.missNegative ? `${e.miss}（负${e.missNegative}）` : e.miss}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {rp.suggestions.length > 0 ? (
              <ul className="sug-list">
                {rp.suggestions.map((s, i) => (
                  <li key={i} className="sug-item">
                    <span className={`sug-badge ${s.risk === 'low' ? 'sug-low' : 'sug-high'}`}>{s.risk === 'low' ? '低风险·可自动' : '高风险·需确认'}</span>
                    <span>{s.action}</span>
                    <span className="hint">（{s.confidence}）</span>
                    {/^(lore|alias)#\d+$/.test(s.target ?? '') && (
                      <button className="op-btn" onClick={() => applyOne(s)} disabled={busy}>应用</button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">该会话暂无建议（样本不足或重试率低）。</p>
            )}
          </section>
        ))
      )}
    </div>
  );
}