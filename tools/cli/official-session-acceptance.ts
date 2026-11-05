/** Two isolated, synthetic-input Session turns; metadata only, no retry or production settings. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../packages/proxy/public/client.ts';
import type { TurnOutcomeMarker } from '../../packages/memory/public/turn-outcome.ts';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const inputs = ['合成测试：旅人进入图书馆，与管理员打个招呼。', '合成测试：旅人询问图书馆今天何时关闭。'] as const;
export async function runIsolatedSessionAcceptance(createClient: () => Promise<ChatCompletionClient>) {
  const tempBase = fs.realpathSync(tmpdir());
  const directory = fs.mkdtempSync(join(tempBase, 'jg-official-session-'));
  const realDirectory = fs.realpathSync(directory);
  if (!realDirectory.startsWith(tempBase + sep) || !basename(realDirectory).startsWith('jg-official-session-'))
    throw new Error('official-session-temp-invalid');
  const prior = { data: process.env.JG_USER_DATA_DIR, pg: process.env.JG_PG_ENABLED, dsn: process.env.JG_PG_DSN,
    key: process.env.JG_API_KEY };
  process.env.JG_USER_DATA_DIR = directory; process.env.JG_PG_ENABLED = 'false';
  process.env.JG_PG_DSN = 'postgresql://127.0.0.1:1/official-session-disabled';
  delete process.env.JG_API_KEY;
  const originalRead = fs.readFileSync;
  fs.readFileSync = ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    if (/(?:^|[\\/])(?:\.env(?:\.[a-z0-9_-]+)?|(?:agent-)?provider\.json|root\.key)$/iu.test(String(path)))
      throw new Error('official-session-credential-file-forbidden');
    return (originalRead as (...values: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  const card = join(directory, 'synthetic-card.json'), db = join(directory, 'synthetic-session.db');
  fs.writeFileSync(card, JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', name: '合成管理员',
    description: '图书馆管理员，关门时间为晚上八点。', personality: '平静', scenario: '安静的图书馆',
    first_mes: '欢迎来到图书馆。', mes_example: '', data: { name: '合成管理员',
      description: '图书馆管理员，关门时间为晚上八点。', personality: '平静', scenario: '安静的图书馆',
      first_mes: '欢迎来到图书馆。', mes_example: '', extensions: {} } }));
  const calls: Array<{ requestDigest: string; usage: ChatResponse['usage']; finishReason: string }> = [];
  const rows: Array<{ round: number; runDigest: string; assistantDigest: string; completionDigest: string }> = [];
  let session: InstanceType<typeof import('../../packages/session/public/session.ts').ChatSession> | undefined;
  let client: ChatCompletionClient;
  let stage = 'initialization';
  const wrapper: ChatCompletionClient = {
    capabilities: () => ({ stream: true, tools: true }), modelName: () => 'deepseek-flash',
    complete: async () => { throw new Error('official-session-unexpected-complete'); },
    stream: async (request, onDelta, onToolArg, signal, call) => {
      if (calls.length >= 2) throw new Error('official-session-call-limit');
      if (call?.lane !== 'turn_final' || !call.runId || request.extraBody !== undefined) throw new Error('official-session-request-invalid');
      const fixed: ChatRequest = { ...request, model: 'deepseek-flash', max_tokens: 4096 };
      const entry: (typeof calls)[number] = { requestDigest: digest(JSON.stringify(fixed)), usage: null, finishReason: 'unavailable' };
      calls.push(entry);
      const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90_000)]);
      const result = await client.stream(fixed, onDelta, onToolArg, boundedSignal, { ...call, maxTransportAttempts: 1 });
      entry.usage = result.usage ?? null;
      entry.finishReason = ['stop', 'tool_calls', 'length', 'content_filter'].includes(result.finishReason) ? result.finishReason : 'other';
      return result;
    },
  };
  try {
    client = await createClient();
    const { ChatSession } = await import('../../packages/session/public/session.ts');
    const open = async (resume: boolean) => {
      const value = new ChatSession({ card, db, resume, useBge: false, contentMode: 'nsf', worldbooks: [],
        providerClient: wrapper, quietLogs: true, storyIndexIdleGraceMs: 0 });
      await value.init(); return value;
    };
    session = await open(false);
    for (let i = 0; i < 2; i++) {
      stage = `turn-${i + 1}`;
      const runId = `official_session_turn_${i + 1}`;
      const prose: string = await session.turn(inputs[i]!, 'nsf', undefined, undefined, [], runId,
        { runId, sessionId: 'synthetic-session', action: 'turn', acquire: () => {} });
      assert.ok(prose.trim());
      const marker: TurnOutcomeMarker | null = session.currentVerifiedTurnOutcome();
      assert.ok(marker && marker.runId === runId && marker.round === i + 1);
      const original = session.turnOutcome(runId); assert.deepEqual(original, marker);
      rows.push({ round: marker.round, runDigest: digest(runId), assistantDigest: digest(prose),
        completionDigest: digest(JSON.stringify(marker)) });
    }
    assert.equal(calls.length, 2);
    stage = 'restart-readback';
    session.close(); session = undefined;
    session = await open(true);
    const latest = session.currentVerifiedTurnOutcome();
    assert.ok(latest && latest.round === 2 && digest(latest.runId) === rows[1]!.runDigest);
    for (let i = 0; i < 2; i++) {
      const marker: TurnOutcomeMarker | null = session.turnOutcome(`official_session_turn_${i + 1}`);
      assert.ok(marker && digest(JSON.stringify(marker)) === rows[i]!.completionDigest);
    }
    stage = 'completed';
    return { status: 'passed' as const, stage, calls, turns: rows, restartVerified: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const diagnostic = error && typeof error === 'object' && 'diagnosticCode' in error ? error.diagnosticCode : undefined;
    const failure = status === 429 || diagnostic === 'provider-rate-limited' ? 'provider-rate-limited'
      : diagnostic === 'provider-timeout' ? 'provider-timeout' : /^official-session-[a-z-]+$/u.test(message) ? message
      : /game-turn-output-invalid/u.test(message) ? 'game-turn-output-invalid'
        : /timeout|timed out/iu.test(message) ? 'provider-timeout'
          : error instanceof assert.AssertionError ? 'verification-failed' : 'session-or-provider-failed';
    return { status: 'failed' as const, stage, failure, calls, turns: rows, restartVerified: false };
  } finally {
    session?.close();
    fs.readFileSync = originalRead; syncBuiltinESMExports();
    for (const [key, value] of [['JG_USER_DATA_DIR', prior.data], ['JG_PG_ENABLED', prior.pg], ['JG_PG_DSN', prior.dsn], ['JG_API_KEY', prior.key]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    if (fs.realpathSync(directory) !== realDirectory || !realDirectory.startsWith(tempBase + sep)
      || !basename(realDirectory).startsWith('jg-official-session-')) throw new Error('official-session-temp-invalid');
    fs.rmSync(realDirectory, { recursive: true, force: true });
  }
}
