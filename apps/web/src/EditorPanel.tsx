import React, { useState } from 'react';
import { RegexLibraryPanel } from './RegexLibraryPanel.tsx';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface AssetInfo { id: string; name: string; source: 'user' | 'asset' }
interface PresetBlock { index: number; role: string; name: string; enabled: boolean; content: string; contentLen: number }
interface WorldEntry {
  uid: string; key: string[]; comment: string; content: string;
  constant: boolean; selective: boolean; use_regex: boolean;
  triggers: unknown[]; probability: number; useProbability: boolean; active: boolean; depth: number;
}

const api = async <T,>(path: string, opts?: RequestInit): Promise<T> => {
  const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
  return d as T;
};

/** 资产编辑器（启动流程审查 P2 非只读：写 data/{presets,worldbooks} 用户层，源资产只读） */
export function EditorPanel() {
  const [sub, setSub] = useState<'preset' | 'worldbook' | 'regex'>('preset');
  return (
    <div className="console">
      <h2>资产编辑器 <small>（写 data/ 用户层，优先于源资产；源文件只读）</small></h2>
      <div className="console-bar">
        <button className={sub === 'preset' ? 'tab-active' : ''} onClick={() => setSub('preset')}>预设</button>
        <button className={sub === 'worldbook' ? 'tab-active' : ''} onClick={() => setSub('worldbook')}>世界书</button>
        <button className={sub === 'regex' ? 'tab-active' : ''} onClick={() => setSub('regex')}>正则库</button>
      </div>
      {sub === 'preset' ? <PresetEditor /> : sub === 'worldbook' ? <WorldbookEditor /> : <RegexLibraryPanel />}
    </div>
  );
}

function SourceBadge({ source }: { source: 'user' | 'asset' }) {
  return <span className={`tag ${source === 'user' ? 'tag-locked' : ''}`}>{source === 'user' ? '用户' : '源'}</span>;
}

// ── 预设编辑器 ──
function PresetEditor() {
  const [list, setList] = useState<AssetInfo[] | null>(null);
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [blocks, setBlocks] = useState<PresetBlock[] | null>(null);
  const [saveAs, setSaveAs] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try { setList((await api<{ presets: AssetInfo[] }>('/api/presets')).presets); } catch (e) { setError((e as Error).message); }
  };
  React.useEffect(() => { load(); }, []);

  const open = async (f: string) => {
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await api<{ name: string; prompts: PresetBlock[]; source: 'user' | 'asset' }>(`/api/preset/${encodeURIComponent(f)}`);
      setFile(f);
      setName(d.name || f.replace(/\.json$/, ''));
      setBlocks(d.prompts.map((p, i) => ({ ...p, index: i })));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const patch = (index: number, part: Partial<PresetBlock>) => {
    setBlocks((prev) => (prev ?? []).map((b) => (b.index === index ? { ...b, ...part } : b)));
  };
  const addBlock = () => {
    setBlocks((prev) => [...(prev ?? []), { index: (prev ?? []).length, role: 'user', name: `新块${(prev ?? []).length + 1}`, enabled: true, content: '', contentLen: 0 }]);
  };
  const removeBlock = (index: number) => {
    setBlocks((prev) => (prev ?? []).filter((b) => b.index !== index).map((b, i) => ({ ...b, index: i })));
  };
  const moveBlock = (index: number, dir: -1 | 1) => {
    setBlocks((prev) => {
      const arr = [...(prev ?? [])];
      const i = arr.findIndex((b) => b.index === index);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return prev ?? [];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr.map((b, k) => ({ ...b, index: k }));
    });
  };

  const save = async (target?: string) => {
    if (!file || !blocks) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await api<{ file: string }>('/api/preset/save', {
        method: 'POST',
        body: JSON.stringify({
          file: target ?? file,
          name: target ? (target.replace(/\.json$/, '') ?? name) : name,
          prompts: blocks.map(({ index: _i, contentLen: _l, ...b }) => b),
        }),
      });
      setMsg(`已保存 ${d.file}（用户层）`);
      setFile(d.file);
      setSaveAs('');
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const restore = async () => {
    if (!file) return;
    setBusy(true); setError(''); setMsg('');
    try {
      await api('/api/preset/delete', { method: 'POST', body: JSON.stringify({ file }) });
      setMsg('已删除用户副本（恢复源资产）');
      await open(file);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const totalChars = blocks?.reduce((a, b) => a + (b.content ?? '').length, 0) ?? 0;
  const enabledCount = blocks?.filter((b) => b.enabled).length ?? 0;

  return (
    <>
      <section className="console-section">
        <h3>预设列表</h3>
        <div className="console-bar">
          <button onClick={load} disabled={busy}>刷新</button>
        </div>
        {list && (
          <ul className="console-hits">
            {list.map((p) => (
              <li key={p.id} className="hit">
                <SourceBadge source={p.source} />{' '}
                <button className="link-btn" onClick={() => open(p.id)}>{p.name}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {blocks && (
        <section className="console-section">
          <h3>编辑：{file} <SourceBadge source={list?.find((l) => l.id === file)?.source ?? 'asset'} />
            <span className="console-meta"> · {blocks.length} 块 · 启用 {enabledCount} · {totalChars} 字符</span>
          </h3>
          <div className="console-bar">
            <button onClick={() => save()} disabled={busy}>保存</button>
            <input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder="另存为文件名（如 我的预设.json）" className="console-filter" />
            <button onClick={() => saveAs && save(saveAs)} disabled={busy || !saveAs.trim()}>另存为</button>
            <button onClick={addBlock} disabled={busy}>＋ 块</button>
            <button onClick={restore} disabled={busy}>恢复源文件</button>
          </div>
          {msg && <p className="ok">{msg}</p>}
          {blocks.map((b) => (
            <div key={b.index} className="edit-card">
              <div className="edit-card-head">
                <label className="edit-check">
                  <input type="checkbox" checked={b.enabled} onChange={(e) => patch(b.index, { enabled: e.target.checked })} /> 启用
                </label>
                <select value={b.role} onChange={(e) => patch(b.index, { role: e.target.value })}>
                  <option value="user">user</option>
                  <option value="system">system</option>
                  <option value="assistant">assistant</option>
                </select>
                <input value={b.name} onChange={(e) => patch(b.index, { name: e.target.value })} placeholder="块名" className="console-filter" style={{ maxWidth: 220 }} />
                <span className="muted">{b.content.length} 字</span>
                <span className="edit-ops">
                  <button onClick={() => moveBlock(b.index, -1)} disabled={b.index === 0}>↑</button>
                  <button onClick={() => moveBlock(b.index, 1)} disabled={b.index === (blocks.length - 1)}>↓</button>
                  <button onClick={() => removeBlock(b.index)}>✕</button>
                </span>
              </div>
              <textarea
                className="console-textarea"
                value={b.content}
                onChange={(e) => patch(b.index, { content: e.target.value })}
                rows={4}
              />
            </div>
          ))}
          <div className="console-bar">
            <button onClick={() => save()} disabled={busy}>保存</button>
          </div>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

// ── 世界书编辑器 ──
function WorldbookEditor() {
  const [list, setList] = useState<AssetInfo[] | null>(null);
  const [file, setFile] = useState('');
  const [entries, setEntries] = useState<WorldEntry[] | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try { setList((await api<{ worldbooks: AssetInfo[] }>('/api/worldbooks')).worldbooks); } catch (e) { setError((e as Error).message); }
  };
  React.useEffect(() => { load(); }, []);

  const open = async (f: string) => {
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await api<{ entries: WorldEntry[] }>(`/api/worldbook/${encodeURIComponent(f)}`);
      setFile(f);
      setEntries(d.entries ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const patch = (uid: string, part: Partial<WorldEntry>) => {
    setEntries((prev) => (prev ?? []).map((e) => (e.uid === uid ? { ...e, ...part } : e)));
  };
  const addEntry = () => {
    setEntries((prev) => [...(prev ?? []), {
      uid: `new-${Date.now()}`, key: [], comment: '新条目', content: '', constant: false,
      selective: false, use_regex: false, triggers: [], probability: 100, useProbability: false, active: true, depth: 0,
    }]);
  };
  const removeEntry = (uid: string) => {
    setEntries((prev) => (prev ?? []).filter((e) => e.uid !== uid));
  };

  const save = async () => {
    if (!file || !entries) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await api<{ file: string }>('/api/worldbook/save', {
        method: 'POST',
        body: JSON.stringify({ file, entries }),
      });
      setMsg(`已保存 ${d.file}（${entries.length} 条，用户层）`);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const restore = async () => {
    if (!file) return;
    setBusy(true); setError(''); setMsg('');
    try {
      await api('/api/worldbook/delete', { method: 'POST', body: JSON.stringify({ file }) });
      setMsg('已删除用户副本（恢复源资产）');
      await open(file);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const filtered = entries?.filter((e) => !filter || `${e.comment} ${e.key?.join(',') ?? ''}`.includes(filter)) ?? [];
  const visible = filtered.slice(0, 60);

  return (
    <>
      <section className="console-section">
        <h3>世界书列表</h3>
        <div className="console-bar">
          <button onClick={load} disabled={busy}>刷新</button>
        </div>
        {list && (
          <ul className="console-hits">
            {list.map((w) => (
              <li key={w.id} className="hit">
                <SourceBadge source={w.source} />{' '}
                <button className="link-btn" onClick={() => open(w.id)}>{w.name}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {entries && (
        <section className="console-section">
          <h3>编辑：{file} <SourceBadge source={list?.find((l) => l.id === file)?.source ?? 'asset'} />
            <span className="console-meta"> · 共 {entries.length} 条</span>
          </h3>
          <div className="console-bar">
            <button onClick={save} disabled={busy}>保存（写用户层）</button>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤 comment/key…" className="console-filter" />
            <button onClick={addEntry} disabled={busy}>＋ 条目</button>
            <button onClick={restore} disabled={busy}>恢复源文件</button>
          </div>
          {msg && <p className="ok">{msg}</p>}
          {filtered.length > 60 && <p className="hint">…共 {filtered.length} 条，仅显示前 60 条（保存时全部写入）</p>}
          {visible.map((e) => (
            <div key={e.uid} className="edit-card">
              <div className="edit-card-head">
                <input value={e.comment} onChange={(ev) => patch(e.uid, { comment: ev.target.value })} placeholder="comment（显示名）" className="console-filter" style={{ maxWidth: 180 }} />
                <input value={e.key?.join(',') ?? ''} onChange={(ev) => patch(e.uid, { key: ev.target.value ? ev.target.value.split(',') : [] })} placeholder="key（逗号分隔）" className="console-filter" style={{ maxWidth: 180 }} />
                <label className="edit-check"><input type="checkbox" checked={e.use_regex} onChange={(ev) => patch(e.uid, { use_regex: ev.target.checked })} /> regex</label>
                <label className="edit-check"><input type="checkbox" checked={e.constant} onChange={(ev) => patch(e.uid, { constant: ev.target.checked })} /> 常驻</label>
                <label className="edit-check"><input type="checkbox" checked={e.active} onChange={(ev) => patch(e.uid, { active: ev.target.checked })} /> 启用</label>
                <label className="edit-check">概率 <input type="number" min={0} max={100} value={e.probability} onChange={(ev) => patch(e.uid, { probability: Number(ev.target.value) })} style={{ width: 60 }} /></label>
                <label className="edit-check"><input type="checkbox" checked={e.useProbability} onChange={(ev) => patch(e.uid, { useProbability: ev.target.checked })} /> 用概率</label>
                <span className="edit-ops"><button onClick={() => removeEntry(e.uid)}>✕</button></span>
              </div>
              <textarea
                className="console-textarea"
                value={e.content}
                onChange={(ev) => patch(e.uid, { content: ev.target.value })}
                rows={3}
              />
            </div>
          ))}
          <div className="console-bar">
            <button onClick={save} disabled={busy}>保存（写用户层）</button>
          </div>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
