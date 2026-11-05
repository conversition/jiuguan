import {
  normalizeNpcMaintenanceProposal,
  type NpcMaintenanceFactEntry,
  type NpcMaintenanceIdentityResolutionEntry,
  type NpcMaintenanceProposalContext,
  type NpcMaintenanceRelationshipEntry,
} from '../../packages/agent-policy/src/npc-maintenance-proposal.ts';
import {
  characterReadbackBatchDigest,
  normalizeCharacterField,
  characterReadbackReceipt,
  type AdmitResult,
  type CharacterCandidate,
  type CharacterChangeCandidate,
  type CharacterMaintenanceAliasRollbackAnchor,
  type CharacterMaintenanceRollbackAnchor,
  type CharacterMaintenanceRollbackResult,
  type CharacterReadbackReceipt,
  type CharacterRelationshipCandidate,
  type CharacterStore,
  type FactKind,
  type FactScope,
  type PredecessorRef,
  type SourceRef,
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

export interface NpcMaintenanceIdentityReceipt {
  readonly characterId: string;
  readonly operationId: string;
  readonly aliasDigest: string;
  readonly added: boolean;
  readonly deduped: boolean;
  /** 别名写入**之后**的人物版本：写后回读靠它把摘要绑到这次写入。 */
  readonly entityVersion: number;
}

export const NPC_MAINTENANCE_ROLLBACK_VERSION = 'npc-maintenance-rollback-v1' as const;

/**
 * P16 C2 · 写后回读回执。
 *
 * NPC 此前只能停在 `applied`，因为回执给不出"写完之后重新读到的权威投影"摘要 ——
 * 备份成功、`applied=true`、公开 diff 都不算回读证据。
 *
 * `verified` 只在**提交之后**重新读取权威投影、且读到的人物版本恰好等于本次写入
 * 报告的版本时才成立（否则出现 `version-drift`，说明提交后 head 又动过）。
 * 回读失败**不回滚**已提交的业务真值，只让本次证据保持"未证明"。
 */
export const NPC_MAINTENANCE_READBACK_VERSION = 'npc-maintenance-readback-v1' as const;

export type NpcMaintenanceReadbackReceipt =
  | {
    readonly status: 'verified';
    readonly version: typeof NPC_MAINTENANCE_READBACK_VERSION;
    /** 多人物按 characterId 稳定排序后的批量摘要；顺序与并发写入顺序都不影响它。 */
    readonly readbackDigest: string;
    readonly characters: readonly CharacterReadbackReceipt[];
  }
  | { readonly status: 'unavailable'; readonly reasonCode: string };

export interface NpcMaintenanceRollbackAnchor {
  readonly version: typeof NPC_MAINTENANCE_ROLLBACK_VERSION;
  readonly runId: string;
  readonly sessionId: string;
  readonly proposalDigest: string;
  readonly characters: readonly CharacterMaintenanceRollbackAnchor[];
  readonly identities: readonly CharacterMaintenanceAliasRollbackAnchor[];
}

export interface NpcMaintenanceRollbackReceipt extends CharacterMaintenanceRollbackResult {
  readonly status: 'rolled_back';
  readonly runId: string;
  readonly sessionId: string;
  readonly proposalDigest: string;
  readonly removedAliases: number;
  readonly identityOperationIds: readonly string[];
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
    readonly identities: readonly NpcMaintenanceIdentityReceipt[];
    readonly readback: NpcMaintenanceReadbackReceipt;
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
  const rootKeys = Object.keys(row).sort();
  const legacyKeys = ['version', 'runId', 'sessionId', 'proposalDigest', 'characters'].sort();
  const currentKeys = [...legacyKeys, 'identities'].sort();
  if ((JSON.stringify(rootKeys) !== JSON.stringify(legacyKeys)
      && JSON.stringify(rootKeys) !== JSON.stringify(currentKeys))
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
  const identityValues = row.identities === undefined ? [] : row.identities;
  if (!Array.isArray(identityValues) || identityValues.length > 64) {
    throw new Error('npc-maintenance-rollback-anchor-invalid');
  }
  const identities = identityValues.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('npc-maintenance-rollback-anchor-invalid');
    }
    const anchor = value as Record<string, unknown>;
    if (!exactKeys(anchor, [
      'characterId', 'operationId', 'aliasDigest', 'expectedEntityVersion',
      'rollbackEntityVersion', 'createdAlias', 'provenanceDigest',
    ])
      || typeof anchor.characterId !== 'string' || !TOKEN_RE.test(anchor.characterId)
      || typeof anchor.operationId !== 'string'
      || !anchor.operationId.startsWith(`maintenance:${row.runId}:npc-identity:`)
      || typeof anchor.aliasDigest !== 'string' || !DIGEST_RE.test(anchor.aliasDigest)
      || !Number.isSafeInteger(anchor.expectedEntityVersion) || Number(anchor.expectedEntityVersion) < 0
      || !Number.isSafeInteger(anchor.rollbackEntityVersion) || Number(anchor.rollbackEntityVersion) < 0
      || Number(anchor.rollbackEntityVersion) < Number(anchor.expectedEntityVersion)
      || typeof anchor.createdAlias !== 'boolean'
      || typeof anchor.provenanceDigest !== 'string' || !DIGEST_RE.test(anchor.provenanceDigest)) {
      throw new Error('npc-maintenance-rollback-anchor-invalid');
    }
    return Object.freeze({
      characterId: anchor.characterId,
      operationId: anchor.operationId,
      aliasDigest: anchor.aliasDigest,
      expectedEntityVersion: Number(anchor.expectedEntityVersion),
      rollbackEntityVersion: Number(anchor.rollbackEntityVersion),
      createdAlias: anchor.createdAlias,
      provenanceDigest: anchor.provenanceDigest,
    });
  });
  if (new Set(identities.map((item) => item.operationId)).size !== identities.length) {
    throw new Error('npc-maintenance-rollback-anchor-invalid');
  }
  return Object.freeze({
    version: NPC_MAINTENANCE_ROLLBACK_VERSION,
    runId: row.runId,
    sessionId: row.sessionId,
    proposalDigest: row.proposalDigest,
    characters: Object.freeze(characters),
    identities: Object.freeze(identities),
  });
}

function identityOperationId(runId: string, index: number): string {
  return `maintenance:${runId}:npc-identity:${String(index).padStart(2, '0')}`;
}

function identityEntries(proposal: NormalizedNpcProposal): readonly NpcMaintenanceIdentityResolutionEntry[] {
  return proposal.entries.filter((entry): entry is NpcMaintenanceIdentityResolutionEntry => (
    entry.kind === 'identity_resolution'
  ));
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
    // Identity entries use the separately audited alias operation path below; never fold
    // them into generic fact candidates or let them advance the fact entity version.
    if (entry.kind === 'identity_resolution') continue;
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

/** Exact native operation targets for read-only evidence validation; no projection or provider access. */
export function npcMaintenanceOperationBindings(
  input: Pick<NpcMaintenanceCommitRequest, 'runId' | 'proposal' | 'context'>,
) {
  if (!TOKEN_RE.test(input.runId)) throw new Error('npc-maintenance-commit-binding-invalid');
  const proposal = normalizeNpcMaintenanceProposal(input.proposal, input.context);
  const sourceRefs = (tokens: readonly string[]): SourceRef[] => tokens.map(token => {
    const match = /^msg:([1-9][0-9]*)$/u.exec(token);
    if (!match) throw new Error('npc-maintenance-source-ref-unresolved');
    return { source: 'message', recordId: match[1]!, recordVersion: 1 };
  });
  const { byCharacter } = proposalBuckets(proposal, sourceRefs);
  return Object.freeze([
    ...[...byCharacter.keys()].sort().map(characterId => {
      const bucket = byCharacter.get(characterId)!;
      return Object.freeze({ operationKind: 'character' as const, characterId,
        operationId: `maintenance:${input.runId}:npc:${characterId}`,
        factIntents: Object.freeze([
          ...bucket.changes.map(row => ({ field: `${row.scope ?? 'fact'}.${normalizeCharacterField(row.field.trim())}`,
            scopeKind: row.scope ?? 'fact', factKind: row.factKind, value: row.value,
            effectiveRound: row.effectiveAt?.round, sourceRefs: row.sourceRefs })),
          ...bucket.relationships.map(row => ({ field: `rel:${row.fromCharacterId}:${row.toCharacterId}:${row.type}`,
            scopeKind: 'relationship', factKind: row.factKind,
            value: { relationshipId: row.perspective === 'objective' ? row.relationshipId : `${row.relationshipId}_subj_${row.fromCharacterId}`,
              from: row.fromCharacterId, to: row.toCharacterId, type: row.type, perspective: row.perspective },
            effectiveRound: row.effectiveAt?.round, sourceRefs: row.sourceRefs })),
        ]) });
    }),
    ...identityEntries(proposal).map((entry, index) => Object.freeze({ operationKind: 'identity' as const,
      characterId: entry.characterId, operationId: identityOperationId(input.runId, index),
      identityIntent: Object.freeze({ alias: entry.alias, mentionKey: entry.mentionKey, sourceRefs: sourceRefs(entry.sourceRefs) }) })),
  ]);
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

function readbackCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * P16 C2：提交**之后**重新读取权威人物投影，产出可核对摘要。
 * - 只读：任何失败都只让本次证据变成 unavailable，绝不回滚已提交的业务真值；
 * - 只绑本次写入报告的人物版本：读到别的版本说明提交后 head 又动过 ⇒ fail-closed；
 * - 多人物按 characterId 稳定排序，重复 characterId 只计一次。
 */
function readbackAfterCommit(
  characters: CharacterStore,
  sessionId: string,
  applied: readonly Readonly<{ characterId: string; entityVersion: number }>[],
): NpcMaintenanceReadbackReceipt {
  if (applied.length === 0) {
    return Object.freeze({ status: 'unavailable', reasonCode: 'npc-readback-no-applied-character' });
  }
  const receipts: CharacterReadbackReceipt[] = [];
  for (const entry of [...applied].sort((left, right) => readbackCompare(left.characterId, right.characterId))) {
    let projection: ReturnType<CharacterStore['project']>;
    try {
      projection = characters.project(sessionId, entry.characterId);
    } catch {
      return Object.freeze({ status: 'unavailable', reasonCode: 'npc-readback-projection-unavailable' });
    }
    if (projection.entityVersion !== entry.entityVersion) {
      return Object.freeze({ status: 'unavailable', reasonCode: 'npc-readback-version-drift' });
    }
    receipts.push(characterReadbackReceipt(projection));
  }
  const byCharacter = new Map<string, CharacterReadbackReceipt>();
  for (const receipt of receipts) if (!byCharacter.has(receipt.characterId)) byCharacter.set(receipt.characterId, receipt);
  const ordered = [...byCharacter.values()]
    .sort((left, right) => readbackCompare(left.characterId, right.characterId));
  let readbackDigest: string;
  try {
    readbackDigest = characterReadbackBatchDigest(ordered);
  } catch {
    return Object.freeze({ status: 'unavailable', reasonCode: 'npc-readback-digest-unavailable' });
  }
  return Object.freeze({
    status: 'verified',
    version: NPC_MAINTENANCE_READBACK_VERSION,
    readbackDigest,
    characters: Object.freeze(ordered),
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

class NpcMaintenanceIdentityRejected extends Error {
  constructor(readonly characterId: string, readonly errorCode: string) {
    super('npc-maintenance-identity-rejected');
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
    const identities = identityEntries(proposal);
    if (byCharacter.size === 0 && identities.length === 0) return null;
    const sourceRefs = new Map<string, SourceRef>();
    const identitySourceTokens = new Set(identities.flatMap((entry) => [...entry.sourceRefs]));
    for (const token of identitySourceTokens) {
      const resolved = this.options.resolveSourceRef(proposal.sessionId, token);
      if (!resolved || !validSourceRef(resolved)) throw new Error('npc-maintenance-source-ref-unresolved');
      sourceRefs.set(token, Object.freeze({ ...resolved }));
    }
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
      const recoveredIdentities = identities.map((entry, index) => {
        const operationId = identityOperationId(input.runId, index);
        const rollbackEntityVersion = entry.expectedEntityVersion + (byCharacter.has(entry.characterId) ? 1 : 0);
        const applied = this.options.characters.maintenanceAppliedAliasOperation({
          sessionKey: proposal.sessionId,
          characterId: entry.characterId,
          operationId,
          alias: entry.alias,
          mentionKey: entry.mentionKey,
          expectedEntityVersion: entry.expectedEntityVersion,
          rollbackEntityVersion,
          sourceRefs: entry.sourceRefs.map((token) => sourceRefs.get(token)!),
          provenanceDigest: input.provenanceDigest,
        });
        return { entry, operationId, applied };
      });
      const appliedFlags = [
        ...recovered.map((item) => item.appliedEntityVersion !== null),
        ...recoveredIdentities.map((item) => item.applied !== null),
      ];
      if (appliedFlags.every((applied) => !applied)) return null;
      if (appliedFlags.some((applied) => !applied)) {
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
      const identityReceipts = recoveredIdentities.map(({ applied }) => Object.freeze({
        characterId: applied!.characterId,
        operationId: applied!.operationId,
        aliasDigest: applied!.anchor.aliasDigest,
        added: applied!.added,
        deduped: true,
        entityVersion: applied!.anchor.rollbackEntityVersion,
      }));
      return Object.freeze({
        status: 'committed' as const,
        runId: input.runId,
        sessionId: proposal.sessionId,
        sourceRevision: proposal.sourceRevision,
        proposalDigest: proposal.proposalDigest,
        provenanceDigest: input.provenanceDigest,
        unresolvedCount,
        characters: Object.freeze(characters),
        identities: Object.freeze(identityReceipts),
        // 恢复路径发生在提交之后：**不**把"之后某时刻的当前状态"包装成写后回读。
        // 只读补偿留给 C4 的 reconciler 按其自身授权去做。
        readback: Object.freeze({
          status: 'unavailable',
          reasonCode: 'npc-readback-on-recovery',
        }) as NpcMaintenanceReadbackReceipt,
        rollbackAnchor: Object.freeze({
          version: NPC_MAINTENANCE_ROLLBACK_VERSION,
          runId: input.runId,
          sessionId: proposal.sessionId,
          proposalDigest: proposal.proposalDigest,
          characters: Object.freeze(anchors),
          identities: Object.freeze(recoveredIdentities.map(({ applied }) => applied!.anchor)),
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
    const identities = identityEntries(proposal);

    const receipts: NpcMaintenanceCharacterReceipt[] = [];
    const rollbackAnchors: CharacterMaintenanceRollbackAnchor[] = [];
    const identityReceipts: NpcMaintenanceIdentityReceipt[] = [];
    const identityRollbackAnchors: CharacterMaintenanceAliasRollbackAnchor[] = [];
    try {
      this.options.transaction(() => {
        // Recheck after BEGIN IMMEDIATE and before the first write. Own writes may change the
        // aggregate session revision, so rechecking between characters would create false stale.
        actualRevision = this.options.currentRevision(proposal.sessionId);
        if (actualRevision !== proposal.sourceRevision) throw new NpcMaintenanceBatchStale(actualRevision);
        // Check proposal-time identity CAS before fact writes alter the same character head.
        for (const entry of identities) {
          const actualVersion = this.options.characters.versionOf(proposal.sessionId, entry.characterId);
          if (actualVersion !== entry.expectedEntityVersion) {
            throw new NpcMaintenanceIdentityRejected(entry.characterId, 'StateVersionConflictError');
          }
        }
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
        for (const [index, entry] of identities.entries()) {
          const operationId = identityOperationId(input.runId, index);
          try {
            const applied = this.options.characters.admitMaintenanceAlias({
              sessionKey: proposal.sessionId,
              characterId: entry.characterId,
              operationId,
              alias: entry.alias,
              mentionKey: entry.mentionKey,
              expectedEntityVersion: entry.expectedEntityVersion,
              rollbackEntityVersion: this.options.characters.versionOf(proposal.sessionId, entry.characterId),
              sourceRefs: resolveMany(entry.sourceRefs),
              provenanceDigest: input.provenanceDigest,
            });
            identityReceipts.push(Object.freeze({
              characterId: entry.characterId,
              operationId,
              aliasDigest: applied.anchor.aliasDigest,
              added: applied.added,
              deduped: applied.deduped,
              entityVersion: this.options.characters.versionOf(proposal.sessionId, entry.characterId),
            }));
            identityRollbackAnchors.push(applied.anchor);
          } catch (error) {
            if (error instanceof StateVersionConflictError) {
              throw new NpcMaintenanceIdentityRejected(entry.characterId, 'StateVersionConflictError');
            }
            const errorCode = error instanceof Error && error.message.startsWith('character-maintenance-identity-')
              ? error.message : 'CharacterMaintenanceIdentityRejected';
            throw new NpcMaintenanceIdentityRejected(entry.characterId, errorCode);
          }
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
      if (error instanceof NpcMaintenanceIdentityRejected) {
        return Object.freeze({
          status: 'rejected',
          runId: input.runId,
          sessionId: proposal.sessionId,
          sourceRevision: proposal.sourceRevision,
          proposalDigest: proposal.proposalDigest,
          provenanceDigest: input.provenanceDigest,
          characterWrites: 0,
          rejectedCharacterId: error.characterId,
          errorCode: error.errorCode,
        });
      }
      throw error;
    }
    // 本次提案可能只写事实、只写别名，或两者都写；回读必须覆盖所有被触达的人物，
    // 并按"同一人物取最后一次写入的版本"绑定（版本在事务内单调递增）。
    const touchedVersions = new Map<string, number>();
    const noteVersion = (characterId: string, entityVersion: number): void => {
      touchedVersions.set(characterId, Math.max(touchedVersions.get(characterId) ?? 0, entityVersion));
    };
    for (const receipt of receipts) noteVersion(receipt.characterId, receipt.entityVersion!);
    for (const receipt of identityReceipts) noteVersion(receipt.characterId, receipt.entityVersion);
    const readback = readbackAfterCommit(
      this.options.characters,
      proposal.sessionId,
      [...touchedVersions.entries()].map(([characterId, entityVersion]) => ({ characterId, entityVersion })),
    );
    return Object.freeze({
      status: 'committed',
      runId: input.runId,
      sessionId: proposal.sessionId,
      sourceRevision: proposal.sourceRevision,
      proposalDigest: proposal.proposalDigest,
      provenanceDigest: input.provenanceDigest,
      unresolvedCount,
      characters: Object.freeze(receipts),
      identities: Object.freeze(identityReceipts),
      readback,
      rollbackAnchor: Object.freeze({
        version: NPC_MAINTENANCE_ROLLBACK_VERSION,
        runId: input.runId,
        sessionId: proposal.sessionId,
        proposalDigest: proposal.proposalDigest,
        characters: Object.freeze(rollbackAnchors),
        identities: Object.freeze(identityRollbackAnchors),
      }),
    });
  }

  rollback(value: unknown): NpcMaintenanceRollbackReceipt {
    const anchor = normalizeRollbackAnchor(value);
    let result: CharacterMaintenanceRollbackResult;
    let identityResult: ReturnType<CharacterStore['rollbackMaintenanceAliases']>;
    try {
      ({ result, identityResult } = this.options.transaction(() => {
        // Delete aliases first while the proposal-applied character head is still current.
        const rolledBackIdentities = this.options.characters.rollbackMaintenanceAliases(
          anchor.sessionId,
          anchor.identities,
        );
        const rolledBackFacts = this.options.characters.rollbackMaintenanceOperations(
          anchor.sessionId,
          anchor.characters,
        );
        return { result: rolledBackFacts, identityResult: rolledBackIdentities };
      }));
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
      deduped: result.deduped && identityResult.deduped,
      removedFactRows: result.removedFactRows,
      removedAliases: identityResult.removedAliases,
      identityOperationIds: identityResult.operationIds,
      characters: result.characters,
    });
  }
}
