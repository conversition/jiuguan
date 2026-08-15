import React, { useEffect, useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface SkillInfo { name: string; description: string; version: string; enabled: boolean; keywords?: string[] }
interface SkillMatch { name: string; score: number; body?: string }

/** Skill 面板：公共格式 data/skills/<name>/SKILL.md 列表 / 添加 / 启停 / 删除 / 命中测试 */
export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const [matched, setMatched] = useState<SkillMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await fetch(`${API}/api/skills`).then((r) => r.json());
      setSkills(d.skills ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim() || !content.trim()) { setError('技能名与指令正文不能为空'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/skills/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, keywords, content }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setName(''); setDescription(''); setKeywords(''); setContent('');
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const toggle = async (name: string, enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const remove = async (name: string) => {
    if (!window.confirm(`删除技能「${name}」？`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/skills/${encodeURIComponent(name)}/delete`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const test = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/skills/match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setMatched(d.matched ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="console">
      <div className="console-meta">
        Skill 系统：公共格式 <code>data/skills/&lt;名&gt;/SKILL.md</code>（frontmatter name/description/enabled + 指令正文）。
        每回合并行语义匹配用户输入 vs 技能描述，命中技能指令自动注入 &lt;Skill 指令&gt; 块。
      </div>

      <section className="console-section">
        <h3>已有技能（{skills?.length ?? 0}）</h3>
        {skills && skills.length === 0 && <p className="console-none">暂无技能 —— 在下方添加。</p>}
        <ul className="console-hits">
          {skills?.map((s) => (
            <li key={s.name} className="hit">
              <span className="hit-tag">[{s.enabled ? 'ON' : 'OFF'}]</span>
              <span className="hit-content"><b>{s.name}</b> · v{s.version} — {s.description || '（无描述）'}
                {s.keywords?.length ? <span className="muted"> · 触发词: {s.keywords.join('/')}</span> : null}
              </span>
              <span className="hit-ops">
                <button className="link-btn" onClick={() => toggle(s.name, !s.enabled)}>{s.enabled ? '停用' : '启用'}</button>
                <button className="link-btn" onClick={() => remove(s.name)}>删除</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="console-section">
        <h3>命中测试（模拟"并行 AI 自觉"）</h3>
        <div className="console-search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入用户语句，看哪些技能会命中…" />
          <button onClick={test} disabled={busy}>匹配</button>
        </div>
        {matched && (
          matched.length === 0
            ? <p className="console-none">（无技能命中）</p>
            : <ul className="console-hits">{matched.map((m) => (
              <li key={m.name} className="hit">
                <span className="hit-tag">[{m.score.toFixed(2)}]</span>
                <span className="hit-content"><b>{m.name}</b> {m.body ? `— ${m.body}` : ''}</span>
              </li>
            ))}</ul>
        )}
      </section>

      <section className="console-section">
        <h3>添加技能</h3>
        <div className="console-bar">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="技能名（英文/中文）" style={{ maxWidth: 160 }} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="何时使用（触发判断依据）" style={{ flex: 1 }} />
        </div>
        <div className="console-bar">
          <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="触发词（逗号分隔，命中即强相关；补足语义泛化）" style={{ flex: 1 }} />
        </div>
        <textarea
          className="console-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={'指令正文（markdown，注入 <Skill 指令> 块）\n例：\n## 目标\n遇到 X 场景时……\n## 规则\n1. ……\n2. ……'}
          rows={6}
        />
        <div className="console-bar">
          <button onClick={add} disabled={busy}>添加技能</button>
        </div>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
