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

export function ProviderPanel() {
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyMsg, setKeyMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reload = () => {
    fetch(`${API}/api/provider`).then((r) => r.json()).then((d) => setInfo(d)).catch((e) => setError(e.message));
  };
  useEffect(() => { reload(); }, []);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setError('');
    setKeyMsg('');
    try {
      const res = await fetch(`${API}/api/provider/key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setKeyMsg('已保存（data/provider.json，不回显）。新会话即时生效。');
      setApiKey('');
      reload();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const test = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/provider/test`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setModels(d.models ?? []);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="console">
      <section className="console-section">
        <h3>Provider 配置（密钥不回显；填一次存 data/provider.json）</h3>
        {info ? (
          <table className="console-table">
            <tbody>
              <tr><td>Base URL</td><td>{info.baseUrl}</td></tr>
              <tr><td>模型</td><td>{info.model}</td></tr>
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
        ) : <p className="console-none">加载中…</p>}
        <div className="console-bar">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="粘贴 API key（sk-…）"
            style={{ flex: 1 }}
          />
          <button onClick={saveKey} disabled={busy || !apiKey.trim()}>保存 Key</button>
          <button onClick={test} disabled={busy}>测试连接（模型列表）</button>
        </div>
        {keyMsg && <p className="ok">{keyMsg}</p>}
        {models && (
          <div className="console-stats">
            <span className="stat">可用模型 {models.length} 个</span>
          </div>
        )}
        {models && models.length > 0 && (
          <ul className="console-hits">
            {models.map((m, i) => (
              <li key={i} className="hit"><span className="hit-content">{m}</span></li>
            ))}
          </ul>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
