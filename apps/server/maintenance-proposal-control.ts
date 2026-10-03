import type { ArcMaintenanceProposalContext } from '../../packages/agent-policy/src/arc-maintenance-proposal.ts';
import { ArcMaintenanceCommitter } from './arc-maintenance-committer.ts';
import type { ArcProjectionStore } from './arc-projection-store.ts';
import type {
  MaintenanceJobManager,
  MaintenancePendingProposalRecord,
  MaintenancePendingProposalSummary,
} from './maintenance-job-manager.ts';
import type {
  NpcMaintenanceCommitResult,
  NpcMaintenanceRollbackReceipt,
} from './npc-maintenance-committer.ts';

export interface MaintenanceProposalControlOptions {
  readonly manager: MaintenanceJobManager;
  readonly arcStore: ArcProjectionStore;
  readonly currentRevision: (sessionId: string) => string;
  /** Narrow trusted-local adapters; no generic CharacterStore write is exposed. */
  readonly applyNpcProposal?: (pending: MaintenancePendingProposalRecord) => NpcMaintenanceCommitResult;
  readonly rollbackNpcProposal?: (anchor: Readonly<Record<string, unknown>>) => NpcMaintenanceRollbackReceipt;
}

/** Trusted-local approval boundary for typed, revisioned, reversible domain proposals. */
export class MaintenanceProposalControl {
  constructor(private readonly options: MaintenanceProposalControlOptions) {}

  approve(proposalId: string, expectedRevision: number): MaintenancePendingProposalSummary {
    const pending = this.options.manager.getPendingProposal(proposalId);
    if (!pending) throw new Error('maintenance-proposal-not-found');
    if (pending.revision !== expectedRevision || pending.status !== 'pending') {
      throw new Error('maintenance-proposal-revision-conflict');
    }
    if (pending.taskKind === 'npc_state') {
      if (!this.options.applyNpcProposal) throw new Error('maintenance-proposal-apply-not-supported');
      const committed = this.options.applyNpcProposal(pending);
      if (committed.status === 'stale') {
        return this.options.manager.markProposalStale({
          proposalId,
          expectedRevision,
          reason: 'source-revision-stale',
        });
      }
      if (committed.status === 'rejected') {
        throw new Error(`maintenance-proposal-npc-apply-rejected:${committed.errorCode}`);
      }
      const { rollbackAnchor, ...receipt } = committed;
      return this.options.manager.markProposalApplied({
        proposalId,
        expectedRevision,
        receipt: receipt as unknown as Record<string, unknown>,
        rollbackAnchor: rollbackAnchor as unknown as Record<string, unknown>,
      });
    }
    if (pending.taskKind !== 'branch_index') {
      throw new Error('maintenance-proposal-apply-not-supported');
    }
    const committer = new ArcMaintenanceCommitter(this.options.arcStore, this.options.currentRevision);
    const committed = committer.commit({
      runId: pending.jobRunId,
      proposal: pending.proposal.payload,
      context: pending.context as ArcMaintenanceProposalContext,
      provenanceDigest: pending.proposalDigest,
    });
    if (committed.status === 'stale') {
      return this.options.manager.markProposalStale({
        proposalId,
        expectedRevision,
        reason: 'source-revision-stale',
      });
    }
    return this.options.manager.markProposalApplied({
      proposalId,
      expectedRevision,
      receipt: committed.receipt as unknown as Record<string, unknown>,
      rollbackAnchor: {
        runId: pending.jobRunId,
        projectionDigest: committed.receipt.projection.projectionDigest,
      },
    });
  }

  rollback(proposalId: string, expectedRevision: number): MaintenancePendingProposalSummary {
    const applied = this.options.manager.getPendingProposal(proposalId);
    if (!applied) throw new Error('maintenance-proposal-not-found');
    if (applied.revision !== expectedRevision || applied.status !== 'applied') {
      throw new Error('maintenance-proposal-revision-conflict');
    }
    if (applied.taskKind === 'npc_state') {
      if (!this.options.rollbackNpcProposal || !applied.rollbackAnchor) {
        throw new Error('maintenance-proposal-rollback-not-supported');
      }
      const rollback = this.options.rollbackNpcProposal(applied.rollbackAnchor);
      return this.options.manager.markProposalRolledBack({
        proposalId,
        expectedRevision,
        receipt: rollback as unknown as Record<string, unknown>,
      });
    }
    if (applied.taskKind !== 'branch_index') {
      throw new Error('maintenance-proposal-rollback-not-supported');
    }
    const rollback = this.options.arcStore.rollbackRun(applied.jobRunId, applied.sessionId);
    return this.options.manager.markProposalRolledBack({
      proposalId,
      expectedRevision,
      receipt: rollback as unknown as Record<string, unknown>,
    });
  }
}
