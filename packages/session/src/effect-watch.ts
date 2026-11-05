import type { DatabaseSync } from 'node:sqlite';
import { LearningOutboxStore, opaqueLearningToken } from '../../memory/public/learning-outbox.ts';

/** Session-owned, body-free observations. A missing row is an empty registry; a damaged row is not. */
export interface EffectWatchEntry {
  readonly operationId: string; readonly capability: string; readonly artifactDigest: string;
  readonly consumerRunId: string; readonly sourceRevision: string; readonly round: number;
  readonly historyEpoch?: number; readonly completionPinDigest?: string;
}
export interface EffectWatchObservation {
  readonly operationId: string; readonly artifactDigest: string; readonly consumerRunId: string;
  readonly effectOutcome: 'negative' | 'inconclusive';
}
export function readEffectWatch(db: DatabaseSync, rawSessionId: string): EffectWatchEntry[] {
  const row = db.prepare('SELECT value FROM session_control WHERE session_key=? AND control_key=?')
    .get(rawSessionId, 'effect-watch') as { value: string } | undefined;
  if (!row) return [];
  const parsed: unknown = JSON.parse(row.value);
  if (!Array.isArray(parsed) || parsed.length > 64) throw new Error('effect-watch-invalid');
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['artifactDigest', 'capability', 'consumerRunId', 'operationId', 'round', 'sourceRevision', 'historyEpoch', 'completionPinDigest'].includes(key))
      || !['operationId', 'capability', 'artifactDigest', 'consumerRunId', 'sourceRevision']
        .every(key => typeof (item as Record<string, unknown>)[key] === 'string' && (item as Record<string, string>)[key]!.length > 0)
      || !Number.isSafeInteger((item as { round?: unknown }).round) || (item as { round: number }).round < 1
      || ('completionPinDigest' in item && (typeof (item as { completionPinDigest?: unknown }).completionPinDigest !== 'string'
        || !/^sha256:[a-f0-9]{64}$/u.test((item as { completionPinDigest: string }).completionPinDigest)))
      || ('historyEpoch' in item && (!Number.isSafeInteger((item as { historyEpoch?: unknown }).historyEpoch)
        || (item as { historyEpoch: number }).historyEpoch < 0))) throw new Error('effect-watch-invalid');
  }
  return parsed;
}

/** Synchronous source reconciliation. Never reconstructs a watch or invents an event. */
export function settleEffectWatch(input: {
  readonly db: DatabaseSync; readonly rawSessionId: string; readonly currentRound: number;
  readonly signalsOnly: boolean; readonly allowed: () => boolean;
  readonly observe: (observation: EffectWatchObservation) => void;
}): void {
  const { db, rawSessionId } = input;
  const allowed = () => { if (input.allowed() !== true) throw new Error('effect-watch-fenced'); };
  allowed();
  const registry = readEffectWatch(db, rawSessionId);
  if (!registry.length) { allowed(); return; }
  const negated = new Set<string>(), negatedPins = new Set<string>();
  const owner = opaqueLearningToken('session', rawSessionId);
  const outbox = new LearningOutboxStore(db);
  const rows = db.prepare(`SELECT event_id FROM learning_outbox
    WHERE session_id=? AND round>=? AND event_kind IN ('regenerate','delete')`)
    .iterate(owner, Math.min(...registry.map(item => item.round)));
  for (const value of rows) {
    allowed();
    const event = outbox.get(String(value.event_id));
    if (!event || event.sessionId !== owner) throw new Error('effect-signal-invalid');
    if (event.eventKind === 'regenerate') {
      const replaced = event.features.replacedSourceRevision, epoch = event.features.replacedHistoryEpoch;
      const pin = event.features.replacedCompletionPinDigest;
      if (replaced !== undefined && typeof replaced !== 'string'
        || epoch !== undefined && (!Number.isSafeInteger(epoch) || Number(epoch) < 0)
        || pin !== undefined && (typeof pin !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(pin)))
        throw new Error('effect-signal-invalid');
      if (typeof replaced === 'string' && typeof pin === 'string') negatedPins.add(`${replaced}\0${pin}`);
      else if (typeof replaced === 'string' && Number.isSafeInteger(epoch) && Number(epoch) >= 0)
        negated.add(`${replaced}\0${epoch}`);
    } else if (event.eventKind === 'delete' && typeof event.sourceRevision === 'string') {
      const epoch = event.features.removedHistoryEpoch, pin = event.features.removedCompletionPinDigest;
      if (epoch !== undefined && (!Number.isSafeInteger(epoch) || Number(epoch) < 0)
        || pin !== undefined && (typeof pin !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(pin)))
        throw new Error('effect-signal-invalid');
      if (typeof pin === 'string') negatedPins.add(`${event.sourceRevision}\0${pin}`);
      else if (Number.isSafeInteger(epoch) && Number(epoch) >= 0) negated.add(`${event.sourceRevision}\0${epoch}`);
    }
  }
  const remaining: EffectWatchEntry[] = [];
  for (const entry of registry) {
    const negative = entry.completionPinDigest !== undefined
      ? negatedPins.has(`${entry.sourceRevision}\0${entry.completionPinDigest}`)
      : entry.historyEpoch !== undefined && negated.has(`${entry.sourceRevision}\0${entry.historyEpoch}`);
    const ready = negative ? (input.signalsOnly || entry.round <= input.currentRound)
      : (!input.signalsOnly && entry.round < input.currentRound && input.currentRound - entry.round >= 3);
    if (!ready) { remaining.push(entry); continue; }
    allowed();
    input.observe({ operationId: entry.operationId, artifactDigest: entry.artifactDigest,
      consumerRunId: entry.consumerRunId, effectOutcome: negative ? 'negative' : 'inconclusive' });
    allowed();
  }
  allowed();
  if (remaining.length !== registry.length) {
    const current = readEffectWatch(db, rawSessionId);
    if (JSON.stringify(current) !== JSON.stringify(registry)) throw new Error('effect-watch-drift');
    allowed();
    db.prepare('UPDATE session_control SET value=?,updated_at=? WHERE session_key=? AND control_key=?')
      .run(JSON.stringify(remaining), new Date().toISOString(), rawSessionId, 'effect-watch');
    allowed();
  }
}
