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

  /** Exact historical readback; no current-source check and no business write. */
  readCommitEvidence(input: ArcMaintenanceCommitRequest): ReturnType<ArcProjectionStore['readCommitEvidence']> {
    return this.store.readCommitEvidence({ runId: input.runId, provenanceDigest: input.provenanceDigest,
      proposal: () => normalizeArcMaintenanceProposal(input.proposal, input.context) });
  }

  /** Exact historical readback; no current-source check and no business write. */
  recover(input: ArcMaintenanceCommitRequest): Extract<ArcProjectionCommitResult, { status: 'committed' }> | null {
    return this.store.recover({ runId: input.runId, provenanceDigest: input.provenanceDigest,
      proposal: () => normalizeArcMaintenanceProposal(input.proposal, input.context) });
  }

  commit(input: ArcMaintenanceCommitRequest): ArcProjectionCommitResult {
    const proposal = normalizeArcMaintenanceProposal(input.proposal, input.context);
    const expectedProjectionDigest = input.context.arcProjectionDigest;
    if (!expectedProjectionDigest) {
      throw new Error('arc-maintenance-projection-cas-required');
    }
    return this.store.commit({
      runId: input.runId,
      proposal,
      provenanceDigest: input.provenanceDigest,
      expectedProjectionDigest,
      currentRevision: () => this.currentRevision(proposal.sessionId),
    });
  }
}
