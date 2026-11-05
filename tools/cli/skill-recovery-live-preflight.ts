import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface SkillRecoveryLiveModel {
  readonly providerId: string; readonly modelId: string; readonly contextWindowTokens: number;
  readonly maxRequestInputTokens: number; readonly maxRequestOutputTokens: number; readonly requestSafetyMarginTokens: number;
  readonly inputMicrousdPerMillionTokens: number; readonly outputMicrousdPerMillionTokens: number;
}
export interface SkillRecoveryLiveModels { readonly main: SkillRecoveryLiveModel; readonly agent: SkillRecoveryLiveModel }
type FileRef = Readonly<{ path: string; sha256: string }>;
type Pair = Readonly<{ original: FileRef; copy: FileRef }>;
export interface SkillRecoveryLiveFixture {
  readonly version: 'skill-recovery-live-fixture-v1'; readonly isolatedRoot: string;
  readonly session: Pair; readonly skills: readonly Pair[]; readonly character: Pair;
  readonly worldbooks: readonly Pair[]; readonly turnInput: Pair; readonly models: SkillRecoveryLiveModels;
}
export interface SkillRecoveryLivePreflight {
  readonly fixture: SkillRecoveryLiveFixture; readonly fixtureDigest: string;
  readonly limits: Readonly<{ maxRuns: number; maxModelCalls: number; maxCostMicrousd: number }>;
}
const invalid = (): never => { throw new Error('skill-recovery-live-preflight-invalid'); };
const modelFields = ['providerId', 'modelId', 'contextWindowTokens', 'maxRequestInputTokens', 'maxRequestOutputTokens',
  'requestSafetyMarginTokens', 'inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens'] as const;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const row = value as Record<string, unknown>, descriptors = Object.getOwnPropertyDescriptors(row);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable
    || !Object.hasOwn(descriptors[key]!, 'value'))) invalid();
  return row;
}
function integer(value: unknown, min = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) invalid();
  return Number(value);
}
function model(value: unknown): SkillRecoveryLiveModel {
  const row = object(value, modelFields);
  if (row.providerId !== 'builtin.openai' || typeof row.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(row.modelId)) invalid();
  const result = { providerId: row.providerId as string, modelId: row.modelId as string,
    contextWindowTokens: integer(row.contextWindowTokens), maxRequestInputTokens: integer(row.maxRequestInputTokens),
    maxRequestOutputTokens: integer(row.maxRequestOutputTokens), requestSafetyMarginTokens: integer(row.requestSafetyMarginTokens, 0),
    inputMicrousdPerMillionTokens: integer(row.inputMicrousdPerMillionTokens),
    outputMicrousdPerMillionTokens: integer(row.outputMicrousdPerMillionTokens) };
  const used = result.maxRequestInputTokens + result.maxRequestOutputTokens + result.requestSafetyMarginTokens;
  if (!Number.isSafeInteger(used) || used > result.contextWindowTokens) invalid();
  return Object.freeze(result);
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || resolve(value) !== value) invalid();
  return value as string;
}
function pathIdentity(path: string, expected: 'directory' | 'file') {
  let cursor = path;
  for (;;) {
    const entry = lstatSync(cursor);
    if (entry.isSymbolicLink()) invalid();
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const actual = realpathSync(path);
  const compare = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
  if (compare(actual) !== compare(path)) invalid();
  const stat = lstatSync(path, { bigint: true });
  if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.size < 1n) invalid();
  return stat;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function file(value: unknown): FileRef {
  const row = object(value, ['path', 'sha256']);
  if (typeof row.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.sha256)) invalid();
  return Object.freeze({ path: absolute(row.path), sha256: row.sha256 as string });
}
function pair(value: unknown): Pair {
  const row = object(value, ['original', 'copy']);
  return Object.freeze({ original: file(row.original), copy: file(row.copy) });
}
function hashFile(ref: FileRef): { dev: bigint; ino: bigint } {
  const before = pathIdentity(ref.path, 'file');
  const fd = openSync(ref.path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) invalid();
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) { const length = readSync(fd, buffer, 0, buffer.length, null); if (!length) break; digest.update(buffer.subarray(0, length)); }
    const after = fstatSync(fd, { bigint: true }), current = pathIdentity(ref.path, 'file');
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || current.dev !== before.dev || current.ino !== before.ino
      || `sha256:${digest.digest('hex')}` !== ref.sha256) invalid();
    return { dev: before.dev, ino: before.ino };
  } finally { closeSync(fd); }
}
function hasPath(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function assertSqliteFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(16);
    if (readSync(fd, header, 0, header.length, 0) !== header.length
      || !header.equals(Buffer.from('SQLite format 3\0', 'ascii'))) invalid();
  } finally { closeSync(fd); }
}

/** Body-free local preflight only. Call again against trusted active model data immediately before use. */
export function skillRecoveryLivePreflight(args: readonly string[], actualModels: SkillRecoveryLiveModels): SkillRecoveryLivePreflight {
  try {
    if (!Array.isArray(args) || args.length !== 9 || args[0] !== '--live') invalid();
    const fields = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1]!;
      if (!['--fixture', '--max-runs', '--max-model-calls', '--max-cost-microusd'].includes(key) || fields.has(key)) invalid();
      fields.set(key, value);
    }
    const count = (key: string) => {
      const value = fields.get(key); if (!value || !/^[1-9][0-9]*$/u.test(value)) invalid();
      return integer(Number(value));
    };
    const maxRuns = count('--max-runs'), maxModelCalls = count('--max-model-calls'), maxCostMicrousd = count('--max-cost-microusd');
    if (maxRuns > 3 || maxModelCalls > 36 || maxModelCalls > maxRuns * 12) invalid();
    const fixturePath = absolute(fields.get('--fixture'));
    const fixtureStat = pathIdentity(fixturePath, 'file');
    if (fixtureStat.size > 131_072n) invalid();
    const raw: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const row = object(raw, ['version', 'isolatedRoot', 'session', 'skills', 'character', 'worldbooks', 'turnInput', 'models']);
    if (row.version !== 'skill-recovery-live-fixture-v1' || !Array.isArray(row.skills) || row.skills.length < 2
      || row.skills.length > 64 || !Array.isArray(row.worldbooks) || row.worldbooks.length < 1 || row.worldbooks.length > 64) invalid();
    const isolatedRoot = absolute(row.isolatedRoot); pathIdentity(isolatedRoot, 'directory');
    const listedModels = object(row.models, ['main', 'agent']);
    const trustedModels = object(actualModels, ['main', 'agent']);
    const fixture: SkillRecoveryLiveFixture = Object.freeze({ version: 'skill-recovery-live-fixture-v1', isolatedRoot,
      session: pair(row.session), skills: Object.freeze((row.skills as unknown[]).map(pair)), character: pair(row.character),
      worldbooks: Object.freeze((row.worldbooks as unknown[]).map(pair)), turnInput: pair(row.turnInput),
      models: Object.freeze({ main: model(listedModels.main), agent: model(listedModels.agent) }) });
    if (JSON.stringify(fixture.models) !== JSON.stringify({ main: model(trustedModels.main), agent: model(trustedModels.agent) })) invalid();
    const pairs = [fixture.session, ...fixture.skills, fixture.character, ...fixture.worldbooks, fixture.turnInput];
    const originals = new Set<string>(), copies = new Set<string>();
    for (const entry of pairs) {
      if (inside(isolatedRoot, entry.original.path) || !inside(isolatedRoot, entry.copy.path)
        || entry.original.sha256 !== entry.copy.sha256) invalid();
      const a = hashFile(entry.original), b = hashFile(entry.copy);
      const idA = `${a.dev}:${a.ino}`, idB = `${b.dev}:${b.ino}`;
      if (idA === idB || originals.has(idA) || copies.has(idB)) invalid();
      originals.add(idA); copies.add(idB);
    }
    if ([...originals].some(id => copies.has(id))) invalid();
    for (const path of [fixture.session.original.path, fixture.session.copy.path]) {
      if (hasPath(`${path}-wal`) || hasPath(`${path}-shm`) || hasPath(`${path}-journal`)) invalid();
      assertSqliteFile(path);
    }
    const fixtureDigest = `sha256:${createHash('sha256').update(JSON.stringify(fixture), 'utf8').digest('hex')}`;
    return Object.freeze({ fixture, fixtureDigest, limits: Object.freeze({ maxRuns, maxModelCalls, maxCostMicrousd }) });
  } catch { return invalid(); }
}
