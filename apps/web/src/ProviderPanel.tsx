import React, { useEffect, useMemo, useState } from 'react';
import { authFetch } from './authClient.ts';

const BUILTIN_PROVIDER_ID = 'builtin.openai';

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

interface ProviderCapabilities {
  listModels: boolean;
  stream: boolean;
  tools: boolean;
  vision: boolean;
  chatCompletions: boolean;
  responses?: boolean;
  messages?: boolean;
}

interface ProviderDescriptor {
  id: string;
  displayName: string;
  adapterVersion: string;
  protocolVersion: number;
  capabilities: ProviderCapabilities;
  configured: boolean;
}

interface ProviderModelInfo {
  id: string;
  displayName?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

interface ProviderDirectory {
  providers: ProviderDescriptor[];
  selectedProviderId: string;
  model: string;
}

interface HealthResult {
  ok: boolean;
  code?: string;
  detail?: string;
}

const CAPABILITY_LABELS: Array<[keyof ProviderCapabilities, string]> = [
  ['chatCompletions', '对话'],
  ['stream', '流式'],
  ['tools', '工具'],
  ['vision', '视觉'],
  ['listModels', '模型列表'],
  ['responses', 'Responses'],
  ['messages', 'Messages'],
];

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function responseError(data: Record<string, unknown>, status: number): string {
  return typeof data.error === 'string' && data.error.trim()
    ? data.error
    : `HTTP ${status}`;
}

/**
 * Provider 面板分成两层：
 * 1. 所有 Provider 共用的运行时选择、模型枚举和健康诊断；
 * 2. 仅 builtin.openai 可见的电脑端凭据配置。
 *
 * 插件 Provider 的 descriptor 只包含公开能力，前端不会为它们渲染或提交 Key/Base URL。
 */
export function ProviderPanel() {
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [legacyModel, setLegacyModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [legacyModels, setLegacyModels] = useState<string[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [dirty, setDirty] = useState(false);

  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState(BUILTIN_PROVIDER_ID);
  const [selectedModel, setSelectedModel] = useState('');
  const [providerModels, setProviderModels] = useState<ProviderModelInfo[] | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState('');

  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedDescriptor = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId),
    [providers, selectedProviderId],
  );
  const selectedMissing = catalogLoaded
    && selectedProviderId.length > 0
    && selectedDescriptor === undefined;
  const isBuiltin = selectedProviderId === BUILTIN_PROVIDER_ID;

  const reloadLegacy = async () => {
    try {
      const res = await authFetch('/api/provider');
      const data = await readJson(res);
      if (!res.ok) throw new Error(responseError(data, res.status));
      const next = data as unknown as ProviderInfo;
      setInfo(next);
      setBaseUrl(next.baseUrl ?? '');
      setLegacyModel(next.model ?? '');
      // API Key 永不从响应回填，输入框始终只保存本次用户草稿。
      setApiKey('');
    } catch (error) {
      setErr((error as Error).message);
    }
  };

  const reloadProviders = async (expectedProviderId?: string): Promise<ProviderDirectory> => {
    const res = await authFetch('/api/providers');
    const data = await readJson(res);
    if (!res.ok) throw new Error(responseError(data, res.status));
    if (!Array.isArray(data.providers)) throw new Error('Provider 目录响应缺少 providers');

    const next: ProviderDirectory = {
      providers: data.providers as ProviderDescriptor[],
      selectedProviderId: typeof data.selectedProviderId === 'string' ? data.selectedProviderId : '',
      model: typeof data.model === 'string' ? data.model : '',
    };
    setProviders(next.providers);
    setSelectedProviderId(next.selectedProviderId);
    setSelectedModel(next.model);
    setCatalogLoaded(true);

    const selectedExists = next.providers.some((provider) => provider.id === next.selectedProviderId);
    if (!next.selectedProviderId || !selectedExists) {
      const message = next.selectedProviderId
        ? `当前选中的 Provider「${next.selectedProviderId}」已卸载或未注册；不会自动切换到其他 Provider。`
        : '服务端未返回当前 Provider；不会自动选择目录中的第一项。';
      setCatalogError(message);
      if (expectedProviderId) throw new Error(message);
      return next;
    }
    if (expectedProviderId && next.selectedProviderId !== expectedProviderId) {
      const message = `Provider 切换未生效：请求「${expectedProviderId}」，服务端仍为「${next.selectedProviderId}」；不会静默回退。`;
      setCatalogError(message);
      throw new Error(message);
    }
    setCatalogError('');
    return next;
  };

  const reloadHistory = async () => {
    try {
      const data = await (await authFetch('/api/provider/history')).json();
      setHistory(Array.isArray(data.history) ? data.history : []);
    } catch {
      // 历史拉取失败不阻塞 Provider 运行时面板。
    }
  };

  useEffect(() => {
    void reloadLegacy();
    void reloadHistory();
    void reloadProviders().catch((error) => {
      setCatalogError(`Provider 目录加载失败：${(error as Error).message}`);
    });
  }, []);

  useEffect(() => {
    setDirty(Boolean(info)
      && (baseUrl !== info?.baseUrl || legacyModel !== info?.model || apiKey.trim() !== ''));
  }, [info, baseUrl, legacyModel, apiKey]);

  const selectProvider = async (providerId: string, model?: string) => {
    if (!providers.some((provider) => provider.id === providerId)) {
      setErr(`Provider「${providerId}」不在当前目录中；不会自动回退。`);
      return;
    }
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const res = await authFetch('/api/providers/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId,
          ...(model?.trim() ? { model: model.trim() } : {}),
        }),
      });
      const data = await readJson(res);
      if (!res.ok || data.ok === false) throw new Error(responseError(data, res.status));

      // 只有服务端明确确认成功后才更新选择；失败时保留原选择，不取 providers[0] 兜底。
      setSelectedProviderId(providerId);
      if (model?.trim()) setSelectedModel(model.trim());
      setProviderModels(null);
      setHealth(null);
      const directory = await reloadProviders(providerId);
      if (providerId === BUILTIN_PROVIDER_ID) setLegacyModel(directory.model);
      const descriptor = directory.providers.find((provider) => provider.id === providerId);
      setMsg(`已切换 Provider：${descriptor?.displayName ?? providerId}${directory.model ? ` · ${directory.model}` : ''}`);
    } catch (error) {
      setErr(`Provider 切换失败：${(error as Error).message}（不会自动回退）`);
    } finally {
      setBusy(false);
    }
  };

  const refreshProviderModels = async () => {
    if (!selectedDescriptor?.configured || !selectedDescriptor.capabilities.listModels) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const encodedId = encodeURIComponent(selectedDescriptor.id);
      const res = await authFetch(`/api/providers/${encodedId}/models`);
      const data = await readJson(res);
      if (!res.ok || data.ok === false) throw new Error(responseError(data, res.status));
      const nextModels = Array.isArray(data.models) ? data.models as ProviderModelInfo[] : [];
      setProviderModels(nextModels);
      setMsg(`已刷新 ${selectedDescriptor.displayName} 的模型列表，共 ${nextModels.length} 个。`);
    } catch (error) {
      setErr(`模型刷新失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const diagnoseProvider = async () => {
    if (!selectedDescriptor) return;
    setBusy(true);
    setErr('');
    setMsg('');
    setHealth(null);
    try {
      const encodedId = encodeURIComponent(selectedDescriptor.id);
      const res = await authFetch(`/api/providers/${encodedId}/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(responseError(data, res.status));
      const result = data.health as HealthResult | undefined;
      if (!result || typeof result.ok !== 'boolean') {
        throw new Error(data.ok === false ? responseError(data, res.status) : '健康诊断响应缺少 health');
      }
      setHealth(result);
    } catch (error) {
      setErr(`健康诊断失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const testLegacy = async () => {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const res = await authFetch('/api/provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          model: legacyModel.trim() || undefined,
        }),
      });
      const data = await readJson(res);
      if (!res.ok || data.ok === false) throw new Error(responseError(data, res.status));
      const nextModels = Array.isArray(data.models) ? data.models as string[] : [];
      setLegacyModels(nextModels);
      if (Array.isArray(data.history)) setHistory(data.history as HistoryEntry[]);
      else void reloadHistory();
      setMsg(`✅ 连接成功：URL + Key 校验通过，共 ${Number(data.count ?? nextModels.length)} 个模型（展示前 ${nextModels.length} 个）。可选择模型后保存。`);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickHistory = (entry: HistoryEntry) => {
    setBaseUrl(entry.baseUrl);
    setLegacyModel(entry.model || '');
    setLegacyModels(null);
  };

  const deleteHistory = async (entry: HistoryEntry) => {
    setBusy(true);
    setErr('');
    try {
      const res = await authFetch('/api/provider/history/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: entry.baseUrl }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(responseError(data, res.status));
      setHistory(Array.isArray(data.history) ? data.history as HistoryEntry[] : []);
    } catch (error) {
      setErr((error as Error).message);
      void reloadHistory();
    } finally {
      setBusy(false);
    }
  };

  const saveLegacy = async () => {
    if (!baseUrl.trim() && !legacyModel.trim() && !apiKey.trim()) {
      setErr('AI Base URL / 模型 / API key 至少填一项');
      return;
    }
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const res = await authFetch('/api/provider/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          model: legacyModel.trim(),
          apiKey: apiKey.trim() || undefined,
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(responseError(data, res.status));
      const next = data as unknown as ProviderInfo;
      setInfo(next);
      setApiKey('');
      setLegacyModel(next.model ?? '');
      setSelectedModel(next.model ?? '');
      setMsg(`已保存并即时生效：Base URL=${next.baseUrl}，模型=${next.model}${next.hasKey ? `，Key ${next.keyFingerprint ?? ''}` : '（未配置 Key）'}`);
      void reloadProviders(BUILTIN_PROVIDER_ID).catch((error) => {
        setCatalogError(`配置已保存，但 Provider 目录刷新失败：${(error as Error).message}`);
      });
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="console">
      <section className="console-section provider-runtime">
        <h3>Provider 运行时</h3>
        <div className="provider-form">
          <label htmlFor="jg-provider-select">当前 Provider</label>
          <select
            id="jg-provider-select"
            value={selectedProviderId}
            onChange={(event) => void selectProvider(event.target.value)}
            disabled={busy || !catalogLoaded}
          >
            {selectedMissing && (
              <option value={selectedProviderId}>⚠ 已卸载：{selectedProviderId}</option>
            )}
            {!catalogLoaded && (
              <option value={selectedProviderId}>正在读取 Provider 目录…</option>
            )}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName} · {provider.id}{provider.configured ? '' : '（未配置）'}
              </option>
            ))}
          </select>
        </div>

        {selectedDescriptor && (
          <>
            <div className="provider-summary">
              <span className={`provider-badge ${selectedDescriptor.configured ? 'provider-badge-ok' : 'provider-badge-off'}`}>
                {selectedDescriptor.configured ? '已配置' : '未配置'}
              </span>
              <span className="provider-id">{selectedDescriptor.id}</span>
              <span className="console-meta">adapter {selectedDescriptor.adapterVersion} · SPI v{selectedDescriptor.protocolVersion}</span>
            </div>
            <div className="provider-capabilities" aria-label="Provider 能力">
              {CAPABILITY_LABELS.map(([capability, label]) => {
                const enabled = selectedDescriptor.capabilities[capability] === true;
                return (
                  <span
                    key={capability}
                    className={`provider-capability ${enabled ? 'provider-capability-on' : 'provider-capability-off'}`}
                    title={enabled ? `${label}：支持` : `${label}：未启用`}
                  >
                    {enabled ? '✓' : '–'} {label}
                  </span>
                );
              })}
            </div>
            <div className="provider-actions">
              <button
                onClick={() => void refreshProviderModels()}
                disabled={busy || !selectedDescriptor.configured || !selectedDescriptor.capabilities.listModels}
                title={!selectedDescriptor.configured
                  ? 'Provider 未配置，不能读取模型'
                  : !selectedDescriptor.capabilities.listModels ? 'Provider 未声明模型列表能力' : '刷新模型列表'}
              >
                ↻ 刷新模型
              </button>
              <button onClick={() => void diagnoseProvider()} disabled={busy}>
                ♡ 健康诊断
              </button>
            </div>
            <table className="console-table">
              <tbody>
                <tr><td>当前模型</td><td>{selectedModel || '未设置'}</td></tr>
              </tbody>
            </table>
            {!selectedDescriptor.configured && (
              <p className="provider-warning">此 Provider 尚未配置，模型刷新与生成调用不可用；仍可执行不读取凭据的健康诊断。</p>
            )}
            {providerModels && (
              <div className="model-picks">
                <span className="console-meta">可用模型 {providerModels.length} 个 · 点击即切换：</span>
                {providerModels.length > 0 ? (
                  <div className="model-tags">
                    {providerModels.map((providerModel) => (
                      <button
                        key={providerModel.id}
                        className={`model-tag${providerModel.id === selectedModel ? ' model-tag-active' : ''}`}
                        onClick={() => void selectProvider(selectedDescriptor.id, providerModel.id)}
                        disabled={busy || !selectedDescriptor.configured}
                        title={providerModel.id}
                      >
                        {providerModel.displayName ?? providerModel.id}
                      </button>
                    ))}
                  </div>
                ) : <p className="console-meta">Provider 返回了空模型列表。</p>}
              </div>
            )}
            {health && (
              <p className={health.ok ? 'ok' : 'error'}>
                {health.ok ? '✅ Provider 健康' : '❌ Provider 异常'}
                {health.code ? ` · ${health.code}` : ''}
                {health.detail ? `：${health.detail}` : ''}
              </p>
            )}
          </>
        )}

        {catalogError && <p className="error">{catalogError}</p>}
        {selectedMissing && (
          <p className="provider-warning">
            请重新安装对应插件，或手动选择一个已注册且已配置的 Provider；系统不会代替你选第一项。
          </p>
        )}
      </section>

      {isBuiltin && (
        <section className="console-section">
          <h3>OpenAI 兼容配置（仅电脑端 builtin.openai；Key 不回显）</h3>
          <div className="provider-form">
            {history.length > 0 && (
              <div className="provider-history">
                <label>历史 URL（测试成功自动记忆 · 下拉回填 URL + 模型）</label>
                <select value="" onChange={(event) => {
                  const hit = history.find((entry) => entry.baseUrl === event.target.value);
                  if (hit) pickHistory(hit);
                }} disabled={busy}>
                  <option value="" disabled>历史 URL 快速切换…</option>
                  {history.map((entry) => (
                    <option key={entry.baseUrl} value={entry.baseUrl}>
                      {entry.baseUrl}{entry.model ? ` · ${entry.model}` : ''}
                    </option>
                  ))}
                </select>
                <div className="history-chips">
                  {history.map((entry) => (
                    <span key={entry.baseUrl} className="history-chip">
                      <button className="model-tag" onClick={() => pickHistory(entry)} disabled={busy} title={`回填 ${entry.baseUrl}`}>
                        {entry.baseUrl}{entry.model ? ` · ${entry.model}` : ''}
                      </button>
                      <button className="mini-btn" onClick={() => void deleteHistory(entry)} disabled={busy} title="删除该历史">✕</button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <label>AI Base URL（OpenAI 兼容，不含 /v1）</label>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://opencode.ai/zen/go" spellCheck={false} />
            <label>API Key</label>
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…（留空 = 保留已保存/环境变量 Key）" spellCheck={false} autoComplete="new-password" />
            <label>模型（可手输；测试后可从列表选择）</label>
            <input list="jg-model-list" value={legacyModel} onChange={(event) => setLegacyModel(event.target.value)} placeholder="deepseek-v4-flash" spellCheck={false} />
            <datalist id="jg-model-list">
              {(legacyModels ?? []).map((entry) => <option key={entry} value={entry} />)}
            </datalist>
          </div>
          <div className="provider-actions">
            <button onClick={() => void testLegacy()} disabled={busy}>⚡ 测试连接（URL + Key）</button>
            <button onClick={() => void saveLegacy()} disabled={busy}>💾 保存并生效</button>
          </div>
          {legacyModels && legacyModels.length > 0 && (
            <div className="model-picks">
              <span className="console-meta">可用模型 {legacyModels.length} 个 · 点击选择：</span>
              <div className="model-tags">
                {legacyModels.map((entry) => (
                  <button key={entry} className={`model-tag${entry === legacyModel ? ' model-tag-active' : ''}`} onClick={() => setLegacyModel(entry)} disabled={busy} title={entry}>{entry}</button>
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
        </section>
      )}

      {msg && <p className="ok">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
