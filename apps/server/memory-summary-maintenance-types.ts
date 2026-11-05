import type {
  MaintenancePendingProposalRecord,
} from './maintenance-job-manager.ts';

export {
  isMemoryConsolidationApplyContext,
  isMemoryConsolidationProposalContext,
  isRollingSummaryApplyContext,
  maintenanceMessageEvidenceBinding,
  maintenanceSummaryInputDigest,
  maintenanceValueDigest,
  normalizeMemoryConsolidationProposal,
  validateMaintenanceProposal,
} from './maintenance-types.ts';
export type {
  MaintenanceMessageEvidenceBinding,
  MemoryConsolidationProposalContext,
  RollingSummaryProposalContext,
} from './maintenance-types.ts';

/** Narrow structural alias prevents the committer from depending on the manager implementation. */
export type MaintenancePendingProposalRecordLike = Pick<MaintenancePendingProposalRecord,
  'jobRunId' | 'sessionId' | 'taskKind' | 'sourceRevision' | 'proposal' | 'context'>;
