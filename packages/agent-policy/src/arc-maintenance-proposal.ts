import { createHash } from 'node:crypto';
import { arcProjectionIdForName } from './arc-projection.ts';

export const ARC_MAINTENANCE_PROPOSAL_VERSION = 'arc-maintenance-proposal-v1' as const;
export type ArcMaintenanceStatus = 'open' | 'dormant' | 'closed';
export type ArcMaintenanceAction =
  | {
    readonly kind: 'set_status';
    readonly arcId: string;
    readonly status: ArcMaintenanceStatus;
    readonly sourceRefs: readonly string[];
  }
  | {
    readonly kind: 'merge';
    readonly arcIds: readonly string[];
    readonly targetArcId: string;
    readonly sourceRefs: readonly string[];
  }
  | {
    readonly kind: 'chapter_boundary';
    readonly arcIds: readonly string[];
    readonly boundaryRound: number;
    readonly sourceRefs: readonly string[];
  }
  | {
    readonly kind: 'order_dependencies';
    readonly arcId: string;
    readonly dependencyArcIds: readonly string[];
    readonly sourceRefs: readonly string[];
  }
  | {
    readonly kind: 'mark_source_conflict';
    readonly arcIds: readonly string[];
    readonly sourceRefs: readonly string[];
  };

export interface ArcMaintenanceProposal {
  readonly version: typeof ARC_MAINTENANCE_PROPOSAL_VERSION;
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly actions: readonly ArcMaintenanceAction[];
  readonly proposalDigest: string;
}

/**
 * Value-minimized Arc state captured from the learning projection at the same
 * fixed snapshot as a Maintenance proposal. It gives the model and approval
 * surface a stable ID/status join without putting narrative text back into the
 * central learning ledger.
 */
export interface ArcMaintenanceEvidenceBinding {
  readonly arcId: string;
  readonly status: ArcMaintenanceStatus;
  readonly firstRound: number;
  readonly lastRound: number;
  readonly evidenceCount: number;
  readonly latestSourceRevision: string;
}

/** Local-only display material. The title must hash back to arcId exactly. */
export interface ArcMaintenanceReviewDescriptor {
  readonly arcId: string;
  readonly title: string;
  readonly currentStage: string;
  readonly nextMilestone: string;
  readonly lastRound: number;
  readonly sourceRevision: string;
}

export interface ArcMaintenanceProposalContext {
  readonly sessionId: string;
  readonly sourceRevision: string;
  /**
   * Digest of the disposable Arc overlay captured with this proposal. Optional
   * only for legacy persisted proposals, which are not apply-capable without
   * this CAS binding.
   */
  readonly arcProjectionDigest?: string;
  readonly allowedArcIds: readonly string[];
  readonly allowedSourceRefs: readonly string[];
  readonly maxRound: number;
  /** Optional only for persisted proposals created before the readable-review contract. */
  readonly arcEvidence?: readonly ArcMaintenanceEvidenceBinding[];
  /** Subset of arcEvidence with an exact session-local human-readable binding. */
  readonly arcReviewDescriptors?: readonly ArcMaintenanceReviewDescriptor[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARC_ID = /^arc:sha256:[a-f0-9]{64}$/u;
const STATUS = new Set<ArcMaintenanceStatus>(['open', 'dormant', 'closed']);
const MAX_ACTIONS = 32;

/**
 * Stable, value-free rejection reasons safe to return to the maintenance model.
 * Never include an arc id, source ref, revision, or proposal value in these codes.
 */
export type ArcMaintenanceProposalRejectionCode =
  | 'proposal-shape-invalid'
  | 'proposal-context-invalid'
  | 'proposal-binding-mismatch'
  | 'proposal-field-invalid'
  | 'proposal-duplicate-target'
  | 'source-ref-not-allowed'
  | 'source-ref-duplicate';

export class ArcMaintenanceProposalRejectedError extends TypeError {
  readonly name = 'ArcMaintenanceProposalRejectedError';

  constructor(
    readonly rejectionCode: ArcMaintenanceProposalRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

export function arcMaintenanceProposalRejectionCode(
  error: unknown,
): ArcMaintenanceProposalRejectionCode | undefined {
  return error instanceof ArcMaintenanceProposalRejectedError
    ? error.rejectionCode
    : undefined;
}

function reject(
  rejectionCode: ArcMaintenanceProposalRejectionCode,
  message: string,
): never {
  throw new ArcMaintenanceProposalRejectedError(rejectionCode, message);
}

function plain(
  value: unknown,
  label: string,
  rejectionCode: ArcMaintenanceProposalRejectionCode = 'proposal-shape-invalid',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(rejectionCode, label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject(rejectionCode, label + ' must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject('proposal-shape-invalid', label + ' has unsupported or missing fields');
  }
}

function stableList(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  minimum = 1,
  maximum = 32,
  invalidCode: ArcMaintenanceProposalRejectionCode = 'proposal-field-invalid',
  duplicateCode: ArcMaintenanceProposalRejectionCode = 'proposal-duplicate-target',
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    reject(invalidCode, label + ' contains an unknown or invalid reference');
  }
  const normalized = [...new Set(value as string[])].sort();
  if (normalized.length !== value.length) {
    reject(duplicateCode, label + ' contains duplicate references');
  }
  return Object.freeze(normalized);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).sort().map((key) => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
}

function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function normalizeContext(input: ArcMaintenanceProposalContext): {
  sessionId: string;
  sourceRevision: string;
  arcIds: ReadonlySet<string>;
  sourceRefs: ReadonlySet<string>;
  maxRound: number;
  currentStatuses: ReadonlyMap<string, ArcMaintenanceStatus>;
} {
  if (!TOKEN.test(input.sessionId) || !DIGEST.test(input.sourceRevision)
    || (input.arcProjectionDigest !== undefined && !DIGEST.test(input.arcProjectionDigest))
    || !Number.isSafeInteger(input.maxRound) || input.maxRound < 1) {
    reject('proposal-context-invalid', 'arc maintenance context is invalid');
  }
  if (!Array.isArray(input.allowedArcIds) || input.allowedArcIds.length < 1 || input.allowedArcIds.length > 64
    || new Set(input.allowedArcIds).size !== input.allowedArcIds.length
    || input.allowedArcIds.some((item) => !ARC_ID.test(item))) {
    reject('proposal-context-invalid', 'allowedArcIds is invalid');
  }
  if (!Array.isArray(input.allowedSourceRefs) || input.allowedSourceRefs.length < 1
    || input.allowedSourceRefs.length > 128 || new Set(input.allowedSourceRefs).size !== input.allowedSourceRefs.length
    || input.allowedSourceRefs.some((item) => !TOKEN.test(item))) {
    reject('proposal-context-invalid', 'allowedSourceRefs is invalid');
  }
  const currentStatuses = new Map<string, ArcMaintenanceStatus>();
  if (input.arcEvidence !== undefined) {
    if (input.arcProjectionDigest === undefined) {
      reject('proposal-context-invalid', 'arcEvidence requires an Arc projection CAS digest');
    }
    if (!Array.isArray(input.arcEvidence)
      || input.arcEvidence.length !== input.allowedArcIds.length
      || input.arcEvidence.length > 64) {
      reject('proposal-context-invalid', 'arcEvidence is incomplete');
    }
    for (const value of input.arcEvidence) {
      const row = plain(value, 'arcEvidence row', 'proposal-context-invalid');
      exact(row, [
        'arcId', 'status', 'firstRound', 'lastRound', 'evidenceCount', 'latestSourceRevision',
      ], 'arcEvidence row');
      if (typeof row.arcId !== 'string' || !input.allowedArcIds.includes(row.arcId)
        || typeof row.status !== 'string' || !STATUS.has(row.status as ArcMaintenanceStatus)
        || !Number.isSafeInteger(row.firstRound) || Number(row.firstRound) < 1
        || !Number.isSafeInteger(row.lastRound) || Number(row.lastRound) < Number(row.firstRound)
        || Number(row.lastRound) > input.maxRound
        || !Number.isSafeInteger(row.evidenceCount) || Number(row.evidenceCount) < 1
        || typeof row.latestSourceRevision !== 'string' || !TOKEN.test(row.latestSourceRevision)
        || currentStatuses.has(row.arcId)) {
        reject('proposal-context-invalid', 'arcEvidence row is invalid');
      }
      currentStatuses.set(row.arcId, row.status as ArcMaintenanceStatus);
    }
    if (currentStatuses.size !== input.allowedArcIds.length) {
      reject('proposal-context-invalid', 'arcEvidence does not cover allowedArcIds');
    }
  }
  if (input.arcReviewDescriptors !== undefined) {
    if (!Array.isArray(input.arcReviewDescriptors) || input.arcReviewDescriptors.length > 64
      || input.arcEvidence === undefined) {
      reject('proposal-context-invalid', 'arcReviewDescriptors is invalid');
    }
    const descriptorKeys = new Set<string>();
    for (const value of input.arcReviewDescriptors) {
      const row = plain(value, 'arcReviewDescriptor', 'proposal-context-invalid');
      exact(row, [
        'arcId', 'title', 'currentStage', 'nextMilestone', 'lastRound', 'sourceRevision',
      ], 'arcReviewDescriptor');
      const key = `${String(row.arcId)}\0${String(row.sourceRevision)}`;
      const evidence = input.arcEvidence.find((candidate) => candidate.arcId === row.arcId);
      if (typeof row.arcId !== 'string' || !input.allowedArcIds.includes(row.arcId)
        || typeof row.title !== 'string' || row.title.length < 1 || [...row.title].length > 240
        || arcProjectionIdForName(row.title) !== row.arcId
        || typeof row.currentStage !== 'string' || [...row.currentStage].length > 240
        || typeof row.nextMilestone !== 'string' || [...row.nextMilestone].length > 240
        || !Number.isSafeInteger(row.lastRound) || Number(row.lastRound) < 1
        || typeof row.sourceRevision !== 'string' || !TOKEN.test(row.sourceRevision)
        || evidence?.latestSourceRevision !== row.sourceRevision
        || evidence.lastRound !== row.lastRound
        || descriptorKeys.has(key)) {
        reject('proposal-context-invalid', 'arcReviewDescriptor is not exactly bound');
      }
      descriptorKeys.add(key);
    }
  }
  return {
    sessionId: input.sessionId,
    sourceRevision: input.sourceRevision,
    arcIds: new Set(input.allowedArcIds),
    sourceRefs: new Set(input.allowedSourceRefs),
    maxRound: input.maxRound,
    currentStatuses,
  };
}

export function normalizeArcMaintenanceProposal(
  value: unknown,
  inputContext: ArcMaintenanceProposalContext,
): ArcMaintenanceProposal {
  const context = normalizeContext(inputContext);
  const proposal = plain(value, 'arc maintenance proposal');
  exact(proposal, ['version', 'sessionId', 'sourceRevision', 'actions'], 'arc maintenance proposal');
  if (proposal.version !== ARC_MAINTENANCE_PROPOSAL_VERSION
    || proposal.sessionId !== context.sessionId
    || proposal.sourceRevision !== context.sourceRevision
    || !Array.isArray(proposal.actions)
    || proposal.actions.length < 1
    || proposal.actions.length > MAX_ACTIONS) {
    reject('proposal-binding-mismatch', 'arc maintenance proposal binding is invalid');
  }

  const actions = proposal.actions.map((raw, index): ArcMaintenanceAction => {
    const row = plain(raw, 'arc action ' + index);
    const kind = row.kind;
    if (kind === 'set_status') {
      exact(row, ['kind', 'arcId', 'status', 'sourceRefs'], 'set_status');
      if (typeof row.arcId !== 'string' || !context.arcIds.has(row.arcId)
        || typeof row.status !== 'string' || !STATUS.has(row.status as ArcMaintenanceStatus)) {
        reject('proposal-field-invalid', 'set_status contains an invalid arc or status');
      }
      if (context.currentStatuses.get(row.arcId) === row.status) {
        reject('proposal-field-invalid', 'set_status must change the current Arc status');
      }
      return Object.freeze({
        kind,
        arcId: row.arcId,
        status: row.status as ArcMaintenanceStatus,
        sourceRefs: stableList(
          row.sourceRefs, context.sourceRefs, 'set_status sourceRefs', 1, 32,
          'source-ref-not-allowed', 'source-ref-duplicate',
        ),
      });
    }
    if (kind === 'merge') {
      exact(row, ['kind', 'arcIds', 'targetArcId', 'sourceRefs'], 'merge');
      const arcIds = stableList(row.arcIds, context.arcIds, 'merge arcIds', 2, 8);
      if (typeof row.targetArcId !== 'string' || !arcIds.includes(row.targetArcId)) {
        reject('proposal-field-invalid', 'merge targetArcId must be one of arcIds');
      }
      return Object.freeze({
        kind,
        arcIds,
        targetArcId: row.targetArcId,
        sourceRefs: stableList(
          row.sourceRefs, context.sourceRefs, 'merge sourceRefs', 1, 32,
          'source-ref-not-allowed', 'source-ref-duplicate',
        ),
      });
    }
    if (kind === 'chapter_boundary') {
      exact(row, ['kind', 'arcIds', 'boundaryRound', 'sourceRefs'], 'chapter_boundary');
      if (!Number.isSafeInteger(row.boundaryRound) || (row.boundaryRound as number) < 1
        || (row.boundaryRound as number) > context.maxRound) {
        reject('proposal-field-invalid', 'chapter_boundary round is invalid');
      }
      return Object.freeze({
        kind,
        arcIds: stableList(row.arcIds, context.arcIds, 'chapter_boundary arcIds', 1, 8),
        boundaryRound: row.boundaryRound as number,
        sourceRefs: stableList(
          row.sourceRefs, context.sourceRefs, 'chapter_boundary sourceRefs', 1, 32,
          'source-ref-not-allowed', 'source-ref-duplicate',
        ),
      });
    }
    if (kind === 'order_dependencies') {
      exact(row, ['kind', 'arcId', 'dependencyArcIds', 'sourceRefs'], 'order_dependencies');
      if (typeof row.arcId !== 'string' || !context.arcIds.has(row.arcId)) {
        reject('proposal-field-invalid', 'order_dependencies arcId is invalid');
      }
      const dependencies = stableList(
        row.dependencyArcIds,
        context.arcIds,
        'order_dependencies dependencyArcIds',
        1,
        16,
      );
      if (dependencies.includes(row.arcId)) {
        reject('proposal-field-invalid', 'arc cannot depend on itself');
      }
      return Object.freeze({
        kind,
        arcId: row.arcId,
        dependencyArcIds: dependencies,
        sourceRefs: stableList(
          row.sourceRefs, context.sourceRefs, 'order_dependencies sourceRefs', 1, 32,
          'source-ref-not-allowed', 'source-ref-duplicate',
        ),
      });
    }
    if (kind === 'mark_source_conflict') {
      exact(row, ['kind', 'arcIds', 'sourceRefs'], 'mark_source_conflict');
      return Object.freeze({
        kind,
        arcIds: stableList(row.arcIds, context.arcIds, 'mark_source_conflict arcIds', 1, 8),
        sourceRefs: stableList(
          row.sourceRefs, context.sourceRefs, 'mark_source_conflict sourceRefs', 2, 32,
          'source-ref-not-allowed', 'source-ref-duplicate',
        ),
      });
    }
    reject('proposal-field-invalid', 'arc action kind is invalid');
  });

  const normalizedActions = actions
    .map((action) => ({ action, key: canonical(action) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(normalizedActions.map((entry) => entry.key)).size !== normalizedActions.length) {
    reject('proposal-duplicate-target', 'arc maintenance proposal contains duplicate actions');
  }
  const normalized = Object.freeze({
    version: ARC_MAINTENANCE_PROPOSAL_VERSION,
    sessionId: context.sessionId,
    sourceRevision: context.sourceRevision,
    actions: Object.freeze(normalizedActions.map((entry) => entry.action)),
  });
  return Object.freeze({ ...normalized, proposalDigest: digest(normalized) });
}
