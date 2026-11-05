/** @author Codex @date 2026-10-18 @version 1.0
 * 发布面只读原型（Phase F 第一阶段）：总览 + 两个候选的结构化 Diff。
 *
 * 边界：
 * 1) 发布先读取服务端体检，再以同一证据和服务端 revision 执行受控 promote；
 *    retire / reconcile 仍由服务端执行，前端不复制发布策略；
 * 2) 不展示正文，只展示身份摘要与结构化差异；
 * 3) 503（未 opt-in 或无库）时给明确提示，不渲染空表冒充「没有候选」。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from './authClient.ts';
import { SkillGovernancePanel } from './SkillGovernancePanel.tsx';

interface OverviewCandidate {
  candidateId: string;
  state: string;
  revision: number;
  adoptionDigest: string | null;
  joinDigest: string | null;
  adoptedAt: string | null;
  channels: string[];
  promotable: boolean;
  cheapBlockers: string[];
}

interface OverviewChannel {
  channelId: string;
  revision: number;
  candidateId: string;
  adoptionDigest: string;
  verdictDigest: string;
  promotedAt: string;
}

interface Overview {
  writesEnabled: boolean;
  candidates: OverviewCandidate[];
  channels: OverviewChannel[];
  nextCursor: number;
  hasMore: boolean;
  skipped: number;
  generatedAt: string;
}

interface DiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  left: string | null;
  right: string | null;
}

interface DiffSide {
  candidateId: string;
  version: string;
  state: string;
  revision: number;
}

interface Diff {
  left: DiffSide;
  right: DiffSide;
  identical: boolean;
  changes: DiffEntry[];
  truncated: boolean;
  program: {
    operationsLeft: number;
    operationsRight: number;
    addedOperationKeys: string[];
    removedOperationKeys: string[];
    orderChanged: boolean;
  } | null;
}

interface AdmissionDecision {
  decisionId: string;
  round: number;
  verdict: string;
  score: number;
  hardSignals: string[];
  reasonCodes: string[];
  semanticRoute: string;
  createdAt: string;
}

interface PromotionRequest {
  candidateId: string; channelId: string; sampleSuiteId: string; batchId: string;
  qualitySuiteId: string; decidedAt: string; checkedAt: string;
}
interface PromotionPreflight {
  candidateId: string; channelId: string; state: 'ready' | 'already-promoted' | 'blocked';
  blockers: string[]; expectedChannelRevision: number; authorizesPromotion: false;
}
interface OperationalSource {
  candidateId: string; operationId: string; effectOutcome: 'positive' | 'neutral' | 'negative' | 'inconclusive';
  interpretation: 'observed-not-evaluated'; promotionEligible: false; sourceCurrent: true;
  capability: string; observedAt: string; evidenceDigest: string;
}
interface PromotionEvidence {
  sampleSuiteId: string; batchId: string; qualitySuiteId: string;
}

const pageSize = 32;

function shortDigest(value: string | null): string {
  if (!value) return '—';
  const body = value.startsWith('sha256:') ? value.slice(7) : value;
  return body.length <= 12 ? body : `${body.slice(0, 8)}…${body.slice(-4)}`;
}

function readOperationalSource(value: unknown, candidateId: string, operationId?: string): OperationalSource {
  const source = value as OperationalSource | null;
  if (!source || typeof source !== 'object' || source.candidateId !== candidateId
    || typeof source.operationId !== 'string' || !source.operationId
    || (operationId !== undefined && source.operationId !== operationId)
    || !['positive', 'neutral', 'negative', 'inconclusive'].includes(source.effectOutcome)
    || source.interpretation !== 'observed-not-evaluated' || source.promotionEligible !== false
    || source.sourceCurrent !== true || typeof source.capability !== 'string' || !source.capability
    || typeof source.observedAt !== 'string' || typeof source.evidenceDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(source.evidenceDigest)) throw new Error('回放证据响应无效');
  return source;
}

const cell: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid rgba(128,128,128,0.25)', textAlign: 'left' };
const head: React.CSSProperties = { ...cell, fontWeight: 600 };

export function PromotionPanel({ sessionId }: { sessionId?: string } = {}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [compareChannel, setCompareChannel] = useState('');
  const [diff, setDiff] = useState<Diff | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [decisions, setDecisions] = useState<AdmissionDecision[] | null>(null);
  const [decisionError, setDecisionError] = useState('');
  const [historyChannel, setHistoryChannel] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, unknown>[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const historyRequest = useRef(0);
  const [promotionFields, setPromotionFields] = useState({ candidateId: '', channelId: '', sampleSuiteId: '', batchId: '', qualitySuiteId: '' });
  const [promotionCheck, setPromotionCheck] = useState<{ request: PromotionRequest; result: PromotionPreflight } | null>(null);
  const [evidenceChoices, setEvidenceChoices] = useState<{ entries: PromotionEvidence[]; batchCursor: string;
    hasMoreBatches: boolean; nextBatchCursor: string | null; hasMoreQualities: boolean;
    nextQualityCursor: string | null; currentBatchId: string | null; unavailable: boolean } | null>(null);
  const [replayCandidate, setReplayCandidate] = useState('');
  const [replayOperation, setReplayOperation] = useState('');
  const [replaySource, setReplaySource] = useState<OperationalSource | null>(null);
  const [recentReplay, setRecentReplay] = useState<{ sources: OperationalSource[]; scanned: number; hasMore: boolean } | null>(null);

  const load = useCallback(async (nextCursor: number) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await authFetch(
        `/api/skills/promotion/overview?limit=${pageSize}&cursor=${nextCursor}`,
      );
      if (response.status === 503) {
        setOverview(null);
        setError('发布面未启用：需要 opt-in（JG_SKILL_PROMOTION_STORES=1）或已有发布库。');
        return;
      }
      if (!response.ok) {
        setOverview(null);
        setError(`读取发布总览失败（HTTP ${response.status}）`);
        return;
      }
      const body = await response.json() as { overview?: Overview };
      if (!body.overview) {
        setOverview(null);
        setError('发布总览响应缺少 overview 字段');
        return;
      }
      setOverview(body.overview);
      setCursor(nextCursor);
    } catch (cause) {
      setOverview(null);
      setError(`读取发布总览失败：${(cause as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(0); }, [load]);

  // Phase F：每轮实际命中与拒绝理由（只读投影，不含任何正文）。
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!sessionId) { setDecisions(null); return; }
      try {
        const response = await authFetch(
          `/api/agent/admission-decisions?limit=20&sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (cancelled) return;
        if (!response.ok) {
          setDecisions(null);
          setDecisionError(response.status === 503
            ? '准入台账不可用（该会话没有决策记录库）' : `读取准入决策失败（HTTP ${response.status}）`);
          return;
        }
        const body = await response.json() as { decisions?: AdmissionDecision[] };
        setDecisionError('');
        setDecisions(body.decisions ?? []);
      } catch (cause) {
        if (!cancelled) setDecisionError(`读取准入决策失败：${(cause as Error).message}`);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [sessionId]);

  /** 展开某通道的 append-only 历史（含每次回滚的原因码）。 */
  const openHistory = useCallback(async (channelId: string) => {
    const requestId = ++historyRequest.current;
    if (historyChannel === channelId) {
      setHistoryChannel(null);
      setHistory(null);
      return;
    }
    setHistoryChannel(channelId);
    setHistory(null);
    setHistoryError('');
    try {
      const response = await authFetch(`/api/skills/channels/${encodeURIComponent(channelId)}`);
      const body = await response.json().catch(() => ({})) as {
        code?: string; history?: Record<string, unknown>[];
      };
      if (!response.ok) {
        if (requestId === historyRequest.current) setHistoryError(`读取历史失败：${body.code ?? `HTTP ${response.status}`}`);
        return;
      }
      if (!Array.isArray(body.history)) throw new Error('Channel 历史响应无效');
      // 新的在前：操作者最关心刚刚发生了什么。
      if (requestId === historyRequest.current) setHistory([...body.history].reverse());
    } catch (cause) {
      if (requestId === historyRequest.current) setHistoryError(`读取历史失败：${(cause as Error).message}`);
    }
  }, [historyChannel]);

  /** 退役并回退：用服务端算出的 revision 做 CAS，原因码必填；不做任何"猜一个"的默认值。 */
  const retire = useCallback(async (channel: OverviewChannel) => {
    const reason = reasonCode.trim();
    if (!reason) {
      setError('退役必须填写原因码（会写进 append-only 历史）');
      return;
    }
    const confirmed = window.confirm(
      `确认退役并回退？\n\nChannel：${channel.channelId}\n当前 rev：${channel.revision}`
      + `\n候选：${channel.candidateId}\n原因码：${reason}\n\n`
      + '这会先杀掉该候选（不可撤销），再把指针退回上一格。',
    );
    if (!confirmed) return;
    setBusy(true);
    setError('');
    setActionNote('');
    try {
      const response = await authFetch('/api/skills/promotion/retire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channelId: channel.channelId,
          expectedChannelRevision: channel.revision,
          candidateId: channel.candidateId,
          reasonCode: reason,
        }),
      });
      const body = await response.json().catch(() => ({})) as {
        code?: string; killedNow?: boolean; retiredRevision?: number;
        pointer?: { revision?: number; candidateId?: string };
      };
      if (!response.ok) {
        setError(`退役失败：${body.code ?? `HTTP ${response.status}`}`);
        return;
      }
      setActionNote(
        `已退役：rev ${body.retiredRevision ?? channel.revision} → 指针 rev ${body.pointer?.revision ?? '?'}`
        + `，候选 ${body.killedNow === false ? '此前已 killed' : '已 killed'}`,
      );
      await load(0);
    } catch (cause) {
      setError(`退役失败：${(cause as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [load, reasonCode]);

  /** 和解：只补「候选已死、指针未退」的半途状态，不影响健康指针。 */
  const reconcile = useCallback(async () => {
    const confirmed = window.confirm(
      '确认运行退役和解？\n\n只处理「指针所指候选已 killed、指针未回退」的半途状态；'
      + '不会杀任何活着的候选，也不会动健康指针。',
    );
    if (!confirmed) return;
    setBusy(true);
    setError('');
    setActionNote('');
    try {
      const response = await authFetch('/api/skills/promotion/reconcile', { method: 'POST' });
      const body = await response.json().catch(() => ({})) as {
        code?: string; entries?: { channelId: string; outcome: string }[];
      };
      if (!response.ok) {
        setError(`和解失败：${body.code ?? `HTTP ${response.status}`}`);
        return;
      }
      const entries = body.entries ?? [];
      const counts = entries.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.outcome] = (acc[entry.outcome] ?? 0) + 1;
        return acc;
      }, {});
      setActionNote(entries.length === 0
        ? '和解完成：没有需要处理的指针'
        : `和解完成：${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join('，')}`);
      await load(0);
    } catch (cause) {
      setError(`和解失败：${(cause as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const compare = useCallback(async () => {
    const from = left.trim();
    const to = right.trim();
    if (!from || !to) {
      setError('Diff 需要两个 candidateId');
      return;
    }
    setBusy(true);
    setError('');
    setDiff(null);
    try {
      const response = await authFetch(
        `/api/skills/candidates/${encodeURIComponent(from)}/diff?against=${encodeURIComponent(to)}`,
      );
      const body = await response.json().catch(() => ({})) as { diff?: Diff; code?: string };
      if (!response.ok || !body.diff) {
        setError(`Diff 失败：${body.code ?? `HTTP ${response.status}`}`);
        return;
      }
      setDiff(body.diff);
      setNotice(body.diff.identical ? '两个 bundle 完全一致' : '');
    } catch (cause) {
      setError(`Diff 失败：${(cause as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [left, right]);

  const compareWithCurrent = useCallback(async () => {
    const candidateId = right.trim();
    if (!candidateId || !compareChannel) { setError('请选择 Channel 并填写候选 ID'); return; }
    setBusy(true); setError(''); setNotice(''); setDiff(null);
    try {
      const channelResponse = await authFetch(`/api/skills/channels/${encodeURIComponent(compareChannel)}`);
      if (!channelResponse.ok) throw new Error(`读取 Channel 失败（HTTP ${channelResponse.status}）`);
      const channel = await channelResponse.json() as { pointer?: { candidateId?: unknown; revision?: unknown } };
      if (typeof channel.pointer?.candidateId !== 'string' || !channel.pointer.candidateId
        || !Number.isSafeInteger(channel.pointer.revision)) throw new Error('Channel 指针无效');
      const activeId = channel.pointer.candidateId;
      const response = await authFetch(`/api/skills/candidates/${encodeURIComponent(activeId)}/diff?against=${encodeURIComponent(candidateId)}`);
      const body = await response.json() as { diff?: Diff; code?: string };
      if (!response.ok || !body.diff) throw new Error(body.code ?? `HTTP ${response.status}`);
      const recheck = await authFetch(`/api/skills/channels/${encodeURIComponent(compareChannel)}`);
      if (!recheck.ok) throw new Error(`复核 Channel 失败（HTTP ${recheck.status}）`);
      const current = await recheck.json() as { pointer?: { candidateId?: unknown; revision?: unknown } };
      if (current.pointer?.candidateId !== activeId || current.pointer.revision !== channel.pointer.revision)
        throw new Error('Channel 指针已变化，请重新比较');
      setLeft(activeId); setDiff(body.diff);
      setNotice(`以 ${compareChannel} 读取时的指针 rev ${channel.pointer.revision} 为基准`);
    } catch (cause) {
      setError(`与当前 Channel 比较失败：${(cause as Error).message}`);
    } finally { setBusy(false); }
  }, [compareChannel, right]);

  const checkPromotion = useCallback(async () => {
    const fields = Object.fromEntries(Object.entries(promotionFields).map(([key, value]) => [key, value.trim()])) as typeof promotionFields;
    if (Object.values(fields).some(value => !value)) { setError('发布体检需要完整的候选、Channel 和三项证据 ID'); return; }
    const now = new Date().toISOString();
    const request: PromotionRequest = { ...fields, decidedAt: now, checkedAt: now };
    setBusy(true); setError(''); setPromotionCheck(null);
    try {
      const response = await authFetch('/api/skills/promotion/preflight', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const body = await response.json() as { preflight?: PromotionPreflight; code?: string };
      const result = body.preflight;
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      if (!result || result.candidateId !== request.candidateId || result.channelId !== request.channelId
        || !['ready', 'already-promoted', 'blocked'].includes(result.state) || !Array.isArray(result.blockers)
        || result.blockers.some(value => typeof value !== 'string') || !Number.isSafeInteger(result.expectedChannelRevision)
        || (result.state === 'blocked') !== (result.blockers.length > 0)
        || result.expectedChannelRevision < 0 || result.authorizesPromotion !== false) throw new Error('发布体检响应无效');
      setPromotionCheck({ request, result });
    } catch (cause) { setError(`发布体检失败：${(cause as Error).message}`); }
    finally { setBusy(false); }
  }, [promotionFields]);

  const findEvidence = useCallback(async (batchCursor = '', qualityCursor = '', expectedBatchId = '') => {
    const candidateId = promotionFields.candidateId.trim();
    if (!candidateId) { setError('查找证据需要候选 ID'); return; }
    setBusy(true); setError(''); setEvidenceChoices(null); setPromotionCheck(null);
    try {
      const query = new URLSearchParams();
      if (batchCursor) query.set('batchCursor', batchCursor);
      if (qualityCursor) query.set('qualityCursor', qualityCursor);
      if (expectedBatchId) query.set('expectedBatchId', expectedBatchId);
      const response = await authFetch(`/api/skills/candidates/${encodeURIComponent(candidateId)}/promotion-evidence${query.size ? `?${query}` : ''}`);
      const body = await response.json() as { evidence?: { entries?: unknown; hasMoreBatches?: unknown;
        nextBatchCursor?: unknown; hasMoreQualities?: unknown; nextQualityCursor?: unknown;
        currentBatchId?: unknown; unavailable?: unknown }; code?: string };
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      if (!body.evidence || !Array.isArray(body.evidence.entries) || body.evidence.entries.length > 10
        || typeof body.evidence.hasMoreBatches !== 'boolean' || typeof body.evidence.hasMoreQualities !== 'boolean'
        || typeof body.evidence.unavailable !== 'boolean') throw new Error('证据列表响应无效');
      const validCursor = (value: unknown) => value === null || typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
      if (!validCursor(body.evidence.nextBatchCursor) || !validCursor(body.evidence.nextQualityCursor)
        || !validCursor(body.evidence.currentBatchId)
        || body.evidence.hasMoreBatches && !body.evidence.nextBatchCursor
        || body.evidence.hasMoreQualities && (!body.evidence.nextQualityCursor || !body.evidence.currentBatchId)
        || expectedBatchId && body.evidence.currentBatchId !== expectedBatchId) throw new Error('证据列表响应无效');
      const entries = body.evidence.entries.map((value: unknown) => {
        const row = value as Partial<PromotionEvidence> | null;
        if (!row || ![row.sampleSuiteId, row.batchId, row.qualitySuiteId].every(
          item => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item))) throw new Error('证据列表响应无效');
        return row as PromotionEvidence;
      });
      setEvidenceChoices({ entries, batchCursor, hasMoreBatches: body.evidence.hasMoreBatches,
        nextBatchCursor: body.evidence.nextBatchCursor as string | null,
        hasMoreQualities: body.evidence.hasMoreQualities, nextQualityCursor: body.evidence.nextQualityCursor as string | null,
        currentBatchId: body.evidence.currentBatchId as string | null,
        unavailable: body.evidence.unavailable });
    } catch (cause) { setError(`查找证据失败：${(cause as Error).message}`); }
    finally { setBusy(false); }
  }, [promotionFields.candidateId]);

  const useChannelEvidence = useCallback(async (channel: OverviewChannel) => {
    setBusy(true); setError(''); setNotice(''); setPromotionCheck(null); setEvidenceChoices(null);
    try {
      const response = await authFetch(`/api/skills/channels/${encodeURIComponent(channel.channelId)}/evidence`);
      const body = await response.json() as { current?: { pointer?: { channelId?: unknown; revision?: unknown;
        candidateId?: unknown }; evidence?: Partial<PromotionEvidence> }; code?: string };
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      const pointer = body.current?.pointer, evidence = body.current?.evidence;
      if (!pointer || pointer.channelId !== channel.channelId || pointer.revision !== channel.revision
        || pointer.candidateId !== channel.candidateId || !evidence
        || ![evidence.sampleSuiteId, evidence.batchId, evidence.qualitySuiteId].every(
          item => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item))) {
        throw new Error('Channel 已变化或证据响应无效，请刷新');
      }
      setPromotionFields({ candidateId: channel.candidateId, channelId: channel.channelId,
        sampleSuiteId: evidence.sampleSuiteId!, batchId: evidence.batchId!, qualitySuiteId: evidence.qualitySuiteId! });
      setNotice(`已填入 ${channel.channelId} rev ${channel.revision} 的原始发布证据；这不代表线上 Active。`);
    } catch (cause) { setError(`读取 Channel 证据失败：${(cause as Error).message}`); }
    finally { setBusy(false); }
  }, []);

  const adoptCandidate = useCallback(async () => {
    const { candidateId, sampleSuiteId, batchId, qualitySuiteId } = promotionFields;
    const fields = { candidateId: candidateId.trim(), sampleSuiteId: sampleSuiteId.trim(),
      batchId: batchId.trim(), qualitySuiteId: qualitySuiteId.trim(), expectedRevision: 1 };
    if (Object.values(fields).some(value => typeof value === 'string' && !value)) {
      setError('采用候选需要候选 ID 和三项证据 ID'); return;
    }
    if (!overview?.writesEnabled) return;
    setBusy(true); setError(''); setActionNote(''); setPromotionCheck(null);
    try {
      const response = await authFetch('/api/skills/promotion/adopt', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) });
      const body = await response.json() as { adoption?: { candidateId?: unknown; candidateRevision?: unknown;
        adoptionDigest?: unknown; joinDigest?: unknown }; code?: string };
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      const result = body.adoption;
      if (!result || result.candidateId !== fields.candidateId || result.candidateRevision !== 2
        || typeof result.adoptionDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(result.adoptionDigest)
        || typeof result.joinDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(result.joinDigest))
        throw new Error('采用回执无效');
      await load(0);
      setActionNote(`候选已采用（rev 2，回执 ${shortDigest(result.adoptionDigest)}）；仍需发布体检。`);
    } catch (cause) { setError(`采用候选失败：${(cause as Error).message}`); }
    finally { setBusy(false); }
  }, [load, overview?.writesEnabled, promotionFields]);

  const promote = useCallback(async () => {
    if (!promotionCheck || promotionCheck.result.state !== 'ready' || !overview?.writesEnabled) return;
    setBusy(true); setError(''); setActionNote('');
    try {
      const response = await authFetch('/api/skills/promotion/promote', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...promotionCheck.request,
          expectedChannelRevision: promotionCheck.result.expectedChannelRevision }) });
      const body = await response.json() as { pointer?: { revision?: unknown }; code?: string };
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      if (!body.pointer || !Number.isSafeInteger(body.pointer.revision)) throw new Error('发布回执无效');
      setPromotionCheck(null); setActionNote(`Channel 指针已更新至 rev ${body.pointer.revision}`);
      await load(0);
    } catch (cause) { setPromotionCheck(null); setError(`发布失败：${(cause as Error).message}`); }
    finally { setBusy(false); }
  }, [load, overview?.writesEnabled, promotionCheck]);

  const readReplay = useCallback(async (selectedOperationId?: string) => {
    const candidateId = replayCandidate.trim(), operationId = (selectedOperationId ?? replayOperation).trim();
    if (!candidateId || !operationId) { setError('读取回放需要候选 ID 和运行 ID'); return; }
    if (selectedOperationId !== undefined) setReplayOperation(operationId);
    setBusy(true); setError(''); setReplaySource(null);
    try {
      const response = await authFetch(`/api/skills/candidates/${encodeURIComponent(candidateId)}/operational-sources/${encodeURIComponent(operationId)}`);
      const body = await response.json() as { source?: OperationalSource; code?: string };
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      setReplaySource(readOperationalSource(body.source, candidateId, operationId));
    } catch (cause) { setRecentReplay(null); setError(`读取回放失败：${(cause as Error).message}`); }
    finally { setBusy(false); }
  }, [replayCandidate, replayOperation]);

  const readRecentReplays = useCallback(async () => {
    const candidateId = replayCandidate.trim();
    if (!candidateId) { setError('读取近期回放需要候选 ID'); return; }
    setBusy(true); setError(''); setRecentReplay(null); setReplaySource(null);
    try {
      const response = await authFetch(`/api/skills/candidates/${encodeURIComponent(candidateId)}/operational-sources`);
      const body = await response.json() as { sources?: unknown; scanned?: unknown; hasMore?: unknown; code?: string };
      if (!response.ok) throw new Error(body.code ?? `HTTP ${response.status}`);
      if (!Array.isArray(body.sources) || body.sources.length > 100 || !Number.isSafeInteger(body.scanned)
        || Number(body.scanned) < body.sources.length || Number(body.scanned) > 100 || typeof body.hasMore !== 'boolean')
        throw new Error('近期回放响应无效');
      setRecentReplay({ sources: body.sources.map(source => readOperationalSource(source, candidateId)),
        scanned: Number(body.scanned), hasMore: body.hasMore });
    } catch (cause) { setError(`读取近期回放失败：${(cause as Error).message}`); }
    finally { setBusy(false); }
  }, [replayCandidate]);

  return (
    <div style={{ padding: 12, display: 'grid', gap: 12 }}>
      <SkillGovernancePanel sessionId={sessionId} candidateId={promotionFields.candidateId.trim()} />
      <section>
        <h3 style={{ margin: '0 0 6px' }}>发布总览与受控操作</h3>
        <p style={{ margin: '0 0 8px', opacity: 0.75 }}>
          发布需要服务端体检和管理员写权限；退役、回滚与和解由服务端 CAS 与追加历史保护。
          无写权限时本页完全只读。
          「阻断（廉价）」只由候选/采用/指针推出，真正的门是体检。
          {overview ? ` 写权限：${overview.writesEnabled ? '已开启' : '关闭（只读）'}` : ''}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => void load(cursor)} disabled={busy}>刷新</button>
          <button onClick={() => void load(0)} disabled={busy || cursor === 0}>回到首页</button>
          {overview?.hasMore
            ? <button onClick={() => void load(overview.nextCursor)} disabled={busy}>下一页</button>
            : null}
          {busy ? <span style={{ opacity: 0.7 }}>读取中…</span> : null}
          {overview ? (
            <span style={{ opacity: 0.7 }}>
              生成于 {overview.generatedAt}
              {overview.skipped > 0 ? `，跳过 ${overview.skipped} 条损坏记录` : ''}
            </span>
          ) : null}
        </div>
        {error ? <p style={{ color: '#b00020' }}>{error}</p> : null}
        {notice ? <p style={{ opacity: 0.8 }}>{notice}</p> : null}
        {overview ? (
          <table style={{ borderCollapse: 'collapse', marginTop: 8, fontSize: 13 }}>
            <thead>
              <tr>
                <th style={head}>候选</th><th style={head}>状态</th><th style={head}>rev</th>
                <th style={head}>采用回执</th><th style={head}>Channel</th><th style={head}>提示</th>
                <th style={head}>阻断（廉价）</th>
              </tr>
            </thead>
            <tbody>
              {overview.candidates.length === 0 ? (
                <tr><td style={cell} colSpan={7}>还没有候选记录</td></tr>
              ) : overview.candidates.map((candidate) => (
                <tr key={candidate.candidateId}>
                  <td style={cell} title={candidate.candidateId}>
                    <button disabled={busy} onClick={() => { setPromotionCheck(null); setEvidenceChoices(null);
                      setPromotionFields(previous => ({ ...previous, candidateId: candidate.candidateId })); }}>
                      {shortDigest(candidate.candidateId)}</button>
                  </td>
                  <td style={cell}>{candidate.state}</td>
                  <td style={cell}>{candidate.revision}</td>
                  <td style={cell} title={candidate.adoptionDigest ?? ''}>
                    {shortDigest(candidate.adoptionDigest)}
                  </td>
                  <td style={cell}>{candidate.channels.length ? candidate.channels.join(', ') : '—'}</td>
                  <td style={cell}>{candidate.promotable ? '可发布（提示，非体检）' : '—'}</td>
                  <td style={cell}>
                    {candidate.cheapBlockers.length > 0 ? candidate.cheapBlockers.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section>
        <h3 style={{ margin: '0 0 6px' }}>回放与效果</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input aria-label="回放候选 ID" placeholder="候选 ID" value={replayCandidate} disabled={busy}
            onChange={event => { setReplayCandidate(event.target.value); setReplaySource(null); setRecentReplay(null); }} />
          <input aria-label="回放运行 ID" placeholder="运行 ID" value={replayOperation} disabled={busy}
            onChange={event => { setReplayOperation(event.target.value); setReplaySource(null); }} />
          <button disabled={busy} onClick={() => void readReplay()}>读取回放证据</button>
          <button disabled={busy || !replayCandidate.trim()} onClick={() => void readRecentReplays()}>查看近期回放</button>
        </div>
        {recentReplay && <div><p>已检查最近 {recentReplay.scanned} 条闭合记录，找到 {recentReplay.sources.length} 条匹配回放。
          {recentReplay.hasMore ? ' 更早记录未扫描。' : ''}</p>
          {recentReplay.sources.map(source => <p key={source.operationId}>
            {source.observedAt} · {source.capability} · {({ positive: '正向', neutral: '中性', negative: '负效果', inconclusive: '无法判断' } as const)[source.effectOutcome]}
            {' '}<button disabled={busy} onClick={() => void readReplay(source.operationId)}>查看证据</button>
          </p>)}</div>}
        {replaySource && <p>效果：{({ positive: '正向', neutral: '中性', negative: '负效果', inconclusive: '无法判断' } as const)[replaySource.effectOutcome]}
          {' '}· {replaySource.capability} · {replaySource.observedAt} · 证据 <code title={replaySource.evidenceDigest}>
            {shortDigest(replaySource.evidenceDigest)}</code>。这是观察结果，尚未评估，也不授予发布资格。</p>}
      </section>

      <section>
        <h3 style={{ margin: '0 0 6px' }}>发布体检与 Promote</h3>
        <p>填写已有证据 ID；采用和发布均由服务端重新校验。采用不代表已生效或已发布。</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([['candidateId', '候选 ID'], ['channelId', 'Channel ID'], ['sampleSuiteId', '样本集 ID'],
            ['batchId', '批次 ID'], ['qualitySuiteId', '质量集 ID']] as const).map(([key, label]) => (
            <input key={key} aria-label={label} placeholder={label} value={promotionFields[key]} disabled={busy}
              onChange={event => { setPromotionCheck(null); if (key === 'candidateId') setEvidenceChoices(null);
                setPromotionFields(previous => ({ ...previous, [key]: event.target.value })); }} />
          ))}
          <button disabled={busy || !promotionFields.candidateId.trim()} onClick={() => void findEvidence()}>查找证据</button>
          <button disabled={busy} onClick={() => void checkPromotion()}>运行发布体检</button>
          <button disabled={busy || !overview?.writesEnabled} onClick={() => void adoptCandidate()}>采用候选</button>
        </div>
        {evidenceChoices && <div><p>本页找到 {evidenceChoices.entries.length} 组候选证据；采用和发布时仍需服务端完整复核。
          {evidenceChoices.unavailable ? ' 部分来源当前不可用。' : ''}</p>
          {evidenceChoices.entries.map(entry => <p key={`${entry.batchId}:${entry.qualitySuiteId}`}>
            <span title={entry.sampleSuiteId}>样本 {shortDigest(entry.sampleSuiteId)}</span> ·
            <span title={entry.batchId}>批次 {shortDigest(entry.batchId)}</span> ·
            <span title={entry.qualitySuiteId}>质量 {shortDigest(entry.qualitySuiteId)}</span>{' '}
            <button disabled={busy} onClick={() => { setPromotionCheck(null);
              setPromotionFields(previous => ({ ...previous, ...entry })); }}>使用这组</button>
          </p>)}
          {evidenceChoices.hasMoreQualities && <button disabled={busy}
            onClick={() => void findEvidence(evidenceChoices.batchCursor, evidenceChoices.nextQualityCursor!, evidenceChoices.currentBatchId!)}>下一页质量记录</button>}{' '}
          {evidenceChoices.hasMoreBatches && <button disabled={busy}
            onClick={() => void findEvidence(evidenceChoices.nextBatchCursor!, '')}>下一批证据</button>}
        </div>}
        {promotionCheck && <p>服务端体检：{promotionCheck.result.state}；预期 Channel rev {promotionCheck.result.expectedChannelRevision}
          {promotionCheck.result.blockers.length ? `；阻断：${promotionCheck.result.blockers.join(', ')}` : ''}。体检本身不授权发布。</p>}
        <button disabled={busy || !overview?.writesEnabled || promotionCheck?.result.state !== 'ready'}
          onClick={() => void promote()}>发布到 Channel</button>
      </section>

      <section>
        <h3 style={{ margin: '0 0 6px' }}>Channel 指针</h3>
        {overview && overview.channels.length > 0 ? (
          <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={head}>Channel</th><th style={head}>rev</th><th style={head}>候选</th>
                <th style={head}>裁决摘要</th><th style={head}>时间</th><th style={head}>操作</th>
              </tr>
            </thead>
            <tbody>
              {overview.channels.map((channel) => (
                <tr key={channel.channelId}>
                  <td style={cell}>{channel.channelId}</td>
                  <td style={cell}>{channel.revision}</td>
                  <td style={cell} title={channel.candidateId}>{shortDigest(channel.candidateId)}</td>
                  <td style={cell} title={channel.verdictDigest}>{shortDigest(channel.verdictDigest)}</td>
                  <td style={cell}>{channel.promotedAt}</td>
                  <td style={cell}>
                    <button onClick={() => void openHistory(channel.channelId)} disabled={busy}>
                      {historyChannel === channel.channelId ? '收起历史' : '查看历史'}
                    </button>{' '}
                    <button onClick={() => void useChannelEvidence(channel)} disabled={busy}>使用发布证据</button>{' '}
                    <button
                      onClick={() => void retire(channel)}
                      disabled={busy || !overview.writesEnabled}
                      title={overview.writesEnabled
                        ? '先杀该候选，再把指针退回上一格（不可撤销）'
                        : '写权限未开启（需要 JG_SKILL_PROMOTION_STORES=1）'}
                    >退役并回退</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ opacity: 0.7 }}>尚无已发布的 Channel 指针</p>}
        {historyChannel ? (
          <div style={{ marginTop: 8 }}>
            <h4 style={{ margin: '0 0 4px' }}>{historyChannel} 历史（新 → 旧）</h4>
            {historyError ? <p style={{ color: '#b00020' }}>{historyError}</p> : null}
            {history && history.length > 0 ? (
              <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={head}>rev</th><th style={head}>动作</th><th style={head}>候选</th>
                    <th style={head}>原因码</th><th style={head}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry, index) => {
                    const row = entry as {
                      toRevision?: number; fromRevision?: number; kind?: string;
                      promotionVersion?: string; candidateId?: string; reasonCode?: string;
                      rollbackTargetRevision?: number; promotedAt?: string;
                    };
                    const action = row.kind === 'rollback'
                      ? `回滚 → rev ${row.rollbackTargetRevision ?? '?'}`
                      : '发布';
                    return (
                      <tr key={`${String(row.toRevision ?? index)}-${index}`}>
                        <td style={cell}>{row.fromRevision ?? '?'} → {row.toRevision ?? '?'}</td>
                        <td style={cell}>{action}</td>
                        <td style={cell} title={row.candidateId ?? ''}>
                          {shortDigest(row.candidateId ?? null)}
                        </td>
                        <td style={cell}>{row.reasonCode ?? '—'}</td>
                        <td style={cell}>{row.promotedAt ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
            {history && history.length === 0 ? (
              <p style={{ opacity: 0.7 }}>该通道还没有历史记录</p>
            ) : null}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <input
            value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}
            placeholder="退役原因码（必填，会进 append-only 历史）" style={{ width: 320 }}
          />
          <button onClick={() => void reconcile()} disabled={busy || !overview?.writesEnabled}>
            运行和解
          </button>
          <span style={{ opacity: 0.7 }}>
            写权限：{overview?.writesEnabled ? '已开启' : '关闭（按钮禁用）'}
          </span>
        </div>
        {actionNote ? <p style={{ opacity: 0.85 }}>{actionNote}</p> : null}
      </section>

      <section>
        <h3 style={{ margin: '0 0 6px' }}>Candidate Diff（只读）</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={left} onChange={(event) => { setLeft(event.target.value); setDiff(null); setNotice(''); }} disabled={busy}
            placeholder="sha256:…（左）" style={{ width: 320 }}
          />
          <input
            value={right} onChange={(event) => { setRight(event.target.value); setDiff(null); setNotice(''); }} disabled={busy}
            placeholder="sha256:…（右）" style={{ width: 320 }}
          />
          <button onClick={() => void compare()} disabled={busy}>比较</button>
          <select value={compareChannel} onChange={(event) => { setCompareChannel(event.target.value); setDiff(null); setNotice(''); }} disabled={busy} aria-label="选择对比 Channel">
            <option value="">选择 Channel</option>
            {overview?.channels.map(channel => <option key={channel.channelId} value={channel.channelId}>{channel.channelId}</option>)}
          </select>
          <button onClick={() => void compareWithCurrent()} disabled={busy || !compareChannel || !right.trim()}>
            与当前 Channel 比较
          </button>
        </div>
        {diff ? (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            <p style={{ margin: '0 0 4px' }}>
              {diff.left.version || '—'}（rev {diff.left.revision}） → {diff.right.version || '—'}
              （rev {diff.right.revision}）：
              {diff.identical ? ' 完全一致' : ` ${diff.changes.length} 处 manifest 变化`}
              {diff.truncated ? '（已截断）' : ''}
            </p>
            {diff.changes.length > 0 ? (
              <table style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr><th style={head}>字段</th><th style={head}>类型</th><th style={head}>左</th><th style={head}>右</th></tr>
                </thead>
                <tbody>
                  {diff.changes.map((entry) => (
                    <tr key={entry.path}>
                      <td style={cell}>{entry.path}</td>
                      <td style={cell}>{entry.kind}</td>
                      <td style={cell}>{entry.left ?? '—'}</td>
                      <td style={cell}>{entry.right ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {diff.program ? (
              <p style={{ margin: '6px 0 0', opacity: 0.85 }}>
                operation：{diff.program.operationsLeft} → {diff.program.operationsRight}
                {diff.program.addedOperationKeys.length > 0
                  ? `；新增 ${diff.program.addedOperationKeys.join(', ')}` : ''}
                {diff.program.removedOperationKeys.length > 0
                  ? `；移除 ${diff.program.removedOperationKeys.join(', ')}` : ''}
                {diff.program.orderChanged ? '；操作顺序已变化' : ''}
              </p>
            ) : <p style={{ margin: '6px 0 0', opacity: 0.7 }}>正文不是规范 JSON IR，仅比较正文摘要</p>}
          </div>
        ) : null}
      </section>
    </div>
  );
}
