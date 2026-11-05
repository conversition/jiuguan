/** @author Codex @date 2026-10-26 @version 1.0 */
import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentSubcapabilityId,
  PublicBranchActionTag,
  PublicAgentControlReadModel,
  PublicAgentRolloutLane,
  PublicAgentSubcapability,
  PublicLearningProfileScope,
  PublicPromptPreferenceToken,
  PublicStyleEvaluationCheck,
} from '../../../packages/mobile-contracts/src/agent-control.ts';
import {
  AGENT_LANE_OPERATOR_OVERRIDE_ACK,
  AgentControlMutationError,
  clearPreferenceProfileControl,
  fetchSessionAgentControl,
  isMaintenanceAgentStatusInvalidation,
  maintenanceProposalRevisionMap,
  maintenanceTruthChanged,
  mutateAgentLaneControl,
  setMaintenanceGlobalEnabled,
  setSessionMaintenanceEnabled,
} from './agentControlClient.ts';
import type { EventStreamSubscription } from '../../../packages/client-runtime/public/events.ts';
import { startAgentStatusEvents } from './agentStatusEvents.ts';
import { AgentLoopTaskInspector } from './AgentLoopTaskInspector.tsx';
import { readCurrentTurnAdmission, type CurrentTurnAdmission } from './currentTurnAdmission.ts';
import { readCurrentTurnEvidence, styleJobStatusText, summarizeTurnEvidence, type TurnAgentEvidence } from './currentTurnEvidence.ts';
import type { AgentLoopTaskReader } from './agentLoopTaskStatusClient.ts';
import {
  capabilityDisplayState,
  capabilityPermissionLabel,
  resolveCapabilityStopSource,
  selectLaneDisplayCapability,
  styleReviewAction,
} from './agentStatusPolicy.ts';
import { NsfwSceneSafetyControl } from './NsfwSceneSafetyControl.tsx';
import { AgentProviderRoutingControl } from './AgentProviderRoutingControl.tsx';

const LABELS: Readonly<Record<AgentSubcapabilityId, string>> = Object.freeze({
  'interactive.prelude': '查证前奏',
  'interactive.director': '剧情导演',
  'interactive.critic': '正文校验',
  'interactive.variableProposal': '变量提案',
  'interactive.aqlReplan': '检索重规划',
  'learning.preference': '偏好学习',
  'learning.branchPreference': '分支偏好',
  'learning.styleCompile': '文风 Skill',
  'maintenance.memory': '记忆维护',
  'maintenance.branchIndex': '剧情弧维护（兼容项）',
  'maintenance.arc': '剧情弧',
  'maintenance.npc': 'NPC 状态',
  'maintenance.worldbook': '世界书修正',
  'context.compiler': '上下文恢复',
});

const LANE_LABELS: Readonly<Record<PublicAgentRolloutLane, string>> = Object.freeze({
  interactive: '对话能力', learning: '学习能力', maintenance: '后台维护',
});
const AGENT_STATUS_POLL_MS = 30_000;
const MAINTENANCE_STATUS_LABELS = Object.freeze({
  pending: '待审批', applied: '已应用', rejected: '已拒绝', stale: '快照已过期', rolled_back: '已回滚',
});
const MAINTENANCE_PROPOSAL_LABELS = Object.freeze({
  memory_consolidation: '记忆维护',
  branch_index: '剧情弧',
  rolling_summary: '滚动摘要',
  npc_state: 'NPC 状态',
});
/** 世界书修正的状态集合与维护提案略有不同（多了 approved / reverted）。 */
const WORLDBOOK_REPAIR_STATUS_LABELS = Object.freeze({
  pending: '待审阅', approved: '已批准（待应用）', applied: '已应用',
  rejected: '已拒绝', stale: '文件已变更（修正作废）', reverted: '已回滚',
});
/** 只暴露原因分类；条目正文按既有 content-free 边界不跨 HTTP。 */
const WORLDBOOK_REPAIR_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'resolve-conflict': '解决设定互相矛盾',
  'clarify-scope': '收紧含糊的适用范围',
  'disable-stale-entry': '停用已过时的条目',
});
const LEARNING_SCOPE_LABELS: Readonly<Record<PublicLearningProfileScope, string>> = Object.freeze({
  session: '当前会话', card: '角色卡回退', none: '未生效',
});
const PROMPT_VALUE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  slow: '慢节奏', balanced: '平衡节奏', fast: '快节奏',
  romance: '浪漫', mystery: '悬疑', action: '动作', slice_of_life: '日常', dark: '暗黑', comedy: '喜剧', horror: '恐怖',
  choice_guided: '选项引导', freeform: '自由输入', dialogue_heavy: '对话为主', exploration: '探索为主',
  first_person: '第一人称', second_person: '第二人称', third_person: '第三人称',
  slow_burn: '慢热关系', trust: '信任建立', rivalry: '竞争关系',
  proactive: '主动推进', cautious: '谨慎行动', diplomatic: '交涉优先', confrontational: '正面对抗',
});
const BRANCH_ACTION_LABELS: Readonly<Record<PublicBranchActionTag, string>> = Object.freeze({
  investigate: '调查', social: '交谈', move: '移动', confront: '对抗', wait: '等待', other: '其他',
});
const STYLE_CHECK_LABELS: Readonly<Record<PublicStyleEvaluationCheck, string>> = Object.freeze({
  'sections-complete': '五个必要章节完整',
  'sample-copy-safe': '没有照抄学习样本',
  'character-isolation': '没有混入角色或会话身份',
  'applicability-explicit': '适用场景明确',
  'prohibitions-complete': '禁止项覆盖玩家、设定和认知边界',
  'steps-executable': '写作步骤足够具体、可执行',
  'example-operational': '例子包含输入场景与输出结果',
});
const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'test-session-admitted': '当前会话已进入限额试运行',
  'canary-sample-gate': '验证样本尚未达到分批开放门槛',
  'outside-stable-canary-bucket': '当前会话未纳入本批开放范围',
  'global-evidence-gate': '尚未达到全面开放所需的样本或观察时长',
  'lane-admitted': '当前会话已通过运行条件检查',
  'p95-latency-exceeded': '质量保护：P95 响应时间超过本能力组阈值',
  'provider-error-rate-exceeded': '质量策略暂停：Provider 失败率超过阈值',
  'invalid-call-rate-exceeded': '质量策略暂停：无效调用率超过阈值',
  'maintenance-multi-task-protocol-invalid': '质量策略暂停：多个后台任务连续出现协议错误',
  'maintenance-protocol-invalid': '本项暂停：模型连续提交了不符合工具合同的请求',
  'player-sovereignty-violation': '安全保护：检测到替玩家做决定或越权推进',
  'unauthorized-or-stale-write': '安全保护：检测到未授权或过期写入',
  'duplicate-write': '安全保护：检测到重复写入',
  'sensitive-audit-violation': '安全保护：审计记录包含敏感内容',
  'host-ceiling-killed': '当前运行环境已紧急停用该能力组',
  'test-session-sample-target-reached': '合格样本已达到门槛，等待人工复核',
  'test-session-window-exhausted': '本轮调用额度已用完，样本不一定达标',
  'test-session-window-fully-reserved': '本轮剩余额度已被进行中的任务占用，正在等待结算',
  'test-session-review-required': '本轮受控验证已结束，等待人工复核',
  'maintenance-persisted-global-disabled': '后台维护总开关已关闭',
  'maintenance-persisted-session-disabled': '当前会话的后台维护开关已关闭',
  'maintenance-runtime-off': '当前运行环境未启用后台观察',
  'maintenance-session-not-allowed': '当前会话不在后台维护开放范围内',
  'session-budget-exhausted': '该回合的会话维护额度已用完',
  'daily-budget-exhausted': '该回合的后台维护总额度已用完',
  'foreground-active': '主对话仍在生成，后台维护本轮让行',
  'duplicate-active': '同一来源的维护任务仍在进行',
  'duplicate-succeeded': '同一来源已成功维护，无需重复执行',
  'duplicate-source-digest': '本轮没有新的可维护材料',
  'cooldown-active': '该维护项仍在冷却时间内',
  'unstable-revision': '会话版本尚未稳定，本轮不执行维护',
  'no-material-change': '本轮没有达到维护触发条件的新材料',
  'lane-shadow-only': '仅观察，不写入业务真值',
  'lane-off': '该能力组已关闭',
  'operational-evaluation-required': '尚未通过运行评测',
  'agent-admission-off': 'Agent 执行入口尚未开放',
  'agent-session-not-allowed': '当前会话未被纳入 Agent 执行范围',
  'interactive-runtime-off': '对话能力尚未启用',
  'interactive-variable-policy-empty': '尚未配置可写变量；当前仅提供建议',
  'interactive-variable-advisory-only': '当前仅提供变量建议，不直接写入',
  'learning-text-off': '学习能力尚未启用',
  'context-compiler-off': '上下文恢复尚未启用',
  'context-compiler-session-not-allowed': '当前会话未被纳入上下文恢复范围',
  'maintenance-off': '后台维护尚未启用',
  'pending-fact': '待确认事实，可作为非权威状态记录',
  'last-known-fact': '仅记录最后已知状态',
  'history-only-fact': '只追加历史，不覆盖当前状态',
  'objective-double-source': '客观事实已有双来源佐证',
  'confidence-not-high': '置信度未达到高，必须人工复核',
  'relationship-requires-review': '人物关系必须人工复核',
  'existing-relationship-overwrite': '该关系已存在，覆盖更新必须人工确认',
  'identity-resolution-requires-review': '人物身份或别名必须人工复核',
  'identity-unresolved': '人物身份尚未解析',
  'identity-conflict': '人物身份证据冲突',
  'existing-fact-overwrite': '将覆盖已有当前事实',
  'objective-source-quorum-missing': '客观事实缺少双来源佐证',
  'confirmed-nonobjective-requires-review': '非客观事实被标为已确认，需人工复核',
  'uncertain-status-requires-review': '状态不确定，需人工复核',
  'auto-write-budget-exhausted': '本批自动写入预算已用尽',
  'auto-character-limit-exceeded': '本批涉及人物数超过自动写入上限',
  'memory-confirmed-high-write': '已确认且高置信，可写入长期记忆',
  'memory-confidence-not-high': '置信度不足，不进入长期记忆真值',
  'summary-cas-write': '将在固定回合水位上以 CAS 写入滚动摘要',
  'arc-projection-write': '将在固定快照上更新剧情弧投影',
  'arc-review-binding-missing': '缺少与剧情弧 ID 和快照精确匹配的本地审阅内容，已阻止盲批',
  'arc-review-current-state-unknown': '无法确认剧情弧的当前状态，已阻止状态变更',
  'arc-status-noop': '目标状态与当前状态相同，没有可执行变更',
  'review-content-not-exact': '内容无法在审阅上限内完整、安全地显示',
  'proposal-review-incomplete': '同一提案还有无法完整审阅的可写内容',
});

function promptPreferenceLabel(token: PublicPromptPreferenceToken): string {
  const [, value, polarity] = token.split('.');
  const valueLabel = PROMPT_VALUE_LABELS[value ?? ''] ?? value ?? token;
  return `${polarity === 'avoid' ? '回避' : '偏好'}${valueLabel}`;
}

function promptConflictLabel(token: string): string {
  const value = token.split('.')[1];
  return PROMPT_VALUE_LABELS[value ?? ''] ?? value ?? token;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function reasonLabel(reason: string): string {
  const exact = REASON_LABELS[reason];
  if (exact) return exact;
  if (reason.endsWith('-config-invalid')) return '运行配置无效，请检查本机设置';
  if (reason.startsWith('agent-admission-')) return 'Agent 执行入口尚未向当前会话开放';
  if (reason.startsWith('interactive-runtime-')) return '对话能力尚未向当前会话开放';
  if (reason.startsWith('learning-text-')) return '学习能力尚未向当前会话开放';
  if (reason.startsWith('maintenance-admission-')) return '后台维护尚未向当前会话开放';
  if (reason.startsWith('gateway-')) return '最近一次模型流程未完成';
  if (reason.startsWith('lease-')) return '最近一次模型流程状态已更新';
  return '当前配置或运行条件未满足';
}

function maintenanceDecisionReason(reasonCodes: readonly string[]): string | null {
  const priority = [
    'session-budget-exhausted', 'daily-budget-exhausted', 'foreground-active',
    'duplicate-active', 'cooldown-active', 'duplicate-succeeded',
    'duplicate-source-digest', 'unstable-revision', 'no-material-change',
  ];
  return priority.find((reason) => reasonCodes.includes(reason)) ?? reasonCodes[0] ?? null;
}

function maintenanceSettlementLabel(
  settlement: NonNullable<NonNullable<PublicAgentControlReadModel['maintenanceSession']>['lastSettlement']>,
): string {
  if (settlement.qualifying) return '已计入后台维护共享验证';
  if (settlement.reasonCode) return `未计入共享验证：${reasonLabel(settlement.reasonCode)}`;
  switch (settlement.outcome) {
    case 'completed': return '未计入共享验证：本次未产生可计入的 Provider 调用';
    case 'budget_exhausted': return '未计入共享验证：单次模型预算耗尽';
    case 'usage_unavailable': return '未计入共享验证：Provider 未返回可验证用量';
    case 'provider_error': return '未计入共享验证：Provider 调用失败';
    case 'cancelled': return '未计入共享验证：任务已取消';
    case 'expired': return '未计入共享验证：执行租约已过期';
  }
}

function localStatusTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function maintenanceAutoScopeLabel(
  scope: NonNullable<PublicAgentControlReadModel['maintenanceRuntime']>['autoApplyScope'],
): string {
  if (scope === 'low-risk-maintenance') {
    return '高置信长期记忆、CAS 滚动摘要和低风险高置信 NPC 事实';
  }
  if (scope === 'safe-memory-summary') return '高置信长期记忆和 CAS 滚动摘要';
  if (scope === 'safe-npc-facts') return '低风险高置信 NPC 事实';
  return '无';
}

function maintenanceProposalHasApplicableWrite(
  proposal: NonNullable<PublicAgentControlReadModel['maintenanceProposals']>[number],
): boolean {
  return Boolean(proposal.reviewItems?.length
    && proposal.reviewItems.some((item) => item.applicable));
}

function maintenanceNoApplicableWriteMessage(
  proposal: NonNullable<PublicAgentControlReadModel['maintenanceProposals']>[number],
): string {
  if (proposal.taskKind === 'memory_consolidation') {
    return '没有“已确认 + 高置信”且完整可审阅的长期记忆写入；不能批准，可拒绝或等待后续提案。';
  }
  if (proposal.taskKind === 'rolling_summary') {
    return '摘要正文未能完整、安全地展示，已阻止批准；请拒绝并等待重新生成。';
  }
  if (proposal.taskKind === 'npc_state') {
    return '该提案只有未解析人物线索，没有可落库写入；不能批准，可拒绝或等待后续提案替换。';
  }
  return '该提案没有可落库且完整可审阅的写入，已阻止批准。';
}

function groupName(id: AgentSubcapabilityId): string {
  if (id.startsWith('interactive.')) return '对话增强';
  if (id.startsWith('learning.')) return '学习';
  if (id.startsWith('maintenance.')) return '后台维护';
  return '上下文';
}

function TurnEvidenceView({ evidence }: { evidence: Extract<TurnAgentEvidence, { state: 'verified' }> }) {
  const summary = summarizeTurnEvidence(evidence);
  const missing = [...summary.missingCapabilities, ...summary.missingLearning];
  return <div>
    <p>最近已提交回合 R{evidence.round} 的 Agent 记录：</p>
    {summary.capabilities.length === 0 && summary.learning.length === 0
      && evidence.learningConsumption.length === 0 && evidence.maintenance.length === 0
      && evidence.styleCompile.state === 'no-intent'
      ? <p>没有找到与此回合关联的 Agent 回执或后台文风编译意图。</p>
      : <>
        {summary.capabilities.map((item, index) => <p key={`${item.capability}-${index}`}>
          {LABELS[item.capability]}：{item.execution === 'recorded' ? `已记录执行（${item.executionClass}）`
            : item.execution === 'cached' ? `已记录缓存复用（${item.executionClass}，不表示本轮模型调用）` : '未找到完成记录'}
          {' · '}{item.validated ? '产物已验证' : '未找到产物验证记录'}{' · '}{item.consumed ? '已记录消费' : '未找到本回合消费记录'}
        </p>)}
        {summary.learning.map(item => <p key={item.capability}>{LABELS[item.capability]}：
          {item.execution === 'recorded' ? `已记录沉淀（${item.executionClass}，不单独证明模型调用）` : '未找到完成记录'}
          {' · '}{item.validated ? '产物已验证' : '未找到产物验证记录'}{' · '}{item.consumed ? '已记录本回合消费此沉淀' : '未找到本回合消费此沉淀的记录'}
        </p>)}
        {evidence.learningConsumption.map((item, index) => <p key={`consumed-${index}`}>
          {LABELS[item.capability]}：已记录本回合消费（{item.origin === 'prior' ? '此前运行产物' : '本回合产物'}，{item.executionClass}）。
        </p>)}
        {evidence.styleCompile.state !== 'no-intent' && <p>文风编译：{styleJobStatusText(evidence.styleCompile)} 调度及结算记录不单独证明本回合模型调用或提案已生效。</p>}
        {evidence.maintenance.map((item, index) => <p key={`${item.capability}-${index}`}>
          {LABELS[item.capability]} · {item.status}：{item.execution === 'recorded' ? `已记录执行（${item.executionClass}）` : '未找到完成记录'}
          {' · '}{item.validated ? '产物已验证' : '未找到产物验证记录'}{' · '}{item.consumed ? '本回合已记录消费' : '未找到本回合消费记录'}
        </p>)}
      </>}
    {missing.length > 0 && <details>
      <summary>{missing.length} 项没有找到回执 · 查看说明</summary>
      <p>没有回执不代表故障，也不能证明当时是否运行；可能未触发、未启用，或历史记录不完整。当前能力开关见下方状态，不能代替历史证据。</p>
      <p>{missing.map(item => LABELS[item.capability]).join('、')}</p>
    </details>}
    {evidence.styleCompile.state === 'no-intent' && <p>本回合没有后台文风编译意图记录；不能据此判断同步编译是否执行。</p>}
  </div>;
}

export function AgentStatusPanel(props: {
  readonly sessionId: string | null;
  readonly contentMode: 'nsfw' | 'nsf';
  readonly refreshKey: string;
  /**
   * A maintenance proposal changed session truth (including a guarded-auto
   * transition observed by the status poll). The parent uses this to make
   * read-only projections re-read their authoritative endpoints.
   */
  readonly onMaintenanceTruthChanged?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [currentAdmission, setCurrentAdmission] = useState<CurrentTurnAdmission | null>(null);
  const [currentAdmissionError, setCurrentAdmissionError] = useState(false);
  const [turnEvidence, setTurnEvidence] = useState<TurnAgentEvidence | null>(null);
  const [turnEvidenceError, setTurnEvidenceError] = useState(false);
  const [model, setModel] = useState<PublicAgentControlReadModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [eventStreamKey, setEventStreamKey] = useState(0);
  const taskReaderRef = React.useRef<{ reader: AgentLoopTaskReader; canPoll: () => boolean } | null>(null);
  const eventSubscriptionRef = React.useRef<EventStreamSubscription | null>(null);
  const eventRetryAllowedRef = React.useRef(true);
  // Revocation synchronously invalidates responses already in flight, before React cleans effects up.
  const readEpochRef = React.useRef(0);
  const registerTaskReader = React.useCallback((reader: AgentLoopTaskReader, canPoll: () => boolean) => {
    const binding = { reader, canPoll };
    taskReaderRef.current = binding;
    return () => {
      if (taskReaderRef.current === binding) taskReaderRef.current = null;
    };
  }, []);
  const reconnectStatusEvents = React.useCallback(() => {
    eventRetryAllowedRef.current = true;
    setEventStreamKey((value) => value + 1);
  }, []);
  const refreshTrackedTask = React.useCallback(async () => {
    const binding = taskReaderRef.current;
    if (!binding || !binding.canPoll()) return;
    try {
      await binding.reader.refresh();
    } catch (reason) {
      // A replaced/unmounted inspector no longer owns the shared stream callback.
      if (taskReaderRef.current === binding) throw reason;
    }
  }, []);

  const [pendingLane, setPendingLane] = useState<PublicAgentRolloutLane | null>(null);
  const [pendingResource, setPendingResource] = useState<string | null>(null);
  const [maintenanceNotice, setMaintenanceNotice] = useState('');
  const [maintenanceRefreshPending, setMaintenanceRefreshPending] = useState(false);
  const maintenanceTruthCallbackRef = React.useRef(props.onMaintenanceTruthChanged);
  useEffect(() => {
    setCurrentAdmission(null); setCurrentAdmissionError(false);
    if (!expanded || !props.sessionId) return;
    const controller = new AbortController();
    let current = true;
    const epoch = readEpochRef.current;
    void readCurrentTurnAdmission(props.sessionId, controller.signal).then(result => {
      if (current && epoch === readEpochRef.current) setCurrentAdmission(result);
    }).catch(() => { if (current && epoch === readEpochRef.current) setCurrentAdmissionError(true); });
    return () => { current = false; controller.abort(); };
  }, [expanded, props.sessionId, props.refreshKey, reloadKey]);
  useEffect(() => {
    setTurnEvidence(null); setTurnEvidenceError(false);
    if (!expanded || !props.sessionId) return;
    const controller = new AbortController();
    let current = true;
    const epoch = readEpochRef.current;
    void readCurrentTurnEvidence(props.sessionId, controller.signal).then(result => {
      if (current && epoch === readEpochRef.current) setTurnEvidence(result);
    }).catch(() => { if (current && epoch === readEpochRef.current) setTurnEvidenceError(true); });
    return () => { current = false; controller.abort(); };
  }, [expanded, props.sessionId, props.refreshKey, reloadKey]);
  const observedMaintenanceRef = React.useRef<{
    sessionId: string | null;
    initialized: boolean;
    revisions: Map<string, string>;
  }>({ sessionId: null, initialized: false, revisions: new Map() });
  maintenanceTruthCallbackRef.current = props.onMaintenanceTruthChanged;
  /** 当前展开「变更内容」的世界书提案 id（受控通道：changes 只在本机可操作时返回）。 */
  const [expandedWorldbook, setExpandedWorldbook] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(false);
    setModel(null);
    setError('');
    setMaintenanceNotice('');
    setMaintenanceRefreshPending(false);
    eventRetryAllowedRef.current = true;
    observedMaintenanceRef.current = {
      sessionId: props.sessionId, initialized: false, revisions: new Map(),
    };
  }, [props.sessionId]);

  useEffect(() => {
    if (!props.sessionId) return;
    const controller = new AbortController();
    let currentRequest = true;
    const epoch = readEpochRef.current;
    setLoading(true);
    setError('');
    void fetchSessionAgentControl(props.sessionId, { signal: controller.signal })
      .then((next) => {
        if (currentRequest && epoch === readEpochRef.current) {
          const observed = observedMaintenanceRef.current;
          const proposals = next.maintenanceProposals ?? [];
          const revisions = maintenanceProposalRevisionMap(proposals);
          const truthChanged = observed.sessionId === props.sessionId
            && maintenanceTruthChanged(observed.initialized ? observed.revisions : null, proposals);
          observedMaintenanceRef.current = {
            sessionId: props.sessionId, initialized: true, revisions,
          };
          setModel(next);
          const reconcileDirectMemoryCommit = next.maintenanceRuntime?.automaticWriteActive === true
            && (next.maintenanceRuntime.autoApplyScope === 'safe-memory-summary'
              || next.maintenanceRuntime.autoApplyScope === 'low-risk-maintenance');
          // Covers guarded-auto applies that complete between status polls.
          // Initial hydration also requests one idempotent re-read when applied
          // proposals exist, closing the panel-load/status-load race window.
          // Memory/summary guarded-auto commits do not create pending-proposal
          // rows. While that path is active, the same low-frequency status poll
          // is therefore also the recovery signal for the read-only projection.
          if (truthChanged || reconcileDirectMemoryCommit) {
            maintenanceTruthCallbackRef.current?.();
          }
        }
      })
      .catch((reason: unknown) => {
        if (currentRequest && epoch === readEpochRef.current && (reason as { name?: string }).name !== 'AbortError') {
          // A failed refresh must never leave yesterday's numbers looking current.
          setModel(null);
          setError(reason instanceof Error
            ? `Agent 状态已过期：${reason.message}`
            : 'Agent 状态已过期：服务暂时不可用');
        }
      })
      .finally(() => {
        if (currentRequest && epoch === readEpochRef.current) {
          setLoading(false);
          setMaintenanceRefreshPending(false);
        }
      });
    return () => {
      currentRequest = false;
      controller.abort();
    };
  }, [props.sessionId, props.refreshKey, reloadKey]);

  useEffect(() => {
    if (!props.sessionId || typeof window === 'undefined' || typeof document === 'undefined') return;
    let lastRefreshAt = 0;
    const requestFreshStatus = () => {
      const now = Date.now();
      // focus and visibilitychange normally arrive as a pair; collapse them into one request.
      if (now - lastRefreshAt < 500) return;
      lastRefreshAt = now;
      setReloadKey((value) => value + 1);
      const binding = taskReaderRef.current;
      if (eventRetryAllowedRef.current && binding?.canPoll()) {
        void refreshTrackedTask().catch(() => {
          /* The reader clears stale data. */
        });
      }
      if (eventRetryAllowedRef.current && eventSubscriptionRef.current?.stopped) reconnectStatusEvents();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') requestFreshStatus();
    };
    window.addEventListener('focus', requestFreshStatus);
    window.addEventListener('online', requestFreshStatus);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    // A post-turn Maintenance job can settle after the main turn is already idle.
    // Keep a low-frequency visible-page reconciliation so its late result is not stranded.
    const pollTimer = window.setInterval(refreshWhenVisible, AGENT_STATUS_POLL_MS);
    return () => {
      window.clearInterval(pollTimer);
      window.removeEventListener('focus', requestFreshStatus);
      window.removeEventListener('online', requestFreshStatus);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [props.sessionId, refreshTrackedTask, reconnectStatusEvents]);

  useEffect(() => {
    if (!props.sessionId || typeof window === 'undefined') return;
    const eventSessionId = props.sessionId;
    let active = true;
    let subscription: EventStreamSubscription | null = null;
    try {
      subscription = startAgentStatusEvents(
        {
          async onEvent(event) {
            if (!active) return;
            if (isMaintenanceAgentStatusInvalidation(event, eventSessionId)) {
              setReloadKey((value) => value + 1);
            }
            const binding = taskReaderRef.current;
            try {
              if (binding?.canPoll()) await binding.reader.onEvent(event);
            } catch (reason) {
              if (taskReaderRef.current === binding) throw reason;
            }
          },
          async onSyncRequired() {
            if (!active) return;
            setReloadKey((value) => value + 1);
            await refreshTrackedTask();
          },
          onError(reason) {
            if (!active) return;
            if (reason.code === 'credential_unavailable') {
              eventRetryAllowedRef.current = false;
              readEpochRef.current += 1;
              setModel(null); setCurrentAdmission(null); setTurnEvidence(null);
              setCurrentAdmissionError(true); setTurnEvidenceError(true);
              setLoading(false);
              setError('访问凭据不可用，已清除旧状态；恢复访问后请刷新。');
            }
            const binding = taskReaderRef.current;
            if (binding?.canPoll()) binding.reader.unavailable();
          },
        },
        {
          async onConnected() {
            if (!active) return;
            setReloadKey((value) => value + 1);
            await refreshTrackedTask();
          },
        },
      );
      eventSubscriptionRef.current = subscription;
    } catch {
      taskReaderRef.current?.reader.unavailable();
      // Unsupported profiles keep the existing visible-page reconciliation.
    }
    return () => {
      active = false;
      subscription?.stop();
      if (eventSubscriptionRef.current === subscription) eventSubscriptionRef.current = null;
    };
  }, [props.sessionId, eventStreamKey, refreshTrackedTask]);

  const groups = useMemo(() => {
    const result = new Map<string, NonNullable<typeof model>['capabilities']>();
    for (const capability of model?.capabilities ?? []) {
      const group = groupName(capability.id);
      result.set(group, [...(result.get(group) ?? []), capability]);
    }
    return [...result.entries()];
  }, [model]);
  const active = model?.capabilities.filter((item) => item.allowed).length ?? 0;
  const laneControls = useMemo(() => {
    if (!model?.allowedActions.canKill) return [];
    return (['interactive', 'learning', 'maintenance'] as const).flatMap((lane) => {
      const laneCapabilities = model.capabilities.filter((item) => item.rolloutLane === lane);
      // A per-capability stop must not masquerade as a stop of the whole Lane.
      const capability = laneCapabilities.find((item) => !item.capabilityKilled) ?? laneCapabilities[0];
      return capability ? [{ lane, capability }] : [];
    });
  }, [model]);
  const laneSummaries = useMemo(() => (
    (['interactive', 'learning', 'maintenance'] as const).flatMap((lane) => {
      const laneCapabilities = model?.capabilities.filter((item) => item.rolloutLane === lane) ?? [];
      // Per-capability stops must not be promoted to a Lane-wide status. Every
      // non-capability-stopped row carries the same Lane decision. If every
      // capability is stopped locally, keep the Lane bar visible and say so.
      const representative = selectLaneDisplayCapability(laneCapabilities);
      return representative ? [{
        lane,
        capability: representative,
        availableCount: laneCapabilities.filter((item) => item.allowed).length,
        capabilityCount: laneCapabilities.length,
        allCapabilitiesStopped: laneCapabilities.every((item) => item.capabilityKilled),
      }] : [];
    })
  ), [model]);
  const maintenanceVerification = model?.capabilities.find((item) => (
    item.rolloutLane === 'maintenance'
  ))?.verification;
  const maintenanceDecisionBlocker = model?.maintenanceSession?.lastDecision?.admitted === false
    ? maintenanceDecisionReason(model.maintenanceSession.lastDecision.reasonCodes)
    : null;
  const maintenanceBlockReason = useMemo(() => {
    const capabilities = model?.capabilities.filter((item) => item.rolloutLane === 'maintenance') ?? [];
    const persistedReasons = new Set([
      'maintenance-persisted-global-disabled', 'maintenance-persisted-session-disabled',
    ]);
    if (capabilities.length === 0 || capabilities.some((item) => item.allowed
      || resolveCapabilityStopSource(item) !== 'none'
      || item.recentReasonCodes.length === 0
      || item.recentReasonCodes.some((reason) => !persistedReasons.has(reason)))) return null;
    const reasons = capabilities.flatMap((item) => item.recentReasonCodes);
    return reasons.includes('maintenance-persisted-global-disabled')
      ? 'maintenance-persisted-global-disabled' : 'maintenance-persisted-session-disabled';
  }, [model]);

  const mutateLane = async (
    lane: PublicAgentRolloutLane,
    controlRevision: string,
    operation: 'kill' | 'clear-kill' | 'shadow' | 'off' | 'override-quality',
  ) => {
    const destructive = operation === 'kill' || operation === 'off';
    if (destructive && typeof window !== 'undefined'
      && !window.confirm(`确认将${LANE_LABELS[lane]}在全部会话中${operation === 'kill' ? '紧急停用' : '关闭'}？`)) return;
    if (operation === 'override-quality' && typeof window !== 'undefined'
      && !window.confirm(`${LANE_LABELS[lane]}当前因质量门禁暂停，正常恢复要求先产出通过证据，`
        + '而暂停中的通道无法产出证据。强制解锁会清除该暂停、作废当前计量窗口并重新开启 test-session，'
        + '同时写入一条不可篡改的审计记录。它不会解除安全类停用。确认继续？')) return;
    setPendingLane(lane);
    setError('');
    try {
      await mutateAgentLaneControl(operation === 'kill'
        ? { operation: 'kill', lane, expectedRevision: controlRevision, reasonCode: 'operator-ui-stop' }
        : operation === 'clear-kill'
          ? { operation: 'clear-kill', lane, expectedRevision: controlRevision }
          : operation === 'override-quality'
            ? {
                operation: 'operator-override-quality-kill',
                lane,
                expectedRevision: controlRevision,
                acknowledgement: AGENT_LANE_OPERATOR_OVERRIDE_ACK,
                reopenTo: 'test-session',
              }
            : { operation: 'downgrade', lane, expectedRevision: controlRevision, desiredState: operation });
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Agent 控制失败');
    } finally {
      setPendingLane(null);
    }
  };

  const mutateCapability = async (
    capabilityId: AgentSubcapabilityId,
    capabilityRevision: string,
    clear: boolean,
    shared: boolean,
  ) => {
    if (!clear && typeof window !== 'undefined'
      && !window.confirm(shared
        ? '此能力与同组能力共用一次模型执行；停用会在下一回合一并阻止该共享执行组。是否继续？'
        : `确认从下一张 Ticket 起停用“${LABELS[capabilityId]}”？`)) return;
    const lane = model?.capabilities.find((item) => item.id === capabilityId)?.rolloutLane ?? null;
    setPendingLane(lane);
    setError('');
    try {
      await mutateAgentLaneControl(clear
        ? { operation: 'clear-capability-kill', capabilityId, expectedRevision: capabilityRevision }
        : {
            operation: 'kill-capability', capabilityId, expectedRevision: capabilityRevision,
            reasonCode: 'operator-ui-stop',
          });
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Agent 子能力控制失败');
    } finally {
      setPendingLane(null);
    }
  };

  const mutateStyleProposal = async (
    proposal: NonNullable<PublicAgentControlReadModel['styleProposals']>[number],
    version?: number,
  ) => {
    const action = version === undefined
      ? '禁用当前 Learned Skill'
      : proposal.status === 'disabled'
        ? `批准并启用版本 v${version}`
        : `回滚到版本 v${version}`;
    if (typeof window !== 'undefined'
      && !window.confirm(`确认对文风 proposal ${proposal.id} 执行“${action}”？此操作不会修改手写或导入 Skill。`)) return;
    setPendingResource(proposal.id);
    setError('');
    try {
      await mutateAgentLaneControl(version === undefined
        ? {
            operation: 'disable-style-proposal', proposalId: proposal.id,
            expectedRevision: proposal.revision,
          }
        : proposal.status === 'disabled'
          ? {
              operation: 'approve-style-proposal', proposalId: proposal.id,
              version, expectedRevision: proposal.revision,
            }
          : {
              operation: 'rollback-style-proposal', proposalId: proposal.id,
              version, expectedRevision: proposal.revision,
            });
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '文风 proposal 控制失败');
    } finally {
      setPendingResource(null);
    }
  };

  const clearPreferenceProfile = async () => {
    const profile = model?.preferenceProfile;
    if (!profile || !props.sessionId) return;
    if (typeof window !== 'undefined' && !window.confirm(
      `确认清空当前会话的 ${profile.sampleCount} 条偏好/分支偏好学习样本？对话记录、完整 Skill、文风、剧情弧和 NPC 状态不会被删除。`,
    )) return;
    setPendingResource('preference-profile');
    setError('');
    try {
      await clearPreferenceProfileControl({
        sessionId: props.sessionId,
        expectedRevision: profile.revision,
      });
      setReloadKey((value) => value + 1);
    } catch (reason) {
      const preferenceSyncPending = reason instanceof AgentControlMutationError
        && reason.code === 'preference-profile-ledger-sync-pending';
      if (reason instanceof AgentControlMutationError
        && (reason.status === 409 || preferenceSyncPending)) {
        setReloadKey((value) => value + 1);
      }
      setError(preferenceSyncPending
        ? '清空已本地提交，等待同步'
        : reason instanceof Error ? reason.message : '偏好学习清空失败');
    } finally {
      setPendingResource(null);
    }
  };

  const mutateMaintenanceProposal = async (
    proposal: NonNullable<PublicAgentControlReadModel['maintenanceProposals']>[number],
    operation: 'approve' | 'reject' | 'rollback',
  ) => {
    const verb = operation === 'approve' ? '批准并应用' : operation === 'rollback' ? '回滚' : '拒绝';
    if (typeof window !== 'undefined' && !window.confirm(
      `确认${verb}${MAINTENANCE_PROPOSAL_LABELS[proposal.taskKind]}提案？`,
    )) return;
    setPendingResource(proposal.id);
    setError('');
    setMaintenanceNotice('');
    try {
      await mutateAgentLaneControl(operation === 'approve'
        ? {
            operation: 'approve-maintenance-proposal', proposalId: proposal.id,
            expectedRevision: proposal.revision,
          }
        : operation === 'rollback'
          ? {
              operation: 'rollback-maintenance-proposal', proposalId: proposal.id,
              expectedRevision: proposal.revision,
            }
          : {
              operation: 'reject-maintenance-proposal', proposalId: proposal.id,
              expectedRevision: proposal.revision, reasonCode: 'operator-rejected',
            });
      if (operation !== 'reject') {
        // The mutation response is sent only after the domain commit/rollback.
        // Refresh immediately; the status poll remains the recovery path for
        // guarded-auto writes and lost/late UI transitions.
        maintenanceTruthCallbackRef.current?.();
        setMaintenanceNotice(proposal.taskKind === 'npc_state'
          ? operation === 'approve'
            ? 'NPC 状态已写入，人物投影正在刷新。'
            : 'NPC 状态已回滚，人物投影正在刷新。'
          : proposal.taskKind === 'memory_consolidation'
            ? operation === 'approve'
              ? '已写入长期记忆；人物投影的“当前事实”仅由 NPC 状态提案更新。'
              : '长期记忆已回滚，记忆面板正在刷新。'
            : `${MAINTENANCE_PROPOSAL_LABELS[proposal.taskKind]}已${operation === 'approve' ? '应用' : '回滚'}，记忆面板正在刷新。`);
      }
      setReloadKey((value) => value + 1);
    } catch (reason) {
      const applyDisabled = reason instanceof AgentControlMutationError
        && reason.code === 'maintenance-proposal-apply-disabled';
      const sourceRevisionStale = reason instanceof AgentControlMutationError
        && reason.code === 'maintenance-proposal-source-revision-stale';
      if (reason instanceof AgentControlMutationError && reason.status === 409) {
        if (sourceRevisionStale) setMaintenanceRefreshPending(true);
        setReloadKey((value) => value + 1);
      }
      if (sourceRevisionStale) {
        setMaintenanceNotice('会话已推进，旧提案已作废。');
      } else {
        setError(applyDisabled
          ? '当前会话未开放 Maintenance apply；请在电脑本机精确授权该会话后重试'
          : reason instanceof Error ? reason.message : '维护提案控制失败');
      }
    } finally {
      setPendingResource(null);
    }
  };

  /**
   * 世界书修正的确认动作。弹窗必须把「改哪个文件 / 几项 / 为什么 / 是否冲突」讲清楚 ——
   * 条目正文按既有 content-free 边界不跨 HTTP，用户是在信息受限的前提下做决定。
   */
  const mutateWorldbookRepair = async (
    proposal: NonNullable<PublicAgentControlReadModel['worldbookRepairProposals']>[number],
    operation: 'apply' | 'reject',
  ) => {
    const reasons = proposal.reasonCodes
      .map((code) => WORLDBOOK_REPAIR_REASON_LABELS[code] ?? code).join('；');
    const body = [
      operation === 'apply'
        ? `确认修改世界书「${proposal.file}」？`
        : `拒绝「${proposal.file}」的修正提案？`,
      `· 变更条目：${proposal.changeCount} 项`,
      `· 原因：${reasons || '未标注'}`,
      proposal.status === 'stale'
        ? '· ⚠ 该文件在提案生成后已被改动，本次修正会被判为过期而拒绝'
        : '',
      operation === 'apply'
        ? '应用后按提案改写指定条目；原文件内容会被保留，可回滚。'
        : '拒绝不会修改任何文件。',
    ].filter(Boolean).join('\n');
    if (typeof window !== 'undefined' && !window.confirm(body)) return;
    setPendingResource(proposal.proposalId);
    setError('');
    try {
      await mutateAgentLaneControl(operation === 'apply'
        ? {
            operation: 'apply-worldbook-repair', proposalId: proposal.proposalId,
            expectedRevision: proposal.revision,
          }
        : {
            operation: 'reject-worldbook-repair', proposalId: proposal.proposalId,
            expectedRevision: proposal.revision,
          });
      setReloadKey((value) => value + 1);
    } catch (reason) {
      if (reason instanceof AgentControlMutationError && reason.status === 409) {
        setReloadKey((value) => value + 1);
      }
      setError(reason instanceof Error ? reason.message : '世界书修正控制失败');
    } finally {
      setPendingResource(null);
    }
  };

  const enableMaintenance = async () => {
    if (!props.sessionId || !maintenanceBlockReason) return;
    if (typeof window !== 'undefined' && !window.confirm(
      '开启后会立即处理最多 4 个已排队的后台任务，并可能产生真实 Provider 调用与费用。'
      + (model?.maintenanceRuntime?.applyMode === 'guarded-auto'
        ? `模型仍只生成类型化提案；${maintenanceAutoScopeLabel(model.maintenanceRuntime.autoApplyScope)}`
          + '可受控自动落库。人物身份、关系、覆盖现值、低置信项及世界书仍需人工审批。确认继续？'
        : model?.maintenanceRuntime?.applyMode === 'manual-approval'
          ? '模型只生成类型化提案，必须人工审批后才能落库。确认继续？'
          : '当前只生成类型化提案，不写入业务真值。确认继续？'),
    )) return;
    const resource = maintenanceBlockReason === 'maintenance-persisted-global-disabled'
      ? 'maintenance-global' : 'maintenance-session';
    setPendingResource(resource);
    setError('');
    try {
      if (resource === 'maintenance-global') await setMaintenanceGlobalEnabled(true);
      else await setSessionMaintenanceEnabled(props.sessionId, true);
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '后台维护观察模式开启失败');
    } finally {
      setPendingResource(null);
    }
  };

  if (!props.sessionId) return null;
  return (
    <section className="agent-status" data-expanded={expanded ? '1' : '0'}>
      <button
        type="button"
        className="agent-status__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Agent 状态</span>
        <small>{loading
          ? '状态刷新中…'
          : model
            ? `${active}/${model.capabilities.length} 项本会话可用`
            : error
              ? '状态已过期 · 服务不可用'
              : '等待状态刷新…'}</small>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="agent-status__body">
          {currentAdmissionError && <p>当前回合准入记录不可用或已变化；请刷新后重读。</p>}
          {currentAdmission?.state === 'idle' && <p>当前没有正在执行的回合。</p>}
          {currentAdmission?.state === 'active' && <p>当前回合 R{currentAdmission.round} 的影子准入评估：
            {currentAdmission.decisions.length === 0 ? '尚无该次运行的准入记录，执行情况未知。'
              : currentAdmission.decisions.map((decision, index) => <span key={index}>
                {index ? '；' : ''}{decision.verdict === 'would-admit' ? '评估为符合条件' : '评估为不符合条件'}
                {decision.reasonCodes.length ? `（${decision.reasonCodes.map(reasonLabel).join('；')}）` : ''}
              </span>)}准入不代表实际执行或完成。</p>}
          {turnEvidenceError && <p>已提交回合执行证据不可用或已变化；请刷新后重读。</p>}
          {turnEvidence?.state === 'unknown' && <p>当前回合缺少可核对的完成证明，Agent 执行情况未知。</p>}
          {turnEvidence?.state === 'verified' && <TurnEvidenceView evidence={turnEvidence} />}
          <AgentLoopTaskInspector key={props.sessionId} registerReader={registerTaskReader}
            onReconnect={reconnectStatusEvents} />
          {error && <p className="agent-status__error">{error}</p>}
          {!error && loading && !model && <p className="agent-status__empty">正在读取脱敏运行状态…</p>}
          {!error && !loading && !model && <p className="agent-status__empty">暂无状态。</p>}
          {model && (
            <p className="agent-status__privacy">
              这些是按需触发的能力模块，不是同时运行的多个模型。只有本会话可用且满足触发条件的模块才会执行，部分模块会共享一次模型调用。
            </p>
          )}
          {model?.maintenanceRuntime && (
            <p className="agent-status__privacy" data-testid="maintenance-runtime-summary">
              后台维护：{model.maintenanceRuntime.proposalGeneration === 'typed-proposals'
                ? '类型化提案能力已启用（满足触发条件时运行）'
                : '提案生成未运行'}；
              {model.maintenanceRuntime.automaticWriteActive
                ? `${maintenanceAutoScopeLabel(model.maintenanceRuntime.autoApplyScope)}`
                  + '已启用受控自动落库；人物身份、关系、覆盖现值、低置信项及世界书仍需人工审批'
                : model.maintenanceRuntime.applyMode === 'manual-approval'
                  ? '当前会话具备受控写入授权；具体写入方式以提案类型和快照校验结果为准'
                  : model.maintenanceRuntime.applyMode === 'guarded-auto'
                    ? '低风险自动落库权限已配置，但当前相关写入能力未开放'
                    : '业务真值写入未开放'}。
            </p>
          )}
          {laneSummaries.length > 0 && (
            <div className="agent-status__lane-summary" aria-label="Agent 能力状态概览">
              {laneSummaries.map(({ lane, capability, availableCount, capabilityCount, allCapabilitiesStopped }) => {
                const source = resolveCapabilityStopSource(capability);
                const reason = capability.killReason ?? capability.recentReasonCodes[0];
                const display = capabilityDisplayState(capability);
                return (
                  <div key={lane} data-stopped={source === 'none' && !allCapabilitiesStopped ? '0' : '1'}
                    data-tone={allCapabilitiesStopped ? 'blocked'
                      : source === 'none' && availableCount > 0 ? 'available' : display.tone}>
                    <strong>{LANE_LABELS[lane]}</strong>
                    <span>{allCapabilitiesStopped
                      ? '各项均已单独暂停'
                      : `${availableCount}/${capabilityCount} 项本会话可用`}</span>
                    <small>{allCapabilitiesStopped
                      ? '请查看下方各项的暂停原因'
                      : source !== 'none' && reason ? reasonLabel(reason)
                        : display.detail}</small>
                  </div>
                );
              })}
            </div>
          )}
          {model?.maintenanceSession && (
            <div className="agent-status__maintenance-session"
              data-blocked={model.maintenanceSession.budget.remaining === 0
                || model.maintenanceSession.attemptBudget.remaining === 0 ? '1' : '0'}
              data-testid="maintenance-session-status">
              <strong>后台维护进度（共享验证 + 双重额度）</strong>
              {maintenanceVerification && (
                <span>
                  共享验证：合格任务 {maintenanceVerification.qualifyingSamples}/
                  {maintenanceVerification.requiredQualifyingSamples}
                  {' · '}已结算调用 {maintenanceVerification.consumedProviderCalls}/
                  {maintenanceVerification.maxProviderCalls}
                  {maintenanceVerification.reservedProviderCalls > 0
                    ? ` · ${maintenanceVerification.reservedProviderCalls} 次进行中` : ''}
                </span>
              )}
              <span>
                本会话调度额度 {model.maintenanceSession.budget.used}/
                {model.maintenanceSession.budget.limit}
                {' · '}剩余 {model.maintenanceSession.budget.remaining}
                {model.maintenanceSession.budget.remaining === 0
                  ? model.maintenanceSession.budget.nextSlotAt
                    ? ` · 下一额度预计 ${localStatusTime(model.maintenanceSession.budget.nextSlotAt)} 恢复`
                    : ' · 正在进行的任务结算后恢复'
                  : ''}
              </span>
              <span>
                24小时尝试安全额度 {model.maintenanceSession.attemptBudget.used}/
                {model.maintenanceSession.attemptBudget.limit}
                {' · '}剩余 {model.maintenanceSession.attemptBudget.remaining}
                {model.maintenanceSession.attemptBudget.remaining === 0
                  ? model.maintenanceSession.attemptBudget.nextSlotAt
                    ? ` · 下一额度预计 ${localStatusTime(model.maintenanceSession.attemptBudget.nextSlotAt)} 恢复`
                    : ' · 正在进行的任务结算后确定恢复时间'
                  : ''}
              </span>
              {model.maintenanceSession.lastDecision && (
                <small>
                  最近调度 R{model.maintenanceSession.lastDecision.round}：
                  {model.maintenanceSession.lastDecision.admitted
                    ? '准入条件已满足；是否实际入队以后台槽位和最近结算为准'
                    : `本轮未执行${maintenanceDecisionBlocker
                      ? `（${reasonLabel(maintenanceDecisionBlocker)}${
                        maintenanceDecisionBlocker === 'session-budget-exhausted'
                          && model.maintenanceSession.budget.remaining > 0
                          ? '；当前本会话额度已恢复'
                          : maintenanceDecisionBlocker === 'daily-budget-exhausted'
                            && model.maintenanceSession.attemptBudget.remaining > 0
                            ? '；当前24小时尝试额度已恢复' : ''}）` : ''}`}
                  {' · '}{localStatusTime(model.maintenanceSession.lastDecision.occurredAt)}
                </small>
              )}
              {model.maintenanceSession.lastSettlement && (
                <small>
                  最近结算 {localStatusTime(model.maintenanceSession.lastSettlement.occurredAt)}：
                  {maintenanceSettlementLabel(model.maintenanceSession.lastSettlement)}
                </small>
              )}
              <small>
                上面的验证计数由所有维护项共享；调度额度与尝试安全额度是两道独立门禁，对话回合本身不会直接增加合格数。
              </small>
            </div>
          )}
          <AgentProviderRoutingControl refreshKey={props.refreshKey} />
          <NsfwSceneSafetyControl
            sessionId={props.sessionId}
            contentMode={props.contentMode}
          />
          {laneControls.length > 0 && (
            <div className="agent-status__controls">
              <h3>电脑本机控制（影响全部会话）</h3>
              {laneControls.map(({ lane, capability }) => {
                const stopSource = resolveCapabilityStopSource(capability);
                return (
                  <div className="agent-status__control-row" key={lane}>
                    <strong>{LANE_LABELS[lane]}</strong>
                    <div className="agent-status__proposal-body">
                      {stopSource === 'lane-operator' ? (
                        <button type="button" disabled={pendingLane === lane}
                          onClick={() => void mutateLane(lane, capability.controlRevision, 'clear-kill')}>解除紧急停用</button>
                      ) : stopSource === 'policy-quality' ? (
                        <>
                          <small>{reasonLabel(capability.killReason ?? capability.recentReasonCodes[0] ?? '质量门禁暂停')}</small>
                          <button type="button" disabled={pendingLane === lane}
                            onClick={() => void mutateLane(lane, capability.controlRevision, 'override-quality')}>强制解锁（运维覆盖）</button>
                        </>
                      ) : stopSource !== 'none' ? (
                        <small>{reasonLabel(capability.killReason ?? capability.recentReasonCodes[0] ?? '质量门禁暂停')}</small>
                      ) : (
                        <>
                          <button type="button" disabled={pendingLane === lane}
                            onClick={() => void mutateLane(lane, capability.controlRevision, 'shadow')}>降为观察</button>
                          <button type="button" disabled={pendingLane === lane}
                            onClick={() => void mutateLane(lane, capability.controlRevision, 'off')}>关闭</button>
                          <button type="button" className="danger" disabled={pendingLane === lane}
                            onClick={() => void mutateLane(lane, capability.controlRevision, 'kill')}>紧急停用</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {maintenanceBlockReason && (
                <div className="agent-status__maintenance-enable">
                  <p>{reasonLabel(maintenanceBlockReason)}。开启后模型仍只产生类型化提案；
                    {model?.maintenanceRuntime?.applyMode === 'guarded-auto'
                      ? `${maintenanceAutoScopeLabel(model.maintenanceRuntime.autoApplyScope)}`
                        + '可由安全策略受控自动落库；世界书等高风险操作仍需人工审批。'
                      : model?.maintenanceRuntime?.applyMode === 'manual-approval'
                        ? '通过人工审批后可落库。'
                        : '不写入业务真值。'}</p>
                  <button type="button" disabled={pendingResource?.startsWith('maintenance-')}
                    onClick={() => void enableMaintenance()}>
                    {maintenanceBlockReason === 'maintenance-persisted-global-disabled'
                      ? '开启后台维护' : '允许当前会话后台维护'}
                  </button>
                </div>
              )}
            </div>
          )}
          {(model?.styleProposals?.length ?? 0) > 0 && (
            <div className="agent-status__controls">
              <h3>Learned Style 审阅（正文仅本机）</h3>
              <p className="agent-status__privacy">
                这里展示模型从已接受样本提炼出的完整写作 Skill。质量门禁全绿后才允许批准；批准不会修改手写或导入 Skill。
              </p>
              {model?.styleProposals?.map((proposal, proposalIndex) => (
                <div className="agent-status__style-proposal" key={proposal.id}>
                  <div className="agent-status__style-heading">
                    <strong>{proposal.status === 'enabled'
                      ? `已启用 v${proposal.activeVersion}` : '尚未启用'}</strong>
                    <small>{proposal.id}</small>
                    {proposal.status === 'enabled' && model?.allowedActions.canRollback && (
                      <button type="button" className="danger" disabled={pendingResource === proposal.id}
                        onClick={() => void mutateStyleProposal(proposal)}>禁用</button>
                    )}
                  </div>
                  {(proposal.reviewVersions?.length ?? 0) === 0 ? (
                    <p className="agent-status__style-blocked">
                      当前服务端只返回了版本号，无法安全审批。请重启升级后的本机服务再查看完整内容。
                    </p>
                  ) : [...proposal.reviewVersions!].reverse().map((review, index) => {
                    const isActive = review.version === proposal.activeVersion;
                    const reviewAction = styleReviewAction(proposal, review, model!.allowedActions);
                    return (
                      <details className="agent-status__style-review"
                        open={proposalIndex === 0 && index === 0} key={review.version}>
                        <summary>
                          <span>{review.name} · v{review.version}{isActive ? '（当前生效）' : ''}</span>
                          <small className={review.evaluation.passed ? 'passed' : 'blocked'}>
                            {review.evaluation.passed ? '质量门禁通过' : '质量门禁未通过'}
                            {' · '}{Math.round(review.evaluation.score * 100)} 分
                          </small>
                        </summary>
                        <div className="agent-status__style-content">
                          <p>{review.description}</p>
                          <div className="agent-status__learning-tags" aria-label="Learned Style 关键词">
                            {review.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}
                          </div>
                          <div className="agent-status__style-quality">
                            <strong>质量检查</strong>
                            <ul>
                              {review.evaluation.checks.map((check) => (
                                <li className="passed" key={check}>通过：{STYLE_CHECK_LABELS[check]}</li>
                              ))}
                              {review.evaluation.failedChecks.map((check) => (
                                <li className="blocked" key={check}>未通过：{STYLE_CHECK_LABELS[check]}</li>
                              ))}
                            </ul>
                          </div>
                          <details className="agent-status__style-body">
                            <summary>查看完整 Skill 规则</summary>
                            <pre>{review.body}</pre>
                          </details>
                          <small className="agent-status__style-provenance">
                            生成模型：{review.model} · 策略：{review.policyVersion}
                            {' · '}{new Date(review.createdAt).toLocaleString('zh-CN')}
                          </small>
                          {!review.evaluation.passed ? (
                            <p className="agent-status__style-blocked">
                              此版本不能批准：上方失败项需要先由文风编译器修订，不建议绕过质量门禁。
                            </p>
                          ) : reviewAction ? (
                            <button type="button" disabled={pendingResource === proposal.id}
                              onClick={() => void mutateStyleProposal(proposal, review.version)}>
                              {reviewAction === 'approve'
                                ? `批准并启用“${review.name}” v${review.version}`
                                : `回滚至“${review.name}” v${review.version}`}
                            </button>
                          ) : null}
                        </div>
                      </details>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {model?.preferenceSyncState === 'pending' && (
            <div className="agent-status__controls" role="status" data-testid="preference-sync-pending">
              <h3>当前生效学习</h3>
              <p className="agent-status__empty">清空已本地提交，等待同步</p>
            </div>
          )}
          {model?.preferenceSyncState !== 'pending' && model?.effectiveLearning && (
            <div className="agent-status__controls agent-status__learning" data-testid="effective-learning">
              <h3>当前生效学习</h3>
              <div className="agent-status__learning-row">
                <div className="agent-status__learning-heading">
                  <strong>Prompt 偏好</strong>
                  <span>{LEARNING_SCOPE_LABELS[model.effectiveLearning.prompt.scope]}
                    {' · '}{model.effectiveLearning.prompt.sampleCount} 条样本</span>
                </div>
                <div className="agent-status__learning-tags" aria-label="生效的 Prompt 固定标签">
                  {model.effectiveLearning.prompt.tagCounts.length > 0
                    ? model.effectiveLearning.prompt.tagCounts.map(({ token, count }) => (
                      <span key={token}>{promptPreferenceLabel(token)} ×{count}</span>
                    ))
                    : <small>暂无固定标签</small>}
                </div>
                {model.effectiveLearning.prompt.conflictTags.length > 0 && (
                  <small className="agent-status__learning-conflict">
                    冲突：{model.effectiveLearning.prompt.conflictTags.map(promptConflictLabel).join('、')}
                  </small>
                )}
              </div>
              <div className="agent-status__learning-row">
                <div className="agent-status__learning-heading">
                  <strong>剧情分支偏好</strong>
                  <span>{LEARNING_SCOPE_LABELS[model.effectiveLearning.branch.scope]}
                    {' · '}{model.effectiveLearning.branch.sampleCount} 次选择
                    {' · '}{model.effectiveLearning.branch.uniqueSelectionCount} 个独立分支</span>
                </div>
                <div className="agent-status__learning-tags" aria-label="生效的剧情分支固定标签">
                  {model.effectiveLearning.branch.actionCounts.some(({ count }) => count > 0)
                    ? model.effectiveLearning.branch.actionCounts.filter(({ count }) => count > 0)
                      .map(({ action, count }) => (
                        <span key={action}>{BRANCH_ACTION_LABELS[action]} ×{count}</span>
                      ))
                    : <small>暂无固定标签</small>}
                </div>
              </div>
            </div>
          )}
          {model?.allowedActions.canClearProfile && model.preferenceProfile && (
            <div className="agent-status__controls">
              <h3>学习样本源（仅本机 CAS 控制）</h3>
              <div className="agent-status__control-row">
                <strong>当前会话源正样本（CAS）：{model.preferenceProfile.sampleCount} 条</strong>
                <div>
                  <button type="button" className="danger"
                    disabled={pendingResource === 'preference-profile'
                      || model.preferenceProfile.sampleCount === 0}
                    onClick={() => void clearPreferenceProfile()}>清空偏好学习</button>
                </div>
              </div>
            </div>
          )}
          {(model?.maintenanceProposals?.length ?? 0) > 0 && (
            <div className="agent-status__controls">
              <h3>后台维护提案{model?.allowedActions.canApprove ? '（本机可操作）' : '（只读）'}</h3>
              {maintenanceNotice && <p className="agent-status__privacy">{maintenanceNotice}</p>}
              {model!.maintenanceProposals!.map((proposal) => (
                <div className="agent-status__control-row" key={proposal.id}>
                  <div>
                    <strong>
                      {MAINTENANCE_PROPOSAL_LABELS[proposal.taskKind]} ·
                      {' '}{MAINTENANCE_STATUS_LABELS[proposal.status]} · {proposal.itemCount} 项
                    </strong>
                    {(proposal.reviewItems?.length ?? 0) > 0 && (
                      <ul className="agent-status__proposal-review">
                        {proposal.reviewItems!.map((item, index) => (
                          <li key={`${proposal.id}:${index}`}>
                            <strong>{item.title}</strong>
                            <div className="agent-status__proposal-detail">{item.detail}</div>
                            <small>
                              {item.applicable ? '存在适用写入' : '仅供审阅，不会写入'}
                              {' · '}
                              {item.decision === 'auto' ? '低风险自动策略可接受' : '必须人工复核'}
                              {' · '}依据：{item.reasonCodes.map(reasonLabel).join('；') || '无附加原因'}
                              {' · '}来源：{item.sourceRefs.join('、')}
                            </small>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    {proposal.status === 'pending' && proposal.applySupported && model?.allowedActions.canApprove
                      && maintenanceProposalHasApplicableWrite(proposal) && (
                      <button type="button" disabled={pendingResource === proposal.id
                        || loading || maintenanceRefreshPending}
                        onClick={() => void mutateMaintenanceProposal(proposal, 'approve')}>批准并应用</button>
                    )}
                    {proposal.status === 'pending' && model?.allowedActions.canApprove && (
                      <button type="button" className="danger" disabled={pendingResource === proposal.id}
                        onClick={() => void mutateMaintenanceProposal(proposal, 'reject')}>拒绝</button>
                    )}
                    {proposal.status === 'applied' && model!.allowedActions.canRollback && (
                      <button type="button" disabled={pendingResource === proposal.id}
                        onClick={() => void mutateMaintenanceProposal(proposal, 'rollback')}>回滚</button>
                    )}
                    {proposal.status === 'pending' && !proposal.applySupported && (
                      <small>当前会话未开放 Maintenance apply；可审阅或拒绝</small>
                    )}
                    {proposal.status === 'pending'
                      && model?.allowedActions.canApprove && (proposal.reviewItems?.length ?? 0) === 0 && (
                      <small>本机审阅详情不可用，已阻止盲批；请打开该会话并刷新，或拒绝此提案</small>
                    )}
                    {proposal.status === 'pending'
                      && model?.allowedActions.canApprove && (proposal.reviewItems?.length ?? 0) > 0
                      && !maintenanceProposalHasApplicableWrite(proposal) && (
                      <small>{maintenanceNoApplicableWriteMessage(proposal)}</small>
                    )}
                    {((proposal.status === 'pending' && proposal.applySupported
                      && !model?.allowedActions.canApprove)
                      || (proposal.status === 'applied' && !model?.allowedActions.canRollback)) && (
                      <small>远端只读；请在电脑本机管理入口审批</small>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {(model?.worldbookRepairProposals?.length ?? 0) > 0 && (
            <div className="agent-status__controls">
              <h3>世界书修正提案{model?.allowedActions.canApprove ? '（本机可操作）' : '（只读）'}</h3>
              {model!.worldbookRepairProposals!.map((proposal) => (
                <div className="agent-status__control-row" key={proposal.proposalId}>
                  <div>
                    <strong>
                      {proposal.file} · {WORLDBOOK_REPAIR_STATUS_LABELS[proposal.status]} · {proposal.changeCount} 项
                    </strong>
                    <div>
                      原因：{proposal.reasonCodes.map((code) => WORLDBOOK_REPAIR_REASON_LABELS[code] ?? code)
                        .join('；') || '未标注'}
                    </div>
                    {proposal.status === 'stale' && (
                      <small className="agent-status__reason">
                        文件在提案生成后已被改动 —— 本次修正已作废，需要重新生成提案。
                      </small>
                    )}
                    {!proposal.forwardAllowed && (
                      <small>世界书写入通道未开启（JG_WORLDBOOK_REPAIR）；可审阅但不可应用。</small>
                    )}
                    {proposal.changes && proposal.changes.length > 0 && (
                      <>
                        <div>
                          <button type="button"
                            onClick={() => setExpandedWorldbook(expandedWorldbook === proposal.proposalId ? null : proposal.proposalId)}>
                            {expandedWorldbook === proposal.proposalId ? '收起变更内容' : '查看变更内容'}
                          </button>
                        </div>
                        {expandedWorldbook === proposal.proposalId && (
                          <ul className="agent-status__proposal-review">
                            {proposal.changes.map((change) => (
                              <li key={change.entryUid}>
                                <strong>条目 {change.entryUid}</strong>
                                <div>
                                  原因：{WORLDBOOK_REPAIR_REASON_LABELS[change.reasonCode] ?? change.reasonCode}
                                  {' · '}改字段：
                                  {[
                                    change.patch.content !== undefined && '正文',
                                    change.patch.name !== undefined && '名称',
                                    change.patch.key !== undefined && '触发词',
                                    change.patch.enabled !== undefined && (change.patch.enabled ? '启用' : '停用'),
                                  ].filter(Boolean).join('、')}
                                </div>
                                {change.patch.name !== undefined && <div>新名称：{change.patch.name}</div>}
                                {change.patch.key !== undefined && <div>新触发词：{change.patch.key.join('、') || '（清空）'}</div>}
                                {change.patch.content !== undefined && (
                                  <div style={{ whiteSpace: 'pre-wrap' }}>
                                    新正文（前 600 字）：{change.patch.content.slice(0, 600)}
                                    {change.patch.content.length > 600 ? '…（其余在应用后于世界书原文中查看）' : ''}
                                  </div>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                  <div>
                    {proposal.status === 'pending' && model?.allowedActions.canApprove && (
                      <>
                        <button type="button" disabled={pendingResource === proposal.proposalId}
                          onClick={() => void mutateWorldbookRepair(proposal, 'apply')}>确认修正</button>
                        <button type="button" className="danger" disabled={pendingResource === proposal.proposalId}
                          onClick={() => void mutateWorldbookRepair(proposal, 'reject')}>拒绝</button>
                      </>
                    )}
                    {proposal.status === 'pending' && !model?.allowedActions.canApprove && (
                      <small>远端只读；请在电脑本机管理入口审阅</small>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {groups.map(([group, capabilities]) => (
            <div className="agent-status__group" key={group}>
              <h3>{group}</h3>
              {capabilities.map((capability) => {
                const display = capabilityDisplayState(capability);
                return (
                  <div className="agent-status__row" key={capability.id} data-state={capability.effectiveState}
                    data-tone={display.tone}>
                    <div className="agent-status__line">
                      <strong>{LABELS[capability.id]}</strong>
                      <span className="agent-status__state">{display.label}</span>
                    </div>
                    <div className="agent-status__summary">
                      <span>{display.detail}</span>
                      <span>权限：{capabilityPermissionLabel(
                        capability,
                        model?.maintenanceRuntime,
                      )}</span>
                    </div>
                    <div className="agent-status__metrics">
                      <span>调用 {capability.metrics.modelCalls}</span>
                      <span>模型流程完成 {capability.metrics.successfulLeases}</span>
                      <span>P95 {compactNumber(capability.metrics.p95LatencyMs)}ms</span>
                      <span>Token {compactNumber(capability.metrics.inputTokens + capability.metrics.outputTokens)}</span>
                      <span>费用 {compactNumber(capability.metrics.costMicrousd)}µ$</span>
                      {capability.metrics.attribution === 'shared' && <span title="与同组能力复用同一模型循环">共享计量</span>}
                    </div>
                    {!capability.allowed && capability.recentReasonCodes[0] && (
                      <span className="agent-status__reason" title={capability.recentReasonCodes[0]}>
                        {resolveCapabilityStopSource(capability) === 'policy-quality'
                          ? `随${LANE_LABELS[capability.rolloutLane]}一起暂停：${reasonLabel(capability.recentReasonCodes[0])}；不是本项单独异常。`
                          : reasonLabel(capability.recentReasonCodes[0])}
                      </span>
                    )}
                    {model?.allowedActions.canKill && resolveCapabilityStopSource(capability) === 'none'
                      && capability.effectiveState !== 'killed' && (
                      <button type="button" className="agent-status__capability-control"
                        disabled={pendingLane === capability.rolloutLane}
                        onClick={() => void mutateCapability(
                          capability.id, capability.capabilityRevision, false,
                          capability.metrics.attribution === 'shared',
                        )}>停用此项</button>
                    )}
                    {resolveCapabilityStopSource(capability) === 'capability-quality' && (
                      <small className="agent-status__reason">
                        需先通过定向回放与质量恢复，不能直接清除熔断
                      </small>
                    )}
                    {model?.allowedActions.canClearKill && capability.capabilityKilled
                      && resolveCapabilityStopSource(capability) === 'capability-operator' && (
                      <button type="button" className="agent-status__capability-control"
                        disabled={pendingLane === capability.rolloutLane}
                        onClick={() => void mutateCapability(
                          capability.id, capability.capabilityRevision, true,
                          capability.metrics.attribution === 'shared',
                        )}>恢复此项</button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <p className="agent-status__privacy">
            常规状态仅显示摘要与计量，不显示对话或模型思考过程；完整 Learned Style 只在电脑本机审阅，手机与远端不会收到正文。
          </p>
        </div>
      )}
    </section>
  );
}
