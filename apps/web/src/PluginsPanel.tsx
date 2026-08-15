import React, { useState } from 'react';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface PluginInfo {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  license?: string;
  includes: string[];
  server?: string;
  hooks: string[];
  enabled: boolean;
  source: string;
  installedAt: string;
  updatedAt: string;
}

/** 插件市场（04 §7：git URL 安装 / 启停 / 卸载 / 更新） */
export function PluginsPanel() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setError('');
    try {
      const d = await fetch(`${API}/api/plugins`).then((r) => r.json());
      setPlugins(d.plugins ?? []);
    } catch (e) { setError((e as Error).message); }
  };

  const post = async (path: string, body?: Record<string, unknown>, successMsg?: string) => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      if (successMsg) setMsg(successMsg);
      await load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const install = () => {
    if (!url.trim()) return;
    post('/api/plugins/install', { url: url.trim() }, `已安装: ${url.trim()}`);
    setUrl('');
  };

  React.useEffect(() => { load(); }, []);

  return (
    <div className="console">
      <h2>插件市场 <small>（参考 SillyTavern git 插件接口：manifest.json + git 安装）</small></h2>
      <div className="row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="git URL 或本地路径，如 https://github.com/user/my-plugin"
          style={{ flex: 1 }}
        />
        <button onClick={install} disabled={busy || !url.trim()}>安装</button>
        <button onClick={load} disabled={busy}>刷新</button>
      </div>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}
      {plugins === null ? (
        <p className="hint">加载中…</p>
      ) : plugins.length === 0 ? (
        <p className="hint">尚未安装插件。粘贴插件仓库 git URL（含 manifest.json + server.js）安装。</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>插件</th><th>版本</th><th>钩子</th><th>来源</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {plugins.map((p) => (
              <tr key={p.id}>
                <td>
                  <b>{p.displayName || p.name}</b>
                  <div className="muted">{p.description}</div>
                  <div className="muted">{p.author}{p.license ? ` · ${p.license}` : ''}</div>
                </td>
                <td>{p.version}</td>
                <td className="muted">{(p.hooks ?? []).join(', ') || '—'}</td>
                <td className="muted" title={p.source}>{p.source.slice(0, 30)}…</td>
                <td>{p.enabled ? '✅ 启用' : '⏸ 停用'}</td>
                <td>
                  <button disabled={busy} onClick={() => post(`/api/plugins/${p.id}/${p.enabled ? 'disable' : 'enable'}`, {}, p.enabled ? '已停用' : '已启用')}>
                    {p.enabled ? '停用' : '启用'}
                  </button>{' '}
                  <button disabled={busy} onClick={() => post(`/api/plugins/${p.id}/update`, {}, '已更新')}>更新</button>{' '}
                  <button disabled={busy} onClick={() => post(`/api/plugins/${p.id}/uninstall`, {}, '已卸载')}>卸载</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">插件 = git 仓库（manifest.json 声明 + 可选 server.js 服务端钩子）。服务端钩子在 node:vm 沙箱执行，支持 onMessageSend / onProsePostProcess / onSessionStart / onSessionEnd 等钩子与 per-plugin storage。</p>
    </div>
  );
}
