import {
  normalizeNpcMaintenanceProposal,
  type NpcMaintenanceFactEntry,
  type NpcMaintenanceProposalContext,
  type NpcMaintenanceRelationshipEntry,
} from '../../packages/agent-policy/src/npc-maintenance-proposal.ts';
import type {
  AdmitResult,
  CharacterCandidate,
  CharacterChangeCandidate,
  CharacterMaintenanceRollbackAnchor,
  CharacterMaintenanceRollbackResult,
  CharacterRelationshipCandidate,
  CharacterStore,
  FactKind,
  FactScope,
  PredecessorRef,
  SourceRef,
} from '../../packages/memory/src/character.ts';
import { StateVersionConflictError } from '../../packages/memory/src/state-store.ts';

export interface NpcMaintenanceCommitRequest {
  readonly runId: string;
  readonly proposal: unknown;
  readonly context: NpcMaintenanceProposalContext;
  readonly provenanceDigest: string;
  readonly instanceId: string;
  readonly historyEpoch: number;
  readonly predecessor: PredecessorRef;
}

export interface NpcMaintenanceCharacterReceipt {
  readonly characterId: string;
  readonly operationId: string;
  readonly ok: boolean;
  readonly deduped: boolean;
  readonly entityVersion?: number;
  readonly applied: readonly string[];
  readonly recordedHistory: readonly string[];
  readonly rejected: readonly { readonly field: string; readonly reason: string }[];
  readonly errorCode?: string;
}

export const NPC_MAINTENANCE_ROLLBACK_VERSION = 'npc-maintenance-rollback-v1' as const;

export interface NpcMaintenanceRollbackAnchor {
  readonly version: typeof NPC_MAINTENANCE_ROLLBACK_VERSION;
  readonly runId: string;
  readonly sessionId: string;
  readonly proposalDigest: string;
  readonly characters: readonly CharacterMaintenanceRollbackAnchor[];
}

export interface NpcMaintenanceRollbackReceipt extends CharacterMaintenanceRollbackResult {
  readonly status: 'rolled_back';
  readonly runId: string;
  readonly sessionId: string;
  readonly proposalDigest: string;
}

export type NpcMaintenanceCommitResult =
  | {
    readonly status: 'committed';
    readonly runId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly proposalDigest: string;
    readonly provenanceDigest: string;
    readonly unresolvedCount: number;
    readonly characters: readonly NpcMaintenanceCharacterReceipt[];
    readonly rollbackAnchor: NpcMaintenanceRollbackAnchor;
  }
  | {
    readonly status: 'rejected';
    readonly runId: string;
    readonly sessionId: string;
    readonly sourceRevision: string;
    readonly proposalDigest: string;
    readonly provenanceDigest: string;
    readonly characterWrites: 0;
    readonly rejectedCharacterId: string;
    readonly errorCode: string;
  }
  | { readonly status: 'stale'; readonly actualRevision: string; readonly characterWrites: 0 };

export interface NpcMaintenanceCommitterOptions {
  readonly characters: CharacterStore;
  readonly currentRevision: (sessionId: string) => string;
  /** Resolve only source tokens already admitted by the fixed snapshot context. */
  readonly resolveSourceRef: (sessionId: string, sourceRef: string) => SourceRef | null;
  /** One SQLite transaction shared by CharacterStore, StateStore, logs and mirrors. */
  readonly transaction: <T>(work: () => T) => T;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function validSourceRef(value: SourceRef): boolean {
  return ['message', 'am', 'lore', 'card', 'user'].includes(value.source)
    && typeof value.recordId === 'string' && value.recordId.length > 0 && value.recordId.length <= 240
    && (value.recordVersion === undefined
      || (Number.isSafeInteger(value.recordVersion) && value.recordVersion >= 1));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function normalizeRollbackAnchor(value: unknown): NpcMaintenanceRollbackAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('npc-maintenance-rollback-anchor-invalid');
  }
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['version', 'runId', 'sessionId', 'proposalDigest', 'characters'])
    || row.version !== NPC_MAINTENANCE_ROLLBACK_VERSION
    || typeof row.runId !== 'string' || !TOKEN_RE.test(row.runId)
    || typeof row.sessionId !== 'string' || !TOKEN_RE.test(row.sessionId)
    || typeof row.proposalDigest !== 'string' || !DIGEST_RE.test(row.proposalDigest)
    || !Array.isArray(row.characters) || row.characters.length > 64) {
    throw new Error('npc-maintenance-rollback-anchor-invalid');
  }
  const characters = row.characters.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('npc-maintenance-rollback-anchor-invalid');
    }
    const anchor = value as Record<string, unknown>;
    if (!exactKeys(anchor, [
      'characterId', 'operationId', 'beforeEntityVersion', 'appliedEntityVersion',
      'beforeFactLogCount', 'beforeProjectionDigest',
    ])
      || typeof anchor.characterId !== 'string' || !TOKEN_RE.test(anchor.characterId)
      || anchor.operationId !== `maintenance:${row.runId}:npc:${anchor.characterId}`
      || !Number.isSafeInteger(anchor.beforeEntityVersion) || Number(anchor.beforeEntityVersion) < 0
      || !Number.isSafeInteger(anchor.appliedEntityVersion) || Number(anchor.appliedEntityVersion) < 1
      || Number(anchor.appliedEntityVersion) !== Number(anchor.beforeEntityVersion) + 1
      || !Number.isSafeInteger(anchor.beforeFactLogCount) || Number(anchor.beforeFactLogCount) < 0
      || typeof anchor.beforeProjectionDigest !== 'string'
      || !DIGEST_RE.test(anchor.beforeProjectionDigest)) {
      throw new Error('npc-maintenance-rollback-anchor-invalid');
    }
    return Object.freeze({
      characterId: anchor.characterId,
      operationId: anchor.operationId,
      beforeEntityVersion: Number(anchor.beforeEntityVersion),
      appliedEntityVersion: Number(anchor.appliedEntityVersion),
      beforeFactLogCount: Number(anchor.beforeFactLogCount),
      beforeProjectionDigest: anchor.beforeProjectionDigest,
    });
  });
  if (new Set(characters.map((item) => item.characterId)).size !== characters.length) {
    throw new Error('npc-maintenance-rollback-anchor-invalid');
  }
  return Object.freeze({
    version: NPC_MAINTENANCE_ROLLBACK_VERSION,
    runId: row.runId,
    sessionId: row.sessionId,
    proposalDigest: row.proposalDigest,
    characters: Object.freeze(characters),
  });
}

function factSemantics(entry: NpcMaintenanceFactEntry): {
  scope: FactScope;
  field: string;
  factKind: FactKind;
} {
  if (entry.kind === 'profile') return {
    scope: 'profile', field: entry.field,
    factKind: entry.confidence === 'high' ? 'fact' : 'hypothesis',
  };
  if (entry.kind === 'objective_fact') return { scope: 'fact', field: entry.field, factKind: 'fact' };
  if (entry.kind === 'belief') return { scope: 'fact', field: `belief.${entry.field}`, factKind: 'hypothesis' };
  if (entry.kind === 'knowledge') return {
    scope: 'fact', field: `knowledge.${entry.field}`,
    factKind: entry.confidence === 'high' ? 'fact' : 'hypothesis',
  };
  if (entry.kind === 'secret') return {
    scope: 'fact', field: `secret.${entry.field}`,
    factKind: entry.confidence === 'high' ? 'fact' : 'hypothesis',
  };
  if (entry.kind === 'goal') return { scope: 'fact', field: `goal.${entry.field}`, factKind: 'plan' };
  return { scope: 'fact', field: `history.${entry.field}`, factKind: 'recall' };
}

type NormalizedNpcProposal = ReturnType<typeof normalizeNpcMaintenanceProposal>;

interface NpcCharacterBucket {
  expectedVersion: number;
  maxRound: number;
  changes: CharacterChangeCandidate[];
  relationships: CharacterRelationshipCandidate[];
}

function proposalBuckets(
  proposal: NormalizedNpcProposal,
  resolveMany: (tokens: readonly string[]) => SourceRef[],
): { readonly byCharacter: Map<string, NpcCharacterBucket>; readonly unresolvedCount: number } {
  const byCharacter = new Map<string, NpcCharacterBucket>();
  let unresolvedCount = 0;
  for (const entry of proposal.entries) {
    if (entry.kind === 'unresolved') { unresolvedCount += 1; continue; }
    const bucket = byCharacter.get(entry.characterId) ?? {
      expectedVersion: entry.expectedEntityVersion,
      maxRound: entry.effectiveRound,
      changes: [],
      relationships: [],
    };
    bucket.maxRound = Math.max(bucket.maxRound, entry.effectiveRound);
    if (entry.kind === 'relationship') {
      const relationship = entry as NpcMaintenanceRelationshipEntry;
      bucket.relationships.push({
        relationshipId: `rel_${relationship.characterId}_${relationship.toCharacterId}_${relationship.relationType}`,
        fromCharacterId: relationship.characterId,
        toCharacterId: relationship.toCharacterId,
        type: relationship.relationType,
        perspective: relationship.perspective,
        status: relationship.status,
        factKind: relationship.perspective === 'objective' ? 'fact' : 'hypothesis',
        effectiveAt: { round: relationship.effectiveRound },
        sourceRefs: resolveMany(relationship.sourceRefs),
      });
    } else {
      const semantics = factSemantics(entry);
      bucket.changes.push({
        field: semantics.field,
        scope: semantics.scope,
        value: structuredClone(entry.value),
        factKind: semantics.factKind,
        status: entry.status,
        effectiveAt: { round: entry.effectiveRound },
        sourceRefs: resolveMany(entry.sourceRefs),
      });
    }
    byCharacter.set(entry.characterId, bucket);
  }
  return { byCharacter, unresolvedCount };
}

function bucketCandidate(characterId: string, bucket: NpcCharacterBucket): CharacterCandidate {
  return {
    characterId,
    changes: bucket.changes,
    relationships: bucket.relationships,
  };
}

function characterReceipt(result: AdmitResult, characterId: string, operationId: string): NpcMaintenanceCharacterReceipt {
  return Object.freeze({
    characterId,
    operationId,
    ok: result.ok,
    deduped: result.receipt.deduped === true,
    ...(result.entityVersion === undefined ? {} : { entityVersion: result.entityVersion }),
    applied: Object.freeze([...result.applied]),
    recordedHistory: Object.freeze([...result.recordedHistory]),
    rejected: Object.freeze(result.rejected.map((entry) => Object.freeze({ ...entry }))),
    ...(result.error ? { errorCode: result.error.name } : {}),
  });
}

class NpcMaintenanceBatchRejected extends Error {
  constructor(readonly receipt: NpcMaintenanceCharacterReceipt) {
    super('npc-maintenance-batch-rejected');
  }
}

class NpcMaintenanceBatchStale extends Error {
  constructor(readonly actualRevision: string) {
    super('npc-maintenance-batch-stale');
  }
}

/** Convert strict NPC typed entries into CharacterStore candidates; no direct state writes exist here. */
export class NpcMaintenanceCommitter {
  constructor(private readonly options: NpcMaintenanceCommitterOptions) {}

  /**
   * Recover a proposal whose CharacterStore transaction committed before the
   * separate control DB persisted its receipt. This path is read-only: every
   * expected operation must already exist and match the normalized candidate,
   * otherwise it either returns null (none applied) or fails closed (partial).
   */
  recoverApplied(
    input: Pick<NpcMaintenanceCommitRequest, 'runId' | 'proposal' | 'context' | 'provenanceDigest'>,
  ): NpcMaintenanceCommitResult | null {
    if (!TOKEN_RE.test(input.runId) || !DIGEST_RE.test(input.provenanceDigest)) {
      throw new Error('npc-maintenance-commit-binding-invalid');
    }
    const proposal = normalizeNpcMaintenanceProposal(input.proposal, input.context);
    const { byCharacter, unresolvedCount } = proposalBuckets(proposal, () => []);
    if (byCharacter.size === 0) return null;
    return this.options.transaction(() => {
      const recovered = [...byCharacter.keys()].sort().map((characterId) => {
        const bucket = byCharacter.get(characterId)!;
        const operationId = `maintenance:${input.runId}:npc:${characterId}`;
        const candidate = bucketCandidate(characterId, bucket);
        const appliedEntityVersion = this.options.characters.maintenanceAppliedOperationVersion(
          proposal.sessionId,
          characterId,
          operationId,
          candidate,
        );
        return { characterId, bucket, operationId, appliedEntityVersion };
      });
      if (recovered.every((item) => item.appliedEntityVersion === null)) return null;
      if (recovered.some((item) => item.appliedEntityVersion === null)) {
        throw new Error('npc-maintenance-operation-replay-partial');
      }
      const characters = recovered.map((item): NpcMaintenanceCharacterReceipt => Object.freeze({
        characterId: item.characterId,
        operationId: item.operationId,
        ok: true,
        deduped: true,
        entityVersion: item.appliedEntityVersion!,
        applied: Object.freeze([]),
        recordedHistory: Object.freeze([]),
        rejected: Object.freeze([]),
      }));
      const anchors = recovered.map((item) => (
        this.options.characters.maintenanceRollbackAnchorForAppliedOperation(
          proposal.sessionId,
          item.characterId,
          item.operationId,
          item.bucket.expectedVersion,
          item.appliedEntityVersion!,
        )
      ));
      return Object.freeze({
        status: 'committed' as const,
        runId: input.runId,
        sessionId: proposal.sessionId,
        sourceRevision: proposal.sourceRevision,
        proposalDigest: proposal.proposalDigest,
        provenanceDigest: input.provenanceDigest,
        unresolvedCount,
        characters: Object.freeze(characters),
        rollbackAnchor: Object.freeze({
          version: NPC_MAINTENANCE_ROLLBACK_VERSION,
          runId: input.runId,
          sessionId: proposal.sessionId,
          proposalDigest: proposal.proposalDigest,
          characters: Object.freeze(anchors),
        }),
      });
    });
  }

  commit(input: NpcMaintenanceCommitRequest): NpcMaintenanceCommitResult {
    if (!TOKEN_RE.test(input.runId) || !TOKEN_RE.test(input.instanceId)
      || !DIGEST_RE.test(input.provenanceDigest)
      || !Number.isSafeInteger(input.historyEpoch) || input.historyEpoch < 0) {
      throw new Error('npc-maintenance-commit-binding-invalid');
    }
    const recovered = this.recoverApplied(input);
    if (recovered) return recovered;
    const proposal = normalizeNpcMaintenanceProposal(input.proposal, input.context);
    let actualRevision = this.options.currentRevision(proposal.sessionId);
    if (actualRevision !== proposal.sourceRevision) {
      return { status: 'stale', actualRevision, characterWrites: 0 };
    }

    // Resolve every source before the first CharacterStore write. A bad provenance map is all-or-nothing.
    const sourceRefs = new Map<string, SourceRef>();
    for (const token of input.context.allowedSourceRefs) {
      const resolved = this.options.resolveSourceRef(proposal.sessionId, token);
      if (!resolved || !validSourceRef(resolved)) throw new Error('npc-maintenance-source-ref-unresolved');
      sourceRefs.set(token, Object.freeze({ ...resolved }));
    }
    const resolveMany = (tokens: readonly string[]): SourceRef[] => tokens.map((token) => sourceRefs.get(token)!);

    const { byCharacter, unresolvedCount } = proposalBuckets(proposal, resolveMany);

    const receipts: NpcMaintenanceCharacterReceipt[] = [];
    const rollbackAnchors: CharacterMaintenanceRollbackAnchor[] = [];
    try {
      this.options.transaction(() => {
        // Recheck after BEGIN IMMEDIATE and before the first write. Own writes may change the
        // aggregate session revision, so rechecking between characters would create false stale.
        actualRevision = this.options.currentRevision(proposal.sessionId);
        if (actualRevision !== proposal.sourceRevision) throw new NpcMaintenanceBatchStale(actualRevision);
        for (const characterId of [...byCharacter.keys()].sort()) {
          const bucket = byCharacter.get(characterId)!;
          const operationId = `maintenance:${input.runId}:npc:${characterId}`;
          const candidate = bucketCandidate(characterId, bucket);
          const beforeProjectionDigest = this.options.characters.maintenanceCurrentProjectionDigest(
            proposal.sessionId,
            characterId,
          );
          const result = this.options.characters.admit(proposal.sessionId, candidate, {
            operationId,
            instanceId: input.instanceId,
            historyEpoch: input.historyEpoch,
            predecessor: input.predecessor,
            allowedCharacterIds: [...input.context.allowedCharacterIds],
            expectedVersion: bucket.expectedVersion,
            round: bucket.maxRound,
            sourceKind: 'story',
          });
          const receipt = characterReceipt(result, characterId, operationId);
          if (!receipt.ok) throw new NpcMaintenanceBatchRejected(receipt);
          receipts.push(receipt);
          if (receipt.entityVersion === undefined) throw new Error('npc-maintenance-receipt-version-missing');
          rollbackAnchors.push(this.options.characters.maintenanceRollbackAnchorForAppliedOperation(
            proposal.sessionId,
            characterId,
            operationId,
            bucket.expectedVersion,
            receipt.entityVersion,
            beforeProjectionDigest,
          ));
        }
      });
    } catch (error) {
      if (error instanceof NpcMaintenanceBatchStale) {
        return { status: 'stale', actualRevision: error.actualRevision, characterWrites: 0 };
      }
      if (error instanceof NpcMaintenanceBatchRejected) {
        return Object.freeze({
          status: 'rejected',
          runId: input.runId,
          sessionId: proposal.sessionId,
          sourceRevision: proposal.sourceRevision,
          proposalDigest: proposal.proposalDigest,
          provenanceDigest: input.provenanceDigest,
          characterWrites: 0,
          rejectedCharacterId: error.receipt.characterId,
          errorCode: error.receipt.errorCode ?? 'NpcMaintenanceCandidateRejected',
        });
      }
      throw error;
    }
    return Object.freeze({
      status: 'committed',
      runId: input.runId,
      sessionId: proposal.sessionId,
      sourceRevision: proposal.sourceRevision,
      proposalDigest: proposal.proposalDigest,
      provenanceDigest: input.provenanceDigest,
      unresolvedCount,
      characters: Object.freeze(receipts),
      rollbackAnchor: Object.freeze({
        version: NPC_MAINTENANCE_ROLLBACK_VERSION,
        runId: input.runId,
        sessionId: proposal.sessionId,
        proposalDigest: proposal.proposalDigest,
        characters: Object.freeze(rollbackAnchors),
      }),
    });
  }

  rollback(value: unknown): NpcMaintenanceRollbackReceipt {
    const anchor = normalizeRollbackAnchor(value);
    let result: CharacterMaintenanceRollbackResult;
    try {
      result = this.options.transaction(() => (
        this.options.characters.rollbackMaintenanceOperations(anchor.sessionId, anchor.characters)
      ));
    } catch (error) {
      if (error instanceof StateVersionConflictError) {
        throw new Error('npc-maintenance-rollback-revision-conflict');
      }
      throw error;
    }
    return Object.freeze({
      status: 'rolled_back',
      runId: anchor.runId,
      sessionId: anchor.sessionId,
      proposalDigest: anchor.proposalDigest,
      deduped: result.deduped,
      removedFactRows: result.removedFactRows,
      characters: result.characters,
    });
  }
}
