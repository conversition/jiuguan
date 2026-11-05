import type { ArcMaintenanceProposalContext } from '../../packages/agent-policy/src/arc-maintenance-proposal.ts';
import { NPC_APPLY_POLICY_VERSION } from '../../packages/agent-policy/src/npc-apply-policy.ts';
import {
  normalizeNpcMaintenanceProposal,
  type NpcMaintenanceProposalContext,
} from '../../packages/agent-policy/src/npc-maintenance-proposal.ts';
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
import {
  assertNpcMaintenanceApplyBackupAnchor,
  type NpcMaintenanceApplyBackupAnchor,
} from './npc-maintenance-apply-backup.ts';
import type {
  MemorySummaryCommitResult,
  MemorySummaryRollbackResult,
} from './memory-summary-maintenance-committer.ts';

export interface MaintenanceProposalControlOptions {
  readonly manager: MaintenanceJobManager;
  readonly arcStore: ArcProjectionStore;
  readonly currentRevision: (sessionId: string) => string;
  /** Narrow trusted-local adapters; no generic CharacterStore write is exposed. */
  readonly recoverNpcProposal?: (
    pending: MaintenancePendingProposalRecord,
  ) => Extract<NpcMaintenanceCommitResult, { readonly status: 'committed' }> | null;
  readonly applyNpcProposal?: (pending: MaintenancePendingProposalRecord) => NpcMaintenanceCommitResult;
  readonly rollbackNpcProposal?: (anchor: Readonly<Record<string, unknown>>) => NpcMaintenanceRollbackReceipt;
  /** Required immediately before every formal NPC business write. */
  readonly prepareNpcApply?: (
    pending: MaintenancePendingProposalRecord,
  ) => NpcMaintenanceApplyBackupAnchor;
  readonly recoverMemorySummaryProposal?: (
    pending: MaintenancePendingProposalRecord,
  ) => MemorySummaryCommitResult | null;
  readonly applyMemorySummaryProposal?: (
    pending: MaintenancePendingProposalRecord,
  ) => MemorySummaryCommitResult;
  readonly rollbackMemorySummaryProposal?: (
    anchor: Readonly<Record<string, unknown>>,
  ) => MemorySummaryRollbackResult;
  /** Best-effort, content-bounded sidecar; never participates in domain commits. */
  readonly observeProposalTransition?: (
    proposal: MaintenancePendingProposalRecord,
  ) => void;
}

export interface GuardedNpcAutoApplyAudit {
  readonly version: 'npc-guarded-auto-audit-v1';
  readonly policyVersion: typeof NPC_APPLY_POLICY_VERSION;
  readonly proposalDigest: string;
  readonly reasonCodes: readonly string[];
  readonly approvedAutoWrites: number;
  readonly occupiedTargetsDigest: string;
  readonly entryDecisions: readonly Readonly<{
    entryIndex: number;
    verdict: 'auto' | 'review';
    reasonCodes: readonly string[];
  }>[];
}

function isUnresolvedOnlyNpcProposal(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const entries = (payload as { entries?: unknown }).entries;
  return Array.isArray(entries) && entries.length > 0 && entries.every((entry) => (
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as { kind?: unknown }).kind === 'unresolved'
  ));
}

/** Trusted-local approval boundary for typed, revisioned, reversible domain proposals. */
export class MaintenanceProposalControl {
  constructor(private readonly options: MaintenanceProposalControlOptions) {}

  #recoverArcProposal(pending: MaintenancePendingProposalRecord): ReturnType<ArcMaintenanceCommitter['recover']> {
    const recovered = new ArcMaintenanceCommitter(this.options.arcStore, this.options.currentRevision).recover({
      runId: pending.jobRunId,
      proposal: pending.proposal.payload,
      context: pending.context as ArcMaintenanceProposalContext,
      provenanceDigest: pending.proposalDigest,
    });
    if (recovered && (recovered.receipt.runId !== pending.jobRunId
      || recovered.receipt.sessionId !== pending.sessionId
      || recovered.receipt.sourceRevision !== pending.sourceRevision
      || recovered.receipt.provenanceDigest !== pending.proposalDigest)) {
      throw new Error('maintenance-proposal-arc-recovery-binding-mismatch');
    }
    return recovered;
  }

  #observed(summary: MaintenancePendingProposalSummary): MaintenancePendingProposalSummary {
    try {
      const proposal = this.options.manager.getPendingProposal(summary.proposalId);
      if (proposal) this.options.observeProposalTransition?.(proposal);
    } catch { /* Missing evaluation evidence is repairable; business truth already committed. */ }
    return summary;
  }

  /**
   * Publish source drift as a durable CAS transition before reporting the
   * conflict to the caller. The backup fence remains authoritative: this only
   * changes the control-plane lifecycle and never permits a stale NPC write.
   */
  #markNpcSourceRevisionStale(
    pending: MaintenancePendingProposalRecord,
  ): never {
    this.#observed(this.options.manager.markProposalStale({
      proposalId: pending.proposalId,
      expectedRevision: pending.revision,
      reason: 'source-revision-stale',
    }));
    throw new Error('maintenance-proposal-source-revision-stale');
  }

  approve(
    proposalId: string,
    expectedRevision: number,
    decisionReason: 'operator-approved' | 'guarded-auto-approved' = 'operator-approved',
    guardedAutoAudit?: GuardedNpcAutoApplyAudit,
  ): MaintenancePendingProposalSummary {
    const pending = this.options.manager.getPendingProposal(proposalId);
    if (!pending) throw new Error('maintenance-proposal-not-found');
    if (pending.revision !== expectedRevision || pending.status !== 'pending') {
      throw new Error('maintenance-proposal-revision-conflict');
    }
    if (pending.taskKind === 'memory_consolidation' || pending.taskKind === 'rolling_summary') {
      if (decisionReason !== 'operator-approved' || guardedAutoAudit) {
        throw new Error('maintenance-proposal-operator-approval-required');
      }
      if (!this.options.applyMemorySummaryProposal) {
        throw new Error('maintenance-proposal-apply-not-supported');
      }
      const committed = this.options.applyMemorySummaryProposal(pending);
      if (committed.status === 'stale') {
        return this.#observed(this.options.manager.markProposalStale({
          proposalId,
          expectedRevision,
          reason: 'source-revision-stale',
        }));
      }
      return this.#observed(this.options.manager.markProposalApplied({
        proposalId,
        expectedRevision,
        receipt: committed.receipt as Record<string, unknown>,
        rollbackAnchor: committed.rollbackAnchor as Record<string, unknown>,
        decisionReason,
      }));
    }
    if (pending.taskKind === 'npc_state') {
      // An unresolved-only proposal is diagnostic evidence, not a business-state mutation.
      // Keep it pending for explicit rejection or later replacement instead of recording a
      // misleading "applied" transition with an empty rollback anchor.
      if (isUnresolvedOnlyNpcProposal(pending.proposal.payload)) {
        throw new Error('maintenance-proposal-no-applicable-writes');
      }
      const entries = pending.proposal.payload && typeof pending.proposal.payload === 'object'
        && !Array.isArray(pending.proposal.payload)
        ? (pending.proposal.payload as { entries?: unknown }).entries : undefined;
      if (decisionReason === 'guarded-auto-approved' && Array.isArray(entries)
        && entries.some((entry) => entry && typeof entry === 'object'
          && !Array.isArray(entry) && (entry as { kind?: unknown }).kind === 'identity_resolution')) {
        throw new Error('maintenance-proposal-identity-requires-operator');
      }
      if (decisionReason === 'guarded-auto-approved' && !guardedAutoAudit) {
        throw new Error('maintenance-proposal-guarded-auto-audit-required');
      }
      if (decisionReason === 'operator-approved' && guardedAutoAudit) {
        throw new Error('maintenance-proposal-guarded-auto-audit-unexpected');
      }
      let normalizedProposalDigest: string | undefined;
      if (guardedAutoAudit) {
        try {
          normalizedProposalDigest = normalizeNpcMaintenanceProposal(
            pending.proposal.payload,
            pending.context as NpcMaintenanceProposalContext,
          ).proposalDigest;
        } catch {
          throw new Error('maintenance-proposal-guarded-auto-audit-invalid');
        }
      }
      if (guardedAutoAudit && (
        guardedAutoAudit.version !== 'npc-guarded-auto-audit-v1'
        || guardedAutoAudit.policyVersion !== NPC_APPLY_POLICY_VERSION
        || !/^sha256:[a-f0-9]{64}$/u.test(guardedAutoAudit.proposalDigest)
        || guardedAutoAudit.proposalDigest !== normalizedProposalDigest
        || !/^sha256:[a-f0-9]{64}$/u.test(guardedAutoAudit.occupiedTargetsDigest)
        || !Number.isSafeInteger(guardedAutoAudit.approvedAutoWrites)
        || guardedAutoAudit.approvedAutoWrites !== (Array.isArray(entries) ? entries.length : -1)
        || !Array.isArray(guardedAutoAudit.entryDecisions)
        || guardedAutoAudit.entryDecisions.length !== (Array.isArray(entries) ? entries.length : -1)
        || guardedAutoAudit.entryDecisions.some((entry: GuardedNpcAutoApplyAudit['entryDecisions'][number], index) => (
          !entry || typeof entry !== 'object'
          || entry.entryIndex !== index || entry.verdict !== 'auto'
          || !Array.isArray(entry.reasonCodes)
          || entry.reasonCodes.some((reason: unknown) => typeof reason !== 'string'
            || !/^[a-z][a-z0-9-]{0,79}$/u.test(reason))
        ))
        || !Array.isArray(guardedAutoAudit.reasonCodes)
        || guardedAutoAudit.reasonCodes.some((reason: unknown) => typeof reason !== 'string'
          || !/^[a-z][a-z0-9-]{0,79}$/u.test(reason))
      )) {
        throw new Error('maintenance-proposal-guarded-auto-audit-invalid');
      }
      if (!this.options.applyNpcProposal) throw new Error('maintenance-proposal-apply-not-supported');
      if (!this.options.prepareNpcApply) {
        throw new Error('maintenance-proposal-npc-backup-required');
      }
      let npcBackupAnchor: NpcMaintenanceApplyBackupAnchor;
      try {
        npcBackupAnchor = this.options.prepareNpcApply(pending);
      } catch (error) {
        if (error instanceof Error
          && error.message === 'npc-maintenance-backup-source-revision-stale') {
          this.#markNpcSourceRevisionStale(pending);
        }
        throw error;
      }
      assertNpcMaintenanceApplyBackupAnchor(npcBackupAnchor, {
        sessionId: pending.sessionId,
        sourceRevision: pending.sourceRevision,
      });
      const committed = this.options.applyNpcProposal(pending);
      if (committed.status === 'stale') {
        this.#markNpcSourceRevisionStale(pending);
      }
      if (committed.status === 'rejected') {
        throw new Error(`maintenance-proposal-npc-apply-rejected:${committed.errorCode}`);
      }
      const { rollbackAnchor, ...receipt } = committed;
      return this.#observed(this.options.manager.markProposalApplied({
        proposalId,
        expectedRevision,
        receipt: {
          ...receipt as unknown as Record<string, unknown>,
          ...(guardedAutoAudit ? { guardedAutoAudit } : {}),
          npcBackupAnchor,
        },
        rollbackAnchor: rollbackAnchor as unknown as Record<string, unknown>,
        decisionReason,
      }));
    }
    if (pending.taskKind !== 'branch_index') {
      throw new Error('maintenance-proposal-apply-not-supported');
    }
    const committer = new ArcMaintenanceCommitter(this.options.arcStore, this.options.currentRevision);
    const request = {
      runId: pending.jobRunId,
      proposal: pending.proposal.payload,
      context: pending.context as ArcMaintenanceProposalContext,
      provenanceDigest: pending.proposalDigest,
    };
    const recovered = this.#recoverArcProposal(pending);
    const committed = recovered ?? committer.commit(request);
    if (committed.status === 'stale') {
      return this.#observed(this.options.manager.markProposalStale({
        proposalId,
        expectedRevision,
        reason: committed.staleReason,
      }));
    }
    return this.#observed(this.options.manager.markProposalApplied({
      proposalId,
      expectedRevision,
      receipt: committed.receipt as unknown as Record<string, unknown>,
      rollbackAnchor: {
        runId: pending.jobRunId,
        projectionDigest: committed.receipt.projection.projectionDigest,
      },
      decisionReason: recovered ? 'crash-recovered-before-approve' : decisionReason,
    }));
  }

  /**
   * Reject only after proving that the separate business database did not
   * already commit this proposal. A recovered write is made visible as applied
   * (and therefore rollback-capable) instead of being mislabeled rejected.
   */
  reject(
    proposalId: string,
    expectedRevision: number,
    reason = 'operator-rejected',
  ): MaintenancePendingProposalSummary {
    const pending = this.options.manager.getPendingProposal(proposalId);
    if (!pending) throw new Error('maintenance-proposal-not-found');
    if (pending.revision !== expectedRevision || pending.status !== 'pending') {
      throw new Error('maintenance-proposal-revision-conflict');
    }
    if (pending.taskKind === 'npc_state' && 'allowedCharacterIds' in pending.context) {
      if (!this.options.recoverNpcProposal) {
        throw new Error('maintenance-proposal-recovery-not-supported');
      }
      const recovered = this.options.recoverNpcProposal(pending);
      if (recovered) {
        const { rollbackAnchor, ...receipt } = recovered;
        return this.#observed(this.options.manager.markProposalApplied({
          proposalId,
          expectedRevision,
          receipt: receipt as unknown as Record<string, unknown>,
          rollbackAnchor: rollbackAnchor as unknown as Record<string, unknown>,
          decisionReason: 'crash-recovered-before-reject',
        }));
      }
    }
    if ((pending.taskKind === 'memory_consolidation' || pending.taskKind === 'rolling_summary')
      && this.options.recoverMemorySummaryProposal) {
      const recovered = this.options.recoverMemorySummaryProposal(pending);
      if (recovered?.status === 'committed') {
        return this.#observed(this.options.manager.markProposalApplied({
          proposalId,
          expectedRevision,
          receipt: recovered.receipt as Record<string, unknown>,
          rollbackAnchor: recovered.rollbackAnchor as Record<string, unknown>,
          decisionReason: 'crash-recovered-before-reject',
        }));
      }
    }
    if (pending.taskKind === 'branch_index') {
      const recovered = this.#recoverArcProposal(pending);
      if (recovered) {
        return this.#observed(this.options.manager.markProposalApplied({
          proposalId, expectedRevision,
          receipt: recovered.receipt as unknown as Record<string, unknown>,
          rollbackAnchor: { runId: pending.jobRunId, projectionDigest: recovered.receipt.projection.projectionDigest },
          decisionReason: 'crash-recovered-before-reject',
        }));
      }
    }
    // Legacy proposal shapes predate the only NPC business committer and therefore
    // cannot have crossed its operation ledger; they remain directly rejectable.
    return this.#observed(this.options.manager.rejectPendingProposal({ proposalId, expectedRevision, reason }));
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
      return this.#observed(this.options.manager.markProposalRolledBack({
        proposalId,
        expectedRevision,
        receipt: rollback as unknown as Record<string, unknown>,
      }));
    }
    if (applied.taskKind === 'memory_consolidation' || applied.taskKind === 'rolling_summary') {
      if (!this.options.rollbackMemorySummaryProposal || !applied.rollbackAnchor) {
        throw new Error('maintenance-proposal-rollback-not-supported');
      }
      const rollback = this.options.rollbackMemorySummaryProposal(applied.rollbackAnchor);
      return this.#observed(this.options.manager.markProposalRolledBack({
        proposalId,
        expectedRevision,
        receipt: rollback as Record<string, unknown>,
      }));
    }
    if (applied.taskKind !== 'branch_index') {
      throw new Error('maintenance-proposal-rollback-not-supported');
    }
    const rollback = this.options.arcStore.rollbackRun(applied.jobRunId, applied.sessionId);
    return this.#observed(this.options.manager.markProposalRolledBack({
      proposalId,
      expectedRevision,
      receipt: rollback as unknown as Record<string, unknown>,
    }));
  }
}
