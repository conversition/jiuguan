import { createHash } from 'node:crypto';

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

export interface ArcMaintenanceProposalContext {
  readonly sessionId: string;
  readonly sourceRevision: string;
  readonly allowedArcIds: readonly string[];
  readonly allowedSourceRefs: readonly string[];
  readonly maxRound: number;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARC_ID = /^arc:sha256:[a-f0-9]{64}$/u;
const STATUS = new Set<ArcMaintenanceStatus>(['open', 'dormant', 'closed']);
const MAX_ACTIONS = 32;

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + ' must be a plain object');
  }
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(label + ' has unsupported or missing fields');
  }
}

function stableList(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  minimum = 1,
  maximum = 32,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    throw new TypeError(label + ' contains an unknown or invalid reference');
  }
  const normalized = [...new Set(value as string[])].sort();
  if (normalized.length !== value.length) throw new TypeError(label + ' contains duplicate references');
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
} {
  if (!TOKEN.test(input.sessionId) || !DIGEST.test(input.sourceRevision)
    || !Number.isSafeInteger(input.maxRound) || input.maxRound < 1) {
    throw new TypeError('arc maintenance context is invalid');
  }
  if (!Array.isArray(input.allowedArcIds) || input.allowedArcIds.length < 1 || input.allowedArcIds.length > 64
    || new Set(input.allowedArcIds).size !== input.allowedArcIds.length
    || input.allowedArcIds.some((item) => !ARC_ID.test(item))) {
    throw new TypeError('allowedArcIds is invalid');
  }
  if (!Array.isArray(input.allowedSourceRefs) || input.allowedSourceRefs.length < 1
    || input.allowedSourceRefs.length > 128 || new Set(input.allowedSourceRefs).size !== input.allowedSourceRefs.length
    || input.allowedSourceRefs.some((item) => !TOKEN.test(item))) {
    throw new TypeError('allowedSourceRefs is invalid');
  }
  return {
    sessionId: input.sessionId,
    sourceRevision: input.sourceRevision,
    arcIds: new Set(input.allowedArcIds),
    sourceRefs: new Set(input.allowedSourceRefs),
    maxRound: input.maxRound,
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
    throw new TypeError('arc maintenance proposal binding is invalid');
  }

  const actions = proposal.actions.map((raw, index): ArcMaintenanceAction => {
    const row = plain(raw, 'arc action ' + index);
    const kind = row.kind;
    if (kind === 'set_status') {
      exact(row, ['kind', 'arcId', 'status', 'sourceRefs'], 'set_status');
      if (typeof row.arcId !== 'string' || !context.arcIds.has(row.arcId)
        || typeof row.status !== 'string' || !STATUS.has(row.status as ArcMaintenanceStatus)) {
        throw new TypeError('set_status contains an invalid arc or status');
      }
      return Object.freeze({
        kind,
        arcId: row.arcId,
        status: row.status as ArcMaintenanceStatus,
        sourceRefs: stableList(row.sourceRefs, context.sourceRefs, 'set_status sourceRefs'),
      });
    }
    if (kind === 'merge') {
      exact(row, ['kind', 'arcIds', 'targetArcId', 'sourceRefs'], 'merge');
      const arcIds = stableList(row.arcIds, context.arcIds, 'merge arcIds', 2, 8);
      if (typeof row.targetArcId !== 'string' || !arcIds.includes(row.targetArcId)) {
        throw new TypeError('merge targetArcId must be one of arcIds');
      }
      return Object.freeze({
        kind,
        arcIds,
        targetArcId: row.targetArcId,
        sourceRefs: stableList(row.sourceRefs, context.sourceRefs, 'merge sourceRefs'),
      });
    }
    if (kind === 'chapter_boundary') {
      exact(row, ['kind', 'arcIds', 'boundaryRound', 'sourceRefs'], 'chapter_boundary');
      if (!Number.isSafeInteger(row.boundaryRound) || (row.boundaryRound as number) < 1
        || (row.boundaryRound as number) > context.maxRound) {
        throw new TypeError('chapter_boundary round is invalid');
      }
      return Object.freeze({
        kind,
        arcIds: stableList(row.arcIds, context.arcIds, 'chapter_boundary arcIds', 1, 8),
        boundaryRound: row.boundaryRound as number,
        sourceRefs: stableList(row.sourceRefs, context.sourceRefs, 'chapter_boundary sourceRefs'),
      });
    }
    if (kind === 'order_dependencies') {
      exact(row, ['kind', 'arcId', 'dependencyArcIds', 'sourceRefs'], 'order_dependencies');
      if (typeof row.arcId !== 'string' || !context.arcIds.has(row.arcId)) {
        throw new TypeError('order_dependencies arcId is invalid');
      }
      const dependencies = stableList(
        row.dependencyArcIds,
        context.arcIds,
        'order_dependencies dependencyArcIds',
        1,
        16,
      );
      if (dependencies.includes(row.arcId)) throw new TypeError('arc cannot depend on itself');
      return Object.freeze({
        kind,
        arcId: row.arcId,
        dependencyArcIds: dependencies,
        sourceRefs: stableList(row.sourceRefs, context.sourceRefs, 'order_dependencies sourceRefs'),
      });
    }
    if (kind === 'mark_source_conflict') {
      exact(row, ['kind', 'arcIds', 'sourceRefs'], 'mark_source_conflict');
      return Object.freeze({
        kind,
        arcIds: stableList(row.arcIds, context.arcIds, 'mark_source_conflict arcIds', 1, 8),
        sourceRefs: stableList(row.sourceRefs, context.sourceRefs, 'mark_source_conflict sourceRefs', 2, 32),
      });
    }
    throw new TypeError('arc action kind is invalid');
  });

  const normalizedActions = actions
    .map((action) => ({ action, key: canonical(action) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(normalizedActions.map((entry) => entry.key)).size !== normalizedActions.length) {
    throw new TypeError('arc maintenance proposal contains duplicate actions');
  }
  const normalized = Object.freeze({
    version: ARC_MAINTENANCE_PROPOSAL_VERSION,
    sessionId: context.sessionId,
    sourceRevision: context.sourceRevision,
    actions: Object.freeze(normalizedActions.map((entry) => entry.action)),
  });
  return Object.freeze({ ...normalized, proposalDigest: digest(normalized) });
}
