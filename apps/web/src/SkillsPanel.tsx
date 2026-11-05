import React, { useEffect, useMemo, useState } from 'react';
import { authFetch } from './authClient.ts';
import {
  EMPTY_SKILL_REPOSITORY_FILTERS,
  UNASSIGNED_SKILL_VALUE,
  filterAgentSkills,
  normalizeAgentSkillRepository,
  skillFilterValues,
  summarizeAgentSkills,
  type AgentSkillRecord,
  type AgentSkillRepository,
  type SkillRepositoryFilters,
} from './skillRepositoryModel.ts';

interface SkillMatch { name: string; score: number; body?: string }

type SkillShadowContentMode = 'nsf' | 'nsfw';

interface SkillShadowPromotionStatus {
  qualifyingTurns: number;
  minimumQualifyingTurns: number;
  remainingQualifyingTurns: number;
  sampleGatePassed: boolean;
  selectionConsistent: boolean;
  operationalHealthPassed: boolean;
  promotionReady: boolean;
  blockers: readonly string[];
}

interface SkillShadowMetrics {
  catalogRevision: string | null;
  validationWindow: number;
  observedTurns: number;
  qualifyingTurns: number;
  nonQualifyingTurns: number;
  promotionCompatibleTurns: number;
  mismatchTurns: number;
  unmappedCandidates: number;
  unmappedLegacySelections: number;
  nsfTurns: number;
  nsfwTurns: number;
  averageDurationMicros: number;
  attempts: number;
  completed: number;
  failed: number;
  dropped: number;
  validationWindowHealthAligned: boolean;
  validationWindowFailed: number;
  validationWindowDropped: number;
  validationWindowCatalogRefreshFailures: number;
  inFlight: number;
  pending: number;
  running: boolean;
  faulted: boolean;
  stale: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  promotionAttemptDenominator: number;
  promotionCompatibleRateBps: number;
  promotionByContentMode: Readonly<Record<SkillShadowContentMode, SkillShadowPromotionStatus>>;
}

interface SkillShadowCatalogCache {
  policy: string;
  ttlMs: number;
  cached: boolean;
  fresh: boolean;
  stale: boolean;
  refreshing: boolean;
  refreshAttempts: number;
  refreshFailures: number;
  lastErrorCode: string | null;
}

interface SkillShadowRuntimeConfigSummary {
  mode: 'off' | 'pilot' | 'all';
  configured: boolean;
  valid: boolean;
  enabled: boolean;
  reason: string;
  sessionCount: number;
  skillCount: number;
  revision: string | null;
}

interface SkillShadowStatus {
  enabled: boolean;
  runtimeConfig: SkillShadowRuntimeConfigSummary | null;
  metrics: SkillShadowMetrics;
  catalogCache: SkillShadowCatalogCache | null;
  contextCompilerCanary: ContextCompilerCanaryStatus | null;
}

interface ContextCompilerCanaryStatus {
  enabled: boolean;
  providerId: string;
  model: string;
  profileDigest: string;
  dispatched: number;
  completed: number;
  succeeded: number;
  failed: number;
  inFlight: number;
  requiredSamples: number;
  remainingSamples: number;
}

function count(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : 0;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const SHADOW_PROMOTION_MINIMUM_TURNS = 20;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeContextCompilerCanary(value: unknown): ContextCompilerCanaryStatus | null {
  const item = record(value);
  if (!item || typeof item.configured !== 'boolean' || typeof item.enabled !== 'boolean')
    throw new Error('Context Compiler 灰度状态无效');
  if (!item.configured) {
    if (item.enabled) throw new Error('Context Compiler 灰度状态无效');
    return null;
  }
  const scope = record(item.scope);
  const keys = ['dispatched', 'completed', 'succeeded', 'failed', 'inFlight', 'requiredSamples', 'remainingSamples'] as const;
  if (!scope || scope.sessionCount !== 1 || typeof scope.providerId !== 'string' || !scope.providerId
    || typeof scope.model !== 'string' || !scope.model || typeof scope.profileDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(scope.profileDigest)
    || keys.some(key => !Number.isSafeInteger(item[key]) || Number(item[key]) < 0)
    || item.lifetime !== 'process' || item.semanticQuality !== 'not-evaluated'
    || item.successMeaning !== 'validated-capsule') throw new Error('Context Compiler 灰度状态无效');
  const values = Object.fromEntries(keys.map(key => [key, Number(item[key])])) as Pick<ContextCompilerCanaryStatus, typeof keys[number]>;
  if (values.completed !== values.succeeded + values.failed || values.dispatched !== values.completed + values.inFlight
    || values.requiredSamples < 1 || values.remainingSamples !== Math.max(0, values.requiredSamples - values.succeeded))
    throw new Error('Context Compiler 灰度计数无效');
  return { enabled: item.enabled, providerId: scope.providerId, model: scope.model,
    profileDigest: scope.profileDigest, ...values };
}

/** Fail closed when an older or malformed server omits the per-content-mode promotion contract. */
function normalizeSkillShadowPromotionStatus(value: unknown): SkillShadowPromotionStatus {
  const source = record(value) ?? {};
  const qualifyingTurns = count(source.qualifyingTurns);
  const minimumQualifyingTurns = Math.max(
    SHADOW_PROMOTION_MINIMUM_TURNS,
    count(source.minimumQualifyingTurns),
  );
  const remainingQualifyingTurns = Math.max(0, minimumQualifyingTurns - qualifyingTurns);
  const sampleGatePassed = remainingQualifyingTurns === 0 && source.sampleGatePassed === true;
  const selectionConsistent = qualifyingTurns > 0 && source.selectionConsistent === true;
  const operationalHealthPassed = source.operationalHealthPassed === true;
  const blockers = Array.isArray(source.blockers)
    ? source.blockers.filter((item): item is string => typeof item === 'string').slice(0, 32)
    : ['promotion-contract-unavailable'];
  return Object.freeze({
    qualifyingTurns,
    minimumQualifyingTurns,
    remainingQualifyingTurns,
    sampleGatePassed,
    selectionConsistent,
    operationalHealthPassed,
    promotionReady: source.promotionReady === true
      && sampleGatePassed
      && selectionConsistent
      && operationalHealthPassed,
    blockers: Object.freeze(blockers),
  });
}

function skillShadowPromotionText(status: SkillShadowPromotionStatus): string {
  if (status.remainingQualifyingTurns > 0) {
    return `采样中 ${status.qualifyingTurns}/${status.minimumQualifyingTurns}`;
  }
  if (!status.sampleGatePassed || !status.selectionConsistent || !status.operationalHealthPassed) {
    const issues = [
      ...(!status.selectionConsistent ? ['选择差异'] : []),
      ...(!status.sampleGatePassed || !status.operationalHealthPassed ? ['运行健康问题'] : []),
    ];
    return `样本足但有${issues.join('、')}（不会自动晋级）`;
  }
  if (status.promotionReady) return '已达旁路评估门槛（仍不自动晋级）';
  return '样本足但有运行健康问题（不会自动晋级）';
}

function skillShadowConfigTitle(status: SkillShadowStatus | null): string {
  if (status === null) return '旁路状态不可用';
  const config = status.runtimeConfig;
  if (config?.configured && !config.valid) return '旁路配置无效，已安全关闭';
  if (!status.enabled) return '旁路配置未开启';
  if (config?.mode === 'pilot') return '受控 Pilot 已开启';
  if (config?.mode === 'all') return '全会话 Shadow 已开启';
  return '旁路配置已开启';
}

function normalizeSkillShadowStatus(input: unknown): SkillShadowStatus | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const rawMetrics = source.metrics;
  if (!rawMetrics || typeof rawMetrics !== 'object' || Array.isArray(rawMetrics)) return null;
  const metrics = rawMetrics as Record<string, unknown>;
  const observedTurns = count(metrics.observedTurns);
  const promotionByContentMode = record(metrics.promotionByContentMode);
  const rawRuntimeConfig = record(source.runtimeConfig);
  const rawCache = source.catalogCache;
  const cache = rawCache && typeof rawCache === 'object' && !Array.isArray(rawCache)
    ? rawCache as Record<string, unknown>
    : null;
  return Object.freeze({
    enabled: source.enabled === true,
    contextCompilerCanary: normalizeContextCompilerCanary(source.contextCompilerCanary),
    runtimeConfig: rawRuntimeConfig === null ? null : Object.freeze({
      mode: rawRuntimeConfig.mode === 'pilot' || rawRuntimeConfig.mode === 'all'
        ? rawRuntimeConfig.mode
        : 'off',
      configured: rawRuntimeConfig.configured === true,
      valid: rawRuntimeConfig.valid === true,
      enabled: rawRuntimeConfig.enabled === true,
      reason: optionalText(rawRuntimeConfig.reason) ?? 'agent-skill-shadow-config-unknown',
      sessionCount: count(rawRuntimeConfig.sessionCount),
      skillCount: count(rawRuntimeConfig.skillCount),
      revision: optionalText(rawRuntimeConfig.revision),
    }),
    metrics: Object.freeze({
      catalogRevision: optionalText(metrics.catalogRevision),
      validationWindow: count(metrics.validationWindow),
      observedTurns,
      qualifyingTurns: count(metrics.qualifyingTurns),
      nonQualifyingTurns: count(metrics.nonQualifyingTurns),
      promotionCompatibleTurns: count(metrics.promotionCompatibleTurns),
      mismatchTurns: count(metrics.mismatchTurns),
      unmappedCandidates: count(metrics.unmappedCandidates),
      unmappedLegacySelections: count(metrics.unmappedLegacySelections),
      nsfTurns: count(metrics.nsfTurns),
      nsfwTurns: count(metrics.nsfwTurns),
      averageDurationMicros: count(metrics.averageDurationMicros),
      attempts: metrics.attempts === undefined ? observedTurns : count(metrics.attempts),
      completed: metrics.completed === undefined ? observedTurns : count(metrics.completed),
      failed: count(metrics.failed),
      dropped: count(metrics.dropped),
      validationWindowHealthAligned: metrics.validationWindowHealthAligned === true,
      validationWindowFailed: count(metrics.validationWindowFailed),
      validationWindowDropped: count(metrics.validationWindowDropped),
      validationWindowCatalogRefreshFailures: count(metrics.validationWindowCatalogRefreshFailures),
      inFlight: count(metrics.inFlight),
      pending: count(metrics.pending),
      running: metrics.running === true,
      faulted: metrics.faulted === true,
      stale: metrics.stale === true,
      lastAttemptAt: optionalText(metrics.lastAttemptAt),
      lastSuccessAt: optionalText(metrics.lastSuccessAt),
      lastFailureAt: optionalText(metrics.lastFailureAt),
      lastErrorCode: optionalText(metrics.lastErrorCode),
      promotionAttemptDenominator: count(metrics.promotionAttemptDenominator),
      promotionCompatibleRateBps: count(metrics.promotionCompatibleRateBps),
      promotionByContentMode: Object.freeze({
        nsf: normalizeSkillShadowPromotionStatus(promotionByContentMode?.nsf),
        nsfw: normalizeSkillShadowPromotionStatus(promotionByContentMode?.nsfw),
      }),
    }),
    catalogCache: cache === null ? null : Object.freeze({
      policy: optionalText(cache.policy) ?? 'unknown',
      ttlMs: count(cache.ttlMs),
      cached: cache.cached === true,
      fresh: cache.fresh === true,
      stale: cache.stale === true,
      refreshing: cache.refreshing === true,
      refreshAttempts: count(cache.refreshAttempts),
      refreshFailures: count(cache.refreshFailures),
      lastErrorCode: optionalText(cache.lastErrorCode),
    }),
  });
}

const VALUE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [UNASSIGNED_SKILL_VALUE]: '未分配',
  legacy: '旧格式',
  foundation: '基础能力',
  policy: '策略',
  procedure: '执行流程',
  style: '文风',
  validator: '校验器',
  instruction: '指令（兼容）',
  workflow: '流程（兼容）',
  evaluator: '评估器（兼容）',
  tactical: '战术',
  host: '宿主内置',
  author: '作者维护',
  learned: 'Agent 学习生成',
  builtin: '内置',
  imported: '导入',
  user: '用户创建',
  generated: '自动生成',
  filesystem: '本机文件',
  managed: '托管生成',
  'agent-learning': 'Agent 学习',
  platform: '平台',
  operator: '操作者',
  active: '正式启用',
  enabled: '已启用',
  disabled: '已停用',
  stable: '稳定',
  candidate: '候选',
  validated: '已校验',
  'replay-passed': '回放通过',
  shadow: '影子运行',
  'canary-5': '5% 受控运行',
  'canary-25': '25% 受控运行',
  'canary-50': '50% 受控运行',
  quarantined: '已隔离',
  'rolled-back': '已回滚',
  experimental: '验证中',
  draft: '草稿',
  deprecated: '待下线',
  retired: '已下线',
  rejected: '已拒绝',
  killed: '已终止',
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '关键风险',
  advisory: '只读建议',
  proposal: '提案级',
  write: '写入级',
  safe: '普通内容',
  sfw: '普通内容',
  nsf: '普通内容',
  nsfw: '成人内容',
  all: '全部内容',
  interactive: '交互 Agent',
  learning: '学习 Agent',
  maintenance: '维护 Agent',
  context: 'Context Compiler',
  plan: '规划',
  execute: '执行',
  validate: '校验',
  learn: '学习',
  observe: '观察（兼容）',
  global: '全局',
  session: '会话',
  card: '角色卡',
  world: '世界',
});

function valueLabel(value: string): string {
  return VALUE_LABELS[value] ?? value;
}

function valuesLabel(values: readonly string[]): string {
  return values.map(valueLabel).join('、');
}

function badgeTone(value: string): 'ok' | 'warn' | 'danger' | 'muted' {
  if (value === 'active' || value === 'enabled' || value === 'stable' || value === 'advisory' || value === 'low') return 'ok';
  if (value === 'write' || value === 'high' || value === 'critical' || value === 'disabled'
    || value === 'retired' || value === 'rejected' || value === 'killed') return 'danger';
  if (value === 'proposal' || value === 'experimental' || value === 'draft' || value === 'medium' || value === 'deprecated') return 'warn';
  return 'muted';
}

function FilterSelect(props: Readonly<{
  label: string;
  value: string;
  values: readonly string[];
  onChange: (value: string) => void;
}>): React.JSX.Element {
  return (
    <label className="skill-repository__filter">
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="all">全部</option>
        {props.values.map((value) => <option key={value} value={value}>{valueLabel(value)}</option>)}
      </select>
    </label>
  );
}

/** Agent Skill 仓库：兼容旧 Skill 列表，并展示服务端逐步补齐的治理元数据。 */
export function SkillsPanel() {
  const [repository, setRepository] = useState<AgentSkillRepository | null>(null);
  const [filters, setFilters] = useState<SkillRepositoryFilters>(EMPTY_SKILL_REPOSITORY_FILTERS);
  const [importMsg, setImportMsg] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const [matched, setMatched] = useState<SkillMatch[] | null>(null);
  const [shadowStatus, setShadowStatus] = useState<SkillShadowStatus | null>(null);
  const [shadowStatusError, setShadowStatusError] = useState('');
  const [shadowStatusUpdatedAt, setShadowStatusUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const skills = repository?.skills ?? [];
  const visibleSkills = useMemo(() => filterAgentSkills(skills, filters), [skills, filters]);
  const computedStats = useMemo(() => summarizeAgentSkills(skills), [skills]);
  const stats = repository?.reportedStats ?? computedStats;
  const coveredAgentCount = repository?.consumers.length || computedStats.agents;
  const unboundSkillCount = skills.filter((skill) => skill.capabilityIds.length === 0).length;
  const shadowPromotions = shadowStatus?.metrics.promotionByContentMode;
  const shadowAnyPromotionReady = shadowPromotions
    ? shadowPromotions.nsf.promotionReady || shadowPromotions.nsfw.promotionReady
    : false;
  const shadowAnySampleGatePassed = shadowPromotions
    ? shadowPromotions.nsf.sampleGatePassed || shadowPromotions.nsfw.sampleGatePassed
    : false;
  const filterValues = useMemo(() => ({
    agents: [...new Set([
      ...skillFilterValues(skills, 'agents'),
      ...(repository?.consumers.map((consumer) => consumer.displayName) ?? []),
    ])].sort((left, right) => left.localeCompare(right, 'zh')),
    domains: skillFilterValues(skills, 'domains'),
    kinds: skillFilterValues(skills, 'kind'),
    statuses: skillFilterValues(skills, 'lifecycleStatus'),
    risks: skillFilterValues(skills, 'riskTier'),
    sources: skillFilterValues(skills, 'sourceType'),
    contentModes: skillFilterValues(skills, 'contentModes'),
    consumers: [...new Set([
      ...skillFilterValues(skills, 'consumers'),
      ...(repository?.consumers.map((consumer) => consumer.capabilityId) ?? []),
    ])].sort((left, right) => left.localeCompare(right, 'zh')),
  }), [skills, repository?.consumers]);

  const patchFilter = <K extends keyof SkillRepositoryFilters>(key: K, value: SkillRepositoryFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await authFetch('/api/skills');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setRepository(normalizeAgentSkillRepository(payload));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skill 仓库读取失败');
    } finally {
      setBusy(false);
    }
  };

  const loadShadowStatus = async () => {
    try {
      const response = await authFetch('/api/skills/shadow-metrics');
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const normalized = normalizeSkillShadowStatus(payload);
      if (!normalized) throw new Error('响应格式无效');
      setShadowStatus(normalized);
      setShadowStatusError('');
      setShadowStatusUpdatedAt(new Date().toLocaleTimeString());
    } catch (reason) {
      setShadowStatus(null);
      setShadowStatusUpdatedAt(null);
      setShadowStatusError(reason instanceof Error ? reason.message : '未知错误');
    }
  };

  useEffect(() => {
    void load();
    void loadShadowStatus();
    const timer = window.setInterval(() => { void loadShadowStatus(); }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  /** 从文风库导入作者风格 skill（幂等可重复）。 */
  const importStyle = async () => {
    setBusy(true);
    setError('');
    setImportMsg('');
    try {
      const response = await authFetch('/api/skills/import-style', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setImportMsg(`导入完成：新建 ${payload.created} / 更新 ${payload.updated} / 未变 ${payload.unchanged}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '文风库导入失败');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name.trim() || !content.trim()) { setError('技能名与指令正文不能为空'); return; }
    setBusy(true);
    setError('');
    try {
      const response = await authFetch('/api/skills/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, keywords, content }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setName(''); setDescription(''); setKeywords(''); setContent('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skill 添加失败');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (skill: AgentSkillRecord) => {
    if (!skill.toggleable) return;
    setBusy(true);
    setError('');
    try {
      const action = skill.enabled ? 'disable' : 'enable';
      const response = await authFetch(`/api/skills/${encodeURIComponent(skill.name)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skill 状态修改失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (skill: AgentSkillRecord) => {
    if (!skill.deletable || !window.confirm(`删除技能「${skill.name}」？`)) return;
    setBusy(true);
    setError('');
    try {
      const response = await authFetch(`/api/skills/${encodeURIComponent(skill.name)}/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skill 删除失败');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError('');
    try {
      const response = await authFetch('/api/skills/match', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setMatched((Array.isArray(payload.matched) ? payload.matched : []).map((match: Record<string, unknown>) => ({
        name: String(match.name ?? ''),
        score: Number(match.score ?? 0),
        ...(typeof match.body === 'string' ? { body: match.body } : {}),
      })));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Skill 命中测试失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="console skill-repository">
      <header className="skill-repository__header">
        <div>
          <p className="skill-repository__eyebrow">AGENT SKILL REPOSITORY</p>
          <h2>全 Agent Skill 仓库</h2>
          <p>
            集中查看每项 Skill 由哪个 Agent 消费、作用于什么领域、处于哪个生命周期，
            并保留旧版 Skill 的添加、启停、删除与命中测试。
          </p>
        </div>
        <div className="skill-repository__version">
          <span>仓库协议</span>
          <b>{repository?.repositoryVersion ?? '读取中…'}</b>
          {repository?.catalogRevision && <code title={repository.catalogRevision}>{repository.catalogRevision}</code>}
          {repository?.legacyFallback && <small>服务端仍是旧列表，缺失字段已标为“未分配”</small>}
        </div>
      </header>

      <section className="skill-repository__stats" aria-label="Skill 仓库摘要">
        <div><strong>{stats.total}</strong><span>Skill 总数</span></div>
        <div><strong>{stats.active}</strong><span>当前生效</span></div>
        <div><strong>{stats.candidate}</strong><span>候选 Skill</span></div>
        <div><strong>{stats.managed}</strong><span>托管生成</span></div>
        <div><strong>{stats.writeGuidance}</strong><span>写入级风险</span></div>
        <div><strong>{coveredAgentCount}</strong><span>Agent 消费方</span></div>
        <div><strong>{unboundSkillCount}</strong><span>待绑定 Skill</span></div>
      </section>

      {unboundSkillCount > 0 && (
        <p className="skill-repository__binding-note">
          {unboundSkillCount} 项现有 Skill 尚未声明 Agent capability，仍按原有文风或战术路径正常使用；
          “待绑定”不表示 Agent 未启用。
        </p>
      )}

      {(shadowStatus || shadowStatusError) && (
        <section
          className={`skill-repository__shadow-status ${shadowStatus?.enabled ? 'is-running' : 'is-off'} ${shadowStatus?.metrics.faulted || (shadowStatus?.runtimeConfig?.configured && !shadowStatus.runtimeConfig.valid) || (shadowStatus?.metrics.catalogRevision && !shadowStatus.metrics.validationWindowHealthAligned) || shadowStatusError ? 'is-fault' : ''} ${shadowStatus?.metrics.stale ? 'is-stale' : ''}`}
          aria-label="新旧 Skill 选择器旁路验证状态"
        >
          <div>
            <span className="skill-repository__shadow-dot" aria-hidden="true" />
            <strong>{skillShadowConfigTitle(shadowStatus)}</strong>
            <small>{shadowStatusUpdatedAt ? `更新于 ${shadowStatusUpdatedAt} · ` : ''}每 15 秒自动刷新</small>
          </div>
          {shadowStatusError && (
            <p className="skill-repository__shadow-alert" role="status">
              状态刷新失败：{shadowStatusError}；下次自动刷新会继续重试。
            </p>
          )}
          {shadowStatus === null ? (
            <p>无法读取旁路运行状态；这不代表 Agent 已停用。</p>
          ) : !shadowStatus.enabled ? (
            <p>
              {shadowStatus.runtimeConfig?.configured && !shadowStatus.runtimeConfig.valid
                ? `配置校验失败（${shadowStatus.runtimeConfig.reason}），旁路已 fail-closed；旧匹配器仍正常决定本轮 Skill。`
                : '旧匹配器仍正常决定本轮 Skill；这里只表示新选择器尚未采样，不是 Agent 停用。'}
            </p>
          ) : (
            <>
              {shadowStatus.runtimeConfig?.mode === 'pilot' ? (
                <p>
                  精确纳入 {shadowStatus.runtimeConfig.sessionCount} 个会话、
                  {shadowStatus.runtimeConfig.skillCount} 个 Skill；未在白名单中的会话与 Skill 不参与采样。
                </p>
              ) : shadowStatus.runtimeConfig?.mode === 'all' ? (
                <p>
                  全部会话参与 Shadow，但仅允许 {shadowStatus.runtimeConfig.skillCount} 个精确 Skill；
                  新增 active Skill 不会自动进入。
                </p>
              ) : null}
              <p>
                {shadowStatus.metrics.running
                  ? `运行中：${shadowStatus.metrics.inFlight} 个执行中，${shadowStatus.metrics.pending} 个待处理。`
                  : shadowStatus.metrics.faulted
                    ? `故障：最近一次尝试失败（${shadowStatus.metrics.lastErrorCode ?? '未知错误'}）。`
                    : shadowStatus.metrics.catalogRevision && !shadowStatus.metrics.validationWindowHealthAligned
                      ? '故障：运行健康基线尚未与当前目录版本对齐，晋级门禁保持关闭。'
                    : shadowStatus.metrics.stale
                      ? '陈旧：超过 2 分钟没有新的旁路活动。'
                      : shadowStatus.metrics.attempts === 0
                        ? '配置已生效，尚未收到成功提交回合的采样尝试。'
                        : shadowStatus.metrics.qualifyingTurns === 0
                          ? `运行正常：已观察 ${shadowStatus.metrics.nonQualifyingTurns} 个未触发 Skill 的回合，尚无晋级样本。`
                          : shadowAnyPromotionReady
                            ? '运行正常：至少一个内容分区已达旁路评估门槛；这仍不会自动晋级。'
                            : shadowAnySampleGatePassed
                              ? '运行正常：至少一个内容分区样本已足，但仍有选择差异或运行健康问题。'
                              : '运行正常：已有触发样本；普通与成人内容分区需要分别累计至少 20 个合格回合。'}
                {shadowStatus.metrics.validationWindowDropped > 0
                  ? ` 当前窗口为保护主对话，已合并丢弃 ${shadowStatus.metrics.validationWindowDropped} 个过期待处理样本。`
                  : ''}
              </p>
              {shadowStatus.catalogCache?.stale && (
                <p>目录缓存已过期；下一次样本会先刷新，刷新失败将按 fail-closed 计为故障。</p>
              )}
              <div className="skill-repository__shadow-grid">
                <span title={shadowStatus.metrics.promotionByContentMode.nsf.blockers.join(', ') || undefined}>
                  <b>普通旁路评估</b> {skillShadowPromotionText(shadowStatus.metrics.promotionByContentMode.nsf)}
                </span>
                <span title={shadowStatus.metrics.promotionByContentMode.nsfw.blockers.join(', ') || undefined}>
                  <b>成人旁路评估</b> {skillShadowPromotionText(shadowStatus.metrics.promotionByContentMode.nsfw)}
                </span>
                <span><b>{shadowStatus.metrics.qualifyingTurns}</b> 触发样本（晋级分母）</span>
                <span><b>{shadowStatus.metrics.promotionCompatibleTurns} / {shadowStatus.metrics.qualifyingTurns}</b> 集合与顺序一致 / 触发样本</span>
                <span><b>{shadowStatus.metrics.nonQualifyingTurns}</b> 未触发回合（不计晋级）</span>
                <span><b>{shadowStatus.metrics.attempts}</b> Runner 投递尝试（运行健康）</span>
                <span><b>{shadowStatus.metrics.completed}</b> 已完成</span>
                <span><b>{shadowStatus.metrics.validationWindowFailed}</b> 当前窗口执行失败</span>
                <span><b>{shadowStatus.metrics.validationWindowDropped}</b> 当前窗口过载合并丢弃</span>
                <span><b>{shadowStatus.metrics.validationWindowCatalogRefreshFailures}</b> 当前窗口目录刷新失败</span>
                <span><b>{shadowStatus.metrics.mismatchTurns}</b> 选择结果有差异</span>
                <span><b>{shadowStatus.metrics.unmappedCandidates + shadowStatus.metrics.unmappedLegacySelections}</b> 尚未映射</span>
                <span><b>{shadowStatus.metrics.nsfTurns} / {shadowStatus.metrics.nsfwTurns}</b> 普通 / 成人</span>
                <span><b>{(shadowStatus.metrics.averageDurationMicros / 1_000).toFixed(1)} ms</b> 平均旁路耗时</span>
                <span><b>{shadowStatus.metrics.validationWindow}</b> 当前验证窗口</span>
              </div>
              {shadowStatus.metrics.catalogRevision && (
                <p>当前目录版本：<code>{shadowStatus.metrics.catalogRevision.slice(0, 19)}…</code>；版本变化会自动开启新的验证窗口。</p>
              )}
              <p>
                进程累计：执行失败 {shadowStatus.metrics.failed} 次、过载合并丢弃 {shadowStatus.metrics.dropped} 次、
                目录刷新失败 {shadowStatus.catalogCache?.refreshFailures ?? 0} 次；历史窗口故障只保留审计可见性，不阻断新目录版本。
              </p>
            </>
          )}
          <em>旁路只观察，不注入 Prompt；当前仍由旧匹配器生成。普通与成人内容分别至少需要 20 个实际触发样本；达到旁路评估门槛也不会自动晋级。空回合单独统计，执行失败、目录刷新失败或丢弃会阻断运行健康门禁。</em>
        </section>
      )}

      {shadowStatus?.contextCompilerCanary && (
        <section className="console-section" aria-label="Context Compiler 灰度状态">
          <strong>Context Compiler 灰度：{shadowStatus.contextCompilerCanary.enabled ? '已启用' : '已停止或配置不匹配'}</strong>
          <p>精确 1 个会话 · {shadowStatus.contextCompilerCanary.providerId} / {shadowStatus.contextCompilerCanary.model}
            {' '}· Profile <code title={shadowStatus.contextCompilerCanary.profileDigest}>
              {shadowStatus.contextCompilerCanary.profileDigest.slice(0, 19)}…</code></p>
          <p>已派发 {shadowStatus.contextCompilerCanary.dispatched} · 已完成 {shadowStatus.contextCompilerCanary.completed}
            {' '}· 编译成功 {shadowStatus.contextCompilerCanary.succeeded} · 失败 {shadowStatus.contextCompilerCanary.failed}
            {' '}· 进行中 {shadowStatus.contextCompilerCanary.inFlight}</p>
          <p>目标 {shadowStatus.contextCompilerCanary.requiredSamples} 次成功，尚需 {shadowStatus.contextCompilerCanary.remainingSamples} 次。
            统计在服务重启后清零；编译成功不代表最终采用或质量改善。</p>
        </section>
      )}

      <section className="console-section skill-repository__coverage">
        <div className="skill-repository__section-heading">
          <div>
            <h3>Agent 覆盖</h3>
            <small>这里只显示静态调用接线；暂停、熔断和受控验证状态请以 Agent 控制面为准</small>
          </div>
        </div>
        {(repository?.consumers.length ?? 0) > 0 ? (
          <div className="skill-repository__consumer-grid">
            {repository!.consumers.map((consumer) => (
              <button
                key={consumer.capabilityId}
                className={filters.agent === consumer.displayName ? 'active' : ''}
                onClick={() => {
                  patchFilter('agent', filters.agent === consumer.displayName ? 'all' : consumer.displayName);
                  patchFilter('consumer', filters.agent === consumer.displayName ? 'all' : consumer.capabilityId);
                }}
              >
                <span><b>{consumer.displayName}</b><small>{valueLabel(consumer.lane)}</small></span>
                <strong>{consumer.activeSkillCount} / {consumer.skillCount}</strong>
                <code>{consumer.capabilityId}</code>
                <em>
                  {consumer.runtimeBound ? '已接入调用通道' : '仅登记，尚未接线'}
                  {' · '}
                  {consumer.domains.length ? valuesLabel(consumer.domains) : '尚未声明领域'}
                </em>
              </button>
            ))}
          </div>
        ) : (
          <p className="console-none">当前服务端尚未提供 Agent 调用方目录；Skill 列表仍可按已有头字段查看。</p>
        )}
      </section>

      <section className="console-section skill-repository__catalogue">
        <div className="skill-repository__section-heading">
          <div>
            <h3>仓库目录</h3>
            <small>显示 {visibleSkills.length} / {skills.length} 项</small>
          </div>
          <div className="skill-repository__heading-actions">
            <button className="link-btn" onClick={() => { void load(); void loadShadowStatus(); }} disabled={busy}>刷新仓库</button>
            <button className="link-btn" onClick={() => void importStyle()} disabled={busy}>导入文风库</button>
          </div>
        </div>

        <div className="skill-repository__search">
          <input
            value={filters.search}
            onChange={(event) => patchFilter('search', event.target.value)}
            placeholder="搜索名称、Skill ID、Agent、领域、能力或触发词…"
            aria-label="搜索 Agent Skill 仓库"
          />
          {filters.search && <button onClick={() => patchFilter('search', '')}>清空</button>}
        </div>

        <div className="skill-repository__role-filter" aria-label="旧版 Skill 分类快捷筛选">
          {(['all', 'style', 'tactical'] as const).map((role) => (
            <button
              key={role}
              className={filters.role === role ? 'active' : ''}
              onClick={() => patchFilter('role', role)}
            >
              {role === 'all' ? '全部 Skill' : role === 'style' ? '文风 Skill' : '战术 Skill'}
            </button>
          ))}
          {importMsg && <span>{importMsg}</span>}
        </div>

        <div className="skill-repository__filters">
          <FilterSelect label="Agent" value={filters.agent} values={filterValues.agents} onChange={(value) => patchFilter('agent', value)} />
          <FilterSelect label="领域" value={filters.domain} values={filterValues.domains} onChange={(value) => patchFilter('domain', value)} />
          <FilterSelect label="类型" value={filters.kind} values={filterValues.kinds} onChange={(value) => patchFilter('kind', value)} />
          <FilterSelect label="状态" value={filters.status} values={filterValues.statuses} onChange={(value) => patchFilter('status', value)} />
          <FilterSelect label="风险" value={filters.risk} values={filterValues.risks} onChange={(value) => patchFilter('risk', value)} />
          <FilterSelect label="来源" value={filters.source} values={filterValues.sources} onChange={(value) => patchFilter('source', value)} />
          <FilterSelect label="内容模式" value={filters.contentMode} values={filterValues.contentModes} onChange={(value) => patchFilter('contentMode', value)} />
          <FilterSelect label="调用方" value={filters.consumer} values={filterValues.consumers} onChange={(value) => patchFilter('consumer', value)} />
        </div>

        {repository && skills.length === 0 && <p className="console-none">仓库中暂无 Skill，可在下方添加。</p>}
        {skills.length > 0 && visibleSkills.length === 0 && (
          <p className="console-none">没有符合当前筛选条件的 Skill。</p>
        )}
        <div className="skill-repository__list">
          {visibleSkills.map((skill) => (
            <article className="skill-repository__card" key={skill.skillId}>
              <div className="skill-repository__card-heading">
                <div>
                  <div className="skill-repository__name-row">
                    <h4>{skill.name}</h4>
                    <span className={`skill-repository__badge skill-repository__badge--${skill.enabled && skill.active ? 'ok' : 'muted'}`}>
                      {skill.enabled && skill.active ? '可用' : '未运行'}
                    </span>
                    {skill.immutable && <span className="skill-repository__badge skill-repository__badge--muted">只读</span>}
                  </div>
                  <code>{skill.skillId}</code>
                </div>
                <span className="skill-repository__version-tag">v{skill.version}</span>
              </div>
              <p className="skill-repository__description">{skill.description || '暂无触发说明'}</p>
              <div className="skill-repository__badges">
                <span>{valuesLabel(skill.agents)}</span>
                <span>{valuesLabel(skill.domains)}</span>
                <span>{valueLabel(skill.kind)}</span>
                <span className={`skill-repository__badge--${badgeTone(skill.lifecycleStatus)}`}>{valueLabel(skill.lifecycleStatus)}</span>
                <span className={`skill-repository__badge--${badgeTone(skill.riskTier)}`}>{valueLabel(skill.riskTier)}</span>
              </div>
              <details className="skill-repository__details">
                <summary>查看治理信息与调用边界</summary>
                <dl>
                  <div><dt>所属 Agent</dt><dd>{valuesLabel(skill.agents)}</dd></div>
                  <div><dt>领域 / 任务</dt><dd>{valuesLabel(skill.domains)}</dd></div>
                  <div><dt>Skill 类型</dt><dd>{valueLabel(skill.kind)}</dd></div>
                  <div><dt>生命周期</dt><dd>{valueLabel(skill.lifecycleStatus)}</dd></div>
                  <div><dt>风险级别</dt><dd>{valueLabel(skill.riskTier)}</dd></div>
                  <div><dt>来源 / 所有者</dt><dd>{valueLabel(skill.sourceType)} / {valueLabel(skill.owner)}</dd></div>
                  <div><dt>内容模式</dt><dd>{valuesLabel(skill.contentModes)}{skill.nsfw ? ' · 含成人内容能力' : ''}</dd></div>
                  <div><dt>调用方</dt><dd>{valuesLabel(skill.consumers)}</dd></div>
                  <div><dt>运行阶段</dt><dd>{skill.phases.length ? valuesLabel(skill.phases) : '未标注'}</dd></div>
                  <div><dt>作用域上限</dt><dd>{valueLabel(skill.scopeLevel)}</dd></div>
                  <div><dt>能力 ID</dt><dd>{skill.capabilityIds.length ? skill.capabilityIds.join('、') : '未标注'}</dd></div>
                  <div><dt>触发词</dt><dd>{skill.keywords.length ? skill.keywords.join('、') : '未设置'}</dd></div>
                  <div><dt>来源引用</dt><dd>{skill.sourceRef || skill.path || '未提供'}</dd></div>
                </dl>
                {skill.isDefault && <p className="skill-repository__note">这是会话默认文风底座。</p>}
                {skill.legacy && <p className="skill-repository__note">旧格式 Skill：可继续使用；补齐仓库头字段后即可参与完整治理筛选。</p>}
              </details>
              <div className="skill-repository__actions">
                <button className="link-btn" onClick={() => void toggle(skill)} disabled={busy || !skill.toggleable}>
                  {skill.enabled ? '停用' : '启用'}
                </button>
                <button className="link-btn danger" onClick={() => void remove(skill)} disabled={busy || !skill.deletable}>删除</button>
                {(!skill.toggleable || !skill.editable || !skill.deletable) && (
                  <small>
                    {!skill.toggleable
                      ? '启停由宿主管理'
                      : !skill.editable && !skill.deletable
                        ? '正文只读；仍可随时停用'
                        : '服务端限制部分写操作'}
                  </small>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="console-section skill-repository__tool">
        <h3>命中测试</h3>
        <p className="muted">输入一条模拟对话，检查当前启用的 Skill 是否会被语义匹配。</p>
        <div className="console-search">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入用户语句，看哪些 Skill 会命中…" />
          <button onClick={() => void test()} disabled={busy}>匹配</button>
        </div>
        {matched && (matched.length === 0
          ? <p className="console-none">本次没有 Skill 命中。</p>
          : <ul className="console-hits">{matched.map((match) => (
            <li key={match.name} className="hit">
              <span className="hit-tag">[{match.score.toFixed(2)}]</span>
              <span className="hit-content"><b>{match.name}</b> {match.body ? `— ${match.body}` : ''}</span>
            </li>
          ))}</ul>)}
      </section>

      <section className="console-section skill-repository__tool">
        <h3>添加用户 Skill</h3>
        <p className="muted">继续写入现有用户 Skill 目录；未填写的新仓库头字段会显示为“未分配”。</p>
        <div className="console-bar">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="技能名（英文/中文）" className="console-filter skill-repository__name-input" />
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="何时使用（触发判断依据）" className="console-filter" />
        </div>
        <div className="console-bar">
          <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="触发词（逗号分隔）" className="console-filter" />
        </div>
        <textarea
          className="console-textarea"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={'指令正文（Markdown，注入 <Skill 指令> 块）\n例：\n## 目标\n遇到 X 场景时……\n## 规则\n1. ……\n2. ……'}
          rows={6}
        />
        <div className="console-bar"><button onClick={() => void add()} disabled={busy}>添加 Skill</button></div>
      </section>

      {busy && <p className="progress">正在同步 Skill 仓库…</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
