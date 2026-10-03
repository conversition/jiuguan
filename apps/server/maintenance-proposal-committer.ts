import type { MaintenanceProposal, MaintenanceTaskKind } from './maintenance-types.ts';

export interface MaintenanceCommitRequest {
  readonly runId: string;
  readonly sessionId: string;
  readonly taskKind: MaintenanceTaskKind;
  readonly expectedRevision: string;
  readonly proposal: MaintenanceProposal;
}

export type MaintenanceCommitResult =
  | { readonly status: 'committed'; readonly revision: string; readonly diff: Record<string, unknown> }
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
