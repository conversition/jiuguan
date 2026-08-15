import React, { useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface PresetInfo { id: string; name: string }
interface PresetDetail { name: string; promptCount: number; prompts: { index: number; role: string; name: string; enabled: boolean; contentLen: number; preview: string }[] }
interface LoreEntry { id: number; book: string; comment: string; key: string; useRegex: boolean; probability: number; active: boolean; preview: string }

export function AssetsPanel({ sessionId }: { sessionId: string | null }) {
  const [presets, setPresets] = useState<PresetInfo[] | null>(null);
  const [detail, setDetail] = useState<PresetDetail | null>(null);
  const [enabled, setEnabled] = useState<Record<number, boolean>>({});
  const [regexPattern, setRegexPattern] = useState('');
  const [regexText, setRegexText] = useState('');
  const [regexReplace, setRegexReplace] = useState('');
  const [regexResult, setRegexResult] = useState<{ matches: { index: number; text: string }[]; count: number; replaced?: string } | null>(null);
  const [lore, setLore] = useState<LoreEntry[] | null>(null);
  const [loreFilter, setLoreFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadPresets = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await fetch(`${API}/api/presets`).then((r) => r.json());
      setPresets(d.presets ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const openPreset = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const d = await fetch(`${API}/api/preset/${encodeURIComponent(id)}`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setDetail(d);
      const en: Record<number, boolean> = {};
      d.prompts.forEach((p: PresetDetail['prompts'][number]) => { en[p.index] = p.enabled; });
      setEnabled(en);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const testRegex = async () => {
    if (!regexPattern) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/regex/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ findRegex: regexPattern, text: regexText, replaceString: regexReplace }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setRegexResult(d);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const loadLore = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError('');
    try {
      const d = await fetch(`${API}/api/session/${sessionId}/lorebook-entries`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setLore(d.entries ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const filteredLore = lore?.filter((e) => !loreFilter || `${e.comment} ${e.key} ${e.book}`.includes(loreFilter)) ?? null;

  return (
    <div className="console">
      <section className="console-section">
        <h3>预设浏览器（块装配查看）</h3>
        <div className="console-bar">
          <button onClick={loadPresets} disabled={busy}>加载预设列表</button>
        </div>
        {presets && (
          <ul className="console-hits">
            {presets.map((p, i) => (
              <li key={i} className="hit">
                <button className="link-btn" onClick={() => openPreset(p.id)}>{p.name}</button>
              </li>
            ))}
          </ul>
        )}
        {detail && (
          <div className="preset-detail">
            <p className="console-meta">{detail.name} · {detail.promptCount} 块</p>
            <table className="console-table">
              <thead><tr><th>#</th><th>角色</th><th>名称</th><th>长度</th><th>启用</th><th>预览</th></tr></thead>
              <tbody>
                {detail.prompts.map((p) => (
                  <tr key={p.index}>
                    <td>{p.index}</td>
                    <td>{p.role}</td>
                    <td>{p.name || '-'}</td>
                    <td>{p.contentLen}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={enabled[p.index] ?? false}
                        onChange={(e) => setEnabled((prev) => ({ ...prev, [p.index]: e.target.checked }))}
                      />
                    </td>
                    <td className="cell-state">{p.preview}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="console-section">
        <h3>正则调试器</h3>
        <div className="console-search">
          <input value={regexPattern} onChange={(e) => setRegexPattern(e.target.value)} placeholder="正则，如 /(偷窥|催眠)/g" />
          <input value={regexReplace} onChange={(e) => setRegexReplace(e.target.value)} placeholder="替换串（可选）" />
          <button onClick={testRegex} disabled={busy}>测试</button>
        </div>
        <textarea
          className="console-textarea"
          value={regexText}
          onChange={(e) => setRegexText(e.target.value)}
          placeholder="输入测试文本…"
          rows={4}
        />
        {regexResult && (
          <div className="regex-result">
            <p className="console-meta">命中 {regexResult.count} 处</p>
            {regexResult.count === 0 && <p className="console-none">（无匹配）</p>}
            {regexResult.matches.slice(0, 10).map((m, i) => (
              <div key={i} className="hit"><span className="hit-tag">@{m.index}</span><span className="hit-content">{m.text}</span></div>
            ))}
            {regexResult.replaced !== undefined && (
              <>
                <p className="console-meta">替换结果：</p>
                <pre className="regex-replaced">{regexResult.replaced}</pre>
              </>
            )}
          </div>
        )}
      </section>

      <section className="console-section">
        <h3>世界书条目浏览（会话内）</h3>
        <div className="console-bar">
          <button onClick={loadLore} disabled={busy || !sessionId}>加载条目</button>
          <input className="console-filter" value={loreFilter} onChange={(e) => setLoreFilter(e.target.value)} placeholder="过滤…" />
        </div>
        {filteredLore && (
          <>
            <p className="console-meta">共 {filteredLore.length} 条</p>
            <ul className="console-hits">
              {filteredLore.slice(0, 50).map((e) => (
                <li key={e.id} className="hit">
                  <span className="hit-tag">[{e.book.slice(0, 6)}]{e.useRegex ? '[regex]' : ''}[p{e.probability}]</span>
                  <span className="hit-content">{e.comment || e.key}: {e.preview}</span>
                </li>
              ))}
            </ul>
            {filteredLore.length > 50 && <p className="console-none">…显示前 50 条</p>}
          </>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
