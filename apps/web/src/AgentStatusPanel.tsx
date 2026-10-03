import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentSubcapabilityId,
  PublicBranchActionTag,
  PublicAgentControlReadModel,
  PublicAgentRolloutLane,
  PublicAgentRolloutState,
  PublicLearningProfileScope,
  PublicPromptPreferenceToken,
} from '../../../packages/mobile-contracts/src/agent-control.ts';
import {
  AgentControlMutationError,
  clearPreferenceProfileControl,
  fetchSessionAgentControl,
  mutateAgentLaneControl,
} from './agentControlClient.ts';

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
  'maintenance.branchIndex': '分支索引',
  'maintenance.arc': '剧情弧',
  'maintenance.npc': 'NPC 状态',
  'context.compiler': '上下文恢复',
});

const STATE_LABELS: Readonly<Record<PublicAgentRolloutState, string>> = Object.freeze({
  off: '关闭', shadow: '观察', 'test-session': '测试会话',
  'canary-5': '灰度 5%', 'canary-25': '灰度 25%', 'canary-50': '灰度 50%',
  on: '开启', killed: '已硬停',
});
const LANE_LABELS: Readonly<Record<PublicAgentRolloutLane, string>> = Object.freeze({
  interactive: '对话增强', learning: '学习', maintenance: '后台维护',
});
const MAINTENANCE_STATUS_LABELS = Object.freeze({
  pending: '待审批', applied: '已应用', rejected: '已拒绝', stale: '快照已过期', rolled_back: '已回滚',
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

function groupName(id: AgentSubcapabilityId): string {
  if (id.startsWith('interactive.')) return '对话增强';
  if (id.startsWith('learning.')) return '学习';
  if (id.startsWith('maintenance.')) return '后台维护';
  return '上下文';
}

export function AgentStatusPanel(props: {
  readonly sessionId: string | null;
  readonly refreshKey: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [model, setModel] = useState<PublicAgentControlReadModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingLane, setPendingLane] = useState<PublicAgentRolloutLane | null>(null);
  const [pendingResource, setPendingResource] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(false);
    setModel(null);
    setError('');
  }, [props.sessionId]);

  useEffect(() => {
    if (!expanded || !props.sessionId) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetchSessionAgentControl(props.sessionId, { signal: controller.signal })
      .then((next) => setModel(next))
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== 'AbortError') {
          setError(reason instanceof Error ? reason.message : 'Agent 状态读取失败');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [expanded, props.sessionId, props.refreshKey, reloadKey]);

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
      const capability = model.capabilities.find((item) => item.rolloutLane === lane);
      return capability ? [{ lane, capability }] : [];
    });
  }, [model]);

  const mutateLane = async (
    lane: PublicAgentRolloutLane,
    controlRevision: string,
    operation: 'kill' | 'clear-kill' | 'shadow' | 'off',
  ) => {
    const destructive = operation === 'kill' || operation === 'off';
    if (destructive && typeof window !== 'undefined'
      && !window.confirm(`确认将${LANE_LABELS[lane]}在全部会话中${operation === 'kill' ? '硬停' : '关闭'}？`)) return;
    setPendingLane(lane);
    setError('');
    try {
      await mutateAgentLaneControl(operation === 'kill'
        ? { operation: 'kill', lane, expectedRevision: controlRevision, reasonCode: 'operator-ui-stop' }
        : operation === 'clear-kill'
          ? { operation: 'clear-kill', lane, expectedRevision: controlRevision }
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
      `确认${verb}${proposal.taskKind === 'branch_index' ? '剧情弧' : 'NPC 状态'}提案？`,
    )) return;
    setPendingResource(proposal.id);
    setError('');
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
      setReloadKey((value) => value + 1);
    } catch (reason) {
      const applyDisabled = reason instanceof AgentControlMutationError
        && reason.code === 'maintenance-proposal-apply-disabled';
      if (reason instanceof AgentControlMutationError && reason.status === 409) {
        setReloadKey((value) => value + 1);
      }
      setError(applyDisabled
        ? '当前会话未开放 Maintenance apply；请在电脑本机精确授权该会话后重试'
        : reason instanceof Error ? reason.message : '维护提案控制失败');
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
        <small>{loading ? '读取中…' : model ? `${active}/${model.capabilities.length} 可运行` : '点击查看'}</small>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="agent-status__body">
          {error && <p className="agent-status__error">{error}</p>}
          {!error && loading && !model && <p className="agent-status__empty">正在读取脱敏运行状态…</p>}
          {!error && !loading && !model && <p className="agent-status__empty">暂无状态。</p>}
          {laneControls.length > 0 && (
            <div className="agent-status__controls">
              <h3>电脑本机控制（影响全部会话）</h3>
              {laneControls.map(({ lane, capability }) => (
                <div className="agent-status__control-row" key={lane}>
                  <strong>{LANE_LABELS[lane]}</strong>
                  <div>
                    {capability.effectiveState === 'killed' ? (
                      <button type="button" disabled={pendingLane === lane}
                        onClick={() => void mutateLane(lane, capability.controlRevision, 'clear-kill')}>解除硬停</button>
                    ) : (
                      <>
                        <button type="button" disabled={pendingLane === lane}
                          onClick={() => void mutateLane(lane, capability.controlRevision, 'shadow')}>降为观察</button>
                        <button type="button" disabled={pendingLane === lane}
                          onClick={() => void mutateLane(lane, capability.controlRevision, 'off')}>关闭</button>
                        <button type="button" className="danger" disabled={pendingLane === lane}
                          onClick={() => void mutateLane(lane, capability.controlRevision, 'kill')}>硬停</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {(model?.allowedActions.canApprove || model?.allowedActions.canRollback)
            && (model.styleProposals?.length ?? 0) > 0 && (
            <div className="agent-status__controls">
              <h3>Learned Style 版本（仅本机）</h3>
              {model.styleProposals!.map((proposal) => (
                <div className="agent-status__control-row" key={proposal.id}>
                  <strong>{proposal.id} · {proposal.status === 'enabled'
                    ? `已启用 v${proposal.activeVersion}` : '已禁用'}</strong>
                  <div>
                    {proposal.status === 'enabled' && model?.allowedActions.canRollback && (
                      <button type="button" className="danger" disabled={pendingResource === proposal.id}
                        onClick={() => void mutateStyleProposal(proposal)}>禁用</button>
                    )}
                    {proposal.availableVersions.map((version) => (
                      version === proposal.activeVersion
                        || (proposal.status === 'disabled' && !model?.allowedActions.canApprove)
                        || (proposal.status === 'enabled' && !model?.allowedActions.canRollback) ? null : (
                        <button type="button" disabled={pendingResource === proposal.id} key={version}
                          onClick={() => void mutateStyleProposal(proposal, version)}>
                          {proposal.status === 'disabled' ? `批准启用 v${version}` : `回滚至 v${version}`}
                        </button>
                      )
                    ))}
                  </div>
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
              <h3>Arc / NPC 维护提案{model?.allowedActions.canApprove ? '（本机可操作）' : '（只读）'}</h3>
              {model!.maintenanceProposals!.map((proposal) => (
                <div className="agent-status__control-row" key={proposal.id}>
                  <strong>
                    {proposal.taskKind === 'branch_index' ? '剧情弧' : 'NPC 状态'} ·
                    {' '}{MAINTENANCE_STATUS_LABELS[proposal.status]} · {proposal.itemCount} 项
                  </strong>
                  <div>
                    {proposal.status === 'pending' && proposal.applySupported && model?.allowedActions.canApprove && (
                      <button type="button" disabled={pendingResource === proposal.id}
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
          {groups.map(([group, capabilities]) => (
            <div className="agent-status__group" key={group}>
              <h3>{group}</h3>
              {capabilities.map((capability) => (
                <div className="agent-status__row" key={capability.id} data-state={capability.effectiveState}>
                  <div className="agent-status__line">
                    <strong>{LABELS[capability.id]}</strong>
                    <span>{STATE_LABELS[capability.effectiveState]}</span>
                  </div>
                  <div className="agent-status__metrics">
                    <span>调用 {capability.metrics.modelCalls}</span>
                    <span>Provider 完成 {capability.metrics.successfulLeases}</span>
                    <span>P95 {compactNumber(capability.metrics.p95LatencyMs)}ms</span>
                    <span>Token {compactNumber(capability.metrics.inputTokens + capability.metrics.outputTokens)}</span>
                    <span>费用 {compactNumber(capability.metrics.costMicrousd)}µ$</span>
                    {capability.metrics.attribution === 'shared' && <span title="与同组能力复用同一模型循环">共享计量</span>}
                  </div>
                  {!capability.allowed && capability.recentReasonCodes[0] && (
                    <code className="agent-status__reason">{capability.recentReasonCodes[0]}</code>
                  )}
                  {model?.allowedActions.canKill && capability.effectiveState !== 'killed' && (
                    <button type="button" className="agent-status__capability-control"
                      disabled={pendingLane === capability.rolloutLane}
                      onClick={() => void mutateCapability(
                        capability.id, capability.capabilityRevision, false,
                        capability.metrics.attribution === 'shared',
                      )}>停用此项</button>
                  )}
                  {model?.allowedActions.canClearKill && capability.capabilityKilled && (
                    <button type="button" className="agent-status__capability-control"
                      disabled={pendingLane === capability.rolloutLane}
                      onClick={() => void mutateCapability(
                        capability.id, capability.capabilityRevision, true,
                        capability.metrics.attribution === 'shared',
                      )}>恢复此项</button>
                  )}
                </div>
              ))}
            </div>
          ))}
          <p className="agent-status__privacy">仅显示摘要与计量，不显示对话、Skill 原文或模型思考过程。手机与远端入口只有查看权。</p>
        </div>
      )}
    </section>
  );
}
