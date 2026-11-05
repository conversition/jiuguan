import React, { useEffect, useRef, useState } from 'react';
import { authClient, authFetch } from './authClient.ts';

interface PinState {
  revision: number; writesEnabled: boolean; profileId: string; currentRevisionConsumed: boolean;
  fixedPackage: { skillId: string; version: string; packageDigest: string };
  pin: { revision: number; enabled: boolean; sessionId: string | null; expiresAt: string | null } | null;
  preflight: { blockers: string[]; potentialReady: boolean };
}
interface Comparison {
  candidateId: string; state: 'off' | 'profile-not-supported' | 'configured'; profileId: string;
  actualInvocation: false; authorizesReplacement: false;
  active: { skillId: string; version: string; manifestDigest: string; bodyHash: string; catalogRevision: string } | null;
  diff: { changes: { path: string; kind: string; left: string | null; right: string | null }[];
    truncated: boolean; program: { orderChanged: boolean } | null } | null;
}
/** The server owns every gate; this panel only carries a displayed revision back for CAS. */
export function SkillGovernancePanel({ sessionId, candidateId }: { sessionId?: string; candidateId: string }) {
  const [state, setState] = useState<PinState | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState(sessionId ?? '');
  const [hours, setHours] = useState('1');
  const [reason, setReason] = useState('admin-pin');
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setTarget(sessionId ?? ''); setState(null); setComparison(null); setBusy(false); }, [sessionId, candidateId]);
  useEffect(() => authClient.subscribeFailures(failure => {
    if (failure.status === 401 || failure.status === 403) { epoch.current++; setState(null); setComparison(null); setBusy(false); setError(failure.code); }
  }), []);
  useEffect(() => () => { epoch.current++; }, []);
  async function refresh() {
    const requestEpoch = ++epoch.current; setBusy(true); setError(''); setState(null);
    try {
      const response = await authFetch('/api/skills/governance/pin');
      const body = await response.json();
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      const value = body.governance as PinState;
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.writesEnabled !== 'boolean'
        || value.profileId !== 'style.compose' || !Array.isArray(value.preflight?.blockers)
        || typeof value.currentRevisionConsumed !== 'boolean' || !value.fixedPackage?.packageDigest
        || (value.pin && value.pin.revision !== value.revision)) throw new Error('Pin 响应无效');
      if (requestEpoch === epoch.current) setState(value);
    } catch (cause) { if (requestEpoch === epoch.current) setError((cause as Error).message); }
    finally { if (requestEpoch === epoch.current) setBusy(false); }
  }
  async function changePin(enabled: boolean) {
    if (!state || !state.writesEnabled) return;
    const duration = Number(hours);
    if (enabled && (!target.trim() || !Number.isFinite(duration) || duration <= 0 || duration > 24)) {
      setError('填写精确会话 ID 和 0～24 小时有效期'); return;
    }
    const requestEpoch = ++epoch.current; setBusy(true); setError(''); setComparison(null);
    try {
      const response = await authFetch('/api/skills/governance/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: state.revision, enabled, sessionId: enabled ? target.trim() : null,
          expiresAt: enabled ? new Date(Date.now() + duration * 3_600_000).toISOString() : null, reason: reason.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      if (requestEpoch === epoch.current) await refresh();
    } catch (cause) { if (requestEpoch === epoch.current) { setState(null); setError((cause as Error).message); } }
    finally { if (requestEpoch === epoch.current) setBusy(false); }
  }
  async function compare() {
    if (!candidateId) return;
    const requestEpoch = ++epoch.current; setBusy(true); setError(''); setComparison(null);
    try {
      const response = await authFetch(`/api/skills/candidates/${encodeURIComponent(candidateId)}/active-diff`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      const value = body.comparison as Comparison;
      if (!value || value.candidateId !== candidateId || value.actualInvocation !== false || value.authorizesReplacement !== false
        || !['off', 'profile-not-supported', 'configured'].includes(value.state)
        || (value.state === 'configured' && (!value.active || !Array.isArray(value.diff?.changes)))) throw new Error('基线比较响应无效');
      if (requestEpoch === epoch.current) setComparison(value);
    } catch (cause) { if (requestEpoch === epoch.current) setError((cause as Error).message); }
    finally { if (requestEpoch === epoch.current) setBusy(false); }
  }
  return <section>
    <h3>Skill 固定版本与当前基线</h3>
    <p>Pin 作用于已接入的单会话 Style 包；服务端验证 Shadow、来源和会话权限，每次调用仍须实时准入。</p>
    <button disabled={busy} onClick={() => void refresh()}>读取 Pin 状态</button>
    {state && <>
      <p>rev {state.revision} · {state.pin?.enabled ? `已固定到 ${state.pin.sessionId}，到期 ${state.pin.expiresAt}` : '已关闭'}
        {' '}· {state.currentRevisionConsumed ? '该修订曾成功消费' : '暂无该修订的可用消费回执'}。</p>
      <details><summary>固定包身份</summary><p>{state.fixedPackage.skillId}</p><p>{state.fixedPackage.version}</p><code>{state.fixedPackage.packageDigest}</code></details>
      {state.preflight.blockers.length > 0 && <p>当前阻断：{state.preflight.blockers.join(', ')}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="Pin 会话 ID" placeholder="精确会话 ID" value={target} disabled={busy} onChange={e => setTarget(e.target.value)} />
        <input aria-label="Pin 有效小时" type="number" min="0.1" max="24" step="0.1" value={hours} disabled={busy} onChange={e => setHours(e.target.value)} />
        <input aria-label="Pin 原因码" value={reason} disabled={busy} onChange={e => setReason(e.target.value)} />
        <button disabled={busy || !state.writesEnabled} onClick={() => void changePin(true)}>固定版本 Pin</button>
        <button disabled={busy || !state.writesEnabled} onClick={() => void changePin(false)}>解除 Pin</button>
      </div>
    </>}
    <p>选择发布表中的候选后，可比较其与 learning.styleCompile 当前配置的基础 Skill。基础 Skill 与候选类型不同，差异不授予替换权限。</p>
    <button disabled={busy || !candidateId} onClick={() => void compare()}>候选与当前基线 Diff</button>
    {comparison?.state === 'off' && <p>该 Profile 的 live 开关关闭，没有启用的基线。</p>}
    {comparison?.state === 'profile-not-supported' && <p>该候选没有对应的已接入 Profile 基线。</p>}
    {comparison?.active && <p>当前配置基线：{comparison.active.skillId} @ {comparison.active.version}。调用是否实际选中须查看调用回执。</p>}
    {comparison?.diff && <>
      <table><thead><tr><th>字段</th><th>候选</th><th>当前基础 Skill</th></tr></thead><tbody>
        {comparison.diff.changes.map(entry => <tr key={entry.path}><td>{entry.path}</td><td>{entry.left ?? '—'}</td><td>{entry.right ?? '—'}</td></tr>)}
      </tbody></table>
      {comparison.diff.truncated && <p>差异超过显示上限，已截断。</p>}
      {comparison.diff.program?.orderChanged && <p>程序操作顺序发生变化。</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
