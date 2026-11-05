/** Exact original job metadata only; never a model-call or adoption certificate. */
import type { TurnOutcomeMarker } from '../../packages/memory/public/turn-outcome.ts';
import type { StyleCompileIntentEntry } from '../../packages/memory/public/style-compile-intent-outbox.ts';
import { styleCompileIntentDigest } from '../../packages/memory/public/style-compile-intent-outbox.ts';
import type { StyleCompileJobRecord } from './skill-hub/style-compile-job-store.ts';
import { styleCompileJobId, styleCompileJobMatchesIntent } from './skill-hub/style-compile-pipeline.ts';

export function readTurnStyleJob(marker: TurnOutcomeMarker, entry: StyleCompileIntentEntry | null,
  jobs: { readJob(jobId: string): StyleCompileJobRecord | null } | null, historyEpoch: number) {
  if (!entry) return Object.freeze({ state: 'no-intent' as const });
  const p = entry.payload;
  if (p.rawSessionId !== marker.sessionId || p.runId !== marker.runId || p.round !== marker.round
    || p.assistantMessageId !== marker.assistantMessageId || p.sourceRevision !== marker.revision
    || styleCompileIntentDigest(p) !== entry.packetDigest) throw new Error('turn-agent-evidence-unavailable');
  if (entry.state === 'invalidated' || p.historyEpoch !== historyEpoch) return Object.freeze({ state: 'invalidated' as const });
  if (!jobs) return Object.freeze({ state: 'unavailable' as const });
  const job = jobs.readJob(styleCompileJobId(marker.sessionId, marker.runId));
  if (!job) return Object.freeze({ state: 'no-job' as const });
  if (!styleCompileJobMatchesIntent(job, entry)) throw new Error('turn-agent-evidence-unavailable');
  return Object.freeze({ state: 'recorded' as const, intentState: entry.state,
    status: job.state, reasonCode: job.reasonCode, result: job.result?.status ?? null });
}
