import React, { useState } from 'react';
import { applyRegexRules, parseFindRegex } from '../../../packages/core/src/regex.ts';
import type { RegexRule } from '../../../packages/core/src/regex.ts';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface CardInfo { id: string; name: string }

const api = async <T,>(path: string, opts?: RequestInit): Promise<T> => {
  const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
  return d as T;
};

const SCOPE_LABEL: Record<string, string> = { display: '前端隐藏', prompt: '进模型前剥离', both: '两者' };

/** 正则库（启动问题修复：对话原始标记自动屏蔽隐藏 + 手动调整维护） */
export function RegexLibraryPanel() {
  const [rules, setRules] = useState<RegexRule[] | null>(null);
  const [cards, setCards] = useState<CardInfo[]>([]);
  const [editing, setEditing] = useState<RegexRule | null>(null);
  const [testText, setTestText] = useState('夜璃说：<think>我在思考</think>今天天气不错。<UpdateVariable>{"a":1}</UpdateVariable>');
  const [testResult, setTestResult] = useState<{ text: string; applied: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const d = await api<{ rules: RegexRule[] }>('/api/regex-rules');
      setRules(d.rules ?? []);
    } catch (e) { setError((e as Error).message); }
  };
  React.useEffect(() => {
    load();
    api<{ cards: CardInfo[] }>('/api/cards').then((d) => setCards(d.cards ?? [])).catch(() => {});
  }, []);

  const toggle = async (r: RegexRule) => {
    setBusy(true); setError('');
    try {
      await api('/api/regex-rules/save', { method: 'POST', body: JSON.stringify({ rule: { ...r, enabled: !r.enabled } }) });
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const remove = async (r: RegexRule) => {
    setBusy(true); setError('');
    try {
      await api('/api/regex-rules/delete', { method: 'POST', body: JSON.stringify({ id: r.id }) });
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const saveEdit = async () => {
    if (!editing || !editing.findRegex.trim()) return;
    setBusy(true); setError(''); setMsg('');
    try {
      await api('/api/regex-rules/save', { method: 'POST', body: JSON.stringify({ rule: editing }) });
      setMsg(`已保存 ${editing.name}`);
      setEditing(null);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const newRule = () => {
    setEditing({ id: `user-${Date.now()}`, name: '新规则', findRegex: '', replaceString: '', enabled: true, scope: 'display', source: 'user', order: 999 });
  };

  const test = () => {
    if (!rules) return;
    const r = applyRegexRules(testText, rules, 'display');
    setTestResult({ text: r.text, applied: r.applied });
  };

  const importCard = async (cardId: string) => {
    if (!cardId) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await api<{ imported: number; skipped: number; total: number }>('/api/regex-rules/import-card', {
        method: 'POST', body: JSON.stringify({ card: cardId }),
      });
      setMsg(`已导入 ${d.imported} 条（跳过重复 ${d.skipped}，库共 ${d.total} 条）`);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <section className="console-section">
      <h3>正则库（对话原始标记屏蔽隐藏 · 可手动调整维护）</h3>
      <div className="console-bar">
        <button onClick={load} disabled={busy}>刷新</button>
        <button onClick={newRule} disabled={busy}>＋ 新规则</button>
        <select defaultValue="" onChange={(e) => importCard(e.target.value)}>
          <option value="" disabled>从角色卡导入正则…</option>
          {cards.map((c) => <option key={c.id} value={c.id}>{c.name.replace(/\.json$/, '')}</option>)}
        </select>
      </div>
      {msg && <p className="ok">{msg}</p>}

      <div className="console-bar" style={{ marginTop: 10 }}>
        <textarea className="console-textarea" value={testText} onChange={(e) => setTestText(e.target.value)} rows={2} placeholder="测试文本…" />
        <button onClick={test} disabled={busy}>测试隐藏</button>
      </div>
      {testResult && (
        <div className="regex-replaced">
          <span className="muted">命中 {testResult.applied.length} 条规则：{testResult.applied.join('、') || '（无）'}</span>
          <div style={{ marginTop: 6 }}>{testResult.text || '（全部被隐藏）'}</div>
        </div>
      )}

      {rules === null ? <p className="hint">加载中…</p> : (
        <table className="table">
          <thead><tr><th>启用</th><th>规则</th><th>匹配</th><th>替换</th><th>范围</th><th>来源</th><th></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} /></td>
                <td>
                  <b>{r.name}</b>
                  {r.note && <div className="muted">{r.note}</div>}
                </td>
                <td className="muted" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.findRegex}</td>
                <td className="muted" style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.replaceString || '—'}</td>
                <td>{SCOPE_LABEL[r.scope] ?? r.scope}</td>
                <td><SourceBadge source={r.source} /></td>
                <td>
                  <button onClick={() => setEditing({ ...r })}>编辑</button>{' '}
                  {r.source !== 'builtin' && <button onClick={() => remove(r)}>删</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="edit-card" style={{ marginTop: 12 }}>
          <div className="edit-card-head">
            <b>编辑规则</b>
            <input className="console-filter" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="规则名" style={{ maxWidth: 180 }} />
            <select value={editing.scope} onChange={(e) => setEditing({ ...editing, scope: e.target.value as RegexRule['scope'] })}>
              <option value="display">前端隐藏</option>
              <option value="prompt">进模型前剥离</option>
              <option value="both">两者</option>
            </select>
            <span className="edit-ops">
              <button onClick={saveEdit} disabled={busy}>保存</button>
              <button onClick={() => setEditing(null)}>取消</button>
            </span>
          </div>
          <div className="edit-card-head">
            <input className="console-filter" value={editing.findRegex} onChange={(e) => setEditing({ ...editing, findRegex: e.target.value })} placeholder="findRegex（/…/flags 或字面串）" style={{ flex: 1 }} />
          </div>
          <div className="edit-card-head">
            <input className="console-filter" value={editing.replaceString} onChange={(e) => setEditing({ ...editing, replaceString: e.target.value })} placeholder="replaceString（留空=删除）" style={{ flex: 1 }} />
          </div>
          {editing.findRegex && !parseFindRegex(editing.findRegex) && <p className="error">正则无法解析</p>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function SourceBadge({ source }: { source: string }) {
  const label = source === 'builtin' ? '内置' : source === 'card' ? '卡片' : '用户';
  return <span className={`tag ${source === 'user' ? 'tag-locked' : ''}`}>{label}</span>;
}
