import { createHash } from 'node:crypto';

export const NPC_EVIDENCE_VERSION = 'npc-evidence-v1';

export type NpcEvidenceCategory = 'objective' | 'knowledge' | 'belief' | 'secret' | 'goal' | 'relationship';
export type NpcProposalKind = 'npc_ambiguity_review' | 'npc_conflict_review' | 'npc_promotion_review';

export interface NpcEvidenceRecord {
  /** CharacterStore 已消歧并准入后的稳定 ID；输出只保留其摘要。 */
  readonly characterId: string;
  readonly field: string;
  readonly value: unknown;
  readonly factKind?: 'fact' | 'recall' | 'plan' | 'hypothesis' | 'quoted' | 'correction';
  readonly status?: 'confirmed' | 'pending' | 'unresolved' | 'last-known' | 'unknown';
  readonly relationship?: boolean;
}

export interface BuildNpcEvidenceInput {
  readonly records: readonly NpcEvidenceRecord[];
  readonly outcome: {
    readonly hasAmbiguity: boolean;
    readonly hasConflict: boolean;
    readonly hasPromotion: boolean;
  };
}

export interface NpcEvidenceFeatures {
  readonly npcEvidenceVersion: typeof NPC_EVIDENCE_VERSION;
  readonly npcSignals: readonly string[];
  readonly npcProposalKinds: readonly NpcProposalKind[];
}

export interface NpcEvidenceEvent {
  readonly eventKind: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: string;
  readonly round: number;
  readonly sourceRevision: string | null;
  readonly subjectDigest: string;
  readonly features: Readonly<Record<string, unknown>>;
}

export interface NpcProjectionItem {
  readonly characterDigest: string;
  readonly evidenceCounts: Readonly<Record<NpcEvidenceCategory, number>>;
  readonly firstRound: number;
  readonly lastRound: number;
  readonly latestSourceRevision: string;
  readonly latestEvidenceDigest: string;
}

export interface NpcTypedProposal {
  readonly proposalId: string;
  readonly kind: NpcProposalKind;
  readonly sourceRevision: string;
  readonly characterDigests: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface NpcSessionProjection {
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly latestRound: number;
  readonly characters: readonly NpcProjectionItem[];
  readonly proposals: readonly NpcTypedProposal[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SIGNAL = /^npc:(objective|knowledge|belief|secret|goal|relationship):([a-f0-9]{64}):([a-f0-9]{64})$/u;
const PROPOSALS = new Set<NpcProposalKind>([
  'npc_ambiguity_review', 'npc_conflict_review', 'npc_promotion_review',
]);
const SECRET_FIELD = /(?:^|[._:/-])(?:secret|secrets|classified|confidential)(?:$|[._:/-])|秘密|隐瞒|机密/u;
const CATEGORIES: readonly NpcEvidenceCategory[] = Object.freeze([
  'objective', 'knowledge', 'belief', 'secret', 'goal', 'relationship',
]);

function shaHex(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC'), 'utf8').digest('hex');
}

function digest(value: string): string { return `sha256:${shaHex(value)}`; }

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function categoryOf(record: NpcEvidenceRecord): NpcEvidenceCategory {
  if (record.relationship) return 'relationship';
  if (record.factKind === 'plan') return 'goal';
  if (record.factKind === 'hypothesis') return 'belief';
  if (record.factKind === 'recall' || record.factKind === 'quoted') return 'knowledge';
  if (SECRET_FIELD.test(record.field.normalize('NFKC').toLowerCase())) return 'secret';
  return 'objective';
}

/**
 * 只消费 CharacterStore 已准入记录。人物 ID、字段和值均在函数内摘要化，返回值不保留来源正文。
 * hypothesis 固定映射到 belief，永远不能成为 objective。
 */
export function buildDeterministicNpcEvidence(input: BuildNpcEvidenceInput): NpcEvidenceFeatures {
  const signals = input.records.filter((record) => record.characterId.trim().length > 0).map((record) => {
    const category = categoryOf(record);
    const character = shaHex(record.characterId.trim());
    const evidence = shaHex(JSON.stringify({
      category,
      field: record.field.normalize('NFKC').trim(),
      factKind: record.factKind ?? 'fact',
      status: record.status ?? ((record.factKind === 'fact' || record.factKind === 'correction' || !record.factKind)
        ? 'confirmed' : 'pending'),
      value: canonical(record.value),
    }));
    return `npc:${category}:${character}:${evidence}`;
  });
  const proposals: NpcProposalKind[] = [];
  if (input.outcome.hasAmbiguity) proposals.push('npc_ambiguity_review');
  if (input.outcome.hasConflict) proposals.push('npc_conflict_review');
  if (input.outcome.hasPromotion) proposals.push('npc_promotion_review');
  return Object.freeze({
    npcEvidenceVersion: NPC_EVIDENCE_VERSION,
    npcSignals: Object.freeze([...new Set(signals)].sort().slice(0, 32)),
    npcProposalKinds: Object.freeze(proposals.sort()),
  });
}

interface MutableNpc {
  characterDigest: string;
  evidenceCounts: Record<NpcEvidenceCategory, number>;
  firstRound: number;
  lastRound: number;
  latestSourceRevision: string;
  latestEvidenceDigest: string;
}

interface MutableSession {
  sessionId: string;
  cardId: string;
  contentMode: 'nsf' | 'nsfw';
  latestRound: number;
  characters: Map<string, MutableNpc>;
  proposals: Map<string, NpcTypedProposal>;
}

function validEvidence(row: NpcEvidenceEvent): NpcEvidenceFeatures | null {
  const value = row.features;
  if (row.eventKind !== 'turn_accepted_weak' || value.npcEvidenceVersion !== NPC_EVIDENCE_VERSION
    || !TOKEN.test(row.sessionId) || !TOKEN.test(row.cardId)
    || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw') || !Number.isSafeInteger(row.round) || row.round < 1
    || row.sourceRevision === null || !TOKEN.test(row.sourceRevision) || !DIGEST.test(row.subjectDigest)
    || !Array.isArray(value.npcSignals) || value.npcSignals.length > 32
    || new Set(value.npcSignals).size !== value.npcSignals.length
    || !value.npcSignals.every((item) => typeof item === 'string' && SIGNAL.test(item))
    || !Array.isArray(value.npcProposalKinds) || value.npcProposalKinds.length > 3
    || new Set(value.npcProposalKinds).size !== value.npcProposalKinds.length
    || !value.npcProposalKinds.every((item) => typeof item === 'string' && PROPOSALS.has(item as NpcProposalKind))) return null;
  return value as unknown as NpcEvidenceFeatures;
}

function emptyCounts(): Record<NpcEvidenceCategory, number> {
  return { objective: 0, knowledge: 0, belief: 0, secret: 0, goal: 0, relationship: 0 };
}

function proposalId(sessionId: string, kind: NpcProposalKind, revision: string): string {
  return `npc-proposal:${digest(`${sessionId}\0${kind}\0${revision}`)}`;
}

/** 从独立学习事件纯重建 NPC shadow；CharacterStore 始终是唯一人物事实真源。 */
export function rebuildNpcSessionProjections(events: readonly NpcEvidenceEvent[]): readonly NpcSessionProjection[] {
  const invalidated = new Set(events.filter((row) => row.eventKind === 'delete' && row.sourceRevision !== null)
    .map((row) => `${row.sessionId}\0${row.sourceRevision}`));
  for (const row of events) {
    const replaced = row.features.replacedSourceRevision;
    if (row.eventKind === 'regenerate' && typeof replaced === 'string' && TOKEN.test(replaced)) {
      invalidated.add(`${row.sessionId}\0${replaced}`);
    }
  }
  const sequence = (revision: string | null): number => Number(revision?.match(/-assistant-(\d+)$/u)?.[1] ?? 0);
  const ordered = [...events].sort((a, b) => a.round - b.round || sequence(a.sourceRevision) - sequence(b.sourceRevision)
    || String(a.sourceRevision).localeCompare(String(b.sourceRevision)));
  const sessions = new Map<string, MutableSession>();
  for (const row of ordered) {
    if (row.sourceRevision === null || invalidated.has(`${row.sessionId}\0${row.sourceRevision}`)) continue;
    const evidence = validEvidence(row);
    if (!evidence || (evidence.npcSignals.length === 0 && evidence.npcProposalKinds.length === 0)) continue;
    const key = `${row.sessionId}\0${row.cardId}\0${row.contentMode}`;
    const session = sessions.get(key) ?? {
      sessionId: row.sessionId, cardId: row.cardId, contentMode: row.contentMode as 'nsf' | 'nsfw',
      latestRound: 0, characters: new Map(), proposals: new Map(),
    };
    session.latestRound = Math.max(session.latestRound, row.round);
    const seen = new Set<string>();
    for (const signal of evidence.npcSignals) {
      const match = signal.match(SIGNAL)!;
      const category = match[1] as NpcEvidenceCategory;
      const characterDigest = `sha256:${match[2]}`;
      const unique = `${characterDigest}\0${category}\0${match[3]}`;
      if (seen.has(unique)) continue;
      seen.add(unique);
      const current = session.characters.get(characterDigest) ?? {
        characterDigest, evidenceCounts: emptyCounts(), firstRound: row.round, lastRound: row.round,
        latestSourceRevision: row.sourceRevision, latestEvidenceDigest: row.subjectDigest,
      };
      current.evidenceCounts[category] += 1;
      current.lastRound = row.round;
      current.latestSourceRevision = row.sourceRevision;
      current.latestEvidenceDigest = row.subjectDigest;
      session.characters.set(characterDigest, current);
    }
    const characterDigests = Object.freeze([...new Set(evidence.npcSignals.map((signal) => {
      const match = signal.match(SIGNAL)!;
      return `sha256:${match[2]}`;
    }))].sort());
    for (const kind of evidence.npcProposalKinds) {
      const proposal = Object.freeze({
        proposalId: proposalId(row.sessionId, kind, row.sourceRevision), kind, sourceRevision: row.sourceRevision,
        characterDigests, reasonCodes: Object.freeze([kind.replaceAll('_', '-')]),
      });
      session.proposals.set(proposal.proposalId, proposal);
    }
    sessions.set(key, session);
  }
  return Object.freeze([...sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((session) => Object.freeze({
    sessionId: session.sessionId, cardId: session.cardId, contentMode: session.contentMode, latestRound: session.latestRound,
    characters: Object.freeze([...session.characters.values()].sort((a, b) => a.characterDigest.localeCompare(b.characterDigest))
      .map((item) => Object.freeze({ ...item, evidenceCounts: Object.freeze({ ...item.evidenceCounts }) }))),
    proposals: Object.freeze([...session.proposals.values()].sort((a, b) => a.proposalId.localeCompare(b.proposalId))),
  })));
}

export const NPC_EVIDENCE_CATEGORIES = CATEGORIES;
