import React, { useEffect, useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface ProviderInfo {
  baseUrl: string;
  model: string;
  kind: string;
  prefixCacheThreshold: number;
  hasKey: boolean;
  keySource?: 'provider.json' | 'env' | 'none';
  keyFingerprint?: string;
}

interface HistoryEntry {
  baseUrl: string;
  model: string;
  lastSuccessAt: string;
}

/** Provider 配置面板：AI URL / Key / 模型 输入 + 测试连接 + 保存即时生效
 *  测试连接用「草稿值」直接校验（不落盘）；保存才写 data/provider.json 并热更全部会话 */
export function ProviderPanel() {
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]); // 测试成功记忆的 URL 历史
  const [dirty, setDirty] = useState(false); // 表单与已保存配置不一致
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const d = await (await fetch(`${API}/api/provider`)).json();
      setInfo(d);
      setBaseUrl(d.baseUrl ?? '');
      setModel(d.model ?? '');
    } catch (e) { setErr((e as Error).message); }
  };
  const reloadHistory = async () => {
    try {
      const d = await (await fetch(`${API}/api/provider/history`)).json();
      setHistory(Array.isArray(d.history) ? d.history : []);
    } catch { /* 历史拉取失败不阻塞面板 */ }
  };
  useEffect(() => { reload(); reloadHistory(); }, []);

  // 草稿与已保存值的差异提示
  useEffect(() => {
    setDirty(Boolean(info) && (baseUrl !== info?.baseUrl || model !== info?.model || apiKey.trim() !== ''));
  }, [info, baseUrl, model, apiKey]);

  const test = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const res = await fetch(`${API}/api/provider/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          model: model.trim() || undefined, // 让历史记住本次测试的模型，而非已保存/默认值
        }),
      });
      const d = await res.json();
      if (!res.ok || d.ok === false) throw new Error(d.error ?? `HTTP ${res.status}`);
      setModels(d.models ?? []);
      if (Array.isArray(d.history)) setHistory(d.history); else reloadHistory(); // 兜底兼容旧服务端
      setMsg(`✅ 连接成功：URL + Key 校验通过，共 ${d.count} 个模型（展示前 ${d.models.length} 个）。可在下方点击选择模型，再「保存并生效」。`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  /** 下拉/标签选中：回填该历史条的 URL + 模型，并清掉旧 URL 的模型列表（dirty 由既有 effect 自动算） */
  const pickHistory = (entry: HistoryEntry) => {
    setBaseUrl(entry.baseUrl);
    setModel(entry.model || '');
    setModels(null);
  };

  /** 删除单条历史（POST 兼容 CORS）；用响应最新列表覆盖 state */
  const deleteHistory = async (entry: HistoryEntry) => {
    setBusy(true); setErr('');
    try {
      const res = await fetch(`${API}/api/provider/history/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: entry.baseUrl }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setHistory(Array.isArray(d.history) ? d.history : []);
    } catch (e) { setErr((e as Error).message); reloadHistory(); }
    setBusy(false);
  };

  const save = async () => {
    if (!baseUrl.trim() && !model.trim() && !apiKey.trim()) {
      setErr('AI Base URL / 模型 / API key 至少填一项');
      return;
    }
    setBusy(true); setErr(''); setMsg('');
    try {
      const res = await fetch(`${API}/api/provider/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKey.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setInfo(d);
      setApiKey('');
      setMsg(`已保存并即时对当前会话生效：Base URL=${d.baseUrl}，模型=${d.model}${d.hasKey ? `，Key ${d.keyFingerprint ?? ''}` : '（未配置 Key）'}`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="console">
      <section className="console-section">
        <h3>Provider 配置（保存到 data/provider.json，立即生效；Key 不回显）</h3>
        <div className="provider-form">
          {history.length > 0 && (
            <div className="provider-history">
              <label>历史 URL（测试成功自动记忆 · 下拉回填 URL + 模型）</label>
              <select value="" onChange={(e) => {
                const hit = history.find((h) => h.baseUrl === e.target.value);
                if (hit) pickHistory(hit);
              }} disabled={busy}>
                <option value="" disabled>历史 URL 快速切换…</option>
                {history.map((h) => (
                  <option key={h.baseUrl} value={h.baseUrl}>{h.baseUrl}{h.model ? ` · ${h.model}` : ''}</option>
                ))}
              </select>
              <div className="history-chips">
                {history.map((h) => (
                  <span key={h.baseUrl} className="history-chip">
                    <button className="model-tag" onClick={() => pickHistory(h)} disabled={busy} title={`回填 ${h.baseUrl}`}>
                      {h.baseUrl}{h.model ? ` · ${h.model}` : ''}
                    </button>
                    <button className="mini-btn" onClick={() => deleteHistory(h)} disabled={busy} title="删除该历史">✕</button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <label>AI Base URL（OpenAI 兼容，不含 /v1）</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://opencode.ai/zen/go" spellCheck={false} />
          <label>API Key</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…（留空 = 保留已保存/环境变量 Key）" spellCheck={false} />
          <label>模型（可手输；测试后可从列表选择）</label>
          <input list="jg-model-list" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-v4-flash" spellCheck={false} />
          <datalist id="jg-model-list">
            {(models ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>
        </div>
        <div className="provider-actions">
          <button onClick={test} disabled={busy}>⚡ 测试连接（URL + Key）</button>
          <button onClick={save} disabled={busy}>💾 保存并生效</button>
        </div>
        {models && models.length > 0 && (
          <div className="model-picks">
            <span className="console-meta">可用模型 {models.length} 个 · 点击选择：</span>
            <div className="model-tags">
              {models.map((m) => (
                <button key={m} className={`model-tag${m === model ? ' model-tag-active' : ''}`} onClick={() => setModel(m)} disabled={busy} title={m}>{m}</button>
              ))}
            </div>
          </div>
        )}
        {info && (
          <table className="console-table">
            <tbody>
              <tr><td>当前生效 Base URL</td><td>{info.baseUrl}</td></tr>
              <tr><td>当前生效模型</td><td>{info.model}</td></tr>
              <tr><td>类型</td><td>{info.kind}</td></tr>
              <tr><td>前缀缓存阈值</td><td>{info.prefixCacheThreshold} tok</td></tr>
              <tr><td>API Key</td><td>{info.hasKey ? `✅ 已配置（${info.keyFingerprint ?? ''}）` : '❌ 未配置'}</td></tr>
              <tr>
                <td>Key 来源</td>
                <td>
                  {info.keySource === 'provider.json' ? 'provider.json（UI 面板唯一权威）'
                    : info.keySource === 'env' ? 'env（.env.local，面板兜底）'
                    : '无'}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {dirty && <p className="console-meta" style={{ marginTop: 8 }}>✎ 有未保存的修改，点「保存并生效」应用。</p>}
        {msg && <p className="ok">{msg}</p>}
        {err && <p className="error">{err}</p>}
      </section>
    </div>
  );
}