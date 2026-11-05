import type {
  AgentControlAllowedActions,
  PublicMaintenanceRuntimeStatus,
  PublicAgentSubcapability,
  PublicStyleProposalControl,
  PublicStyleProposalVersionReview,
} from '../../../packages/mobile-contracts/src/agent-control.ts';

export type CapabilityStopSource = NonNullable<PublicAgentSubcapability['stopSource']>;
export type CapabilityDisplayTone = 'available' | 'verifying' | 'observing' | 'inactive' | 'blocked';
export type StyleReviewAction = 'approve' | 'rollback' | null;

export interface CapabilityDisplayState {
  readonly label: string;
  readonly detail: string;
  readonly tone: CapabilityDisplayTone;
}

const QUALITY_STOP_REASONS = new Set([
  'provider-error-rate-exceeded',
  'invalid-call-rate-exceeded',
  'p95-latency-exceeded',
  'maintenance-multi-task-protocol-invalid',
]);
const SAFETY_STOP_REASONS = new Set([
  'player-sovereignty-violation',
  'unauthorized-or-stale-write',
  'duplicate-write',
  'sensitive-audit-violation',
]);

/**
 * New servers return an explicit source. The fallback keeps an older server
 * safe: it never presents a policy/host stop as an operator-clearable switch.
 */
export function resolveCapabilityStopSource(
  capability: PublicAgentSubcapability,
): CapabilityStopSource {
  if (capability.stopSource) return capability.stopSource;
  if (capability.capabilityKilled) return capability.killReason === 'maintenance-protocol-invalid'
    ? 'capability-quality' : 'capability-operator';
  if (capability.effectiveState !== 'killed') return 'none';
  const reasons = [capability.killReason, ...capability.recentReasonCodes]
    .filter((reason): reason is string => typeof reason === 'string');
  if (reasons.some((reason) => SAFETY_STOP_REASONS.has(reason))) return 'policy-safety';
  if (reasons.some((reason) => QUALITY_STOP_REASONS.has(reason))) return 'policy-quality';
  if (capability.hostCeiling === 'killed') return 'host-ceiling';
  return 'lane-operator';
}

function canaryPercent(capability: PublicAgentSubcapability): number | null {
  if (capability.effectiveState === 'canary-5') return 5;
  if (capability.effectiveState === 'canary-25') return 25;
  if (capability.effectiveState === 'canary-50') return 50;
  return null;
}

function verificationSummary(capability: PublicAgentSubcapability): {
  readonly counts: string;
  readonly remainingSamples: number;
  readonly remainingCallCapacity: number;
} | null {
  const progress = capability.verification;
  if (!progress) return null;
  const counts = `${capability.rolloutLane === 'maintenance' ? '后台维护共享验证 · ' : ''}`
    + `合格回合 ${progress.qualifyingSamples}/${progress.requiredQualifyingSamples}`
    + ` · 调用额度 ${progress.consumedProviderCalls}/${progress.maxProviderCalls}`
    + (progress.reservedProviderCalls > 0 ? `（${progress.reservedProviderCalls} 次进行中）` : '');
  return Object.freeze({
    counts,
    remainingSamples: Math.max(0, progress.requiredQualifyingSamples - progress.qualifyingSamples),
    // Reserved calls can still settle into qualifying samples, so only settled
    // calls are removed from the theoretical capacity of this exact window.
    remainingCallCapacity: Math.max(0, progress.maxProviderCalls - progress.consumedProviderCalls),
  });
}

function rolloutLaneLabel(capability: PublicAgentSubcapability): string {
  switch (capability.rolloutLane) {
    case 'interactive': return '对话通道';
    case 'learning': return '学习通道';
    case 'maintenance': return '后台维护通道';
  }
}

function qualityStopDetail(capability: PublicAgentSubcapability): string {
  const reason = [capability.killReason, ...capability.recentReasonCodes]
    .find((candidate) => candidate !== null && QUALITY_STOP_REASONS.has(candidate));
  switch (reason) {
    case 'p95-latency-exceeded':
      return '通道响应耗时保护已触发；本项不代表独立故障';
    case 'provider-error-rate-exceeded':
      return '通道模型服务失败率保护已触发；本项不代表独立故障';
    case 'invalid-call-rate-exceeded':
      return '通道无效调用率保护已触发；本项不代表独立故障';
    case 'maintenance-multi-task-protocol-invalid':
      return '后台维护多任务输出协议保护已触发；本项不代表独立故障';
    default:
      return '通道质量保护已触发；本项不代表独立故障';
  }
}

/**
 * Converts deployment controls into the answer operators actually need:
 * whether this session can use the capability now. Rollout percentages remain
 * secondary context and are never presented as per-turn execution odds.
 */
export function capabilityDisplayState(
  capability: PublicAgentSubcapability,
): CapabilityDisplayState {
  const verification = verificationSummary(capability);
  const source = resolveCapabilityStopSource(capability);
  if (source === 'policy-quality') {
    return {
      label: `受${rolloutLaneLabel(capability)}暂停影响`,
      detail: qualityStopDetail(capability),
      tone: 'blocked',
    };
  }
  if (source === 'policy-safety') {
    return { label: '已暂停', detail: '总通道触发安全保护', tone: 'blocked' };
  }
  if (source === 'host-ceiling') {
    return { label: '已暂停', detail: '当前运行环境已停用此通道', tone: 'blocked' };
  }
  if (source === 'lane-operator') {
    return { label: '已暂停', detail: '总通道已由管理员停用', tone: 'blocked' };
  }
  if (source === 'capability-quality') {
    return { label: '已暂停', detail: '本项触发质量保护', tone: 'blocked' };
  }
  if (source === 'capability-operator') {
    return { label: '已停用', detail: '本项已由管理员停用', tone: 'blocked' };
  }

  if (capability.effectiveState === 'off') {
    return { label: '未启用', detail: '当前不会运行', tone: 'inactive' };
  }
  if (capability.effectiveState === 'shadow') {
    return { label: '仅观察', detail: '不接收正式任务，不写入业务数据', tone: 'observing' };
  }
  if (capability.effectiveState === 'test-session') {
    if (capability.allowed) {
      if (verification && verification.remainingSamples > verification.remainingCallCapacity) {
        return {
          label: '受控验证中 · 本轮不足',
          detail: `${verification.counts}；本窗口最多再增加 ${verification.remainingCallCapacity} 个合格回合，无法达到门槛`,
          tone: 'verifying',
        };
      }
      return {
        label: '受控验证中',
        detail: verification
          ? `${verification.counts}；至少还差 ${verification.remainingSamples} 个成功触发本能力组的对话回合`
          : '当前会话可用；成功触发的对话回合计入本能力组的共享验证进度',
        tone: 'verifying',
      };
    }
    if (capability.recentReasonCodes.includes('test-session-sample-target-reached')) {
      return {
        label: '验证达标，等待复核',
        detail: `${verification ? `${verification.counts}；` : ''}已达到门槛，通过人工复核后可进入分批开放`,
        tone: 'verifying',
      };
    }
    if (capability.recentReasonCodes.includes('test-session-window-exhausted')) {
      return {
        label: '额度用完，等待复核',
        detail: `${verification ? `${verification.counts}；` : ''}本轮调用额度已用完，样本未达标时需复核后开启新窗口`,
        tone: 'verifying',
      };
    }
    if (capability.recentReasonCodes.includes('test-session-window-fully-reserved')) {
      return {
        label: '调用结算中',
        detail: `${verification ? `${verification.counts}；` : ''}本轮剩余额度已被进行中的任务占用，结算或释放后自动更新`,
        tone: 'verifying',
      };
    }
    if (capability.recentReasonCodes.includes('test-session-review-required')) {
      return {
        label: '本轮验证结束，等待复核',
        detail: '旧版服务未提供结束原因；请复核样本进度与调用额度',
        tone: 'verifying',
      };
    }
    if (capability.recentReasonCodes.includes('operational-evaluation-required')) {
      return { label: '等待验证条件', detail: '尚未通过运行评测', tone: 'inactive' };
    }
    return { label: '本会话暂未启用', detail: '仅向指定验证会话开放', tone: 'inactive' };
  }

  const percent = canaryPercent(capability);
  if (percent !== null) {
    const managedLocal = capability.rolloutCohortScope === 'managed-local';
    if (capability.allowed) {
      return {
        label: '本会话已启用',
        detail: (managedLocal
          ? '当前安装共享验证批次 · 本机全部受管会话已纳入该批次'
          : `分批开放 ${percent}% · 当前会话已纳入固定批次`)
          + (verification ? ` · 试运行：${verification.counts}` : ''),
        tone: 'available',
      };
    }
    if (capability.recentReasonCodes.includes('canary-sample-gate')) {
      return {
        label: '等待试运行验证',
        detail: managedLocal
          ? (verification
            ? `${verification.counts}；还差 ${verification.remainingSamples} 个合格回合后启用本机共享验证批次`
            : '达到验证门槛后启用本机共享验证批次')
          : (verification
            ? `${verification.counts}；还差 ${verification.remainingSamples} 个合格回合后进入 ${percent}% 分批开放`
            : `达到验证门槛后进入 ${percent}% 分批开放`),
        tone: 'verifying',
      };
    }
    if (capability.recentReasonCodes.includes('operational-evaluation-required')) {
      return { label: '等待验证条件', detail: '尚未通过运行评测', tone: 'inactive' };
    }
    return {
      label: '本会话暂未启用',
      detail: (managedLocal
        ? '当前安装共享验证批次 · 本会话受其他启用条件限制'
        : `分批开放 ${percent}% · 当前会话未纳入固定批次`)
        + (verification ? ` · 试运行：${verification.counts}` : ''),
      tone: 'inactive',
    };
  }

  if (capability.effectiveState === 'on') {
    return capability.allowed
      ? { label: '已全面启用', detail: '满足触发条件时运行', tone: 'available' }
      : { label: '等待正式开放', detail: '尚未达到全面开放条件', tone: 'verifying' };
  }

  return { label: '已暂停', detail: '当前不可运行', tone: 'blocked' };
}

export function capabilityPermissionLabel(
  capability: PublicAgentSubcapability,
  maintenanceRuntime?: PublicMaintenanceRuntimeStatus,
): string {
  const capabilityId = capability.id;
  switch (capabilityId) {
    case 'interactive.prelude':
      return '读取会话上下文并提供本轮生成指导；不直接修改记忆、人物或世界书';
    case 'interactive.director':
      return '与查证前奏共享执行并提供剧情方向；不直接修改持久数据';
    case 'interactive.critic':
      return '可校验并修订本轮候选回复；不单独写入记忆、人物或世界书';
    case 'interactive.variableProposal':
      return capability.recentReasonCodes.includes('interactive-variable-advisory-only')
        ? '只提供变量建议，不写入'
        : '可在本轮事务内写入已声明且通过范围校验的变量，提交后回读验证';
    case 'interactive.aqlReplan':
      return '只生成检索重规划建议；不写入对话、记忆或人物状态';
    case 'learning.preference':
      return '自动记录 Prompt 偏好并影响后续回复；可清空，不修改角色或世界书';
    case 'learning.branchPreference':
      return '自动记录已选剧情方向并影响后续排序；可清空，不修改角色或世界书';
    case 'learning.styleCompile':
      return '生成并保存可审阅的文风提案；本机批准后才影响后续回复';
    case 'maintenance.memory':
      if (capability.allowed && maintenanceRuntime?.automaticWriteActive
        && (maintenanceRuntime.autoApplyScope === 'safe-memory-summary'
          || maintenanceRuntime.autoApplyScope === 'low-risk-maintenance')) {
        return '高置信长期记忆与 CAS 滚动摘要可受控自动写入；其余内容仍需人工复核';
      }
      return '可生成长期记忆与滚动摘要；仅在写入授权和快照校验通过后落库';
    case 'maintenance.branchIndex':
      return '剧情弧维护的兼容入口；与“剧情弧”共用同一提案和计量';
    case 'maintenance.arc':
      return '可生成剧情弧调整提案；批准后仅更新可重建投影，不修改正文或世界书';
    case 'maintenance.npc':
      if (capability.allowed && maintenanceRuntime?.automaticWriteActive
        && (maintenanceRuntime.autoApplyScope === 'safe-npc-facts'
          || maintenanceRuntime.autoApplyScope === 'low-risk-maintenance')) {
        return '仅低风险且高置信 NPC 事实可受控自动写入；关系、身份、覆盖与低置信项仍需人工复核';
      }
      return maintenanceRuntime?.applyMode === 'manual-approval'
        ? '可生成 NPC 状态提案，人工批准后写入'
        : '只生成 NPC 状态提案，不写入';
    case 'maintenance.worldbook':
      return '只生成世界书修正提案；不会自动修改，必须本机确认后写入';
    case 'context.compiler':
      return '只读并压缩上下文供本轮使用；不修改原始对话或业务数据';
  }
  const exhaustiveCapability: never = capabilityId;
  return exhaustiveCapability;
}

/** Chooses the most informative row for a lane-level summary. */
export function selectLaneDisplayCapability(
  capabilities: readonly PublicAgentSubcapability[],
): PublicAgentSubcapability | undefined {
  return capabilities.find((item) => item.allowed)
    ?? capabilities.find((item) => !item.capabilityKilled && item.effectiveState !== 'off')
    ?? capabilities.find((item) => !item.capabilityKilled)
    ?? capabilities[0];
}

/** Returns the only legal human action for a fully reviewed Learned Style version. */
export function styleReviewAction(
  proposal: PublicStyleProposalControl,
  review: PublicStyleProposalVersionReview,
  actions: AgentControlAllowedActions,
): StyleReviewAction {
  if (!review.evaluation.passed || review.version === proposal.activeVersion) return null;
  if (proposal.status === 'disabled') return actions.canApprove ? 'approve' : null;
  if (proposal.activeVersion === null || review.version >= proposal.activeVersion) return null;
  return actions.canRollback ? 'rollback' : null;
}
