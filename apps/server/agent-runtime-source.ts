import type { AgentLane } from '../../packages/agent-policy/src/admission.ts';
import type { AgentRuntimeLeaseRow } from './agent-admission-ledger.ts';

/**
 * Foreground chat-window compaction currently reuses the maintenance lane and
 * rolling_summary task kind.  Its policy marker is therefore the only durable
 * discriminator available in existing append-only lease rows.
 */
export const FOREGROUND_SUMMARY_POLICY_MARKER = 'foreground-summary' as const;

export type AgentRuntimeExecutionSource =
  | AgentLane
  | 'foreground_summary'
  | 'background_maintenance';

export function isForegroundRollingSummaryLease(
  row: Pick<AgentRuntimeLeaseRow, 'lane' | 'taskKind' | 'policyVersion'>,
): boolean {
  return row.lane === 'maintenance'
    && row.taskKind === 'rolling_summary'
    && row.policyVersion.includes(FOREGROUND_SUMMARY_POLICY_MARKER);
}

/** Classifies execution purpose without changing the persisted lease schema. */
export function agentRuntimeExecutionSource(
  row: Pick<AgentRuntimeLeaseRow, 'lane' | 'taskKind' | 'policyVersion'>,
): AgentRuntimeExecutionSource {
  if (isForegroundRollingSummaryLease(row)) return 'foreground_summary';
  if (row.lane === 'maintenance') return 'background_maintenance';
  return row.lane;
}
