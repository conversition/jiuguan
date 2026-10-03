import { normalizeWorldbookRepairProposal } from '../../packages/agent-policy/src/worldbook-repair-proposal.ts';
import type {
  PublicWorldbookRepairControl,
  WorldbookRepairControlMutation,
} from '../../packages/mobile-contracts/src/agent-control.ts';
import {
  WorldbookRepairControl,
  type WorldbookRepairSummary,
} from './worldbook-repair-control.ts';
import {
  worldbookRepairForwardAllowsSession,
  type WorldbookRepairRuntimeConfig,
} from './worldbook-repair-runtime-config.ts';

export interface WorldbookRepairSessionBinding {
  readonly sessionId: string;
  readonly worldbooks: readonly string[];
}

export interface WorldbookRepairAssetChanged {
  readonly sessionId: string;
  readonly file: string;
  readonly revision: string;
}

export interface WorldbookRepairMutationResult {
  readonly control: PublicWorldbookRepairControl;
  readonly assetChanged?: WorldbookRepairAssetChanged;
}

type ResolveSessionBinding = (
  sessionId: string,
) => Promise<WorldbookRepairSessionBinding | null> | WorldbookRepairSessionBinding | null;

function publicSummary(
  summary: WorldbookRepairSummary,
  forwardAllowed: boolean,
): PublicWorldbookRepairControl {
  return Object.freeze({
    proposalId: summary.proposalId,
    file: summary.file,
    evidenceSetDigest: summary.evidenceSetDigest,
    proposalDigest: summary.proposalDigest,
    sourceRevision: summary.sourceRevision,
    ...(summary.appliedRevision ? { appliedRevision: summary.appliedRevision } : {}),
    status: summary.status,
    revision: summary.revision,
    changeCount: summary.changeCount,
    forwardAllowed,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  });
}

/**
 * Trusted control-plane adapter. The core store remains reusable/testable, but
 * every production mutation must pass exact-session runtime and asset binding
 * checks here before it can reach the filesystem.
 */
export class WorldbookRepairControlPlane {
  readonly #control: WorldbookRepairControl;
  readonly #runtime: WorldbookRepairRuntimeConfig;
  readonly #resolveSessionBinding: ResolveSessionBinding;

  constructor(input: {
    readonly control: WorldbookRepairControl;
    readonly runtime: WorldbookRepairRuntimeConfig;
    readonly resolveSessionBinding: ResolveSessionBinding;
  }) {
    this.#control = input.control;
    this.#runtime = input.runtime;
    this.#resolveSessionBinding = input.resolveSessionBinding;
  }

  list(sessionId: string, limit = 50): readonly PublicWorldbookRepairControl[] {
    const forwardAllowed = worldbookRepairForwardAllowsSession(this.#runtime, sessionId);
    return Object.freeze(this.#control.list(sessionId, limit).map((summary) => (
      publicSummary(summary, forwardAllowed)
    )));
  }

  /** Internal producer entrypoint only. No HTTP route accepts proposal bytes. */
  async create(input: { readonly operationId: string; readonly proposal: unknown }): Promise<WorldbookRepairSummary> {
    const proposal = normalizeWorldbookRepairProposal(input.proposal);
    this.#assertForwardAllowed(proposal.sessionId);
    await this.#assertBound(proposal.sessionId, proposal.file);
    return this.#control.create({ operationId: input.operationId, proposal });
  }

  async mutate(input: {
    readonly mutation: WorldbookRepairControlMutation;
    readonly trustedOperator: boolean;
  }): Promise<WorldbookRepairMutationResult> {
    if (!input.trustedOperator) throw new Error('worldbook-repair-authority-required');
    const current = this.#control.get(input.mutation.proposalId);
    if (!current) throw new Error('worldbook-repair-proposal-not-found');
    if (input.mutation.operation === 'approve-worldbook-repair'
      || input.mutation.operation === 'apply-worldbook-repair') {
      this.#assertForwardAllowed(current.sessionId);
    }
    await this.#assertBound(current.sessionId, current.file);

    if (input.mutation.operation === 'approve-worldbook-repair') {
      const control = this.#control.approve(current.proposalId, input.mutation.expectedRevision);
      return Object.freeze({
        control: publicSummary(control, worldbookRepairForwardAllowsSession(this.#runtime, control.sessionId)),
      });
    }
    if (input.mutation.operation === 'reject-worldbook-repair') {
      const control = this.#control.reject(current.proposalId, input.mutation.expectedRevision);
      return Object.freeze({
        control: publicSummary(control, worldbookRepairForwardAllowsSession(this.#runtime, control.sessionId)),
      });
    }
    if (input.mutation.operation === 'apply-worldbook-repair') {
      const control = this.#control.apply(current.proposalId, input.mutation.expectedRevision);
      if (control.status === 'stale') {
        return Object.freeze({
          control: publicSummary(control, worldbookRepairForwardAllowsSession(this.#runtime, control.sessionId)),
        });
      }
      if (!control.appliedRevision) throw new Error('worldbook-repair-applied-revision-missing');
      return Object.freeze({
        control: publicSummary(control, worldbookRepairForwardAllowsSession(this.#runtime, control.sessionId)),
        assetChanged: Object.freeze({
          sessionId: control.sessionId,
          file: control.file,
          revision: control.appliedRevision,
        }),
      });
    }
    const control = this.#control.revert(current.proposalId, input.mutation.expectedRevision);
    return Object.freeze({
      control: publicSummary(control, worldbookRepairForwardAllowsSession(this.#runtime, control.sessionId)),
      assetChanged: Object.freeze({
        sessionId: control.sessionId,
        file: control.file,
        revision: control.sourceRevision,
      }),
    });
  }

  #assertForwardAllowed(sessionId: string): void {
    if (!worldbookRepairForwardAllowsSession(this.#runtime, sessionId)) {
      throw new Error('worldbook-repair-forward-disabled');
    }
  }

  async #assertBound(sessionId: string, file: string): Promise<void> {
    const binding = await this.#resolveSessionBinding(sessionId);
    if (!binding) throw new Error('worldbook-repair-session-not-found');
    if (binding.sessionId !== sessionId) throw new Error('worldbook-repair-session-conflict');
    const normalized = new Set(binding.worldbooks.map((item) => item.normalize('NFC')));
    if (!normalized.has(file.normalize('NFC'))) {
      throw new Error('worldbook-repair-worldbook-not-bound');
    }
  }
}
