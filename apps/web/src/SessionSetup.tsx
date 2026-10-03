import React, { useState, useRef } from 'react';
import { authClient, authFetch, eventUrl } from './authClient.ts';
import { StoryboardPanel } from './StoryboardPanel.tsx';
import { downloadText, downloadBase64 } from './filetools.ts';
import { downloadLocalAsset } from './assetDownloads.ts';
import type { ClientStorageNamespace } from '../../../packages/client-runtime/src/index.ts';
import {
  ABSENT_REVISION,
  conflictDetails,
  responseJson,
  revisionHeaders,
} from './revisionApi.ts';

interface AssetRefInfo { id: string; assetId: string; name: string; revision: string }
interface CardInfo extends AssetRefInfo { source: 'user' | 'asset' }
interface WorldbookInfo extends AssetRefInfo { source: 'user' | 'asset' }
interface PresetInfo extends AssetRefInfo {}
interface PresetBlock { index: number; role: string; name: string; enabled: boolean; contentLen: number; preview: string }

const stableAssetRef = (asset: AssetRefInfo): string => asset.assetId || asset.id;
const matchesAssetRef = (asset: AssetRefInfo, reference: string): boolean =>
  asset.assetId === reference || asset.id === reference;

const STAGE_LABEL: Record<string, string> = {
  card: '加载角色卡…',
  worldbook: '加载世界书…',
  vectorize: '向量化记忆（约 8 秒）…',
  engine: '接入 MVU 引擎…',
  ready: '就绪',
};

type CreateMode = 'nsfw' | 'nsf' | 'director';

/** 新建配置快照（server/client namespace：卡/世界书/预设/预设块勾选，下次新建自动回填） */
interface SetupSnapshot {
  card: string;
  mode: CreateMode;
  worldbooks: string[];
  preset: string;
  overrides: Record<number, boolean>;
  style: string;
}

/** 新建创作前置面板（创作模式三项并列：NSFW / NSF / 导演分镜；对话走会话入参，分镜走编排器） */
export function SessionSetup({ storageNamespace, onCreated, onCardsChanged }: {
  storageNamespace: ClientStorageNamespace;
  onCreated: (sid: string, greeting: string, card: string, mode: string) => void;
  onCardsChanged?: () => void;
}) {
  const setupKey = storageNamespace.preferenceKey('session-setup');
  const [cards, setCards] = useState<CardInfo[] | null>(null);
  const [worldbooks, setWorldbooks] = useState<WorldbookInfo[] | null>(null);
  const [presets, setPresets] = useState<PresetInfo[] | null>(null);
  const [card, setCard] = useState('');
  const [mode, setMode] = useState<CreateMode>('nsfw');
  const [selectedBooks, setSelectedBooks] = useState<string[]>([]);
  const [preset, setPreset] = useState('');
  const [style, setStyle] = useState('未指定文风');
  const [styleSkills, setStyleSkills] = useState<{ name: string; description: string; default?: boolean }[] | null>(null);
  const [blocks, setBlocks] = useState<PresetBlock[] | null>(null);
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  /** 首次加载+回填完成前，禁止把初始空态写回 localStorage（避免覆盖上次配置） */
  const loadedRef = useRef(false);
  /** 卡片/世界书两步内联确认删除（同会话删除：第一次点击进入确认态，第二次执行） */
  const [confirmDel, setConfirmDel] = useState<{ kind: 'card' | 'worldbook'; id: string } | null>(null);
  /** 卡片导入检测到内嵌世界书 → 弹窗确认是否单独导入世界书库 */
  const [importPrompt, setImportPrompt] = useState<{
    assetId: string;
    cardName: string;
    count: number;
    bookName: string;
    expectedRevision?: string;
  } | null>(null);

  React.useEffect(() => {
    const load = async () => {
      try {
        const [c, w, p, sk] = await Promise.all([
          authFetch('/api/cards').then((r) => r.json()),
          authFetch('/api/worldbooks').then((r) => r.json()),
          authFetch('/api/presets').then((r) => r.json()),
          authFetch('/api/skills').then((r) => r.json()),
        ]);
        setCards(c.cards ?? []);
        setWorldbooks(w.worldbooks ?? []);
        setPresets(p.presets ?? []);
        const styleOpts = (sk.skills ?? []).filter((s: { role?: string }) => s.role === 'style');
        setStyleSkills(styleOpts);
        // 回填上次新建配置（存在快照时优先；仅缺失条目/已删预设按存活过滤）
        let snap: SetupSnapshot | null = null;
        try { snap = JSON.parse(localStorage.getItem(setupKey) ?? 'null'); } catch { snap = null; }
        if (snap) {
          const books = (snap.worldbooks ?? []).flatMap((reference) => {
            const item = (w.worldbooks ?? []).find((candidate: WorldbookInfo) => matchesAssetRef(candidate, reference));
            return item ? [stableAssetRef(item)] : [];
          });
          const savedCard = (c.cards ?? []).find((item: CardInfo) => matchesAssetRef(item, snap.card));
          if (savedCard) setCard(stableAssetRef(savedCard));
          if (snap.mode === 'nsf' || snap.mode === 'director') setMode(snap.mode);
          setSelectedBooks(books);
          if (snap.style && styleOpts.some((x: { name: string }) => x.name === snap.style)) setStyle(snap.style);
          if (snap.preset) {
            const savedPreset = (p.presets ?? []).find((item: PresetInfo) => matchesAssetRef(item, snap.preset));
            const presetRef = savedPreset ? stableAssetRef(savedPreset) : '';
            setPreset(presetRef);
            const prompts = presetRef ? await fetchPresetPrompts(presetRef) : null;
            if (prompts) {
              setBlocks(prompts);
              const o: Record<number, boolean> = {};
              for (const b of prompts) {
                o[b.index] = snap.overrides && snap.overrides[b.index] !== undefined ? snap.overrides[b.index] : b.enabled;
              }
              setOverrides(o);
            }
          }
        } else if (styleOpts.length > 0) {
          const defaultStyle = styleOpts.find((item: { default?: boolean }) => item.default) ?? styleOpts[0];
          setStyle(defaultStyle.name);
        }
      } catch (e) { setError((e as Error).message); }
      loadedRef.current = true;
    };
    load();
  }, []);

  // 记住最近一次新建配置（含预设块勾选）；切换标签页/刷新后自动回填
  // 预设已选但块未加载完成时跳过（避免切换预设中途把旧勾选瞬时写入）
  React.useEffect(() => {
    if (!loadedRef.current) return;
    if (preset && !blocks) return;
    const snap: SetupSnapshot = { card, mode, worldbooks: selectedBooks, preset, overrides, style };
    try { localStorage.setItem(setupKey, JSON.stringify(snap)); } catch { /* localStorage 不可用则跳过 */ }
  }, [card, mode, selectedBooks, preset, overrides, blocks, style, setupKey]);

  /** 拉取预设块列表（失败返回 null，不抛错） */
  const fetchPresetPrompts = async (file: string): Promise<PresetBlock[] | null> => {
    try {
      const d = await authFetch(`/api/preset/${encodeURIComponent(file)}`).then((r) => r.json());
      if (d.error) return null;
      return d.prompts ?? [];
    } catch { return null; }
  };

  const openPreset = async (file: string) => {
    setPreset(file);
    setBlocks(null);
    setOverrides({});
    if (!file) return;
    setError('');
    try {
      const prompts = await fetchPresetPrompts(file);
      if (!prompts) throw new Error('预设加载失败');
      setBlocks(prompts);
      const o: Record<number, boolean> = {};
      prompts.forEach((b: PresetBlock) => { o[b.index] = b.enabled; });
      setOverrides(o);
    } catch (e) { setError((e as Error).message); }
  };

  const toggleBook = (id: string) => {
    setSelectedBooks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // ── 可视化导入/导出（卡片 PNG 兼容酒馆 / 世界书 / 预设 JSON）──
  const uploadAsset = async (kind: 'card' | 'worldbook' | 'preset', file: File) => {
    const form = new FormData();
    form.append('kind', kind);
    form.append('displayName', file.name.replace(/\.(json|png)$/i, ''));
    form.append('file', file, file.name);
    return authFetch('/api/assets/import', { method: 'POST', body: form });
  };

  const importCard = async (file: File) => {
    try {
      const r = await uploadAsset('card', file);
      const d = await responseJson<{
        assetId: string;
        displayName: string;
        embeddedWorldbook?: { count?: number; displayName?: string };
      }>(r);
      setError('');
      const c = await authFetch('/api/cards').then((x) => x.json());
      setCards(c.cards ?? []);
      onCardsChanged?.(); // 同步 App 侧栏卡列表，导入后立即可选
      // 内嵌世界书：弹窗告知并确认是否单独导入世界书库（卡与内嵌世界书分别记录）
      const embeddedWorldbook = d.embeddedWorldbook;
      if (typeof embeddedWorldbook?.count === 'number' && embeddedWorldbook.count > 0) {
        setImportPrompt({
          assetId: d.assetId,
          cardName: d.displayName,
          count: embeddedWorldbook.count,
          bookName: embeddedWorldbook.displayName ?? '',
          expectedRevision: ABSENT_REVISION,
        });
      }
    } catch (e) { setError((e as Error).message); }
  };

  /** 将卡片内嵌世界书另存为独立世界书资产（弹窗确认后；成功后刷新世界书列表） */
  const importCardWorldbook = async () => {
    if (!importPrompt) return;
    setBusy(true);
    setError('');
    try {
      const r = await authFetch('/api/card/import-worldbook', {
        method: 'POST', headers: revisionHeaders(importPrompt.expectedRevision ?? ABSENT_REVISION),
        body: JSON.stringify({ assetId: importPrompt.assetId }),
      });
      await responseJson(r);
      setImportPrompt(null);
      setWorldbooks((await authFetch('/api/worldbooks').then((x) => x.json()).then((w) => w.worldbooks ?? [])));
    } catch (e) {
      const conflict = conflictDetails(e);
      if (conflict) {
        setImportPrompt((current) => current ? { ...current, expectedRevision: conflict.actualRevision } : null);
        setError('同名世界书已存在且未被覆盖。确认内容后再次点击即可按最新版本覆盖。');
      } else {
        setError((e as Error).message);
        setImportPrompt(null);
      }
    }
    setBusy(false);
  };

  const exportCard = async (c: CardInfo) => {
    try {
      if ((await authClient.initialize()).phase !== 'local-only') {
        await downloadLocalAsset(stableAssetRef(c), 'png');
        return;
      }
      const d = await authFetch(`/api/card/${encodeURIComponent(stableAssetRef(c))}/png`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      downloadBase64(d.pngFile ?? c.name + '.png', d.data_b64, 'image/png');
    } catch (e) { setError((e as Error).message); }
  };

  const importWorldbook = async (file: File) => {
    try {
      const r = await uploadAsset('worldbook', file);
      await responseJson(r);
      setError('');
      const w = await authFetch('/api/worldbooks').then((x) => x.json());
      setWorldbooks(w.worldbooks ?? []);
    } catch (e) { setError((e as Error).message); }
  };

  const exportWorldbook = async (asset: WorldbookInfo) => {
    try {
      if ((await authClient.initialize()).phase !== 'local-only') {
        await downloadLocalAsset(stableAssetRef(asset), 'json');
        return;
      }
      const d = await authFetch(`/api/worldbook/${encodeURIComponent(stableAssetRef(asset))}/raw`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      downloadText(`${asset.name}.json`, d.raw);
    } catch (e) { setError((e as Error).message); }
  };

  /** 删除角色卡（仅用户导入；两步确认 → 刷新列表 + 同步侧栏；删除选中卡时清空选择） */
  const deleteCard = async (c: CardInfo) => {
    const assetId = stableAssetRef(c);
    if (confirmDel?.kind !== 'card' || confirmDel.id !== assetId) { setConfirmDel({ kind: 'card', id: assetId }); return; }
    setConfirmDel(null);
    setBusy(true);
    setError('');
    try {
      const r = await authFetch('/api/card/delete', {
        method: 'POST', headers: revisionHeaders(c.revision),
        body: JSON.stringify({ assetId }),
      });
      await responseJson(r);
      if (card === assetId) setCard('');
      const list = await authFetch('/api/cards').then((x) => x.json());
      setCards(list.cards ?? []);
      onCardsChanged?.(); // 同步 App 侧栏卡列表，删除后立即消失
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  /** 删除世界书（按钮全覆盖；force 两层兜底删除；两步确认 → 刷新列表，移除已勾选） */
  const deleteWorldbook = async (w: WorldbookInfo) => {
    const assetId = stableAssetRef(w);
    if (confirmDel?.kind !== 'worldbook' || confirmDel.id !== assetId) {
      setConfirmDel({ kind: 'worldbook', id: assetId });
      return;
    }
    setConfirmDel(null);
    setBusy(true);
    setError('');
    try {
      const r = await authFetch('/api/worldbook/delete', {
        method: 'POST', headers: revisionHeaders(w.revision),
        body: JSON.stringify({ assetId, force: true }),
      });
      await responseJson(r);
      setSelectedBooks((prev) => prev.filter((x) => x !== assetId));
      const list = await authFetch('/api/worldbooks').then((x) => x.json());
      setWorldbooks(list.worldbooks ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const importPreset = async (file: File) => {
    try {
      const r = await uploadAsset('preset', file);
      await responseJson(r);
      setError('');
      const p = await authFetch('/api/presets').then((x) => x.json());
      setPresets(p.presets ?? []);
    } catch (e) { setError((e as Error).message); }
  };

  const exportPreset = async (assetId: string) => {
    try {
      if ((await authClient.initialize()).phase !== 'local-only') {
        await downloadLocalAsset(assetId, 'json');
        return;
      }
      const d = await authFetch(`/api/preset/${encodeURIComponent(assetId)}/raw`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      const item = presets?.find((candidate) => stableAssetRef(candidate) === assetId);
      downloadText(`${item?.name ?? 'preset'}.json`, d.raw);
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
        style: style || undefined,
      };
      let sid = '';
      let greeting = '';
      let cardName = '';
      let modeName = '';
      const res = await authFetch(eventUrl('/api/session/new'), {
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

      {mode !== 'director' && (
        <section className="console-section">
          <h3>文风（公开版不内置文风 Skill；导入后可在此选择）</h3>
          <div className="console-bar">
            <select value={style} onChange={(e) => setStyle(e.target.value)} style={{ maxWidth: 360 }}>
              {styleSkills && styleSkills.length > 0 ? styleSkills.map((s) => (
                <option key={s.name} value={s.name}>{s.default ? '★ 默认 · ' : ''}{s.description || s.name}</option>
              )) : <option value="未指定文风">未指定文风</option>}
            </select>
            <span className="muted">导入文风库可在 Skill 面板触发</span>
          </div>
        </section>
      )}

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
                  <div key={stableAssetRef(c)} className="setup-cell">
                    <button className={`setup-item${card === stableAssetRef(c) ? ' setup-active' : ''}`} onClick={() => setCard(stableAssetRef(c))}>
                      {c.name}
                    </button>
                    <button className="mini-btn" title="导出为酒馆兼容 PNG" onClick={() => exportCard(c)}>⇩</button>
                    {c.source === 'user' && (
                      <button
                        className={`mini-btn${confirmDel?.kind === 'card' && confirmDel.id === stableAssetRef(c) ? ' mini-btn-danger' : ''}`}
                        title={confirmDel?.kind === 'card' && confirmDel.id === stableAssetRef(c) ? '再次点击确认删除（用户导入卡片）' : '删除卡片（用户导入）'}
                        disabled={busy}
                        onClick={() => deleteCard(c)}
                      >
                        {confirmDel?.kind === 'card' && confirmDel.id === stableAssetRef(c) ? '✕' : '🗑'}
                      </button>
                    )}
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
                  <div key={stableAssetRef(w)} className="setup-cell">
                    <label className={`setup-item setup-check${selectedBooks.includes(stableAssetRef(w)) ? ' setup-active' : ''}`}>
                      <input type="checkbox" checked={selectedBooks.includes(stableAssetRef(w))} onChange={() => toggleBook(stableAssetRef(w))} />
                      {w.name}
                    </label>
                    <button className="mini-btn" title="导出" onClick={() => exportWorldbook(w)}>⇩</button>
                    <button
                      className={`mini-btn${confirmDel?.kind === 'worldbook' && confirmDel.id === stableAssetRef(w) ? ' mini-btn-danger' : ''}`}
                      title={confirmDel?.kind === 'worldbook' && confirmDel.id === stableAssetRef(w)
                        ? '再次点击确认删除'
                        : w.source === 'user' ? '删除世界书（用户导入）' : '删除世界书（源资产层，删除后不可恢复）'}
                      disabled={busy}
                      onClick={() => deleteWorldbook(w)}
                    >
                      {confirmDel?.kind === 'worldbook' && confirmDel.id === stableAssetRef(w) ? '✕' : '🗑'}
                    </button>
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
                {(presets ?? []).map((p) => <option key={stableAssetRef(p)} value={stableAssetRef(p)}>{p.name}</option>)}
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

      {importPrompt && (
        <div className="import-prompt" role="dialog" aria-modal="true">
          <div className="import-prompt-box">
            <h3>检测到内嵌世界书</h3>
            <p>
              角色卡「{importPrompt.cardName}」内嵌了{importPrompt.bookName ? `世界书「${importPrompt.bookName}」` : '一份世界书'}，共{' '}
              <b>{importPrompt.count}</b> 条。
            </p>
            <p className="muted">角色卡已导入。是否将内嵌世界书单独导入世界书库（可与卡片分开选择、跨会话复用）？</p>
            <div className="import-prompt-actions">
              <button onClick={importCardWorldbook} disabled={busy}>
                {importPrompt.expectedRevision && importPrompt.expectedRevision !== ABSENT_REVISION ? '确认覆盖世界书' : '导入世界书'}
              </button>
              <button className="ghost" onClick={() => setImportPrompt(null)} disabled={busy}>仅导入卡片</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
