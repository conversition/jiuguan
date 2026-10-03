import { createHash } from 'node:crypto';

export const ARC_EVIDENCE_VERSION = 'arc-evidence-v1';
export const ARC_DORMANT_REVIEW_ROUNDS = 8;

export type ArcStatusSignal = 'open' | 'closed' | 'dormant';
export type ArcProposalKind = 'multi_arc_review' | 'chapter_close_review' | 'dependency_review'
  | 'dormant_close_review';

export interface ArcEvidenceFeatures {
  readonly arcEvidenceVersion: typeof ARC_EVIDENCE_VERSION;
  readonly arcIds: readonly string[];
  readonly arcStatusSignal: ArcStatusSignal;
  readonly arcGoalDigest: string;
  readonly arcDependencyDigests: readonly string[];
  readonly arcKeyEventDigests: readonly string[];
  readonly arcMemoryEventDigests: readonly string[];
  readonly arcConflict: boolean;
  readonly arcUnresolvedDependency: boolean;
  readonly arcProposalKinds: readonly ArcProposalKind[];
}

export interface BuildArcEvidenceInput {
  readonly plan: {
    readonly roadmap?: {
      readonly current_arc?: string;
      readonly current_stage?: string;
      readonly next_milestone?: string;
      readonly active_foreshadowing?: readonly { readonly clue?: string; readonly status?: string }[];
    };
    readonly key_events?: readonly { readonly description?: string }[];
    readonly next_plan?: string;
  };
  readonly memoryDelta: { readonly new_events?: readonly { readonly description?: string }[] };
}

export interface ArcEvidenceEvent {
  readonly eventKind: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: string;
  readonly round: number;
  readonly sourceRevision: string | null;
  readonly subjectDigest: string;
  readonly features: Readonly<Record<string, unknown>>;
}

export interface ArcProjectionItem {
  readonly arcId: string;
  readonly status: ArcStatusSignal;
  readonly firstRound: number;
  readonly lastRound: number;
  readonly evidenceCount: number;
  readonly goalDigest: string;
  readonly dependencyDigests: readonly string[];
  readonly latestKeyEventDigests: readonly string[];
  readonly latestMemoryEventDigests: readonly string[];
  readonly latestSourceRevision: string;
  readonly latestEvidenceDigest: string;
}

export interface ArcTypedProposal {
  readonly proposalId: string;
  readonly kind: ArcProposalKind;
  readonly arcIds: readonly string[];
  readonly sourceRevision: string;
  readonly reasonCodes: readonly string[];
}

export interface ArcSessionProjection {
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly latestRound: number;
  readonly arcs: readonly ArcProjectionItem[];
  readonly proposals: readonly ArcTypedProposal[];
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARC_ID = /^arc:sha256:[a-f0-9]{64}$/u;
const STATUS = new Set<ArcStatusSignal>(['open', 'closed', 'dormant']);
const PROPOSALS = new Set<ArcProposalKind>([
  'multi_arc_review', 'chapter_close_review', 'dependency_review', 'dormant_close_review',
]);

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value.normalize('NFKC').trim(), 'utf8').digest('hex')}`;
}

function arcId(value: string): string { return `arc:${digest(value)}`; }

function boundedUnique(values: readonly string[], limit = 32): readonly string[] {
  return Object.freeze([...new Set(values)].sort().slice(0, limit));
}

function currentArcNames(value: string): string[] {
  return value.normalize('NFKC').split(/[|/｜／\n]+/u).map((item) => item.trim()).filter(Boolean).slice(0, 8);
}

function statusSignal(stage: string, milestone: string): ArcStatusSignal {
  const value = `${stage}\n${milestone}`.normalize('NFKC');
  const negatedClosure = /(?:尚未|还未|并未|没有|未曾).{0,4}(?:完结|收束|结束|完成)/u.test(value);
  if (!negatedClosure && /终章|已完结|章节收束|篇章收束|(?:剧情|章节|主线|支线|故事|篇章).{0,4}(?:完结|结束|完成)/u.test(value)) return 'closed';
  if (/休眠|搁置|暂停|等待后续/u.test(value)) return 'dormant';
  return 'open';
}

/** 从已校验 game_turn 的结构化字段生成摘要/枚举；返回值不携带任何来源正文。 */
export function buildDeterministicArcEvidence(input: BuildArcEvidenceInput): ArcEvidenceFeatures {
  const roadmap = input.plan.roadmap ?? {};
  const names = currentArcNames(roadmap.current_arc ?? '');
  const arcIds = boundedUnique(names.map(arcId), 8);
  const stage = roadmap.current_stage ?? '';
  const milestone = roadmap.next_milestone ?? input.plan.next_plan ?? '';
  const foreshadowing = (roadmap.active_foreshadowing ?? []).slice(0, 32);
  const dependencyDigests = boundedUnique(foreshadowing
    .map((item) => (item.clue ?? '').trim()).filter(Boolean).map(digest));
  const unknownDependency = foreshadowing.some((item) => {
    const value = (item.status ?? '').normalize('NFKC').trim().toLowerCase();
    return value.length > 0 && !/^(?:pending|open|active|resolved|closed|complete|待处理|进行中|已解决|已完成)$/u.test(value);
  });
  const status = statusSignal(stage, milestone);
  const proposals: ArcProposalKind[] = [];
  if (arcIds.length > 1) proposals.push('multi_arc_review');
  if (status === 'closed') proposals.push('chapter_close_review');
  if (unknownDependency) proposals.push('dependency_review');
  return Object.freeze({
    arcEvidenceVersion: ARC_EVIDENCE_VERSION,
    arcIds,
    arcStatusSignal: status,
    arcGoalDigest: digest(milestone),
    arcDependencyDigests: dependencyDigests,
    arcKeyEventDigests: boundedUnique((input.plan.key_events ?? []).slice(0, 32)
      .map((item) => (item.description ?? '').trim()).filter(Boolean).map(digest)),
    arcMemoryEventDigests: boundedUnique((input.memoryDelta.new_events ?? []).slice(0, 32)
      .map((item) => (item.description ?? '').trim()).filter(Boolean).map(digest)),
    arcConflict: arcIds.length > 1,
    arcUnresolvedDependency: unknownDependency,
    arcProposalKinds: Object.freeze(proposals.sort()),
  });
}

interface ValidArcEvidence extends ArcEvidenceFeatures {}

function validEvidence(row: ArcEvidenceEvent): ValidArcEvidence | null {
  const value = row.features;
  if (row.eventKind !== 'turn_accepted_weak' || value.arcEvidenceVersion !== ARC_EVIDENCE_VERSION
    || !TOKEN.test(row.sessionId) || !TOKEN.test(row.cardId)
    || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw') || !Number.isSafeInteger(row.round) || row.round < 1
    || row.sourceRevision === null || !TOKEN.test(row.sourceRevision) || !DIGEST.test(row.subjectDigest)
    || !Array.isArray(value.arcIds) || value.arcIds.length > 8
    || !value.arcIds.every((item) => typeof item === 'string' && ARC_ID.test(item))
    || new Set(value.arcIds).size !== value.arcIds.length
    || typeof value.arcStatusSignal !== 'string' || !STATUS.has(value.arcStatusSignal as ArcStatusSignal)
    || typeof value.arcGoalDigest !== 'string' || !DIGEST.test(value.arcGoalDigest)
    || !Array.isArray(value.arcDependencyDigests) || !Array.isArray(value.arcKeyEventDigests)
    || !Array.isArray(value.arcMemoryEventDigests) || !Array.isArray(value.arcProposalKinds)
    || typeof value.arcConflict !== 'boolean' || typeof value.arcUnresolvedDependency !== 'boolean') return null;
  const digestArrays = [value.arcDependencyDigests, value.arcKeyEventDigests, value.arcMemoryEventDigests];
  if (digestArrays.some((items) => items.length > 32 || new Set(items).size !== items.length
    || !items.every((item) => typeof item === 'string' && DIGEST.test(item)))) return null;
  if (value.arcProposalKinds.length > 5 || new Set(value.arcProposalKinds).size !== value.arcProposalKinds.length
    || !value.arcProposalKinds.every((item) => typeof item === 'string' && PROPOSALS.has(item as ArcProposalKind))) return null;
  const expectedProposals: ArcProposalKind[] = [];
  if (value.arcIds.length > 1) expectedProposals.push('multi_arc_review');
  if (value.arcStatusSignal === 'closed') expectedProposals.push('chapter_close_review');
  if (value.arcUnresolvedDependency) expectedProposals.push('dependency_review');
  if (value.arcConflict !== (value.arcIds.length > 1)
    || JSON.stringify([...value.arcProposalKinds].sort()) !== JSON.stringify(expectedProposals.sort())) return null;
  return value as unknown as ValidArcEvidence;
}

interface MutableArc {
  arcId: string;
  status: ArcStatusSignal;
  firstRound: number;
  lastRound: number;
  evidenceCount: number;
  goalDigest: string;
  dependencyDigests: Set<string>;
  latestKeyEventDigests: readonly string[];
  latestMemoryEventDigests: readonly string[];
  latestSourceRevision: string;
  latestEvidenceDigest: string;
}

interface MutableSession {
  sessionId: string;
  cardId: string;
  contentMode: 'nsf' | 'nsfw';
  latestRound: number;
  arcs: Map<string, MutableArc>;
  proposals: Map<string, ArcTypedProposal>;
}

function proposalId(sessionId: string, kind: ArcProposalKind, arcIds: readonly string[], revision: string): string {
  return `arc-proposal:${digest(`${sessionId}\0${kind}\0${arcIds.join(',')}\0${revision}`)}`;
}

function addProposal(session: MutableSession, kind: ArcProposalKind, arcIds: readonly string[], revision: string, reason: string): void {
  const ids = boundedUnique(arcIds, 8);
  const proposal = Object.freeze({
    proposalId: proposalId(session.sessionId, kind, ids, revision), kind, arcIds: ids,
    sourceRevision: revision, reasonCodes: Object.freeze([reason]),
  });
  session.proposals.set(proposal.proposalId, proposal);
}

/** 从独立学习账本纯重建 Arc shadow；不读取或覆盖旧 memory_arc。 */
export function rebuildArcSessionProjections(events: readonly ArcEvidenceEvent[]): readonly ArcSessionProjection[] {
  const invalidated = new Set(events.filter((row) => row.eventKind === 'delete' && row.sourceRevision !== null)
    .map((row) => `${row.sessionId}\0${row.sourceRevision}`));
  for (const row of events) {
    const replaced = row.features.replacedSourceRevision;
    if (row.eventKind === 'regenerate' && typeof replaced === 'string' && TOKEN.test(replaced)) {
      invalidated.add(`${row.sessionId}\0${replaced}`);
    }
  }
  const sessions = new Map<string, MutableSession>();
  const revisionSequence = (revision: string | null): number => {
    const match = revision?.match(/-assistant-(\d+)$/u);
    return match ? Number(match[1]) : 0;
  };
  const ordered = [...events].sort((left, right) => left.round - right.round
    || revisionSequence(left.sourceRevision) - revisionSequence(right.sourceRevision)
    || String(left.sourceRevision).localeCompare(String(right.sourceRevision)));
  for (const row of ordered) {
    if (row.sourceRevision === null || invalidated.has(`${row.sessionId}\0${row.sourceRevision}`)) continue;
    const evidence = validEvidence(row);
    if (!evidence || evidence.arcIds.length === 0) continue;
    const key = `${row.sessionId}\0${row.cardId}\0${row.contentMode}`;
    const session = sessions.get(key) ?? {
      sessionId: row.sessionId, cardId: row.cardId, contentMode: row.contentMode as 'nsf' | 'nsfw',
      latestRound: 0, arcs: new Map(), proposals: new Map(),
    };
    session.latestRound = Math.max(session.latestRound, row.round);
    const current = new Set(evidence.arcIds);
    for (const arc of session.arcs.values()) {
      if (arc.status === 'open' && !current.has(arc.arcId)) arc.status = 'dormant';
    }
    for (const id of evidence.arcIds) {
      const arc = session.arcs.get(id) ?? {
        arcId: id, status: evidence.arcStatusSignal, firstRound: row.round, lastRound: row.round,
        evidenceCount: 0, goalDigest: evidence.arcGoalDigest, dependencyDigests: new Set<string>(),
        latestKeyEventDigests: Object.freeze([]), latestMemoryEventDigests: Object.freeze([]),
        latestSourceRevision: row.sourceRevision, latestEvidenceDigest: row.subjectDigest,
      };
      arc.status = evidence.arcStatusSignal;
      arc.lastRound = row.round;
      arc.evidenceCount += 1;
      arc.goalDigest = evidence.arcGoalDigest;
      arc.dependencyDigests = new Set(evidence.arcDependencyDigests);
      arc.latestKeyEventDigests = Object.freeze([...evidence.arcKeyEventDigests]);
      arc.latestMemoryEventDigests = Object.freeze([...evidence.arcMemoryEventDigests]);
      arc.latestSourceRevision = row.sourceRevision;
      arc.latestEvidenceDigest = row.subjectDigest;
      session.arcs.set(id, arc);
    }
    for (const kind of evidence.arcProposalKinds) {
      addProposal(session, kind, evidence.arcIds, row.sourceRevision, `arc-${kind.replace(/_/gu, '-')}`);
    }
    sessions.set(key, session);
  }
  return Object.freeze([...sessions.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)).map((session) => {
    for (const arc of session.arcs.values()) {
      if (arc.status === 'dormant' && session.latestRound - arc.lastRound >= ARC_DORMANT_REVIEW_ROUNDS) {
        addProposal(session, 'dormant_close_review', [arc.arcId], arc.latestSourceRevision, 'arc-dormant-threshold');
      }
    }
    const arcs = [...session.arcs.values()].sort((left, right) => left.arcId.localeCompare(right.arcId)).map((arc) => Object.freeze({
      arcId: arc.arcId, status: arc.status, firstRound: arc.firstRound, lastRound: arc.lastRound,
      evidenceCount: arc.evidenceCount, goalDigest: arc.goalDigest,
      dependencyDigests: Object.freeze([...arc.dependencyDigests].sort()),
      latestKeyEventDigests: arc.latestKeyEventDigests,
      latestMemoryEventDigests: arc.latestMemoryEventDigests,
      latestSourceRevision: arc.latestSourceRevision, latestEvidenceDigest: arc.latestEvidenceDigest,
    }));
    return Object.freeze({
      sessionId: session.sessionId, cardId: session.cardId, contentMode: session.contentMode,
      latestRound: session.latestRound, arcs: Object.freeze(arcs),
      proposals: Object.freeze([...session.proposals.values()].sort((a, b) => a.proposalId.localeCompare(b.proposalId))),
    });
  }));
}
