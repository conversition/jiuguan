#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PROTOCOL_VERSION, MAX_CLIENT_PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL_VERSION } from '../../packages/mobile-contracts/src/version.ts';
import { SCHEMA_VERSION as MEMORY_SCHEMA_VERSION } from '../../packages/memory/src/schema.ts';
import { AUTH_SCHEMA_VERSION } from '../../packages/server-auth/src/schema.ts';
import { TURN_JOB_SCHEMA_VERSION } from '../../apps/server/turn-job-manager.ts';
import { MAINTENANCE_JOB_SCHEMA_VERSION } from '../../apps/server/maintenance-job-manager.ts';
import { INTERACTIVE_LEDGER_SCHEMA_VERSION } from '../../apps/server/interactive-call-ledger.ts';
import { MODEL_USAGE_SCHEMA_VERSION } from '../../apps/server/model-usage-ledger.ts';
import { AGENT_ADMISSION_SCHEMA_VERSION } from '../../apps/server/agent-admission-ledger.ts';
import { AGENT_LEARNING_SCHEMA_VERSION } from '../../apps/server/agent-learning-ledger.ts';
import { ARC_PROJECTION_SCHEMA_VERSION } from '../../apps/server/arc-projection-store.ts';
import { AGENT_CONTROL_SCHEMA_VERSION } from '../../apps/server/agent-control-store.ts';
import { DSH_HOST_API_VERSION } from '../../packages/plugin/src/dsh-host.ts';
import { beginReleaseDrain, endReleaseDrain } from '../../apps/server/release-drain.ts';
import { readJsonObjectFile } from './json-file.ts';
import {
  activateRelease,
  currentRelease,
  layoutFor,
  listReleases,
  rollbackTo,
  stageRelease,
  type ReleaseHostLayout,
} from './compat-matrix.ts';
import {
  assertRollbackCompatible,
  exactHttpsTailnetOrigin,
  loadHostRelease,
  sha256File,
  type HostReleaseManifest,
} from './host-release-manifest.ts';

const repo = resolve(import.meta.dirname ?? '.', '..', '..');
const layout = layoutFor(join(repo, '.workbuddy', 'host-release'));
const runtimeStatePath = join(repo, '.workbuddy', 'runtime', 'private-host.json');
const MAX_DRAIN_WAIT_MS = 28 * 60_000;
const HOST_RELEASE_USAGE = 'usage: release:host prepare [--check-only] [--endpoint=<origin>] [--release-id=<id>] | activate <id> [--data-dir=<path>] [--timeout-ms=<ms>] | rollback <id> [--data-dir=<path>] [--timeout-ms=<ms>] | status';

function argValue(name: string, argv: readonly string[] = process.argv.slice(2)): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function packageVersion(path: string): string {
  const version = readJsonObjectFile(path).version;
  if (typeof version !== 'string') throw new Error(`package version missing: ${path}`);
  return version;
}

export function writeCommandCodeProviderReleasePackage(
  pluginDir: string,
  version: string,
): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('host-release-plugin-version-invalid');
  }
  const packageJson = {
    name: 'commandcode-provider',
    version,
    private: true,
    type: 'module',
    main: 'index.js',
    jiuguan: { hostApi: DSH_HOST_API_VERSION },
  } as const;
  writeFileSync(
    join(pluginDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

export interface HostReleaseRuntime {
  readonly capture: typeof capture;
  readonly run: typeof run;
  readonly log: (...values: unknown[]) => void;
}

const defaultRuntime: HostReleaseRuntime = {
  capture,
  run,
  log: (...values) => console.log(...values),
};

function endpoint(argv: readonly string[], environment: NodeJS.ProcessEnv): string {
  const explicit = argValue('endpoint', argv) ?? environment.JG_PINNED_ENDPOINT;
  if (explicit) return exactHttpsTailnetOrigin(explicit);
  if (existsSync(runtimeStatePath)) {
    const origin = readJsonObjectFile(runtimeStatePath).origin;
    if (typeof origin === 'string') return exactHttpsTailnetOrigin(origin);
  }
  throw new Error('host-release-endpoint-required');
}

function dataDir(argv: readonly string[], environment: NodeJS.ProcessEnv): string {
  const explicit = argValue('data-dir', argv) ?? environment.JG_USER_DATA_DIR;
  if (explicit) return resolve(explicit);
  if (existsSync(runtimeStatePath)) {
    const value = readJsonObjectFile(runtimeStatePath).dataDir;
    if (typeof value === 'string' && value) return resolve(value);
  }
  return join(repo, 'data');
}

function activeCount(path: string, sql: string): number {
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000;');
    const row = db.prepare(sql).get() as { count: number };
    if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error('host-release-active-count-invalid');
    return row.count;
  } finally { db.close(); }
}

export function activeHostJobs(root: string): { turn: number; maintenance: number } {
  return {
    turn: activeCount(join(root, 'turn-jobs.sqlite'),
      "SELECT count(*) count FROM turn_job WHERE status IN ('queued','running','recovering')"),
    maintenance: activeCount(join(root, 'maintenance-jobs.sqlite'),
      "SELECT count(*) count FROM maintenance_job WHERE status='running'"),
  };
}

export function parseHostReleaseTimeout(raw: string | undefined): number {
  const value = raw === undefined ? 120_000 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_DRAIN_WAIT_MS) {
    throw new Error('host-release-timeout-invalid');
  }
  return value;
}

export function restoreHostReleasePointer(targetLayout: ReleaseHostLayout, previousReleaseId: string | null): void {
  if (previousReleaseId) {
    rollbackTo(targetLayout, previousReleaseId);
  } else if (existsSync(targetLayout.pointerPath)) {
    unlinkSync(targetLayout.pointerPath);
  }
}

async function waitForDrain(root: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const active = activeHostJobs(root);
    if (active.turn === 0 && active.maintenance === 0) return;
    if (Date.now() >= deadline) throw new Error(`host-release-drain-timeout turn=${active.turn} maintenance=${active.maintenance}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
}

function buildManifest(releaseId: string, commit: string, apiOrigin: string): HostReleaseManifest {
  const rootVersion = packageVersion(join(repo, 'package.json'));
  const webVersion = packageVersion(join(repo, 'apps', 'web', 'package.json'));
  const pluginVersion = packageVersion(join(repo, 'plugins', 'commandcode-provider', 'package.json'));
  if (rootVersion !== webVersion) throw new Error('host-release-component-version-mismatch');
  const runtimeEntry = 'dist-runtime/apps/server/server.js';
  const webEntry = 'web/index.html';
  const pluginEntry = 'plugin/index.js';
  return {
    version: 2,
    releaseId,
    commit,
    apiOrigin,
    components: { server: rootVersion, web: webVersion, plugin: pluginVersion },
    protocol: { api: API_PROTOCOL_VERSION, minClient: MIN_CLIENT_PROTOCOL_VERSION, maxClient: MAX_CLIENT_PROTOCOL_VERSION },
    schemas: {
      memory: MEMORY_SCHEMA_VERSION,
      auth: AUTH_SCHEMA_VERSION,
      turnJobs: TURN_JOB_SCHEMA_VERSION,
      maintenance: MAINTENANCE_JOB_SCHEMA_VERSION,
      interactiveLedger: INTERACTIVE_LEDGER_SCHEMA_VERSION,
      modelUsage: MODEL_USAGE_SCHEMA_VERSION,
      agentAdmission: AGENT_ADMISSION_SCHEMA_VERSION,
      agentLearning: AGENT_LEARNING_SCHEMA_VERSION,
      arcProjection: ARC_PROJECTION_SCHEMA_VERSION,
      agentControl: AGENT_CONTROL_SCHEMA_VERSION,
    },
    artifacts: {
      runtimeEntry, runtimeSha256: sha256File(join(layout.stagingDir, runtimeEntry)),
      webEntry, webSha256: sha256File(join(layout.stagingDir, webEntry)),
      pluginEntry, pluginSha256: sha256File(join(layout.stagingDir, pluginEntry)),
    },
  };
}

export function prepareHostRelease(
  argv: readonly string[],
  checkOnly: boolean,
  runtime: HostReleaseRuntime = defaultRuntime,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (runtime.capture('git', ['status', '--porcelain'])) throw new Error('host-release-requires-clean-tree');
  const commit = runtime.capture('git', ['rev-parse', 'HEAD']);
  const apiOrigin = endpoint(argv, environment);
  const version = packageVersion(join(repo, 'package.json'));
  const releaseId = argValue('release-id', argv) ?? `${version}-${commit.slice(0, 12)}`;
  if (existsSync(layout.stagingDir)) {
    if (readdirSync(layout.stagingDir).length > 0) throw new Error('host-release-staging-not-empty');
  }
  if (checkOnly) {
    runtime.log(JSON.stringify({ ok: true, command: 'prepare-check', releaseId, apiOrigin }));
    return;
  }
  runtime.run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['test']);
  runtime.run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build']);
  if (existsSync(layout.stagingDir)) {
    rmSync(layout.stagingDir, { force: false });
  }
  mkdirSync(layout.stagingDir, { recursive: true });
  cpSync(join(repo, 'dist-runtime'), join(layout.stagingDir, 'dist-runtime'), { recursive: true, errorOnExist: true });
  cpSync(join(repo, 'apps', 'web', 'dist'), join(layout.stagingDir, 'web'), { recursive: true, errorOnExist: true });
  mkdirSync(join(layout.stagingDir, 'plugin'), { recursive: true });
  cpSync(join(repo, 'plugins', 'commandcode-provider', 'bundle', 'index.js'), join(layout.stagingDir, 'plugin', 'index.js'));
  writeCommandCodeProviderReleasePackage(
    join(layout.stagingDir, 'plugin'),
    packageVersion(join(repo, 'plugins', 'commandcode-provider', 'package.json')),
  );
  const manifest = buildManifest(releaseId, commit, apiOrigin);
  writeFileSync(join(layout.stagingDir, 'host-release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  stageRelease(layout, releaseId, { commit, apiOrigin });
  loadHostRelease(layout, releaseId);
  console.log(JSON.stringify({ ok: true, command: 'prepare', releaseId }));
}

function managedServerRunning(): boolean {
  if (!existsSync(runtimeStatePath)) return false;
  const pid = Number(readJsonObjectFile(runtimeStatePath).pid);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function launcher(action: 'start' | 'stop', runtime: HostReleaseRuntime): void {
  runtime.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(repo, 'tools', 'windows', 'jiuguan-private.ps1'), '-Action', action]);
}

async function switchRelease(
  releaseId: string,
  rollback: boolean,
  argv: readonly string[],
  runtime: HostReleaseRuntime,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const target = loadHostRelease(layout, releaseId);
  const currentId = currentRelease(layout);
  if (currentId) assertRollbackCompatible(loadHostRelease(layout, currentId), target);
  if (existsSync(runtimeStatePath)) {
    const runningOrigin = readJsonObjectFile(runtimeStatePath).origin;
    if (typeof runningOrigin === 'string' && exactHttpsTailnetOrigin(runningOrigin) !== target.apiOrigin) {
      throw new Error('host-release-running-origin-mismatch');
    }
  }
  const root = dataDir(argv, environment);
  const timeoutMs = parseHostReleaseTimeout(argValue('timeout-ms', argv));
  const lease = beginReleaseDrain({ dataDir: root, releaseId, ttlMs: timeoutMs + 2 * 60_000 });
  const wasRunning = managedServerRunning();
  let pointerChanged = false;
  try {
    await waitForDrain(root, timeoutMs);
    if (wasRunning) launcher('stop', runtime);
    if (rollback) rollbackTo(layout, releaseId); else activateRelease(layout, releaseId);
    pointerChanged = true;
    if (wasRunning) launcher('start', runtime);
    endReleaseDrain(root, lease.token);
    console.log(JSON.stringify({ ok: true, command: rollback ? 'rollback' : 'activate', releaseId, restarted: wasRunning }));
  } catch (error) {
    let recoveryError: unknown;
    if (pointerChanged) {
      try { restoreHostReleasePointer(layout, currentId); } catch (restoreError) { recoveryError = restoreError; }
    }
    if (wasRunning && !managedServerRunning()) {
      try { launcher('start', runtime); } catch (restartError) { recoveryError ??= restartError; }
    }
    try { endReleaseDrain(root, lease.token); } catch { /* 过期/损坏留给运维诊断。 */ }
    if (recoveryError) throw new AggregateError([error, recoveryError], 'host-release-recovery-failed');
    throw error;
  }
}

function assertAllowedOptions(
  argv: readonly string[],
  booleanOptions: readonly string[],
  valueOptions: readonly string[],
): void {
  const invalid = argv.find((value) => {
    if (booleanOptions.some((name) => value === `--${name}`)) return false;
    const match = /^--([^=]+)=(.+)$/.exec(value);
    return !match || !valueOptions.includes(match[1]!);
  });
  if (invalid) throw new Error(`${HOST_RELEASE_USAGE}; unknown option: ${invalid}`);
}

export async function runHostReleaseCli(
  argv: readonly string[],
  runtime: HostReleaseRuntime = defaultRuntime,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    runtime.log(HOST_RELEASE_USAGE);
    return;
  }
  const command = argv[0];
  if (command === 'prepare') {
    assertAllowedOptions(argv.slice(1), ['check-only'], ['endpoint', 'release-id']);
    return prepareHostRelease(argv, argv.includes('--check-only'), runtime, environment);
  }
  if (command === 'activate' || command === 'rollback') {
    assertAllowedOptions(argv.slice(2), [], ['data-dir', 'timeout-ms']);
    const releaseId = argv[1];
    if (!releaseId) throw new Error('host-release-id-required');
    return switchRelease(releaseId, command === 'rollback', argv, runtime, environment);
  }
  if (command === 'status') {
    if (argv.length !== 1) throw new Error(HOST_RELEASE_USAGE);
    const current = currentRelease(layout);
    const manifest = current ? loadHostRelease(layout, current) : null;
    runtime.log(JSON.stringify({ current, releases: listReleases(layout), manifest }));
    return;
  }
  throw new Error(HOST_RELEASE_USAGE);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  void runHostReleaseCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'host-release-failed');
    process.exitCode = 1;
  });
}
