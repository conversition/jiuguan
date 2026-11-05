/** Reconcile only retained, matched user actions from an existing Session database. */
import { existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { inspectSessionAuthoritySchema } from '../../packages/memory/public/session-database.ts';
import { SCHEMA_VERSION } from '../../packages/memory/public/schema.ts';
import { settleEffectWatch } from '../../packages/session/public/effect-watch.ts';
import type { AgentClosureStore } from './agent-closure-store.ts';
import type { AgentClosureRecorder } from './agent-closure-recorder.ts';

export function recoverSessionEffectWatch(input: {
  readonly path: string; readonly rawSessionId: string; readonly allowed: (id: string) => boolean;
  readonly closure: Pick<AgentClosureStore, 'get'>; readonly recorder: Pick<AgentClosureRecorder, 'observeEffect'>;
  readonly onObserved?: (id: string) => void;
}): void {
  let denied = false;
  const allowed = () => {
    if (denied) return false;
    try { if (input.allowed(input.rawSessionId) === true) return true; } catch { /* fail closed */ }
    denied = true; return false;
  };
  if (!allowed()) throw new Error('effect-recovery-fenced');
  if (!existsSync(input.path)) throw new Error('effect-recovery-source-missing');
  const file = lstatSync(input.path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('effect-recovery-file-invalid');
  // URI mode=rw refuses a vanished source instead of creating an empty database.
  const sourceUri = pathToFileURL(input.path);
  sourceUri.searchParams.set('mode', 'rw');
  const db = new DatabaseSync(sourceUri.href);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION
      || db.prepare('PRAGMA application_id').get()?.application_id !== 0) throw new Error('effect-recovery-schema-invalid');
    inspectSessionAuthoritySchema(db);
    const columns = (db.prepare('PRAGMA table_info(session_control)').all() as { name: string; type: string; notnull: number; pk: number }[])
      .map(row => [row.name, row.type, row.notnull, row.pk]);
    if (JSON.stringify(columns) !== JSON.stringify([['session_key', 'TEXT', 1, 1], ['control_key', 'TEXT', 1, 2],
      ['value', 'TEXT', 1, 0], ['updated_at', 'TEXT', 0, 0]])) throw new Error('effect-recovery-schema-invalid');
    const sameFile = () => { const current = lstatSync(input.path); return current.isFile() && !current.isSymbolicLink()
      && current.dev === file.dev && current.ino === file.ino; };
    if (!sameFile() || !allowed()) throw new Error('effect-recovery-fenced');
    let observed = false;
    settleEffectWatch({ db, rawSessionId: input.rawSessionId, currentRound: 0, signalsOnly: true, allowed,
      observe: event => {
        if (!allowed()) throw new Error('effect-recovery-fenced');
        const original = input.closure.get(event.operationId);
        const consumed = original?.events.filter(item => item.type === 'context-consumed'
          && item.consumerRunId === event.consumerRunId && item.artifactDigest === event.artifactDigest) ?? [];
        if (!original || original.sessionId !== input.rawSessionId || consumed.length !== 1)
          throw new Error('effect-recovery-consumer-unavailable');
        input.recorder.observeEffect(event);
        if (!allowed()) throw new Error('effect-recovery-fenced');
        const current = input.closure.get(event.operationId);
        const after = current?.events.filter(item => item.type === 'context-consumed'
          && item.consumerRunId === event.consumerRunId && item.artifactDigest === event.artifactDigest) ?? [];
        const effects = current?.events.filter(item => item.type === 'effect-observed'
          && item.consumerRunId === event.consumerRunId && item.artifactDigest === event.artifactDigest
          && item.effectOutcome === event.effectOutcome) ?? [];
        if (!current || current.sessionId !== input.rawSessionId || after.length !== 1 || effects.length !== 1
          || JSON.stringify(consumed[0]) !== JSON.stringify(after[0])) throw new Error('effect-recovery-source-drift');
        observed = true;
      } });
    if (!sameFile() || !allowed()) throw new Error('effect-recovery-fenced');
    db.exec('COMMIT;');
    if (observed && allowed()) input.onObserved?.(input.rawSessionId);
  } finally { if (db.isTransaction) db.exec('ROLLBACK;'); db.close(); }
}
