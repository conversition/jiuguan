import React, { useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

const api = async <T,>(path: string, opts?: RequestInit): Promise<T> => {
  const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
  return d as T;
};

interface PanelBrief {
  panel: number; time: string; shot_size: string; angle: string;
  transition_hint: string; positive_prompt_short: string;
}
interface ValidationIssue { stage: string; errors: string[]; warnings: string[] }
interface RunResult {
  passed: boolean; voice: string; intention: string;
  panels: PanelBrief[];
  sequence: { master_prompt: string; narrative: string; consistency: string; sfx: string } | null;
  humanized: string;
  validation: ValidationIssue[];
  errors: string[];
  warnings: string[];
}

interface StageEvent { label: string; detail: string }

/** 导演分镜面板（第三个创作选项：读本→逐镜→串联→人类化，SSE 阶段进度） */
export function StoryboardPanel() {
  const [scene, setScene] = useState('');
  const [shots, setShots] = useState(3);
  const [mode, setMode] = useState<'batch' | 'shot'>('batch');
  const [voice, setVoice] = useState('');
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [workflow, setWorkflow] = useState('');
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<StageEvent[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState('');

  React.useEffect(() => {
    api<{ workflows: string[]; defaultWorkflow: string; voices: string[] }>('/api/storyboard/workflows')
      .then((d) => { setWorkflows(d.workflows ?? []); setVoices(d.voices ?? []); setWorkflow(d.defaultWorkflow ?? ''); })
      .catch((e) => setError((e as Error).message));
  }, []);

  const run = async () => {
    if (!scene.trim() || busy) return;
    setBusy(true); setError(''); setResult(null); setStages([]);
    try {
      const res = await fetch(`${API}/api/storyboard/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ scene: scene.trim(), shots, mode, voice: voice || undefined, workflow: workflow || undefined }),
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
            const ev = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;
            if (ev.type === 'stage') setStages((s) => [...s, { label: String(ev.label ?? ''), detail: String(ev.detail ?? '') }]);
            if (ev.type === 'done') setResult(ev as unknown as RunResult);
            if (ev.type === 'error') setError(String(ev.message ?? '分镜执行失败'));
          } catch { /* 忽略坏块 */ }
        }
      }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <>
      <p className="hint">导演分镜（Commit B）：导演读本 → 逐镜分镜 → 串联序列 → 人类化改写，五级校验内联，结果落库。</p>

      <section className="console-section">
        <h3>场景输入</h3>
        <textarea
          className="console-textarea"
          value={scene}
          onChange={(e) => setScene(e.target.value)}
          placeholder="描述要分镜的场景，如：深夜雨后铁桥，两人相拥坠落…"
          rows={4}
        />
        <div className="console-bar">
          <label className="edit-check">镜数
            <input type="number" min={1} max={30} value={shots} onChange={(e) => setShots(Number(e.target.value))} style={{ width: 64 }} />
          </label>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'batch' | 'shot')}>
            <option value="batch">批量（多镜/次）</option>
            <option value="shot">单镜接力</option>
          </select>
          <select value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="">导演之声（自动选择）</option>
            {voices.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
          <button onClick={run} disabled={busy || !scene.trim()}>{busy ? '执行中…' : '开始分镜'}</button>
        </div>
      </section>

      {stages.length > 0 && (
        <section className="console-section">
          <h3>进度</h3>
          <div className="var-layers">
            {stages.map((s, i) => (
              <div key={i} className="var-layer">
                <span className="tag tag-locked">▶ {s.label}</span>
                {s.detail && <span className="muted">{s.detail}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {result && (
        <section className="console-section">
          <h3>结果 <span className={`tag ${result.passed ? 'tag-locked' : ''}`}>{result.passed ? '✅ VP PASS' : '❌ VP FAIL'}</span>
            <span className="console-meta"> · {result.panels.length} 镜 · errors {result.errors.length} / warnings {result.warnings.length}</span>
          </h3>
          {result.voice && <p className="ok">导演之声：{result.voice} ｜ 意图：{result.intention}</p>}
          {result.panels.length > 0 && (
            <table className="table">
              <thead><tr><th>镜</th><th>时间</th><th>景别</th><th>角度</th><th>转场</th><th>凝固帧（简）</th></tr></thead>
              <tbody>
                {result.panels.map((p) => (
                  <tr key={p.panel}>
                    <td>{p.panel}</td><td>{p.time}</td><td>{p.shot_size}</td><td>{p.angle}</td>
                    <td className="muted">{p.transition_hint}</td>
                    <td className="muted">{p.positive_prompt_short?.slice(0, 90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.sequence && (
            <>
              <h3>串联序列</h3>
              <p className="muted"><b>Master:</b> {result.sequence.master_prompt}</p>
              <p className="muted"><b>叙事:</b> {result.sequence.narrative}</p>
              <p className="muted"><b>一致性:</b> {result.sequence.consistency}</p>
              <p className="muted"><b>音效:</b> {result.sequence.sfx}</p>
            </>
          )}
          {result.humanized && <p className="muted"><b>人类化改写:</b> {result.humanized}</p>}
          {result.errors.length > 0 && result.errors.map((e, i) => <p key={i} className="error">✕ {e}</p>)}
          {result.warnings.length > 0 && result.warnings.slice(0, 6).map((w, i) => <p key={i} className="hint">⚠ {w}</p>)}
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
