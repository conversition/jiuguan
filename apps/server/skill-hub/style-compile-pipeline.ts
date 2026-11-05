/** Original turn intent -> durable Style job -> read-back proposal -> Session settlement.
 * No timer, model client, new permission, or production cutover is created by this module.
 */
import { createHash } from 'node:crypto';
import type { ChatSession, SessionArgs } from '../../../packages/session/public/session.ts';
import type { StyleProposal } from '../../../packages/core/public/learned-style-store.ts';
import type { StyleCompileIntentEntry } from '../../../packages/memory/public/style-compile-intent-outbox.ts';
import type { StyleCompileJobRecord, StyleCompileJobStore, StyleCompileJobResult } from './style-compile-job-store.ts';
import type { StyleCompileJobHost, PreparedStyleJobOutcome } from './style-compile-job-executor.ts';

export type StyleCompileProposalInput = Parameters<NonNullable<NonNullable<SessionArgs['agentAdmission']>['requestStyleProposal']>>[0];
type ProposalOutcome = Awaited<ReturnType<NonNullable<NonNullable<SessionArgs['agentAdmission']>['requestStyleProposal']>>>;
export type PreparedStyleCompileProposal = Exclude<ProposalOutcome, { status: 'created' }>
  | Readonly<{ status: 'prepared'; commit(): ProposalOutcome }>;
type SessionPort = Pick<ChatSession, 'scanStyleCompileIntents' | 'readStyleCompileIntent'
  | 'styleCompileIntentRequest' | 'styleCompileIntentIsObsolete' | 'markStyleCompileIntentDelivered'
  | 'readStyleCompileSettlement' | 'settleStyleCompileIntent' | 'turnOutcome'>;

export interface StyleCompilePipelineReport {
  readonly attempted: number;
  readonly delivered: number;
  readonly settled: number;
  readonly failed: number;
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

/** Identity is session + original run, never a guessed run extracted from a job ID. */
export function styleCompileJobId(sessionId: string, runId: string): string {
  return `style.${createHash('sha256').update(JSON.stringify({
    version: 'style-compile-job-identity-v1', sessionId, runId,
  })).digest('hex')}`;
}

export function styleCompileJobMatchesIntent(job: StyleCompileJobRecord, entry: StyleCompileIntentEntry): boolean {
  const p = entry.payload;
  return job.jobId === styleCompileJobId(p.rawSessionId, p.runId)
    && job.sessionId === p.rawSessionId && job.runId === p.runId
    && job.intentPacketDigest === entry.packetDigest && job.contentMode === p.scope.contentMode
    && job.styleSkillId === p.styleSkillId && job.round === p.round
    && job.sourceRevision === p.sourceRevision && job.explicitRequest === p.explicitRequest;
}
const matches = styleCompileJobMatchesIntent;

function terminal(job: StyleCompileJobRecord): boolean {
  return ['done', 'failed', 'cancelled', 'uncertain'].includes(job.state);
}

export function createStyleCompilePipeline(options: Readonly<{
  store: StyleCompileJobStore;
  resolveSession(rawSessionId: string): SessionPort | null;
  isSessionDeleted?(rawSessionId: string): boolean;
  /** Inject the real server prepare/commit helper, not a second Provider implementation. */
  prepare(rawSessionId: string, input: StyleCompileProposalInput, job?: StyleCompileJobRecord): Promise<PreparedStyleCompileProposal>;
  readProposal(proposalId: string): StyleProposal | null;
  now(): string;
}>) {
  const sessionFor = (id: string): SessionPort | null => options.isSessionDeleted?.(id) === true
    ? null : options.resolveSession(id);

  const proposalMatches = (proposalId: string, entry: StyleCompileIntentEntry): boolean => {
    const proposal = options.readProposal(proposalId);
    const p = entry.payload;
    // create() may idempotently return a proposal with this exact source at v2+. Match
    // immutable provenance, never whichever version happens to be active now.
    return !!proposal && proposal.id === proposalId
      && proposal.scope?.sessionId === p.scope.sessionId && proposal.scope.cardId === p.scope.cardId
      && proposal.scope.contentMode === p.scope.contentMode && proposal.scope.baseStyleSkillId === p.scope.baseStyleSkillId
      && proposal.versions.some((version) => version.sourceDigest === p.sourceDigest
        && version.profileVersion === p.profileVersion && version.model === p.binding.modelId
        && version.policyVersion === p.binding.policyVersion);
  };

  /** Cross-database recovery replays a durable result, never a paid model operation. */
  const project = (job: StyleCompileJobRecord): boolean => {
    if (!terminal(job) || !job.runId || !job.intentPacketDigest) return false;
    const session = sessionFor(job.sessionId);
    if (!session) return false; // unloaded is deferred, not deleted
    const entry = session.readStyleCompileIntent(job.runId);
    if (!entry || !matches(job, entry)) return false;
    const receipt = session.readStyleCompileSettlement(job.runId);
    if (receipt) return receipt.packetDigest === entry.packetDigest;
    let result: StyleCompileJobResult | null = job.result;
    if (!result) return false; // legacy terminal rows do not prove business effects
    if (result.status === 'created' && !proposalMatches(result.proposalId, entry)) {
      result = { status: 'unknown', attempted: true };
    }
    // Deleted/regenerated source cannot acquire a new success/attempt baseline. Keep the
    // central history and its possibly-used slot quarantined; never relabel a call as no-call.
    if ((result.status === 'created' || result.status === 'rejected'
      || (result.status === 'unknown' && result.attempted === true))
      && !session.styleCompileIntentRequest(job.runId, entry.packetDigest)) {
      result = { status: 'unknown', attempted: null };
    }
    // Delivery may have persisted centrally just before the local acknowledgment was lost.
    if (entry.state === 'pending' && (result.status === 'created' || result.status === 'rejected'
      || (result.status === 'unknown' && result.attempted === true))
      && !session.markStyleCompileIntentDelivered(job.runId, entry.packetDigest, options.now())) return false;
    return session.settleStyleCompileIntent(job.runId, entry.packetDigest, result, options.now());
  };

  const current = (job: StyleCompileJobRecord): boolean => {
    if (!job.runId || !job.intentPacketDigest) return false;
    const session = sessionFor(job.sessionId);
    const entry = session?.readStyleCompileIntent(job.runId);
    if (!session || !entry || !matches(job, entry) || session.readStyleCompileSettlement(job.runId)
      || !session.styleCompileIntentRequest(job.runId, job.intentPacketDigest)) return false;
    if (entry.state === 'delivered') return true;
    if (entry.state !== 'pending') return false;
    // Target commit may precede a crash before its local delivery acknowledgment. A drain
    // that wins the startup race must repair that acknowledgment, not cancel a valid job.
    const durable = options.store.read(job.jobId);
    return !!durable && matches(durable, entry) && ['pending', 'leased', 'executing'].includes(durable.state)
      && session.markStyleCompileIntentDelivered(job.runId, entry.packetDigest, options.now());
  };

  const host: StyleCompileJobHost = {
    resolveSession: sessionFor,
    isSessionDeleted: options.isSessionDeleted,
    isSourceRevisionCommitted: (id, revision, job) => {
      // Read the exact original run marker, never a bounded history page or a parsed job ID.
      const session = sessionFor(id);
      return !!session && !!job?.runId && job.sessionId === id
        && session.turnOutcome(job.runId)?.revision === revision;
    },
    isIntentCurrent: current,
    onJobSettled: (job) => { project(job); },
    executeStyleJob: async (job, { signal }): Promise<PreparedStyleJobOutcome> => {
      if (!current(job)) return { status: 'ineligible' };
      const session = sessionFor(job.sessionId)!;
      if (session.styleCompileIntentIsObsolete(job.runId!, job.intentPacketDigest!)) return { status: 'ineligible' };
      const entry = session.readStyleCompileIntent(job.runId!)!;
      const request = session.styleCompileIntentRequest(job.runId!, job.intentPacketDigest!);
      if (!request || signal.aborted) return { status: 'ineligible' };
      const prepared = await options.prepare(job.sessionId, Object.freeze({ ...request, signal }), job);
      if (prepared.status === 'skipped') return { status: 'ineligible' };
      if (prepared.status === 'rejected') return { status: 'rejected' };
      return { status: 'prepared', commit: (): StyleCompileJobResult => {
        // The executor also checks packet + generation + TTL while holding central authority.
        if (signal.aborted || !current(job)) return { status: 'unknown', attempted: true };
        try {
          const result = prepared.commit();
          return result.status === 'created' && proposalMatches(result.proposalId, entry)
            ? { status: 'created', proposalId: result.proposalId }
            : { status: 'unknown', attempted: true };
        } catch {
          // A domain store may have committed before throwing. Never infer no-effect/retry.
          return { status: 'unknown', attempted: true };
        }
      } };
    },
  };

  const scan = (rawSessionId: string, input: { limit?: number; cursor?: number }, deliver: boolean): StyleCompilePipelineReport => {
    const session = sessionFor(rawSessionId);
    const report = { attempted: 0, delivered: 0, settled: 0, failed: 0,
      nextCursor: input.cursor ?? 0, hasMore: false };
    if (!session) return Object.freeze(report);
    const page = session.scanStyleCompileIntents(input);
    report.attempted = page.attempted;
    report.failed = page.failed;
    report.nextCursor = page.nextCursor;
    report.hasMore = page.hasMore;
    for (const entry of page.entries) {
      try {
        const p = entry.payload;
        if (p.rawSessionId !== rawSessionId) { report.failed += 1; continue; }
        if (session.readStyleCompileSettlement(p.runId)) continue;
        const jobId = styleCompileJobId(rawSessionId, p.runId);
        let job = options.store.read(jobId);
        if (job && !matches(job, entry)) { report.failed += 1; continue; }
        if (job && terminal(job)) {
          report.settled += project(job) ? 1 : 0;
          continue;
        }
        if (!session.styleCompileIntentRequest(p.runId, entry.packetDigest)) {
          if (job) options.store.cancelBySourceRevision(rawSessionId, p.sourceRevision, options.now());
          if (job && terminal(options.store.read(jobId)!)) {
            report.settled += project(options.store.read(jobId)!) ? 1 : 0;
          } else if (!job) {
            report.settled += session.settleStyleCompileIntent(p.runId, entry.packetDigest,
              { status: 'cancelled' }, options.now()) ? 1 : 0;
          }
          continue;
        }
        if (!deliver) continue;
        options.store.enqueue({ jobId, sessionId: rawSessionId, runId: p.runId,
          intentPacketDigest: entry.packetDigest, contentMode: p.scope.contentMode,
          styleSkillId: p.styleSkillId, round: p.round, sourceRevision: p.sourceRevision,
          explicitRequest: p.explicitRequest, now: options.now() });
        job = options.store.read(jobId);
        // Never acknowledge an INSERT/trigger receipt without exact durable target readback.
        if (!job || !matches(job, entry)) { report.failed += 1; continue; }
        if (session.markStyleCompileIntentDelivered(p.runId, entry.packetDigest, options.now())) report.delivered += 1;
        else report.failed += 1;
      } catch { report.failed += 1; /* one corrupt/future packet must not starve later cursor pages */ }
    }
    return Object.freeze(report);
  };

  return Object.freeze({ host,
    deliverSessionIntents: (rawSessionId: string, input: { limit?: number; cursor?: number } = {}) => scan(rawSessionId, input, true),
    reconcileSession: (rawSessionId: string, input: { limit?: number; cursor?: number } = {}) => scan(rawSessionId, input, false),
  });
}
