import type { MaintenanceTaskKind } from './maintenance-types.ts';

export interface MaintenanceExecutionPolicy {
  /** Maximum backend evidence-read attempts. Further reads return a bounded redirect to propose_*. */
  readonly maxEvidenceReads: number;
  /** Logical Harness steps. Covers reads, one proposal, and at most one protocol repair. */
  readonly maxSteps: number;
  /** Physical Provider ceiling. One slot above maxSteps is reserved for one transient retry. */
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
}

/**
 * Production Maintenance termination contract.
 *
 * The 2026-10-06/07 production sample showed branch_index, npc_state and
 * rolling_summary consuming all three calls as reads (3 tools / 0 writes), so
 * increasing the shared token ceiling cannot fix the failure. Each task now
 * gets only the reads it can use, one proposal slot, one repair slot, and one
 * physical retry slot. The retry slot is a Provider allowance, not another
 * logical Harness step, so it cannot turn into an unbounded tool loop.
 */
const POLICY: Readonly<Record<MaintenanceTaskKind, MaintenanceExecutionPolicy>> = Object.freeze({
  memory_consolidation: Object.freeze({
    maxEvidenceReads: 2, maxSteps: 4, maxModelCalls: 5, maxToolCalls: 4,
  }),
  branch_index: Object.freeze({
    maxEvidenceReads: 2, maxSteps: 4, maxModelCalls: 5, maxToolCalls: 4,
  }),
  rolling_summary: Object.freeze({
    // The fixed snapshot already carries recent history; one lookup is enough
    // to resolve an omitted long-range fact before proposing the summary.
    maxEvidenceReads: 1, maxSteps: 3, maxModelCalls: 4, maxToolCalls: 3,
  }),
  npc_state: Object.freeze({
    maxEvidenceReads: 2, maxSteps: 4, maxModelCalls: 5, maxToolCalls: 4,
  }),
  worldbook_repair: Object.freeze({
    maxEvidenceReads: 2, maxSteps: 4, maxModelCalls: 5, maxToolCalls: 4,
  }),
});

export function maintenanceExecutionPolicy(
  taskKind: MaintenanceTaskKind,
): MaintenanceExecutionPolicy {
  return POLICY[taskKind];
}
