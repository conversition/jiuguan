import React, { useState } from 'react';
import { StoryboardPanel } from './StoryboardPanel.tsx';
import { downloadText, downloadBase64, readFileAsText, readFileAsBase64 } from './filetools.ts';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface CardInfo { id: string; name: string }
interface WorldbookInfo { id: string; name: string }
interface PresetInfo { id: string; name: string }
interface PresetBlock { index: number; role: string; name: string; enabled: boolean; contentLen: number; preview: string }

const STAGE_LABEL: Record<string, string> = {
  card: '加载角色卡…',
  worldbook: '加载世界书…',
  vectorize: '向量化记忆（约 8 秒）…',
  engine: '接入 MVU 引擎…',
  ready: '就绪',
};

type CreateMode = 'nsfw' | 'nsf' | 'director';

/** 新建创作前置面板（创作模式三项并列：NSFW / NSF / 导演分镜；对话走会话入参，分镜走编排器） */
export function SessionSetup({ onCreated, onCardsChanged }: {
  onCreated: (sid: string, greeting: string, card: string, mode: string) => void;
  onCardsChanged?: () => void;
}) {
  const [cards, setCards] = useState<CardInfo[] | null>(null);
  const [worldbooks, setWorldbooks] = useState<WorldbookInfo[] | null>(null);
  const [presets, setPresets] = useState<PresetInfo[] | null>(null);
  const [card, setCard] = useState('');
  const [mode, setMode] = useState<CreateMode>('nsfw');
  const [selectedBooks, setSelectedBooks] = useState<string[]>([]);
  const [preset, setPreset] = useState('');
  const [blocks, setBlocks] = useState<PresetBlock[] | null>(null);
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');

  React.useEffect(() => {
    const load = async () => {
      try {
        const [c, w, p] = await Promise.all([
          fetch(`${API}/api/cards`).then((r) => r.json()),
          fetch(`${API}/api/worldbooks`).then((r) => r.json()),
          fetch(`${API}/api/presets`).then((r) => r.json()),
        ]);
        setCards(c.cards ?? []);
        setWorldbooks(w.worldbooks ?? []);
        setPresets(p.presets ?? []);
        // 默认：nsfw → XP 大全世界书
        const def = (w.worldbooks ?? []).filter((b: WorldbookInfo) => b.id.includes('XP大全绿灯') || b.id.startsWith('__XP'));
        if (def.length > 0) setSelectedBooks(def.map((b: WorldbookInfo) => b.id));
      } catch (e) { setError((e as Error).message); }
    };
    load();
  }, []);

  const openPreset = async (file: string) => {
    setPreset(file);
    setBlocks(null);
    setOverrides({});
    if (!file) return;
    setError('');
    try {
      const d = await fetch(`${API}/api/preset/${encodeURIComponent(file)}`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setBlocks(d.prompts ?? []);
      const o: Record<number, boolean> = {};
      (d.prompts ?? []).forEach((b: PresetBlock) => { o[b.index] = b.enabled; });
      setOverrides(o);
    } catch (e) { setError((e as Error).message); }
  };

  const toggleBook = (id: string) => {
    setSelectedBooks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // ── 可视化导入/导出（卡片 PNG 兼容酒馆 / 世界书 / 预设 JSON）──
  const importCard = async (file: File) => {
    try {
      const isPng = /\.png$/i.test(file.name);
      const data = isPng ? await readFileAsBase64(file) : await readFileAsText(file);
      const r = await fetch(`${API}/api/card/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, format: isPng ? 'png' : 'json', data }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setError('');
      const c = await fetch(`${API}/api/cards`).then((x) => x.json());
      setCards(c.cards ?? []);
      onCardsChanged?.(); // 同步 App 侧栏卡列表，导入后立即可选
    } catch (e) { setError((e as Error).message); }
  };

  const exportCard = async (c: CardInfo) => {
    try {
      const d = await fetch(`${API}/api/card/${encodeURIComponent(c.id)}/png`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      downloadBase64(d.pngFile ?? c.name + '.png', d.data_b64, 'image/png');
    } catch (e) { setError((e as Error).message); }
  };

  const importWorldbook = async (file: File) => {
    try {
      const raw = await readFileAsText(file);
      const r = await fetch(`${API}/api/worldbook/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, raw }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setError('');
      const w = await fetch(`${API}/api/worldbooks`).then((x) => x.json());
      setWorldbooks(w.worldbooks ?? []);
    } catch (e) { setError((e as Error).message); }
  };

  const exportWorldbook = async (id: string) => {
    try {
      const d = await fetch(`${API}/api/worldbook/${encodeURIComponent(id)}/raw`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      downloadText(id, d.raw);
    } catch (e) { setError((e as Error).message); }
  };

  const importPreset = async (file: File) => {
    try {
      const raw = await readFileAsText(file);
      const r = await fetch(`${API}/api/preset/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, raw }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setError('');
      const p = await fetch(`${API}/api/presets`).then((x) => x.json());
      setPresets(p.presets ?? []);
    } catch (e) { setError((e as Error).message); }
  };

  const exportPreset = async (id: string) => {
    try {
      const d = await fetch(`${API}/api/preset/${encodeURIComponent(id)}/raw`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      downloadText(id, d.raw);
    } catch (e) { setError((e as Error).message); }
  };

  const create = async () => {
    if (!card) { setError('请选择角色卡'); return; }
    setBusy(true);
    setError('');
    setStage('card');
    try {
      const body: Record<string, unknown> = {
        card, content_mode: mode,
        worldbooks: selectedBooks.length > 0 ? selectedBooks : undefined,
        preset: preset || undefined,
        preset_overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      };
      let sid = '';
      let greeting = '';
      let cardName = '';
      let modeName = '';
      const res = await fetch(`${API}/api/session/new`, {
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
            const ev = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;
            if (ev.type === 'stage' && typeof ev.stage === 'string') setStage(ev.stage);
            if (ev.type === 'ready') {
              sid = String(ev.id ?? '');
              greeting = String(ev.greeting ?? '');
              cardName = String(ev.card ?? '');
              modeName = String(ev.contentMode ?? 'nsfw');
            }
          } catch { /* 忽略坏块 */ }
        }
      }
      if (!sid) throw new Error('会话创建失败（未收到 ready）');
      onCreated(sid, greeting, cardName, modeName);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="console">
      <h2>新建创作</h2>

      {/* 创作模式：NSFW / NSF / 导演分镜 三项并列 */}
      <section className="console-section">
        <h3>创作模式</h3>
        <div className="setup-grid">
          <button className={`setup-item${mode === 'nsfw' ? ' setup-active' : ''}`} onClick={() => setMode('nsfw')}>NSFW（成年向对话）</button>
          <button className={`setup-item${mode === 'nsf' ? ' setup-active' : ''}`} onClick={() => setMode('nsf')}>NSF（纯净对话）</button>
          <button className={`setup-item${mode === 'director' ? ' setup-active' : ''}`} onClick={() => setMode('director')}>导演分镜（分镜创作）</button>
        </div>
      </section>

      {mode === 'director' ? (
        <StoryboardPanel />
      ) : (
        <>
          <section className="console-section">
            <h3>1. 角色卡</h3>
            <div className="console-bar">
              <label className="btn-file">导入卡片（.png / .json）
                <input type="file" accept=".json,.png" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importCard(f); e.target.value = ''; }} />
              </label>
            </div>
            {cards === null ? <p className="hint">加载中…</p> : (
              <div className="setup-grid">
                {cards.map((c) => (
                  <div key={c.id} className="setup-cell">
                    <button className={`setup-item${card === c.id ? ' setup-active' : ''}`} onClick={() => setCard(c.id)}>
                      {c.name}
                    </button>
                    <button className="mini-btn" title="导出为酒馆兼容 PNG" onClick={() => exportCard(c)}>⇩</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="console-section">
            <h3>2. 世界书（多选；留空 = 按 content_mode 默认）</h3>
            <div className="console-bar">
              <label className="btn-file">导入世界书（.json）
                <input type="file" accept=".json" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importWorldbook(f); e.target.value = ''; }} />
              </label>
            </div>
            {worldbooks === null ? <p className="hint">加载中…</p> : (
              <div className="setup-grid">
                {worldbooks.map((w) => (
                  <div key={w.id} className="setup-cell">
                    <label className={`setup-item setup-check${selectedBooks.includes(w.id) ? ' setup-active' : ''}`}>
                      <input type="checkbox" checked={selectedBooks.includes(w.id)} onChange={() => toggleBook(w.id)} />
                      {w.name}
                    </label>
                    <button className="mini-btn" title="导出" onClick={() => exportWorldbook(w.id)}>⇩</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="console-section">
            <h3>3. 预设（可选；勾选生效块，未勾选 = 不加载预设）</h3>
            <div className="console-bar">
              <select value={preset} onChange={(e) => openPreset(e.target.value)}>
                <option value="">（不加载预设）</option>
                {(presets ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {preset && <button className="mini-btn" title="导出当前预设" onClick={() => exportPreset(preset)}>⇩</button>}
              <label className="btn-file">导入预设
                <input type="file" accept=".json" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importPreset(f); e.target.value = ''; }} />
              </label>
            </div>
            {blocks && (
              <div className="preset-blocks">
                <div className="preset-block-head">
                  <span>共 {blocks.length} 块，已选 {Object.values(overrides).filter(Boolean).length} 块（注入 {'<预设>'}）</span>
                </div>
                {blocks.map((b) => (
                  <label key={b.index} className={`preset-block${overrides[b.index] ? ' preset-block-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={overrides[b.index] === true}
                      onChange={(e) => setOverrides((prev) => ({ ...prev, [b.index]: e.target.checked }))}
                    />
                    <span className="preset-block-name">{b.name || `块${b.index + 1}`} <small>({b.contentLen}字)</small></span>
                    <span className="muted">{b.preview}</span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="console-section">
            <h3>4. 内容分支（{mode === 'nsfw' ? 'NSFW 成年向' : 'NSF 纯净'}）</h3>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'nsfw' | 'nsf')}>
              <option value="nsfw">NSFW（成年向）</option>
              <option value="nsf">NSF（纯净）</option>
            </select>
          </section>

          {stage && <p className="progress">{STAGE_LABEL[stage] ?? stage}</p>}
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button onClick={create} disabled={busy || !card}>创建会话并开始</button>
          </div>
        </>
      )}
    </div>
  );
}
