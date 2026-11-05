/** Isolated same-history style comparison. Only final turns may reach the official Provider. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { DatabaseSync, backup } from 'node:sqlite';
import type { ChatCompletionClient, ChatRequest, ChatResponse, ChatToolArgumentDelta } from '../../packages/proxy/public/client.ts';

const argv = process.argv.slice(2);
const tightFixture = argv.length === 1 && argv[0] === '--fixture-tight';
const fixture = argv.length === 1 && (argv[0] === '--fixture' || tightFixture);
if (!fixture && !(argv.length === 3 && argv[0] === '--key-stdin' && argv[1] === '--output'))
  throw new Error('style-pair-arguments-invalid');
let output: string | undefined;
if (!fixture) {
  output = resolve(argv[2]!);
  const root = fs.realpathSync(process.cwd()), parent = fs.realpathSync(dirname(output));
  if ((parent !== root && !parent.startsWith(root + sep)) || fs.existsSync(output)) throw new Error('style-pair-output-invalid');
}
let key = '';
if (!fixture) {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  key = await new Promise<string>((accept, reject) => {
    const input = createInterface({ input: process.stdin, terminal: false });
    let received = false;
    input.once('line', line => { received = true; input.close(); if (process.stdin.isTTY) process.stdin.setRawMode(false); accept(line.trim()); });
    input.once('close', () => { if (!received) reject(new Error('style-pair-key-missing')); });
  });
  if (!key || /[\r\n]/u.test(key)) throw new Error('style-pair-key-invalid');
}
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const tempBase = fs.realpathSync(tmpdir());
let root = '', realRoot = '';
const prior = { data: process.env.JG_USER_DATA_DIR, pg: process.env.JG_PG_ENABLED, dsn: process.env.JG_PG_DSN,
  key: process.env.JG_API_KEY, context: process.env.JG_MODEL_CONTEXT_TOKENS, budget: process.env.JG_FINAL_PROMPT_BUDGET_TOKENS,
  lockdown: process.env.JG_TEST_CREDENTIAL_LOCKDOWN };
const originalFetch = globalThis.fetch;
let physicalCalls = 0;
let registry: { clear(): Promise<void> } | undefined;
let openSession: { close(): void } | undefined;
try {
root = fs.mkdtempSync(join(tempBase, 'jg-style-pair-'));
realRoot = fs.realpathSync(root);
if (!realRoot.startsWith(tempBase + sep) || !basename(realRoot).startsWith('jg-style-pair-')) throw new Error('style-pair-temp-invalid');
process.env.JG_USER_DATA_DIR = root; process.env.JG_PG_ENABLED = 'false';
process.env.JG_TEST_CREDENTIAL_LOCKDOWN = '1';
process.env.JG_PG_DSN = 'postgresql://127.0.0.1:1/style-pair-disabled';
const finalPromptBudgetTokens = tightFixture ? 5600 : 16000;
process.env.JG_MODEL_CONTEXT_TOKENS = '32768'; process.env.JG_FINAL_PROMPT_BUDGET_TOKENS = String(finalPromptBudgetTokens);
delete process.env.JG_API_KEY;
const skillDir = join(root, 'skills', '文风-底座-轻小说'); fs.mkdirSync(skillDir, { recursive: true });
for (const name of ['SKILL.md', 'program.json']) fs.copyFileSync(resolve('data/skills/文风-底座-轻小说', name), join(skillDir, name));
const card = join(root, 'card.json');
const cardData = { name: '合成图书管理员', description: '图书馆晚上八点关闭。', personality: '平静',
  scenario: '安静的图书馆', first_mes: '欢迎来到图书馆。', mes_example: '', extensions: {} };
fs.writeFileSync(card, JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', ...cardData, data: cardData }));
const fixedResponse = {
  plan: { thought: 'fixture summary', roadmap: { current_arc: '调查真相|守护证人', current_stage: '推进中',
    next_milestone: '揭露学生会阴谋', active_foreshadowing: [] },
    key_events: [{ description: '爱丽丝发现证词互相矛盾', character_focus: [], reference_source: [] }],
    bars_delta: { personal: 0, accident: 0, main: 1, erotic: 0 }, parallel: [], next_plan: '查证并保护证人',
    event_type: 'normal', nsfw_lock: { locked: false, round: 0 } },
  memory_delta: { delta_summary: '取得一条互相矛盾的证词。', state_changes: [],
    new_events: [{ description: '取得一条互相矛盾的证词' }], character_deltas: [] },
  story_index_seed: { version: 'story-index-seed-v1', branches: [
    { action: '核对两份证词', intent: 'investigate', risk: 'low' }, { action: '询问目击学生', intent: 'social', risk: 'medium' },
    { action: '护送证人离开', intent: 'move', risk: 'high' }] },
  prose: '爱丽丝将两份证词并排摊开，指尖停在互相矛盾的时间记录上。',
};
const synthetic: ChatCompletionClient = {
  capabilities: () => ({ stream: true, tools: true }), modelName: () => 'synthetic-fixture',
  complete: async () => { throw new Error('style-pair-unexpected-complete'); },
  stream: async (_request, _onDelta, onToolArg?: (name: string, args: string, delta?: ChatToolArgumentDelta) => void) => {
    const args = JSON.stringify(fixedResponse);
    onToolArg?.('game_turn', args, { index: 0, id: 'fixture-tool', nameDelta: 'game_turn' });
    return { content: null, toolCalls: [{ id: 'fixture-tool', name: 'game_turn', arguments: args }],
      finishReason: 'tool_calls', raw: {}, usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } };
  },
};
globalThis.fetch = async (input, init) => {
  if (fixture) throw new Error('style-pair-fixture-network-forbidden');
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.origin !== 'https://api.deepseek.com' || url.pathname !== '/v1/chat/completions' || url.search || url.hash)
    throw new Error('style-pair-origin-invalid');
  if (physicalCalls >= 2) throw new Error('style-pair-call-limit');
  const body = JSON.parse(String(init?.body)) as { model?: unknown; max_tokens?: unknown; stream?: unknown };
  if (body.model !== 'deepseek-flash' || body.max_tokens !== 4096 || body.stream !== true) throw new Error('style-pair-wire-invalid');
  physicalCalls++;
  return originalFetch(input, { ...init, redirect: 'error' });
};
  const { ChatSession } = await import('../../packages/session/public/session.ts');
  const { createStylePackageShadowObserver } = await import('../../apps/server/skill-hub/style-package-shadow.ts');
  const { SessionAgentSkillShadowRunner } = await import('../../apps/server/skill-hub/session-shadow-runner.ts');
  const { createStylePackageCanary, STYLE_PACKAGE_CANARY_ACK, STYLE_PACKAGE_CANARY_FILE } =
    await import('../../apps/server/skill-hub/style-package-canary.ts');
  const { STYLE_PACKAGE_SHADOW_PIN } = await import('../../apps/server/skill-hub/style-package-source.ts');
  const shadow = createStylePackageShadowObserver({ directory: join(root, 'skills'), isEnabled: () => true });
  const runner = new SessionAgentSkillShadowRunner(shadow);
  const canary = createStylePackageCanary({ directory: join(root, 'skills'), controlFile: join(root, STYLE_PACKAGE_CANARY_FILE),
    shadow, runner, allowsSession: sessionId => sessionId === 'pilot' });
  const baseDir = join(root, 'base'), newDir = join(root, 'candidate'), seedDir = join(root, 'seed');
  for (const path of [baseDir, newDir, seedDir]) fs.mkdirSync(path);
  const seed = join(seedDir, 'pilot.db');
  const create = async (db: string, resume: boolean, client: ChatCompletionClient, useCanary: boolean) => {
    const session = new ChatSession({ card, db, resume, useBge: false, contentMode: 'nsf', worldbooks: [],
      quietLogs: true, providerClient: client, skillSelectionObserver: runner, storyIndexIdleGraceMs: 0,
      stylePackageShadowRequired: () => true, stylePackageShadowRejected: input => shadow.rejectTurn(input),
      ...(useCanary ? { stylePackageCanary: canary } : {}) });
    openSession = session; await session.init(); return session;
  };
  const drain = async () => {
    for (let i = 0; i < 1000 && runner.snapshot().running; i++) await new Promise<void>(done => setImmediate(done));
    if (runner.snapshot().running) throw new Error('style-pair-shadow-not-drained');
  };
  const seedSession = await create(seed, false, synthetic, false);
  for (let i = 0; i < 20; i++) {
    const result = await seedSession.turn('合成输入：核对两份证词。', 'nsf', undefined, undefined, [], `seed:${i}`);
    assert.ok(result); await drain();
  }
  assert.equal(shadow.snapshot().succeeded, 20); assert.equal(shadow.snapshot().failed, 0);
  seedSession.close(); openSession = undefined;
  const source = new DatabaseSync(seed, { readOnly: true });
  try { await backup(source, join(baseDir, 'pilot.db')); await backup(source, join(newDir, 'pilot.db')); }
  finally { source.close(); }
  const history = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return digest(JSON.stringify(db.prepare('SELECT * FROM chat_log ORDER BY rowid').all())); } finally { db.close(); }
  };
  const baseDb = join(baseDir, 'pilot.db'), newDb = join(newDir, 'pilot.db');
  const historyDigest = history(baseDb); assert.equal(history(newDb), historyDigest);
  let upstream: ChatCompletionClient = synthetic;
  if (!fixture) {
    const { ProviderRegistry, createOpenAIProviderController, createRegistryProviderClient } =
      await import('../../packages/proxy/public/provider-runtime.ts');
    const instance = new ProviderRegistry(); registry = instance;
    instance.registerBuiltin('core.server', createOpenAIProviderController({ providerId: 'builtin.openai', kind: 'openai',
      baseUrl: 'https://api.deepseek.com', apiKey: key, model: 'deepseek-flash', prefixCacheThreshold: 1024,
      timeoutMs: 90_000 }).adapter);
    upstream = createRegistryProviderClient({ registry: instance,
      resolveSelection: () => ({ providerId: 'builtin.openai', model: 'deepseek-flash' }) });
  }
  const requests: ChatRequest[] = [];
  const calls: Array<{ streamDurationMs: number; usage: ChatResponse['usage']; finishReason: string }> = [];
  const maskStyle = (request: ChatRequest) => {
    let matched = 0;
    const visit = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replace(/<文风底座>\n[\s\S]*?\n<\/文风底座>/gu, () => {
        matched++; return '<文风底座>[masked]</文风底座>';
      });
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
      return value;
    };
    const masked = visit(request);
    if (matched !== 1) throw new Error('style-pair-style-carrier-invalid');
    return digest(JSON.stringify(masked));
  };
  const client: ChatCompletionClient = { capabilities: () => ({ stream: true, tools: true }), modelName: () => 'deepseek-flash',
    complete: async () => { throw new Error('style-pair-unexpected-complete'); },
    stream: async (request, onDelta, onToolArg, signal, call) => {
      if (requests.length >= 2 || call?.lane !== 'turn_final' || request.extraBody !== undefined) throw new Error('style-pair-call-invalid');
      const fixed = { ...request, model: 'deepseek-flash', max_tokens: 4096 };
      if (requests.length === 1 && maskStyle(requests[0]!) !== maskStyle(fixed)) {
        if (tightFixture) {
          // Only the known budget effects are expected here. Do not let an
          // unrelated mismatch accidentally make the negative fixture pass.
          const baseline = requests[0]!;
          assert.deepEqual({ ...baseline, messages: [] }, { ...fixed, messages: [] });
          assert.equal(baseline.messages.length, 12);
          assert.equal(fixed.messages.length, 10);
          assert.equal(maskStyle({ ...baseline, messages: baseline.messages.slice(0, 1) }),
            maskStyle({ ...fixed, messages: fixed.messages.slice(0, 1) }));
          assert.deepEqual(baseline.messages.slice(3, -1), fixed.messages.slice(1, -1));
          const oldTail = baseline.messages.at(-1), newTail = fixed.messages.at(-1);
          assert.equal(oldTail?.role, 'user'); assert.equal(newTail?.role, 'user');
          assert.equal(typeof oldTail?.content, 'string'); assert.equal(typeof newTail?.content, 'string');
          const oldText = oldTail!.content as string, newText = newTail!.content as string;
          const plan = /<上一轮编排>\n[\s\S]*?\n<\/上一轮编排>/u;
          assert.match(oldText, plan); assert.match(newText, plan);
          assert.doesNotMatch(oldText.match(plan)![0], /…\(已精简\)/u);
          assert.match(newText.match(plan)![0], /…\(已精简\)/u);
          assert.equal(oldText.replace(plan, '[plan]'), newText.replace(plan, '[plan]'));
        }
        throw new Error('style-pair-requests-not-comparable');
      }
      requests.push(structuredClone(fixed));
      const start = performance.now();
      const result = await upstream.stream(fixed, onDelta, onToolArg,
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90_000)]), { ...call, maxTransportAttempts: 1 });
      calls.push({ streamDurationMs: Math.round(performance.now() - start), usage: result.usage ?? null, finishReason: result.finishReason });
      return result;
    } };
  const input = '合成测试：旅人向图书管理员询问今晚的闭馆时间。';
  const baseline = await create(baseDb, true, client, false);
  const oldProse = await baseline.turn(input, 'nsf', undefined, undefined, [], 'pair:final');
  assert.ok(oldProse.trim()); baseline.close(); openSession = undefined; await drain();
  fs.writeFileSync(join(root, STYLE_PACKAGE_CANARY_FILE), JSON.stringify({ ack: STYLE_PACKAGE_CANARY_ACK,
    revision: 1, sessionId: 'pilot', packageDigest: STYLE_PACKAGE_SHADOW_PIN.packageDigest,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
  const candidate = await create(newDb, true, client, true);
  const newProse = await candidate.turn(input, 'nsf', undefined, undefined, [], 'pair:final');
  if (tightFixture) throw new Error('style-pair-tight-expected-mismatch');
  assert.ok(newProse.trim()); assert.equal(canary.snapshot().committed, 1);
  candidate.close(); openSession = undefined; await drain();
  assert.equal(requests.length, 2); assert.equal(calls.length, 2); assert.equal(physicalCalls, fixture ? 0 : 2);
  const requestDigests = requests.map(request => digest(JSON.stringify(request)));
  const maskedRequestDigests = requests.map(maskStyle);
  const requestChangedKeys = [...new Set([...Object.keys(requests[0]!), ...Object.keys(requests[1]!)])]
    .filter(name => JSON.stringify((requests[0] as unknown as Record<string, unknown>)[name]) !== JSON.stringify((requests[1] as unknown as Record<string, unknown>)[name])).sort();
  const messageDifferences = Array.from({ length: Math.max(requests[0]!.messages.length, requests[1]!.messages.length) }, (_, index) => {
    const left = requests[0]!.messages[index], right = requests[1]!.messages[index];
    const leftBytes = left === undefined ? null : JSON.stringify(left), rightBytes = right === undefined ? null : JSON.stringify(right);
    return leftBytes === rightBytes ? null : { index, baselineRole: left?.role ?? null, candidateRole: right?.role ?? null,
      baselineDigest: leftBytes === null ? null : digest(leftBytes), candidateDigest: rightBytes === null ? null : digest(rightBytes),
      baselineBytes: leftBytes === null ? null : Buffer.byteLength(leftBytes), candidateBytes: rightBytes === null ? null : Buffer.byteLength(rightBytes) };
  }).filter(Boolean);
  const report = { version: 'style-package-paired-acceptance-v1', scope: 'isolated-synthetic-session',
    provider: fixture ? 'synthetic' : 'https://api.deepseek.com', model: fixture ? 'synthetic-fixture' : 'deepseek-flash',
    modelIdentity: 'requested-only', physicalCalls, shadowCommits: 20, canaryCommits: 1, finalPromptBudgetTokens,
    historyDigest, requestDigests, maskedRequestDigests, onlyStyleDiffers: maskedRequestDigests[0] === maskedRequestDigests[1],
    comparisonScope: 'this-synthetic-session-and-budget-only',
    requestChangedKeys, messageDifferences, calls, prose: { baseline: oldProse, candidate: newProse },
    quality: 'not-evaluated', productionEquivalent: false };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (key && serialized.includes(key)) throw new Error('style-pair-evidence-invalid');
  if (output) fs.writeFileSync(output, serialized, { flag: 'wx' });
  console.log(JSON.stringify({ status: 'passed', fixture, physicalCalls, shadowCommits: 20,
    canaryCommits: 1, requestChangedKeys, onlyStyleDiffers: report.onlyStyleDiffers, ...(fixture ? { messageDifferences } : {}), ...(output ? { output } : {}) }));
} catch (error) {
  const reason = error instanceof assert.AssertionError ? 'verification-failed'
    : error instanceof Error && /^style-pair-[a-z-]+$/u.test(error.message) ? error.message : 'session-or-provider-failed';
  if (tightFixture && reason === 'style-pair-requests-not-comparable' && physicalCalls === 0)
    console.log(JSON.stringify({ status: 'not-comparable', fixture: true, finalPromptBudgetTokens: 5600, physicalCalls: 0, reason }));
  else {
    console.error(JSON.stringify({ status: 'failed', reason, physicalCalls }));
    process.exitCode = 1;
  }
} finally {
  try { openSession?.close(); } catch { console.error('style-pair-session-cleanup-failed'); process.exitCode = 1; }
  try { globalThis.fetch = originalFetch; await registry?.clear(); }
  catch { console.error('style-pair-provider-cleanup-failed'); process.exitCode = 1; }
  finally {
    for (const [name, value] of [['JG_USER_DATA_DIR', prior.data], ['JG_PG_ENABLED', prior.pg], ['JG_PG_DSN', prior.dsn],
      ['JG_API_KEY', prior.key], ['JG_MODEL_CONTEXT_TOKENS', prior.context], ['JG_FINAL_PROMPT_BUDGET_TOKENS', prior.budget],
      ['JG_TEST_CREDENTIAL_LOCKDOWN', prior.lockdown]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    if (root) try {
      if (!realRoot || fs.realpathSync(root) !== realRoot || !realRoot.startsWith(tempBase + sep) || !basename(realRoot).startsWith('jg-style-pair-'))
        throw new Error('style-pair-temp-invalid');
      fs.rmSync(realRoot, { recursive: true, force: true });
    } catch { console.error('style-pair-temp-cleanup-failed'); process.exitCode = 1; }
  }
}
