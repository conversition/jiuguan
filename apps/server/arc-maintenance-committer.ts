import {
  normalizeArcMaintenanceProposal,
  type ArcMaintenanceProposalContext,
} from '../../packages/agent-policy/src/arc-maintenance-proposal.ts';
import {
  ArcProjectionStore,
  type ArcProjectionCommitResult,
} from './arc-projection-store.ts';

export interface ArcMaintenanceCommitRequest {
  readonly runId: string;
  readonly proposal: unknown;
  readonly context: ArcMaintenanceProposalContext;
  readonly provenanceDigest: string;
}

/** Typed Arc proposals can only update the disposable projection store. */
export class ArcMaintenanceCommitter {
  constructor(
    private readonly store: ArcProjectionStore,
    private readonly currentRevision: (sessionId: string) => string,
  ) {}

  commit(input: ArcMaintenanceCommitRequest): ArcProjectionCommitResult {
    const proposal = normalizeArcMaintenanceProposal(input.proposal, input.context);
    return this.store.commit({
      runId: input.runId,
      proposal,
      provenanceDigest: input.provenanceDigest,
      currentRevision: () => this.currentRevision(proposal.sessionId),
    });
  }
}
