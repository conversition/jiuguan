import type {
  MaintenanceProposal,
  MaintenanceStrictProposalContext,
  MaintenanceTaskKind,
} from './maintenance-types.ts';
import type { MaintenanceMemoryDirectPreparation } from './maintenance-memory-direct-proposal.ts';
import type { MaintenanceSummaryDirectPreparation } from './maintenance-summary-skill-source.ts';

export interface MaintenanceCommitRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly expectedRevision: string;
  readonly proposal: MaintenanceProposal;
  /**
   * P16 E2：领域提案上下文（来自 harness 快照的 proposalContext）。
   * memory/summary 的 typed committer 靠它做历史纪元/证据集/输入摘要校验。
   */
  readonly context?: MaintenanceStrictProposalContext;
  /** Internal current-claim binding, never a model or HTTP argument. */
  readonly executionClaim?: Readonly<{ ownerInstanceId: string; attempt: number }>;
  readonly signal?: AbortSignal;
  /** A persisted preparation is not sufficient: the Manager's one-shot process brand is required at commit. */
  readonly directPreparation?: MaintenanceMemoryDirectPreparation;
  /** Summary authority is independent of the Memory handle, even under a shared control profile. */
  readonly summaryPreparation?: MaintenanceSummaryDirectPreparation;
}

export type MaintenanceCommitResult =
  | {
    readonly status: 'committed';
    readonly revision: string;
    readonly diff: Record<string, unknown>;
    /** Internal domain receipt only; never persisted in a public job or its diff. */
    readonly receipt?: Readonly<Record<string, unknown>>;
  }
  | { readonly status: 'stale'; readonly actualRevision: string; readonly diff: Record<string, unknown> };

/**
 * 实现方必须在一个短事务中完成 source revision 比较、typed proposal 写入和 runId 去重。
 * 同一 runId 重放必须返回同一结果，不能重复写或重复计费。
 */
export interface MaintenanceProposalCommitter {
  commit(request: MaintenanceCommitRequest): Promise<MaintenanceCommitResult>;
}

export function shadowDiff(proposal: MaintenanceProposal): Record<string, unknown> {
  const payload = proposal.payload;
  if (proposal.taskKind === 'rolling_summary') {
    return {
      taskKind: proposal.taskKind,
      itemCount: 1,
      summaryChars: String(payload.summary ?? '').length,
      throughRound: payload.throughRound,
    };
  }
  const field = proposal.taskKind === 'memory_consolidation' ? 'facts'
    : proposal.taskKind === 'branch_index'
      ? (Array.isArray(payload.actions) ? 'actions' : 'branches')
      : (Array.isArray(payload.entries) ? 'entries' : 'characters');
  return {
    taskKind: proposal.taskKind,
    itemCount: Array.isArray(payload[field]) ? payload[field].length : 0,
  };
}
