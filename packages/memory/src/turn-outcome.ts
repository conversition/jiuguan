import type { DatabaseSync } from 'node:sqlite';

export type TurnOutcomeAction = 'turn' | 'regenerate';

export interface TurnOutcomeMarker {
  runId: string;
  sessionId: string;
  action: TurnOutcomeAction;
  round: number;
  assistantMessageId: number;
  revision: string;
  committedAt: string;
}

export interface CommitTurnOutcomeInput {
  runId: string;
  sessionId: string;
  action: TurnOutcomeAction;
  round: number;
  assistantMessageId: number;
  revision: string;
  committedAt?: string;
}

function requireOpaque(value: unknown, field: string, maxLength = 160): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${field} 非法`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} 非法`);
  return value as number;
}

function canonicalTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('committedAt 必须是 canonical ISO 时间');
  }
  return value;
}

function parseMarker(row: Record<string, unknown>): TurnOutcomeMarker {
  const action = row.action;
  if (action !== 'turn' && action !== 'regenerate') throw new Error('turn outcome action 非法');
  return {
    runId: requireOpaque(row.run_id, 'run_id'),
    sessionId: requireOpaque(row.session_id, 'session_id'),
    action,
    round: requirePositiveInteger(row.round, 'round'),
    assistantMessageId: requirePositiveInteger(row.assistant_message_id, 'assistant_message_id'),
    revision: requireOpaque(row.revision, 'revision'),
    committedAt: canonicalTimestamp(String(row.committed_at)),
  };
}

/** 会话数据库中的成功回执；调用方必须在最终写环事务内 commit。 */
export class TurnOutcomeStore {
  constructor(private readonly db: DatabaseSync) {}

  get(runIdValue: string): TurnOutcomeMarker | null {
    const runId = requireOpaque(runIdValue, 'runId');
    const row = this.db.prepare('SELECT * FROM turn_job_outcome WHERE run_id = ?').get(runId) as
      Record<string, unknown> | undefined;
    return row ? parseMarker(row) : null;
  }

  commit(input: CommitTurnOutcomeInput): TurnOutcomeMarker {
    const marker: TurnOutcomeMarker = {
      runId: requireOpaque(input.runId, 'runId'),
      sessionId: requireOpaque(input.sessionId, 'sessionId'),
      action: input.action,
      round: requirePositiveInteger(input.round, 'round'),
      assistantMessageId: requirePositiveInteger(input.assistantMessageId, 'assistantMessageId'),
      revision: requireOpaque(input.revision, 'revision'),
      committedAt: canonicalTimestamp(input.committedAt ?? new Date().toISOString()),
    };
    if (marker.action !== 'turn' && marker.action !== 'regenerate') throw new Error('action 非法');

    const existing = this.get(marker.runId);
    if (existing) {
      if (
        existing.sessionId !== marker.sessionId
        || existing.action !== marker.action
        || existing.round !== marker.round
        || existing.assistantMessageId !== marker.assistantMessageId
        || existing.revision !== marker.revision
      ) {
        throw new Error('相同 runId 已绑定不同会话结果');
      }
      return existing;
    }

    this.db.prepare(
      `INSERT INTO turn_job_outcome
         (run_id, session_id, action, round, assistant_message_id, revision, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      marker.runId,
      marker.sessionId,
      marker.action,
      marker.round,
      marker.assistantMessageId,
      marker.revision,
      marker.committedAt,
    );
    return marker;
  }
}
