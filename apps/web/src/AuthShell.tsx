import React, { useEffect, useMemo, useState } from 'react';
import {
  DEVICE_SCOPES,
  isDeviceListResult,
  isDeviceRevocationResult,
  isIssuedPairingCode,
  type DeviceScope,
  type IssuedPairingCode,
  type PublicDeviceDescriptor,
} from '../../../packages/mobile-contracts/src/index.ts';
import { ClientStorageNamespace } from '../../../packages/client-runtime/src/index.ts';
import { App } from './App.tsx';
import { localClientId } from './localClientIdentity.ts';
import { useOnlineStatus } from './hooks/useOnlineStatus.ts';
import {
  authClient,
  authFetch,
  type WebAuthFailure,
  type WebAuthState,
} from './authClient.ts';
import { WEB_CLIENT_PROFILE } from './clientProfile.ts';

const AUTH_CHANNEL = 'jg-auth-state-v1';
const DEFAULT_DEVICE_NAME = WEB_CLIENT_PROFILE.profile === 'android-bundled' ? '酒馆 Android' : '手机浏览器';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

async function responsePayload(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function responseError(response: Response, payload: unknown): Error {
  const row = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const message = typeof row.error === 'string' ? row.error : '请求失败（HTTP ' + response.status + '）';
  return new Error(message);
}

function useAuthState(): WebAuthState {
  const [state, setState] = useState<WebAuthState>(authClient.state);
  useEffect(() => authClient.subscribe(setState), []);
  return state;
}

function signalAuthRefresh(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.postMessage('refresh');
  channel.close();
}

function isLoopbackPage(): boolean {
  if (typeof location === 'undefined') return false;
  return location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname === '[::1]';
}

function PairingPage({ onNotice, recovery = false }: { onNotice: (message: string) => void; recovery?: boolean }) {
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState(DEFAULT_DEVICE_NAME);
  const [scopes, setScopes] = useState<DeviceScope[]>([...DEVICE_SCOPES]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggleScope = (scope: DeviceScope): void => {
    setScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (scopes.length === 0) {
      setError('至少选择一个权限');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await authClient.pair({
        code: code.trim(),
        transport: 'same-origin-cookie',
        device: { displayName: displayName.trim(), platform: 'web' },
        requestedScopes: scopes,
      });
      setCode('');
      signalAuthRefresh();
      onNotice('设备已安全配对');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-gate">
      <form className="auth-card" onSubmit={(event) => { void submit(event); }}>
        <div className="auth-brand">酒馆 · 私有连接</div>
        <h1>配对这台设备</h1>
        <p className="auth-lead">
          在电脑端生成一次性配对码，然后在这里输入。配对码只用于本次请求，不会写入浏览器存储或网址。
        </p>
        {recovery && (
          <div className="auth-recovery" role="status">
            原配对已失效或被吊销。会话数据仍在电脑端，请生成新的一次性配对码重新连接。
          </div>
        )}
        <label>
          设备名称
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={120}
            required
            autoComplete="off"
          />
        </label>
        <label>
          一次性配对码
          <input
            className="auth-code-input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="jgp1_…"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <details className="auth-scope-box">
          <summary>本设备申请的权限</summary>
          <div className="auth-scope-grid">
            {DEVICE_SCOPES.map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                {scope}
              </label>
            ))}
          </div>
          <p>申请权限必须是电脑端签发范围的子集；移动端完整管理通常需要全部权限。</p>
        </details>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="auth-primary" type="submit" disabled={busy}>
          {busy ? '正在配对…' : '安全配对'}
        </button>
        <p className="auth-footnote">
          {WEB_CLIENT_PROFILE.profile === 'android-bundled'
            ? '设备凭据只保存在 Android Keystore 中，不会写入网页存储。'
            : '安全 Cookie 只会在已配置的私有 HTTPS 地址上生效。'}
        </p>
      </form>
    </main>
  );
}

function DeviceSecurityPanel({ onClose, onNotice }: {
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const state = authClient.state;
  const auth = state.phase === 'authenticated' ? state.auth : null;
  const admin = auth?.device.scopes.includes('admin') === true;
  const [devices, setDevices] = useState<PublicDeviceDescriptor[]>([]);
  const [issued, setIssued] = useState<IssuedPairingCode | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [allowedScopes, setAllowedScopes] = useState<DeviceScope[]>([...DEVICE_SCOPES]);

  const activeDevices = useMemo(
    () => [...devices].sort((left, right) => {
      if (left.id === auth?.device.id) return -1;
      if (right.id === auth?.device.id) return 1;
      if (!left.revokedAt && right.revokedAt) return -1;
      if (left.revokedAt && !right.revokedAt) return 1;
      return right.createdAt.localeCompare(left.createdAt);
    }),
    [devices, auth?.device.id],
  );

  const loadDevices = async (): Promise<void> => {
    if (!admin) return;
    setBusy('devices');
    setError('');
    try {
      const response = await authFetch('/api/auth/devices');
      const payload = await responsePayload(response);
      if (!response.ok) throw responseError(response, payload);
      if (!isDeviceListResult(payload)) throw new Error('设备列表响应不符合协议');
      setDevices(payload.devices);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  useEffect(() => { void loadDevices(); }, [admin]);

  const issueCode = async (): Promise<void> => {
    if (allowedScopes.length === 0) {
      setError('至少为新设备选择一个权限');
      return;
    }
    setBusy('issue');
    setError('');
    setIssued(null);
    try {
      const response = await authFetch('/api/auth/pairing-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowedScopes,
          allowedTransports: ['same-origin-cookie'],
          ttlSeconds: 900,
          displayNameHint: 'Web 配对',
        }),
      });
      const payload = await responsePayload(response);
      if (!response.ok) throw responseError(response, payload);
      if (!isIssuedPairingCode(payload)) throw new Error('配对码响应不符合协议');
      setIssued(payload);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  const revoke = async (device: PublicDeviceDescriptor): Promise<void> => {
    if (!window.confirm('确定吊销设备“' + device.displayName + '”吗？它的活动请求会立即中止。')) return;
    setBusy('revoke:' + device.id);
    setError('');
    try {
      const response = await authFetch(
        '/api/auth/devices/' + encodeURIComponent(device.id) + '/revoke',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const payload = await responsePayload(response);
      if (!response.ok) throw responseError(response, payload);
      if (!isDeviceRevocationResult(payload)) throw new Error('吊销响应不符合协议');
      signalAuthRefresh();
      if (device.id === auth?.device.id) {
        authClient.clearSession();
        return;
      }
      onNotice('设备已吊销');
      await loadDevices();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  const logout = async (): Promise<void> => {
    setBusy('logout');
    setError('');
    try {
      await authClient.logout();
      signalAuthRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  if (!auth) return null;
  return (
    <div className="auth-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="auth-security-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设备与安全"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="auth-brand">设备与安全</span>
            <h2>{auth.device.displayName}</h2>
          </div>
          <button className="auth-icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <div className="auth-current">
          <span>当前设备</span>
          <strong>{auth.device.platform} · {auth.device.scopes.join(', ')}</strong>
          <small>会话到期：{auth.session.expiresAt ? new Date(auth.session.expiresAt).toLocaleString() : '未指定'}</small>
        </div>

        {admin && (
          <>
            <div className="auth-section">
              <div className="auth-section-title">
                <h3>生成一次性配对码</h3>
                <span>15 分钟有效，仅显示在当前面板内</span>
              </div>
              <div className="auth-scope-grid compact">
                {DEVICE_SCOPES.map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={allowedScopes.includes(scope)}
                      onChange={() => setAllowedScopes((current) => current.includes(scope)
                        ? current.filter((item) => item !== scope)
                        : [...current, scope])}
                    />
                    {scope}
                  </label>
                ))}
              </div>
              <button className="auth-secondary" onClick={() => { void issueCode(); }} disabled={busy !== ''}>
                {busy === 'issue' ? '正在生成…' : '生成 Web 配对码'}
              </button>
              {issued && (
                <div className="auth-issued" aria-live="polite">
                  <span>请立即在新设备输入；关闭面板后不再显示</span>
                  <code>{issued.code}</code>
                  <small>到期：{new Date(issued.expiresAt).toLocaleString()}</small>
                </div>
              )}
            </div>

            <div className="auth-section">
              <div className="auth-section-title">
                <h3>已配对设备</h3>
                <button className="auth-link-button" onClick={() => { void loadDevices(); }} disabled={busy !== ''}>
                  刷新
                </button>
              </div>
              <div className="auth-device-list">
                {activeDevices.map((device) => (
                  <article className="auth-device-row" key={device.id}>
                    <div>
                      <strong>{device.displayName}{device.id === auth.device.id ? '（当前）' : ''}</strong>
                      <span>{device.platform} · {device.scopes.join(', ')}</span>
                      <small>
                        {device.revokedAt
                          ? '已吊销 ' + new Date(device.revokedAt).toLocaleString()
                          : '最近活动 ' + new Date(device.lastSeenAt ?? device.createdAt).toLocaleString()}
                      </small>
                    </div>
                    {!device.revokedAt && (
                      <button
                        className="auth-danger-button"
                        onClick={() => { void revoke(device); }}
                        disabled={busy !== ''}
                      >
                        {busy === 'revoke:' + device.id ? '吊销中…' : '吊销'}
                      </button>
                    )}
                  </article>
                ))}
                {busy === 'devices' && <p className="auth-muted">正在读取设备…</p>}
                {busy !== 'devices' && activeDevices.length === 0 && <p className="auth-muted">暂无设备记录</p>}
              </div>
            </div>
          </>
        )}

        {!admin && <p className="auth-muted">当前设备没有 admin 权限，不能签发配对码或管理其他设备。</p>}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <footer>
          <button className="auth-danger-button" onClick={() => { void logout(); }} disabled={busy !== ''}>
            {busy === 'logout' ? '正在退出…' : '退出当前设备'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function AuthShell() {
  const state = useAuthState();
  const online = useOnlineStatus();
  const [securityOpen, setSecurityOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [everPaired, setEverPaired] = useState(false);
  const serverId = 'meta' in state ? state.meta.serverId : '';
  const storageClientId = state.phase === 'authenticated'
    ? state.auth.device.id
    : state.phase === 'local-only'
      ? localClientId()
      : '';
  const storageNamespace = useMemo(
    () => serverId && storageClientId
      ? new ClientStorageNamespace({ serverId, clientId: storageClientId })
      : null,
    [serverId, storageClientId],
  );

  useEffect(() => {
    if (state.phase === 'authenticated') setEverPaired(true);
  }, [state.phase]);

  useEffect(() => {
    const refresh = (): void => {
      if (authClient.state.phase !== 'local-only') void authClient.refreshSession();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(AUTH_CHANNEL);
    if (channel) channel.onmessage = refresh;
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      channel?.close();
    };
  }, []);

  useEffect(() => authClient.subscribeFailures((failure: WebAuthFailure) => {
    if (failure.status === 401) setSecurityOpen(false);
    else if (failure.status === 429) {
      setNotice('请求过快，请在 ' + (failure.retryAfterSeconds ?? 0) + ' 秒后重试');
    } else {
      setNotice(failure.message);
    }
  }), []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (state.phase === 'unknown') {
    return <main className="auth-gate"><div className="auth-card"><p>正在建立安全连接…</p></div></main>;
  }
  if (state.phase === 'unreachable') {
    const loopback = isLoopbackPage();
    return (
      <main className="auth-gate">
        <div className="auth-card">
          <h1>{online ? (loopback ? '本机酒馆后端不可达' : '电脑端私有连接不可达') : '手机当前没有网络'}</h1>
          <p className="auth-lead">
            {online
              ? (loopback
                  ? '请确认一键启动的 API 窗口仍在运行。' + state.message
                  : '请确认电脑端酒馆与 Tailscale/私有 HTTPS 连接仍在运行。' + state.message)
              : '恢复手机网络后再重试；无需清除配对或应用数据。'}
          </p>
          <button className="auth-primary" onClick={() => { void authClient.refreshSession(); }}>重新连接</button>
        </div>
      </main>
    );
  }
  if (state.phase === 'incompatible') {
    const upgradeClient = state.upgrade === 'client';
    return (
      <main className="auth-gate">
        <div className="auth-card">
          <div className="auth-brand">酒馆 · 协议保护</div>
          <h1>{upgradeClient ? '需要升级客户端' : '需要升级电脑端'}</h1>
          <p className="auth-lead">
            当前客户端协议为 {state.clientProtocol}，电脑端支持 {state.minClientProtocol}–{state.maxClientProtocol}。
            已进入只读升级模式，写操作已在网络前禁用。
          </p>
          <p>电脑端版本：{state.meta.app.version}</p>
          <button className="auth-primary" onClick={() => { void authClient.refreshSession(); }}>
            升级后重新检测
          </button>
        </div>
      </main>
    );
  }
  if (state.phase === 'unauthenticated') {
    return <PairingPage onNotice={setNotice} recovery={everPaired} />;
  }

  return (
    <>
      <App storageNamespace={storageNamespace!} />
      {state.phase === 'authenticated' && (
        <>
          <button className="auth-security-launcher" onClick={() => setSecurityOpen(true)}>
            安全 · {state.auth.device.displayName}
          </button>
          {securityOpen && (
            <DeviceSecurityPanel onClose={() => setSecurityOpen(false)} onNotice={setNotice} />
          )}
        </>
      )}
      {notice && <div className="auth-toast" role="status">{notice}</div>}
    </>
  );
}
