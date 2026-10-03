import React, { useEffect, useState } from 'react';
import { authFetch } from './authClient.ts';

interface PresetInfo { id: string; assetId: string; name: string }
interface PresetDetail { name: string; promptCount: number; prompts: { index: number; role: string; name: string; enabled: boolean; contentLen: number; preview: string }[] }
interface LoreEntry { id: number; book: string; comment: string; key: string; useRegex: boolean; probability: number; active: boolean; preview: string }
interface AssetStatus { total: number; cachedCount: number; failedCount: number; diskBytes: number; scannedAt: string; byKind: Record<string, number> }
interface CardItem { assetId: string; name: string }

interface PreloadState { running: boolean; progress: number; done: number; total: number; failed: number; last: string }

const fmtBytes = (n: number): string => {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
};

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
  const [cards, setCards] = useState<CardItem[]>([]);
  const [galCard, setGalCard] = useState('');
  const [galStatus, setGalStatus] = useState<AssetStatus | null>(null);
  const [preload, setPreload] = useState<PreloadState>({ running: false, progress: 0, done: 0, total: 0, failed: 0, last: '' });

  const loadPresets = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await authFetch('/api/presets').then((r) => r.json());
      setPresets(d.presets ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const openPreset = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const d = await authFetch(`/api/preset/${encodeURIComponent(id)}`).then((r) => r.json());
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
      const res = await authFetch('/api/regex/test', {
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
      const d = await authFetch(`/api/session/${sessionId}/lorebook-entries`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setLore(d.entries ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const filteredLore = lore?.filter((e) => !loreFilter || `${e.comment} ${e.key} ${e.book}`.includes(loreFilter)) ?? null;

  const refreshGal = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await authFetch('/api/assets/status').then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setGalStatus(d);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const loadGalCards = async () => {
    try {
      const d = await authFetch('/api/cards').then((r) => r.json());
      setCards((d.cards ?? []).map((c: { assetId: string; name: string }) => ({ assetId: c.assetId, name: c.name })));
      if (!galCard && d.cards?.length) setGalCard(d.cards[0].assetId);
    } catch { /* 卡片列表可选 */ }
  };

  const scanAssets = async () => {
    if (!galCard) return;
    setBusy(true);
    setError('');
    try {
      const res = await authFetch('/api/assets/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: galCard }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setGalStatus(d);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const preloadAssets = async () => {
    if (!galCard || preload.running) return;
    setError('');
    setPreload({ running: true, progress: 0, done: 0, total: 0, failed: 0, last: '开始预载…' });
    let failN = 0;
    try {
      const res = await authFetch('/api/assets/preload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ card: galCard }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;
            if (ev.type === 'progress') {
              if (ev.ok === false) failN++;
              const done = Number(ev.done ?? 0);
              const total = Number(ev.total ?? 0);
              setPreload({ running: true, progress: total ? done / total : 0, done, total, failed: failN, last: String(ev.name ?? ev.url ?? '') });
            } else if (ev.type === 'done') {
              const failed = Array.isArray(ev.failed) ? ev.failed.length : Number(ev.failed ?? 0);
              setPreload({ running: false, progress: 1, done: Number(ev.done ?? 0), total: Number(ev.total ?? 0), failed, last: '预载完成' });
            }
          } catch { /* 忽略坏块 */ }
        }
      }
    } catch (e) { setError((e as Error).message); setPreload((p) => ({ ...p, running: false })); }
    refreshGal();
  };

  const clearCache = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await authFetch('/api/assets/cache/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      refreshGal();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const galKindLabel: Record<string, string> = { bg: '背景', sprite: '立绘', menu: '菜单', cg: 'CG', audio: '音频', page: '页面', generic: '其它' };

  useEffect(() => { loadGalCards(); refreshGal(); }, []);

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
                <button className="link-btn" onClick={() => openPreset(p.assetId)}>{p.name}</button>
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

      <section className="console-section">
        <h3>GLA 远端资源（Galgame 交互卡：扫描 / 预载 / 出图）</h3>
        <div className="console-bar">
          <select value={galCard} onChange={(e) => setGalCard(e.target.value)} disabled={busy || preload.running}>
            <option value="">选择角色卡…</option>
            {cards.map((c) => <option key={c.assetId} value={c.assetId}>{c.name.replace(/\.json$/, '')}</option>)}
          </select>
          <button onClick={scanAssets} disabled={busy || !galCard || preload.running}>扫描并建索引</button>
          <button onClick={preloadAssets} disabled={preload.running || !galCard || busy} className={preload.running ? 'btn-stop' : ''}>
            {preload.running ? '预载中…' : '预载全部资源'}
          </button>
          <button onClick={clearCache} disabled={busy || preload.running}>清空缓存</button>
          <button onClick={refreshGal} disabled={busy || preload.running}>刷新状态</button>
        </div>
        {galStatus && (
          <div className="asset-status">
            <p className="console-meta">
              共 {galStatus.total} 项 · 已缓存 <b>{galStatus.cachedCount}</b> · 失败 {galStatus.failedCount} · 磁盘 {fmtBytes(galStatus.diskBytes)}
              {galStatus.scannedAt && <> · 扫描于 {new Date(galStatus.scannedAt).toLocaleString()}</>}
            </p>
            {galStatus.byKind && Object.keys(galStatus.byKind).length > 0 && (
              <div className="asset-kinds">
                {Object.entries(galStatus.byKind).filter(([, v]) => v > 0).map(([k, v]) => (
                  <span key={k} className="tag">{galKindLabel[k] ?? k}: {v}</span>
                ))}
              </div>
            )}
          </div>
        )}
        {preload.running && preload.total > 0 && (
          <div className="preload-line">
            <div className="preload-bar"><div className="preload-fill" style={{ width: `${Math.round(preload.progress * 100)}%` }} /></div>
            <span className="preload-meta">
              {preload.done}/{preload.total} · 失败 {preload.failed} · {preload.last.length > 24 ? `${preload.last.slice(0, 24)}…` : preload.last}
            </span>
          </div>
        )}
        {!preload.running && preload.total > 0 && (
          <p className="console-meta">预载完成：{preload.done}/{preload.total}，失败 {preload.failed}（可再次预载重试失败项）</p>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
