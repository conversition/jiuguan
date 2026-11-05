import { authFetch } from './authClient.ts';
import { fetchWithInactivityTimeout } from './activityTimeout.ts';

const CAPABILITIES = ['interactive.prelude', 'interactive.variableProposal', 'interactive.critic', 'interactive.aqlReplan'] as const;
type Capability = typeof CAPABILITIES[number] | 'context.compiler';
type Item<C extends string> = Readonly<{ capability: C; execution: 'recorded' | 'cached' | 'unknown';
  executionClass: 'production' | 'shadow' | 'operational-replay' | 'fixture' | null; validated: boolean; consumed: boolean }>;
const STYLE_STATUSES = ['pending', 'leased', 'executing', 'uncertain', 'done', 'failed', 'cancelled'] as const;
const STYLE_REASONS = ['style-job-completed', 'style-job-failed-provider', 'style-job-failed-rejected',
  'style-job-cancelled-session-deleted', 'style-job-cancelled-request', 'style-job-cancelled-quiesce',
  'style-job-fenced-source-revision', 'style-job-attempts-exhausted', 'style-job-skipped-ineligible',
  'style-job-execution-uncertain', 'style-job-deferred-unavailable', 'style-job-intent-unbound'] as const;
type StyleJobView = Readonly<{ state: 'no-intent' | 'no-job' | 'unavailable' | 'invalidated' }> | Readonly<{
  state: 'recorded'; intentState: 'pending' | 'delivered' | 'invalidated'; status: typeof STYLE_STATUSES[number];
  reasonCode: typeof STYLE_REASONS[number] | null; result: 'created' | 'rejected' | 'skipped' | 'cancelled' | 'unknown' | null }>;
export type TurnAgentEvidence = Readonly<{ state: 'active' | 'unknown' }> | Readonly<{
  state: 'verified'; round: number; capabilities: readonly Item<Capability>[];
  learning: readonly Item<'learning.preference' | 'learning.branchPreference'>[];
  learningConsumption: readonly Readonly<{ capability: 'learning.preference' | 'learning.branchPreference';
    executionClass: Exclude<Item<string>['executionClass'], null>; origin: 'current' | 'prior' }>[];
  styleCompile: StyleJobView;
  maintenance: readonly (Item<'maintenance.memory' | 'maintenance.arc' | 'maintenance.npc' | 'maintenance.worldbook'> &
    Readonly<{ status: 'active' | 'closed' | 'no_op' | 'failed' | 'cancelled' | 'rejected' | 'stale' | 'rolled_back' }>)[];
}>;

/** Missing receipts are not proof that a capability did or did not run. */
export function summarizeTurnEvidence(evidence: Extract<TurnAgentEvidence, { state: 'verified' }>) {
  const hasEvidence = (item: Item<string>) => item.execution !== 'unknown'
    || item.executionClass !== null || item.validated || item.consumed;
  return Object.freeze({
    capabilities: evidence.capabilities.filter(hasEvidence),
    missingCapabilities: evidence.capabilities.filter(item => !hasEvidence(item)),
    learning: evidence.learning.filter(hasEvidence),
    missingLearning: evidence.learning.filter(item => !hasEvidence(item)),
  });
}
export async function readCurrentTurnEvidence(sessionId: string, signal: AbortSignal,
  fetcher: typeof authFetch = authFetch): Promise<TurnAgentEvidence> {
  const url = `/api/session/${encodeURIComponent(sessionId)}/turn-agent-evidence`;
  const response = await fetchWithInactivityTimeout(s => fetcher(url, { signal: s, cache: 'no-store' }), 12_000, signal);
  if (!response.ok) throw new Error(`turn-agent-evidence-http-${response.status}`);
  const data = await response.json() as { evidence?: unknown };
  if (!data?.evidence || typeof data.evidence !== 'object' || Array.isArray(data.evidence)) throw new Error('turn-agent-evidence-invalid');
  const row = data.evidence as Record<string, unknown>;
  if (row.state === 'active' || row.state === 'unknown') {
    if (Object.keys(row).length !== 1) throw new Error('turn-agent-evidence-invalid');
    return Object.freeze({ state: row.state });
  }
  if (row.state !== 'verified' || Object.keys(row).length !== 7 || !Number.isSafeInteger(row.round)
    || Number(row.round) < 1 || !Array.isArray(row.capabilities) || row.capabilities.length < CAPABILITIES.length + 1
    || row.capabilities.length > CAPABILITIES.length + 256) {
    throw new Error('turn-agent-evidence-invalid');
  }
  const capabilities = row.capabilities.map((item: unknown, index: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('turn-agent-evidence-invalid');
    const entry = item as Record<string, unknown>;
    const expected = index < CAPABILITIES.length ? CAPABILITIES[index]! : 'context.compiler';
    if (Object.keys(entry).length !== 5 || entry.capability !== expected
      || !['recorded', 'cached', 'unknown'].includes(String(entry.execution))
      || (entry.execution === 'cached' && expected !== 'context.compiler')
      || ![null, 'production', 'shadow', 'operational-replay', 'fixture'].includes(entry.executionClass as string | null)
      || typeof entry.validated !== 'boolean' || typeof entry.consumed !== 'boolean'
      || (entry.executionClass === null && (entry.execution !== 'unknown' || entry.validated || entry.consumed))) {
      throw new Error('turn-agent-evidence-invalid');
    }
    return Object.freeze({ capability: expected as Capability, execution: entry.execution as 'recorded' | 'cached' | 'unknown',
      executionClass: entry.executionClass as 'production' | 'shadow' | 'operational-replay' | 'fixture' | null,
      validated: entry.validated, consumed: entry.consumed });
  });
  const learningKinds = ['learning.preference', 'learning.branchPreference'] as const;
  const maintenanceKinds = ['maintenance.memory', 'maintenance.arc', 'maintenance.npc', 'maintenance.worldbook'] as const;
  const statuses = ['active', 'closed', 'no_op', 'failed', 'cancelled', 'rejected', 'stale', 'rolled_back'] as const;
  function parseExtra<C extends string>(value: unknown, kinds: readonly C[], statusRequired: boolean): Item<C> & { status?: typeof statuses[number] } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('turn-agent-evidence-invalid');
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).length !== (statusRequired ? 6 : 5) || typeof entry.capability !== 'string'
      || !kinds.includes(entry.capability as C) || !['recorded', 'unknown'].includes(String(entry.execution))
      || ![null, 'production', 'shadow', 'operational-replay', 'fixture'].includes(entry.executionClass as string | null)
      || typeof entry.validated !== 'boolean' || typeof entry.consumed !== 'boolean'
      || (entry.executionClass === null && (entry.execution !== 'unknown' || entry.validated || entry.consumed))
      || (statusRequired && !statuses.includes(entry.status as typeof statuses[number]))) throw new Error('turn-agent-evidence-invalid');
    return Object.freeze({ capability: entry.capability as C, execution: entry.execution as 'recorded' | 'unknown',
      executionClass: entry.executionClass as Item<C>['executionClass'], validated: entry.validated, consumed: entry.consumed,
      ...(statusRequired ? { status: entry.status as typeof statuses[number] } : {}) });
  }
  if (!Array.isArray(row.learning) || row.learning.length !== learningKinds.length
    || !Array.isArray(row.maintenance) || row.maintenance.length > 256) throw new Error('turn-agent-evidence-invalid');
  const learning = row.learning.map((item: unknown, index: number) => {
    const entry = parseExtra(item, learningKinds, false);
    if (entry.capability !== learningKinds[index]) throw new Error('turn-agent-evidence-invalid');
    return entry;
  });
  const maintenance = row.maintenance.map((item: unknown) => parseExtra(item, maintenanceKinds, true) as
    Item<typeof maintenanceKinds[number]> & { status: typeof statuses[number] });
  if (!Array.isArray(row.learningConsumption) || row.learningConsumption.length > 256) throw new Error('turn-agent-evidence-invalid');
  const learningConsumption = row.learningConsumption.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('turn-agent-evidence-invalid');
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).length !== 3 || !learningKinds.includes(entry.capability as typeof learningKinds[number])
      || !['production', 'shadow', 'operational-replay', 'fixture'].includes(String(entry.executionClass))
      || !['current', 'prior'].includes(String(entry.origin))) throw new Error('turn-agent-evidence-invalid');
    return Object.freeze({ capability: entry.capability as typeof learningKinds[number],
      executionClass: entry.executionClass as Exclude<Item<string>['executionClass'], null>, origin: entry.origin as 'current' | 'prior' });
  });
  if (!row.styleCompile || typeof row.styleCompile !== 'object' || Array.isArray(row.styleCompile)) throw new Error('turn-agent-evidence-invalid');
  const style = row.styleCompile as Record<string, unknown>;
  let styleCompile: StyleJobView;
  if (style.state === 'recorded') {
    if (Object.keys(style).length !== 5 || !['pending', 'delivered', 'invalidated'].includes(String(style.intentState))
      || !STYLE_STATUSES.includes(style.status as typeof STYLE_STATUSES[number])
      || !(style.reasonCode === null || STYLE_REASONS.includes(style.reasonCode as typeof STYLE_REASONS[number]))
      || ![null, 'created', 'rejected', 'skipped', 'cancelled', 'unknown'].includes(style.result as string | null)) {
      throw new Error('turn-agent-evidence-invalid');
    }
    styleCompile = Object.freeze({ state: 'recorded', intentState: style.intentState as 'pending' | 'delivered' | 'invalidated',
      status: style.status as typeof STYLE_STATUSES[number], reasonCode: style.reasonCode as typeof STYLE_REASONS[number] | null,
      result: style.result as 'created' | 'rejected' | 'skipped' | 'cancelled' | 'unknown' | null });
  } else {
    if (Object.keys(style).length !== 1 || !['no-intent', 'no-job', 'unavailable', 'invalidated'].includes(String(style.state))) throw new Error('turn-agent-evidence-invalid');
    styleCompile = Object.freeze({ state: style.state as 'no-intent' | 'no-job' | 'unavailable' | 'invalidated' });
  }
  return Object.freeze({ state: 'verified', round: Number(row.round), capabilities: Object.freeze(capabilities),
    learning: Object.freeze(learning), maintenance: Object.freeze(maintenance),
    learningConsumption: Object.freeze(learningConsumption), styleCompile });
}

/** Only explains the persisted job; it never promises retries or infers a Provider call. */
export function styleJobStatusText(value: StyleJobView): string {
  if (value.state === 'no-intent') return '本回合无后台编译意图记录；同步编译执行情况未知。请查看学习配置及原编译记录。';
  if (value.state === 'no-job') return '已记录编译意图，未找到关联任务；请检查调度器状态及配置。';
  if (value.state === 'unavailable') return '原编译账本不可用；恢复服务后重读。';
  if (value.state === 'invalidated') return '原编译意图已失效；不能据此派发或推断当前执行情况。';
  if (value.state !== 'recorded') throw new Error('turn-agent-evidence-invalid');
  const statuses = { pending: '排队中', leased: '已认领，等待执行', executing: '执行阶段', uncertain: '结果不确定，禁止自动重试',
    done: '任务已结算', failed: '任务失败', cancelled: '任务已取消' };
  const reasons: Record<typeof STYLE_REASONS[number], string> = {
    'style-job-completed': '结算完成', 'style-job-failed-provider': 'Provider 失败', 'style-job-failed-rejected': '产物被拒绝',
    'style-job-cancelled-session-deleted': '会话已删除', 'style-job-cancelled-request': '已收到取消请求',
    'style-job-cancelled-quiesce': '服务已停止派发', 'style-job-fenced-source-revision': '来源版本已失效',
    'style-job-attempts-exhausted': '认领次数已用完', 'style-job-skipped-ineligible': '未满足执行条件',
    'style-job-execution-uncertain': '执行结果待核对', 'style-job-deferred-unavailable': '等待会话可用',
    'style-job-intent-unbound': '任务未绑定原意图',
  };
  const results = { created: '账本记录已产出提案', rejected: '产物被拒绝', skipped: '未执行', cancelled: '已取消', unknown: '结果未知' };
  const next = value.intentState === 'invalidated' ? '原意图已失效，不再派发。'
    : value.status === 'pending' || value.status === 'leased' ? '等待调度与来源条件满足。'
    : value.status === 'executing' ? '等待任务结算。'
    : value.status === 'uncertain' ? '须核对原执行结果，不自动重试。'
    : '本任务已结束；后续操作仍受原学习策略约束。';
  return `${statuses[value.status]}${value.reasonCode ? `（${reasons[value.reasonCode]}）` : ''}；${value.result ? results[value.result] : '尚无结算结果'}。${next}`;
}
