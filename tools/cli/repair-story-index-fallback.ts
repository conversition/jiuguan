import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

interface CliArgs {
  sessionId: string;
  apply: boolean;
  dataRoot: string;
}

interface EventRow {
  event_id: string;
  event_kind: string;
  round: number;
}

const LEGACY_FALLBACK_FRAGMENTS = [
  '调查并核实「',
  '根据当前目标采取一个能够推进局势的具体行动',
  '与当前在场角色交谈，确认各自掌握的信息',
] as const;

function parseArgs(argv: readonly string[]): CliArgs {
  const apply = argv.includes('--apply');
  const sessionAt = argv.indexOf('--session');
  const rootAt = argv.indexOf('--data-root');
  const sessionId = sessionAt >= 0 ? argv[sessionAt + 1] ?? '' : '';
  if (!/^session-\d{10,}$/u.test(sessionId)) {
    throw new Error('usage: repair:story-index -- --session session-<digits> [--apply] [--data-root <path>]');
  }
  const defaultRoot = process.env.JG_USER_DATA_DIR
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Jiuguan', 'a9-private-data') : '');
  const dataRoot = resolve(rootAt >= 0 ? argv[rootAt + 1] ?? '' : defaultRoot);
  if (!dataRoot || !existsSync(dataRoot)) throw new Error('story-index-repair-data-root-not-found');
  return { sessionId, apply, dataRoot };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(',');
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionPath = resolve(args.dataRoot, args.sessionId + '.db');
  const learningPath = resolve(args.dataRoot, 'agent-learning.sqlite');
  if (dirname(sessionPath) !== args.dataRoot || basename(sessionPath) !== args.sessionId + '.db') {
    throw new Error('story-index-repair-path-outside-data-root');
  }
  if (!existsSync(sessionPath)) throw new Error('story-index-repair-session-not-found');
  if (!existsSync(learningPath)) throw new Error('story-index-repair-learning-db-not-found');

  const sessionDb = new DatabaseSync(sessionPath);
  const learningDb = new DatabaseSync(learningPath);
  try {
    const badRounds = (sessionDb.prepare(
      'SELECT round FROM story_index '
      + 'WHERE content LIKE ? AND content LIKE ? AND content LIKE ? ORDER BY round',
    ).all(...LEGACY_FALLBACK_FRAGMENTS.map((fragment) => '%' + fragment + '%')) as Array<{ round: number }>)
      .map((row) => row.round);

    const affectedEvents = badRounds.length === 0
      ? []
      : sessionDb.prepare(
        'SELECT event_id,event_kind,round FROM learning_outbox '
        + "WHERE (event_kind='branch_exposed' AND round IN (" + placeholders(badRounds) + ')) '
        + "OR (event_kind='branch_exact_selected' "
        + "AND CAST(json_extract(features_json,'$.exposureRound') AS INTEGER) IN ("
        + placeholders(badRounds) + ')) ORDER BY round,event_kind,event_id',
      ).all(...badRounds, ...badRounds) as unknown as EventRow[];

    const preview = {
      mode: args.apply ? 'apply' : 'dry-run',
      sessionId: args.sessionId,
      badRounds,
      affectedEvents: affectedEvents.map((event) => ({
        eventId: event.event_id,
        eventKind: event.event_kind,
        round: event.round,
      })),
    };
    if (!args.apply || badRounds.length === 0) {
      console.log(JSON.stringify(preview, null, 2));
      return;
    }

    const backupDir = join(args.dataRoot, '.repair-backups', 'story-index-fallback-' + timestamp());
    mkdirSync(backupDir, { recursive: true });
    await backup(sessionDb, join(backupDir, args.sessionId + '.db'));
    await backup(learningDb, join(backupDir, 'agent-learning.sqlite'));

    const eventIds = affectedEvents.map((event) => event.event_id);
    sessionDb.exec('BEGIN IMMEDIATE');
    try {
      sessionDb.prepare(
        'DELETE FROM story_index WHERE round IN (' + placeholders(badRounds) + ')',
      ).run(...badRounds);
      sessionDb.prepare(
        'DELETE FROM session_control WHERE session_key=? AND control_key IN ('
        + placeholders(badRounds) + ')',
      ).run(args.sessionId, ...badRounds.map((round) => 'story_index:' + round));
      if (eventIds.length > 0) {
        sessionDb.prepare(
          'DELETE FROM learning_outbox WHERE event_id IN (' + placeholders(eventIds) + ')',
        ).run(...eventIds);
      }
      sessionDb.exec('COMMIT');
    } catch (error) {
      sessionDb.exec('ROLLBACK');
      throw error;
    }

    if (eventIds.length > 0) {
      learningDb.exec('BEGIN IMMEDIATE');
      try {
        learningDb.prepare(
          'DELETE FROM learning_event WHERE event_id IN (' + placeholders(eventIds) + ')',
        ).run(...eventIds);
        learningDb.exec('COMMIT');
      } catch (error) {
        learningDb.exec('ROLLBACK');
        throw error;
      }
    }

    console.log(JSON.stringify({ ...preview, backupDir }, null, 2));
  } finally {
    learningDb.close();
    sessionDb.close();
  }
}

await main();
