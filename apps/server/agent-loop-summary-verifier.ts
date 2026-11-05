/** P17-02.5a: read-only Summary history inspection, never AL write/completion authority.
 * Existing domain readers own operation/readback truth. A matching historical write
 * still lacks an AL write Action/proposal/attempt binding, so this runner cannot pass.
 */
import { agentClosureDigest, agentClosureTimestamp, agentClosureToken } from '../../packages/agent-closure/index.ts';
import type { AgentLoopCompletionCandidate, AgentLoopVerifierResult, AgentLoopVerifierRunner } from './agent-loop-completion-gate.ts';
import type { SummaryWriteHistoricalEvidence } from './memory-summary-maintenance-committer.ts';
import { parseSummaryWriteIntent, parseSummaryWriteReadback, summaryWriteDigest } from './maintenance-summary-write-receipt.ts';

export const AGENT_LOOP_SUMMARY_VERIFIER_VERSION = 'agent-loop-summary-history-verifier-v1' as const;
export const AGENT_LOOP_SUMMARY_VERIFIER_REASONS = Object.freeze([
  'summary-write-source-stale', 'summary-write-evidence-missing', 'summary-write-evidence-unavailable',
  'summary-write-evidence-invalid', 'summary-write-rolled-back', 'summary-write-action-unbound',
] as const);
type Reason = typeof AGENT_LOOP_SUMMARY_VERIFIER_REASONS[number];

export interface AgentLoopRollingSummaryVerifierOptions {
  /** Selected trusted reader identity only; none of these strings grants AL write authority. */
  readonly boundSource: Readonly<{
    taskId: string; attemptId: string; runId: string; sessionId: string; sourceRevision: string;
  }>;
  readonly readSummaryWriteEvidence: (candidate: AgentLoopCompletionCandidate) => SummaryWriteHistoricalEvidence | null
    | Promise<SummaryWriteHistoricalEvidence | null>;
  readonly assertSourceCurrent: (candidate: AgentLoopCompletionCandidate) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

function invalid(): never { throw new Error('agent-loop-summary-verifier-options-invalid'); }
function dataRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) invalid();
}
function inconclusive(reason: Reason): Omit<AgentLoopVerifierResult, 'verifierId'> {
  return Object.freeze({ disposition: 'inconclusive', reasonCodes: Object.freeze([reason]), evidenceRefs: Object.freeze([]) });
}
function candidateSnapshot(candidate: AgentLoopCompletionCandidate): AgentLoopCompletionCandidate {
  dataRecord(candidate);
  if (!Number.isSafeInteger(candidate.taskRevision) || candidate.taskRevision < 1
    || !Array.isArray(candidate.artifactRefs) || candidate.artifactRefs.length > 128) invalid();
  const artifactRefs: string[] = [];
  for (let index = 0; index < candidate.artifactRefs.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate.artifactRefs, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    artifactRefs.push(agentClosureToken(descriptor.value, 'candidate-artifact-ref'));
  }
  return Object.freeze({ candidateRef: agentClosureToken(candidate.candidateRef, 'candidate-ref'),
    taskId: agentClosureToken(candidate.taskId, 'candidate-task'), attemptId: agentClosureToken(candidate.attemptId, 'candidate-attempt'),
    taskRevision: candidate.taskRevision, artifactRefs: Object.freeze(artifactRefs),
    actionWatermark: candidate.actionWatermark === null ? null : agentClosureToken(candidate.actionWatermark, 'candidate-action-watermark'),
    createdAt: agentClosureTimestamp(candidate.createdAt, 'candidate-created-at') });
}

export function createAgentLoopRollingSummaryVerifier(options: AgentLoopRollingSummaryVerifierOptions): AgentLoopVerifierRunner {
  let bound: AgentLoopRollingSummaryVerifierOptions['boundSource'];
  try {
    if (!options || typeof options.readSummaryWriteEvidence !== 'function' || typeof options.assertSourceCurrent !== 'function'
      || options.signal !== undefined && typeof options.signal.aborted !== 'boolean') invalid();
    dataRecord(options.boundSource);
    const source = options.boundSource;
    if (typeof source.runId !== 'string' || !/^mjob_[a-f0-9]{32}$/u.test(source.runId)
      || source.taskId !== `agentloop.maintenance.${source.runId}`) invalid();
    bound = Object.freeze({ taskId: agentClosureToken(source.taskId, 'bound-task'),
      attemptId: agentClosureToken(source.attemptId, 'bound-attempt'), runId: source.runId,
      sessionId: agentClosureToken(source.sessionId, 'bound-session'),
      sourceRevision: agentClosureDigest(source.sourceRevision, 'bound-source-revision') });
  } catch { return invalid(); }
  const { readSummaryWriteEvidence, assertSourceCurrent, signal } = options;
  const assertCurrent = async (candidate: AgentLoopCompletionCandidate): Promise<void> => {
    if (signal?.aborted) invalid();
    // The port is an assertion, not an allow-by-default boolean predicate.
    const result = await assertSourceCurrent(candidate);
    if (result !== undefined || signal?.aborted) invalid();
  };

  return async ({ candidate }) => {
    let pinned: AgentLoopCompletionCandidate;
    try {
      pinned = candidateSnapshot(candidate);
      if (pinned.taskId !== bound.taskId || pinned.attemptId !== bound.attemptId) invalid();
      await assertCurrent(pinned);
      if (signal?.aborted) invalid();
    } catch { return inconclusive('summary-write-source-stale'); }

    let evidence: SummaryWriteHistoricalEvidence | null = null;
    let unavailable = false;
    try { evidence = await readSummaryWriteEvidence(pinned); }
    catch { unavailable = true; }
    // Always recheck after the awaited read, including missing/throwing readers.
    try { await assertCurrent(pinned); if (signal?.aborted) invalid(); }
    catch { return inconclusive('summary-write-source-stale'); }
    if (unavailable) return inconclusive('summary-write-evidence-unavailable');
    if (evidence === null) return inconclusive('summary-write-evidence-missing');

    try {
      dataRecord(evidence);
      if (Reflect.ownKeys(evidence).some(key => !['intent', 'state', 'readback', 'updatedAt', 'rollbackDigest'].includes(String(key)))
        || !['applied', 'rolled_back'].includes(evidence.state)) invalid();
      dataRecord(evidence.intent);
      const intent = parseSummaryWriteIntent(evidence.intent);
      const updatedAt = agentClosureTimestamp(evidence.updatedAt, 'summary-history-updated-at');
      if (intent.runId !== bound.runId || intent.sessionId !== bound.sessionId || intent.sourceRevision !== bound.sourceRevision
        || updatedAt < intent.committedAt) invalid();
      const readback = evidence.readback === null ? null : (() => {
        dataRecord(evidence.readback);
        return parseSummaryWriteReadback(evidence.readback);
      })();
      if (readback && (readback.runId !== intent.runId || readback.sessionId !== intent.sessionId
        || readback.sourceRevision !== intent.sourceRevision || readback.proposalDigest !== intent.proposalDigest
        || readback.targetRevision !== intent.targetRevision || readback.intentDigest !== intent.intentDigest
        || readback.committedAt !== intent.committedAt || readback.truthVersion !== intent.truthVersion
        || readback.historyEpoch !== intent.historyEpoch || readback.throughRound !== intent.throughRound
        || readback.summaryDigest !== intent.summaryDigest || readback.projectionDigest !== summaryWriteDigest({
          operationDigest: intent.operationDigest, throughRound: intent.throughRound, summaryDigest: intent.summaryDigest,
          truthVersion: intent.truthVersion, historyEpoch: intent.historyEpoch,
        }))) invalid();
      if (evidence.state === 'rolled_back') {
        agentClosureDigest(evidence.rollbackDigest, 'summary-rollback-digest');
        if (readback && updatedAt < readback.verifiedAt) invalid();
        return inconclusive('summary-write-rolled-back');
      }
      if (evidence.rollbackDigest !== undefined) invalid();
      if (!readback) return inconclusive('summary-write-evidence-missing');
      // No existing producer binds this historical write to an AL Action/attempt.
      // Neither matching bytes nor a legacy Summary Skill proof can fill that gap.
      return inconclusive('summary-write-action-unbound');
    } catch { return inconclusive('summary-write-evidence-invalid'); }
  };
}
