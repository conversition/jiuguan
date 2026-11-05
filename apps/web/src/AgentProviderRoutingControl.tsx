import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchAgentProviderDirectory,
  fetchAgentProviderModels,
  fetchAgentProviderRouting,
  updateAgentProviderRouting,
  type AgentProviderDescriptor,
  type AgentProviderMode,
  type AgentProviderModelInfo,
  type AgentProviderRouting,
} from './agentProviderClient.ts';

const EFFECTIVE_REFRESH_MS = 10_000;

export function AgentProviderRoutingControl(props: { readonly refreshKey: string }) {
  const [routing, setRouting] = useState<AgentProviderRouting | null>(null);
  const [providers, setProviders] = useState<readonly AgentProviderDescriptor[]>([]);
  const [mode, setMode] = useState<AgentProviderMode>('inherit-main');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<readonly AgentProviderModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [modelLoading, setModelLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providers, providerId],
  );
  const currentModelExists = models.some((item) => item.id === model);
  const canSaveOverride = mode === 'override'
    && Boolean(selectedProvider?.configured)
    && selectedProvider?.capabilities.listModels === true
    && currentModelExists;
  const unchanged = routing?.mode === mode
    && (mode === 'inherit-main'
      || (routing.providerId === providerId && routing.model === model));

  const loadModels = useCallback(async (
    nextProviderId: string,
    preferredModel = '',
    signal?: AbortSignal,
  ) => {
    const descriptor = providers.find((provider) => provider.id === nextProviderId);
    setModels([]);
    setModel('');
    if (!descriptor?.configured || !descriptor.capabilities.listModels) return;
    setModelLoading(true);
    try {
      const nextModels = await fetchAgentProviderModels(nextProviderId, { signal });
      setModels(nextModels);
      setModel(nextModels.some((item) => item.id === preferredModel) ? preferredModel : '');
    } catch (reason) {
      if ((reason as { name?: string }).name !== 'AbortError') {
        setError(`模型列表读取失败：${reason instanceof Error ? reason.message : '未知错误'}`);
      }
    } finally {
      if (!signal?.aborted) setModelLoading(false);
    }
  }, [providers]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([
      fetchAgentProviderRouting({ signal: controller.signal }),
      fetchAgentProviderDirectory({ signal: controller.signal }),
    ]).then(([nextRouting, directory]) => {
      if (controller.signal.aborted) return;
      setRouting(nextRouting);
      setProviders(directory.providers);
      setMode(nextRouting.mode);
      const initialProviderId = nextRouting.mode === 'override'
        ? nextRouting.providerId ?? ''
        : nextRouting.effectiveProviderId;
      const initialModel = nextRouting.mode === 'override'
        ? nextRouting.model ?? ''
        : nextRouting.effectiveModel;
      setProviderId(initialProviderId);
      setModel(initialModel);
    }).catch((reason: unknown) => {
      if ((reason as { name?: string }).name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : 'Agent 模型路由读取失败');
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  // 目录加载完成后，以服务端当前生效模型初始化受约束的模型下拉框。
  useEffect(() => {
    if (providers.length === 0 || !providerId) return;
    const controller = new AbortController();
    const preferred = mode === 'override' ? routing?.model ?? model : routing?.effectiveModel ?? model;
    void loadModels(providerId, preferred, controller.signal);
    return () => controller.abort();
    // providerId 变化由 onProviderChange 显式处理，避免同一次交互重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const refreshEffective = useCallback(async (signal?: AbortSignal) => {
    try {
      setRouting(await fetchAgentProviderRouting({ signal }));
    } catch (reason) {
      if ((reason as { name?: string }).name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : 'Agent 模型路由刷新失败');
      }
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    const controller = new AbortController();
    void refreshEffective(controller.signal);
    return () => controller.abort();
  }, [props.refreshKey, loading, refreshEffective]);

  useEffect(() => {
    if (loading || typeof window === 'undefined') return;
    const timer = window.setInterval(() => { void refreshEffective(); }, EFFECTIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loading, refreshEffective]);

  const onProviderChange = async (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setNotice('');
    setError('');
    await loadModels(nextProviderId);
  };

  const save = async () => {
    if (mode === 'override' && !canSaveOverride) {
      setError('请选择一个已配置、支持模型列表的 Provider，并从返回列表中选择模型。');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await updateAgentProviderRouting(mode === 'inherit-main'
        ? { mode: 'inherit-main' }
        : { mode: 'override', providerId, model });
      setRouting(next);
      setMode(next.mode);
      setNotice(next.mode === 'inherit-main'
        ? 'Agent 已改为跟随主对话；主对话切换 Provider/模型后会自动生效。'
        : `Agent 独立路由已生效：${next.effectiveProviderId} · ${next.effectiveModel}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Agent 模型路由保存失败');
    } finally {
      setSaving(false);
    }
  };

  const effectiveName = routing?.provider?.displayName
    ?? providers.find((provider) => provider.id === routing?.effectiveProviderId)?.displayName
    ?? routing?.effectiveProviderId
    ?? '未知 Provider';

  return (
    <div className="agent-status__controls agent-provider-routing" data-testid="agent-provider-routing">
      <div className="agent-provider-routing__heading">
        <h3>Agent 模型路由</h3>
        <span data-available={routing?.available ? '1' : '0'}>
          {loading ? '读取中…' : routing?.available ? '可用' : '不可用'}
        </span>
      </div>
      {routing && (
        <p className="agent-provider-routing__effective" aria-live="polite">
          当前生效：<strong>{effectiveName}</strong>
          <span>{routing.effectiveProviderId} · {routing.effectiveModel}</span>
        </p>
      )}
      <div className="agent-provider-routing__mode" role="radiogroup" aria-label="Agent Provider 路由方式">
        <label>
          <input type="radio" name="agent-provider-mode" value="inherit-main"
            checked={mode === 'inherit-main'} disabled={loading || saving}
            onChange={() => { setMode('inherit-main'); setError(''); setNotice(''); }} />
          <span><strong>跟随主对话（推荐）</strong><small>Agent 自动使用主对话当前的 Provider 与模型</small></span>
        </label>
        <label>
          <input type="radio" name="agent-provider-mode" value="override"
            checked={mode === 'override'} disabled={loading || saving}
            onChange={() => { setMode('override'); setError(''); setNotice(''); }} />
          <span><strong>独立配置</strong><small>只从已注册 Provider 的公开模型列表选择</small></span>
        </label>
      </div>
      {mode === 'override' && (
        <div className="agent-provider-routing__override">
          <label htmlFor="jg-agent-provider">Agent Provider</label>
          <select id="jg-agent-provider" value={providerId} disabled={loading || saving}
            onChange={(event) => void onProviderChange(event.target.value)}>
            <option value="">请选择 Provider…</option>
            {providerId && !providers.some((provider) => provider.id === providerId) && (
              <option value={providerId} disabled>已卸载：{providerId}</option>
            )}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}
                disabled={!provider.configured || !provider.capabilities.listModels}>
                {provider.displayName} · {provider.id}
                {!provider.configured ? '（未配置）' : !provider.capabilities.listModels ? '（无模型目录）' : ''}
              </option>
            ))}
          </select>
          <label htmlFor="jg-agent-model">Agent 模型</label>
          <select id="jg-agent-model" value={currentModelExists ? model : ''}
            disabled={saving || modelLoading || !selectedProvider?.configured
              || !selectedProvider.capabilities.listModels}
            onChange={(event) => { setModel(event.target.value); setError(''); setNotice(''); }}>
            <option value="">{modelLoading ? '正在读取模型…' : '请选择模型…'}</option>
            {models.map((item) => (
              <option key={item.id} value={item.id}>{item.displayName ?? item.id}</option>
            ))}
          </select>
          {selectedProvider && (!selectedProvider.configured || !selectedProvider.capabilities.listModels) && (
            <small className="agent-provider-routing__hint">
              {!selectedProvider.configured ? '该 Provider 尚未在电脑端配置。' : '该 Provider 不提供可验证的模型列表，不能用于独立路由。'}
            </small>
          )}
        </div>
      )}
      {!loading && routing && !routing.available && (
        <p className="agent-provider-routing__warning">当前生效 Provider 已卸载或不可用；请恢复插件，或改为可用的独立路由。</p>
      )}
      {error && <p className="agent-status__error" role="alert">{error}</p>}
      {notice && <p className="agent-provider-routing__notice" role="status">{notice}</p>}
      <div className="agent-provider-routing__actions">
        <button type="button" disabled={loading || saving || unchanged
          || (mode === 'override' && !canSaveOverride)} onClick={() => void save()}>
          {saving ? '保存中…' : '应用 Agent 路由'}
        </button>
        <button type="button" disabled={loading || saving} onClick={() => void refreshEffective()}>
          刷新生效状态
        </button>
      </div>
      <small className="agent-provider-routing__privacy">
        Agent 只保存 Provider ID 与模型名；凭据和连接地址继续由电脑端 Provider 统一保管。
      </small>
    </div>
  );
}
