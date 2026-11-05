import {
  PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
  PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
  sanitizePublicMaintenanceReviewText,
  type PublicMaintenanceProposalReviewItem,
} from './maintenance-types.ts';
import type { MaintenancePendingProposalRecord } from './maintenance-job-manager.ts';
import {
  isMemoryConsolidationProposalContext,
  isMemoryConsolidationApplyContext,
  isRollingSummaryApplyContext,
  normalizeMemoryConsolidationProposal,
  validateMaintenanceProposal,
  type ArcMaintenanceEvidenceBinding,
  type ArcMaintenanceProposalContext,
  type ArcMaintenanceReviewDescriptor,
  type RollingSummaryProposalContext,
} from './maintenance-types.ts';
import { arcProjectionIdForName } from '../../packages/agent-policy/public/arc-review.ts';

function bounded(value: string, maximum: number): string {
  return sanitizePublicMaintenanceReviewText(value, maximum);
}

function visibleWithoutLoss(value: string, maximum: number): boolean {
  return bounded(value, maximum) === value;
}

function memoryValue(value: string | number | boolean | null): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function memoryReviewItems(
  pending: MaintenancePendingProposalRecord,
): readonly PublicMaintenanceProposalReviewItem[] | undefined {
  if (!isMemoryConsolidationProposalContext(pending.context)
    || !isMemoryConsolidationApplyContext(pending.context)) return undefined;
  const proposal = normalizeMemoryConsolidationProposal(pending.proposal.payload, pending.context);
  const rawDetails = proposal.facts.map((fact) => [
    `主体：${fact.subject}`,
    `关系：${fact.predicate}`,
    `拟写值：${memoryValue(fact.value)}`,
    `状态：${fact.status}；置信度：${fact.confidence}；证据轮次：R${fact.effectiveRound}`,
  ].join('\n'));
  const eligible = proposal.facts.map((fact) => (
    fact.status === 'confirmed' && fact.confidence === 'high'
  ));
  // One hidden/truncated eligible fact would make approving the whole proposal a blind write.
  // In that case every otherwise-eligible item becomes non-applicable and the API rejects approval.
  const allEligibleVisible = rawDetails.every((detail, index) => (
    !eligible[index] || visibleWithoutLoss(detail, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS)
  ));
  return Object.freeze(proposal.facts.map((fact, index): PublicMaintenanceProposalReviewItem => {
    const exact = visibleWithoutLoss(rawDetails[index]!, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS);
    const reasonCodes: string[] = [];
    if (fact.status === 'pending') reasonCodes.push('pending-fact');
    if (fact.status === 'last-known') reasonCodes.push('last-known-fact');
    if (fact.status === 'history_only') reasonCodes.push('history-only-fact');
    if (fact.status === 'confirmed' && fact.confidence !== 'high') {
      reasonCodes.push('memory-confidence-not-high');
    }
    if (!exact) reasonCodes.push('review-content-not-exact');
    if (eligible[index] && exact && !allEligibleVisible) reasonCodes.push('proposal-review-incomplete');
    if (eligible[index] && exact && allEligibleVisible) reasonCodes.push('memory-confirmed-high-write');
    return Object.freeze({
      kind: 'memory',
      title: bounded(
        `长期记忆事实 ${index + 1}/${proposal.facts.length}`,
        PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
      ),
      detail: bounded(rawDetails[index]!, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS),
      applicable: Boolean(eligible[index] && exact && allEligibleVisible),
      decision: 'review',
      reasonCodes: unique(reasonCodes),
      sourceRefs: Object.freeze([...fact.sourceRefs]),
    });
  }));
}

function rollingSummaryReviewItems(
  pending: MaintenancePendingProposalRecord,
): readonly PublicMaintenanceProposalReviewItem[] | undefined {
  if (!isRollingSummaryApplyContext(pending.context)) return undefined;
  const context = pending.context as RollingSummaryProposalContext;
  const validated = validateMaintenanceProposal(
    'rolling_summary', pending.proposal.payload, context,
  );
  const summary = String(validated.payload.summary);
  const throughRound = Number(validated.payload.throughRound);
  const originalCodePoints = [...summary];
  const sanitized = bounded(summary, Math.max(1, originalCodePoints.length));
  const exact = sanitized === summary;
  const codePoints = [...sanitized];
  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length;
    offset += PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS) {
    chunks.push(codePoints.slice(
      offset,
      offset + PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS,
    ).join(''));
  }
  if (chunks.length === 0) chunks.push('摘要内容无法安全显示，已阻止批准。');
  return Object.freeze(chunks.map((detail, index): PublicMaintenanceProposalReviewItem => Object.freeze({
    kind: 'summary',
    title: bounded(
      `滚动摘要（片段 ${index + 1}/${chunks.length}，写至 R${throughRound}）`,
      PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
    ),
    detail,
    applicable: exact,
    decision: 'review',
    reasonCodes: Object.freeze([exact ? 'summary-cas-write' : 'review-content-not-exact']),
    sourceRefs: Object.freeze([`round:${throughRound}`]),
  })));
}

type ArcReviewAction =
  | Readonly<{ kind: 'set_status'; arcId: string; status: string; sourceRefs: readonly string[] }>
  | Readonly<{ kind: 'merge'; arcIds: readonly string[]; targetArcId: string;
      sourceRefs: readonly string[] }>
  | Readonly<{ kind: 'chapter_boundary'; arcIds: readonly string[]; boundaryRound: number;
      sourceRefs: readonly string[] }>
  | Readonly<{ kind: 'order_dependencies'; arcId: string; dependencyArcIds: readonly string[];
      sourceRefs: readonly string[] }>
  | Readonly<{ kind: 'mark_source_conflict'; arcIds: readonly string[];
      sourceRefs: readonly string[] }>;

const ARC_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  open: '进行中', dormant: '休眠', closed: '已收束',
});

function arcStatusOperation(
  current: ArcMaintenanceEvidenceBinding['status'] | undefined,
  target: string,
): string {
  if (target === 'open') {
    return current === 'dormant' || current === 'closed' ? '重新开启' : '设为进行中';
  }
  if (target === 'dormant') return '设为休眠';
  if (target === 'closed') return '收束并关闭';
  return `设为 ${target}`;
}

function validLegacyEvidence(value: ArcMaintenanceEvidenceBinding): boolean {
  return /^arc:sha256:[a-f0-9]{64}$/u.test(value.arcId)
    && ['open', 'dormant', 'closed'].includes(value.status)
    && Number.isSafeInteger(value.firstRound) && value.firstRound >= 1
    && Number.isSafeInteger(value.lastRound) && value.lastRound >= value.firstRound
    && Number.isSafeInteger(value.evidenceCount) && value.evidenceCount >= 1
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(value.latestSourceRevision);
}

function validLegacyDescriptor(
  value: ArcMaintenanceReviewDescriptor,
  evidence: ArcMaintenanceEvidenceBinding | undefined,
): boolean {
  return evidence !== undefined
    && value.arcId === evidence.arcId
    && value.sourceRevision === evidence.latestSourceRevision
    && value.lastRound === evidence.lastRound
    && typeof value.title === 'string' && value.title.length > 0
    && arcProjectionIdForName(value.title) === value.arcId
    && typeof value.currentStage === 'string'
    && typeof value.nextMilestone === 'string';
}

function arcActionIds(action: ArcReviewAction): readonly string[] {
  if (action.kind === 'set_status' || action.kind === 'order_dependencies') {
    return Object.freeze([...new Set([
      action.arcId,
      ...(action.kind === 'order_dependencies' ? action.dependencyArcIds : []),
    ])]);
  }
  return Object.freeze([...new Set(action.arcIds)]);
}

function arcDisplayName(
  arcId: string,
  descriptors: ReadonlyMap<string, ArcMaintenanceReviewDescriptor>,
): string {
  return descriptors.get(arcId)?.title ?? '未解析剧情弧';
}

function appendArcContext(
  lines: string[],
  arcIds: readonly string[],
  evidence: ReadonlyMap<string, ArcMaintenanceEvidenceBinding>,
  descriptors: ReadonlyMap<string, ArcMaintenanceReviewDescriptor>,
): void {
  const label = (arcId: string): string => `「${arcDisplayName(arcId, descriptors)}」`;
  lines.push(`当前状态：${arcIds.map((arcId) => {
    const current = evidence.get(arcId);
    return `${label(arcId)}=${current ? ARC_STATUS_LABELS[current.status] : '未知'}`;
  }).join('；')}`);
  const stages = arcIds.flatMap((arcId) => {
    const stage = descriptors.get(arcId)?.currentStage;
    return stage ? [`${label(arcId)}=${stage}`] : [];
  });
  if (stages.length > 0) lines.push(`当前阶段：${stages.join('；')}`);
  const milestones = arcIds.flatMap((arcId) => {
    const milestone = descriptors.get(arcId)?.nextMilestone;
    return milestone ? [`${label(arcId)}=${milestone}`] : [];
  });
  if (milestones.length > 0) lines.push(`下一里程碑：${milestones.join('；')}`);
  lines.push(`最近推进：${arcIds.map((arcId) => {
    const current = evidence.get(arcId);
    return `${label(arcId)}=${current ? `R${current.lastRound}（${current.evidenceCount} 条证据）` : '未知'}`;
  }).join('；')}`);
}

function arcActionDetail(
  action: ArcReviewAction,
  evidence: ReadonlyMap<string, ArcMaintenanceEvidenceBinding>,
  descriptors: ReadonlyMap<string, ArcMaintenanceReviewDescriptor>,
): string {
  const lines: string[] = [];
  if (action.kind === 'set_status') {
    const current = evidence.get(action.arcId);
    const descriptor = descriptors.get(action.arcId);
    lines.push(`剧情弧：${arcDisplayName(action.arcId, descriptors)}`);
    lines.push(`当前状态：${current ? ARC_STATUS_LABELS[current.status] : '未知'}`);
    lines.push(`拟变更：${arcStatusOperation(current?.status, action.status)}`);
    if (current) {
      lines.push(`状态变化：${ARC_STATUS_LABELS[current.status]} → ${ARC_STATUS_LABELS[action.status] ?? action.status}`);
    }
    if (descriptor?.currentStage) lines.push(`当前阶段：${descriptor.currentStage}`);
    if (descriptor?.nextMilestone) lines.push(`下一里程碑：${descriptor.nextMilestone}`);
    if (current) lines.push(`最近推进：R${current.lastRound}（累计 ${current.evidenceCount} 条证据）`);
    lines.push(`内部 ID：${action.arcId}`);
    return lines.join('\n');
  }
  if (action.kind === 'merge') {
    lines.push(`剧情弧：${action.arcIds.map((arcId) => arcDisplayName(arcId, descriptors)).join('、')}`);
    appendArcContext(lines, action.arcIds, evidence, descriptors);
    lines.push(`拟执行：合并到「${arcDisplayName(action.targetArcId, descriptors)}」`);
    lines.push(`内部 ID：${action.arcIds.join('、')}`);
    return lines.join('\n');
  }
  if (action.kind === 'chapter_boundary') {
    lines.push(`剧情弧：${action.arcIds.map((arcId) => arcDisplayName(arcId, descriptors)).join('、')}`);
    appendArcContext(lines, action.arcIds, evidence, descriptors);
    lines.push(`拟执行：在 R${action.boundaryRound} 设置章节边界`);
    lines.push(`内部 ID：${action.arcIds.join('、')}`);
    return lines.join('\n');
  }
  if (action.kind === 'order_dependencies') {
    const involvedArcIds = [action.arcId, ...action.dependencyArcIds];
    lines.push(`剧情弧：${arcDisplayName(action.arcId, descriptors)}`);
    appendArcContext(lines, involvedArcIds, evidence, descriptors);
    lines.push(`拟执行：依赖 ${action.dependencyArcIds.map((arcId) => arcDisplayName(arcId, descriptors)).join('、')}`);
    lines.push(`内部 ID：${involvedArcIds.join('、')}`);
    return lines.join('\n');
  }
  lines.push(`剧情弧：${action.arcIds.map((arcId) => arcDisplayName(arcId, descriptors)).join('、')}`);
  appendArcContext(lines, action.arcIds, evidence, descriptors);
  lines.push('拟执行：标记来源冲突');
  lines.push(`内部 ID：${action.arcIds.join('、')}`);
  return lines.join('\n');
}

function arcReviewItems(
  pending: MaintenancePendingProposalRecord,
): readonly PublicMaintenanceProposalReviewItem[] | undefined {
  if (!pending.context || typeof pending.context !== 'object'
    || !('allowedArcIds' in pending.context)) return undefined;
  const context = pending.context as ArcMaintenanceProposalContext;
  const validated = validateMaintenanceProposal('branch_index', pending.proposal.payload, context);
  const actions = validated.payload.actions as unknown as readonly ArcReviewAction[];
  const persistedEvidence = context.arcEvidence;
  const evidence = new Map<string, ArcMaintenanceEvidenceBinding>();
  for (const value of persistedEvidence ?? []) {
    if (!validLegacyEvidence(value) || evidence.has(value.arcId)) continue;
    evidence.set(value.arcId, value);
  }
  const descriptors = new Map<string, ArcMaintenanceReviewDescriptor>();
  for (const value of context.arcReviewDescriptors ?? []) {
    if (!validLegacyDescriptor(value, evidence.get(value.arcId)) || descriptors.has(value.arcId)) continue;
    descriptors.set(value.arcId, value);
  }
  const details = actions.map((action) => arcActionDetail(action, evidence, descriptors));
  const allVisible = details.every((detail) => (
    visibleWithoutLoss(detail, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS)
  ));
  const actionChecks = actions.map((action) => {
    const ids = arcActionIds(action);
    const bindingComplete = ids.every((arcId) => descriptors.has(arcId));
    const stateComplete = ids.every((arcId) => evidence.has(arcId));
    const noOp = action.kind === 'set_status'
      && evidence.get(action.arcId)?.status === action.status;
    return { bindingComplete, stateComplete, noOp };
  });
  const proposalComplete = allVisible && actionChecks.every((check) => (
    check.bindingComplete && check.stateComplete && !check.noOp
  ));
  return Object.freeze(actions.map((action, index): PublicMaintenanceProposalReviewItem => Object.freeze({
    kind: 'arc',
    title: bounded(
      `${action.kind === 'set_status' && descriptors.has(action.arcId)
        ? `剧情弧「${descriptors.get(action.arcId)!.title}」状态变更`
        : `剧情弧变更 ${index + 1}/${actions.length}`}`,
      PUBLIC_MAINTENANCE_REVIEW_TITLE_MAX_CODE_POINTS,
    ),
    detail: bounded(details[index]!, PUBLIC_MAINTENANCE_REVIEW_DETAIL_MAX_CODE_POINTS),
    applicable: proposalComplete,
    decision: 'review',
    reasonCodes: unique([
      ...(!actionChecks[index]!.bindingComplete ? ['arc-review-binding-missing'] : []),
      ...(!actionChecks[index]!.stateComplete ? ['arc-review-current-state-unknown'] : []),
      ...(actionChecks[index]!.noOp ? ['arc-status-noop'] : []),
      ...(!allVisible ? ['review-content-not-exact'] : []),
      ...(!proposalComplete ? ['proposal-review-incomplete'] : ['arc-projection-write']),
    ]),
    sourceRefs: Object.freeze([...action.sourceRefs]),
  })));
}

/**
 * Derives content-bearing local review rows from the immutable pending proposal.
 * Invalid proposals are omitted; legacy Arc proposals without frozen readable
 * bindings render as non-applicable rows so callers still fail closed.
 */
export function typedMaintenanceProposalReviewItems(
  pending: MaintenancePendingProposalRecord,
): readonly PublicMaintenanceProposalReviewItem[] | undefined {
  try {
    if (pending.status !== 'pending') return undefined;
    if (pending.taskKind === 'memory_consolidation') return memoryReviewItems(pending);
    if (pending.taskKind === 'branch_index') return arcReviewItems(pending);
    if (pending.taskKind === 'rolling_summary') return rollingSummaryReviewItems(pending);
    return undefined;
  } catch {
    return undefined;
  }
}

export function maintenanceReviewHasApplicableWrite(
  reviewItems: readonly PublicMaintenanceProposalReviewItem[] | undefined,
): boolean {
  return Boolean(reviewItems?.length && reviewItems.some((item) => item.applicable));
}
