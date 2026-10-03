#!/usr/bin/env node
/** P11：当前 P10 管线之上的可审计 APK 封包入口。 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL_VERSION, MAX_CLIENT_PROTOCOL_VERSION } from '../../packages/mobile-contracts/src/version.ts';
import { versionCodeFor } from './apk-release.ts';
import { apkCertificateSha256, apkManifestFacts, resolveAndroidSdk } from './android-tools.ts';
import { readJsonObjectFile } from './json-file.ts';
import { buildReleaseManifest, sha256FileBytes } from './release-manifest.ts';
import { planReleasePackage } from './packaging-plan.ts';
import { TOOLCHAIN } from './toolchain.ts';

const root = resolve(import.meta.dirname ?? '.', '..', '..');
const mobileDir = join(root, 'apps', 'mobile');
const runtimeDir = join(root, '.workbuddy', 'runtime');
const PACKAGE_RELEASE_USAGE = 'usage: package-release.ts [--debug|--release] [--check-only]';
const packageVersion = (path: string): string => String(readJsonObjectFile(path).version);

function capture(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} 失败：${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function run(command: string, commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit', shell });
  if (result.status !== 0) throw new Error(`${command} 失败（exit=${result.status ?? 'signal'}）`);
}

export interface PackageReleaseOptions {
  readonly buildType: 'debug' | 'release';
  readonly checkOnly: boolean;
  readonly help: boolean;
}

export function parsePackageReleaseArgs(argv: readonly string[]): PackageReleaseOptions {
  const allowed = new Set(['--debug', '--release', '--check-only', '--help', '-h']);
  const unknown = argv.find((arg) => !allowed.has(arg));
  if (unknown) throw new Error(`${PACKAGE_RELEASE_USAGE}; unknown argument: ${unknown}`);
  if (argv.includes('--debug') && argv.includes('--release')) {
    throw new Error(`${PACKAGE_RELEASE_USAGE}; --debug and --release are mutually exclusive`);
  }
  return {
    buildType: argv.includes('--release') ? 'release' : 'debug',
    checkOnly: argv.includes('--check-only'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

export interface PackageReleaseRuntime {
  readonly capture: typeof capture;
  readonly run: typeof run;
  readonly resolveAndroidSdk: typeof resolveAndroidSdk;
  readonly log: (...values: unknown[]) => void;
  readonly error: (...values: unknown[]) => void;
}

const defaultRuntime: PackageReleaseRuntime = {
  capture,
  run,
  resolveAndroidSdk,
  log: (...values) => console.log(...values),
  error: (...values) => console.error(...values),
};

export function runPackageReleaseCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  runtime: PackageReleaseRuntime = defaultRuntime,
): number {
  const options = parsePackageReleaseArgs(argv);
  if (options.help) {
    runtime.log(PACKAGE_RELEASE_USAGE);
    return 0;
  }

  const { buildType, checkOnly } = options;
  let endpoint = environment.JG_PINNED_ENDPOINT?.trim() ?? '';
  if (!endpoint) {
    const statePath = join(runtimeDir, 'private-host.json');
    if (existsSync(statePath)) endpoint = String(readJsonObjectFile(statePath).origin ?? '').trim();
  }
  const appVersion = environment.JG_APP_VERSION?.trim() || packageVersion(join(root, 'package.json'));
  const sdk = (() => {
    try { return runtime.resolveAndroidSdk(); } catch { return environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT; }
  })();
  const plan = planReleasePackage({
    hasMobileApp: existsSync(join(mobileDir, 'capacitor.config.ts')),
    hasGradlew: existsSync(join(mobileDir, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')),
    hasKeystoreProperties: existsSync(join(mobileDir, 'android', 'keystore.properties')),
    androidHome: sdk,
    jgPinnedEndpoint: endpoint,
    jgAppVersion: appVersion,
    buildType,
  });
  runtime.log('封包步骤:', plan.steps.join(' → '));
  if (!plan.feasible) {
    runtime.error('\n前置缺失，拒绝封包：\n  - ' + plan.missing.join('\n  - '));
    return 1;
  }
  if (buildType === 'release' && runtime.capture('git', ['status', '--porcelain'])) {
    runtime.error('release 封包要求 clean tree；请先提交或移走当前改动');
    return 1;
  }
  if (checkOnly) {
    runtime.log('\n前置检查通过（--check-only）。');
    return 0;
  }

  const versionCode = versionCodeFor(appVersion);
  const env: NodeJS.ProcessEnv = {
    ...environment,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    JG_PINNED_ENDPOINT: endpoint,
    JG_APP_VERSION: appVersion,
    JG_VERSION_CODE: String(versionCode),
    JG_BUILD_TYPE: buildType,
  };
  if (buildType === 'release') runtime.run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['test'], root, env);
  runtime.run(process.execPath, ['--experimental-strip-types', '--experimental-transform-types', 'scripts/build-android.ts'], mobileDir, env);

  const apkName = `app-${buildType}.apk`;
  const apkPath = join(mobileDir, 'android', 'app', 'build', 'outputs', 'apk', buildType, apkName);
  if (!existsSync(apkPath)) throw new Error(`APK 未生成: ${apkPath}`);
  const facts = apkManifestFacts(sdk!, apkPath);
  const expectedId = buildType === 'release' ? 'com.jiuguan.app' : 'com.jiuguan.app.dev';
  if (facts.applicationId !== expectedId || facts.versionName !== appVersion || facts.versionCode !== versionCode) {
    throw new Error(`APK 身份与构建计划不一致：${JSON.stringify(facts)}`);
  }
  const certificateSha256 = apkCertificateSha256(sdk!, apkPath);
  const artifactName = `jiuguan-${buildType}-${appVersion}.apk`;
  const artifactBytes = readFileSync(apkPath);
  const manifest = buildReleaseManifest({
    buildType,
    gitCommit: runtime.capture('git', ['rev-parse', 'HEAD']),
    builtAt: new Date().toISOString(),
    apiOrigin: endpoint,
    application: { ...facts, applicationId: facts.applicationId as typeof expectedId },
    components: {
      server: packageVersion(join(root, 'package.json')),
      web: packageVersion(join(root, 'apps', 'web', 'package.json')),
      plugin: packageVersion(join(root, 'plugins', 'commandcode-provider', 'package.json')),
      mobile: packageVersion(join(root, 'apps', 'mobile', 'package.json')),
    },
    protocol: { api: API_PROTOCOL_VERSION, minClient: MIN_CLIENT_PROTOCOL_VERSION, maxClient: MAX_CLIENT_PROTOCOL_VERSION },
    artifact: { fileName: artifactName, bytes: statSync(apkPath).size, sha256: sha256FileBytes(artifactBytes) },
    signing: { scheme: buildType === 'release' ? 'release-keystore' : 'android-debug', certificateSha256 },
    toolchain: {
      node: process.version.slice(1), pnpm: TOOLCHAIN.pnpm, jdk: TOOLCHAIN.jdk,
      gradle: TOOLCHAIN.gradleWrapper, compileSdk: TOOLCHAIN.compileSdk, capacitor: TOOLCHAIN.capacitor,
    },
  });

  const distRoot = join(root, 'dist-release');
  const releaseId = `${appVersion}-${buildType}-${manifest.gitCommit.slice(0, 12)}`;
  const staging = join(distRoot, `.staging-${releaseId}`);
  const target = join(distRoot, 'releases', releaseId);
  if (existsSync(staging) || existsSync(target)) throw new Error(`发布目录已存在：${releaseId}`);
  mkdirSync(staging, { recursive: true });
  copyFileSync(apkPath, join(staging, artifactName));
  writeFileSync(join(staging, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  mkdirSync(join(distRoot, 'releases'), { recursive: true });
  renameSync(staging, target);
  const pointerTmp = join(distRoot, 'current.json.tmp');
  writeFileSync(pointerTmp, `${JSON.stringify({ manifest: `releases/${releaseId}/release-manifest.json` })}\n`, 'utf8');
  renameSync(pointerTmp, join(distRoot, 'current.json'));
  runtime.log(`\n封包完成: dist-release/releases/${releaseId}/${artifactName}`);
  runtime.log(`APK SHA-256: ${manifest.artifact.sha256}`);
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runPackageReleaseCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'package-release-failed');
    process.exitCode = 1;
  }
}
