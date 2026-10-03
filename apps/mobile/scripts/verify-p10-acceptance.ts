#!/usr/bin/env node
/**
 * P10-11/P10-12 可重复验收入口。
 *
 *   pnpm p10:verify:release  # 真实 tailnet endpoint + 正式 release 签名 + APK 审计
 *   pnpm p10:verify:device   # 已授权设备 + debug APK 审计 + instrumentation
 *   pnpm p10:verify          # 两项都执行
 *
 * endpoint 优先读取 JG_PINNED_ENDPOINT；未设置时只读取私有启动器生成的
 * `.workbuddy/runtime/private-host.json`。本脚本不会自行启动/停止 Tailscale。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const mobileDir = resolve(import.meta.dirname ?? '.', '..');
const repoDir = resolve(mobileDir, '..', '..');
const androidDir = join(mobileDir, 'android');
const runtimeDir = join(repoDir, '.workbuddy', 'runtime');
const evidencePath = join(runtimeDir, 'p10-acceptance.json');
const args = new Set(process.argv.slice(2));
const runRelease = !args.has('--device-only');
const runDevice = !args.has('--release-only');

if (args.has('--device-only') && args.has('--release-only')) {
  throw new Error('--device-only 与 --release-only 不能同时使用');
}

function exactTailnetOrigin(): string {
  let value = process.env.JG_PINNED_ENDPOINT?.trim() ?? '';
  if (!value) {
    const statePath = join(runtimeDir, 'private-host.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { origin?: unknown };
      if (typeof state.origin === 'string') value = state.origin.trim();
    }
  }
  if (!value) {
    throw new Error('缺少真实 endpoint：先运行 pnpm private:start，或设置 JG_PINNED_ENDPOINT');
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.username || parsed.password || !parsed.hostname.toLowerCase().endsWith('.ts.net')) {
    throw new Error('P10 验收只接受无路径/query/凭据的真实 https://*.ts.net origin');
  }
  return parsed.origin;
}

function resolveSdk(): string {
  const configured = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const conventional = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
    : '';
  const sdk = configured || conventional;
  if (!sdk || !existsSync(join(sdk, 'platform-tools'))) {
    throw new Error('缺少 Android SDK；请设置 ANDROID_HOME/ANDROID_SDK_ROOT');
  }
  return sdk;
}

function command(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(
  executable: string,
  commandArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  console.log(`\n$ ${basename(executable)} ${commandArgs.join(' ')}`);
  const needsWindowsCommandShell = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(executable);
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env,
    stdio: 'inherit',
    shell: needsWindowsCommandShell,
  });
  if (result.status !== 0) {
    throw new Error(`${basename(executable)} 失败（exit=${result.status ?? 'signal'}）`);
  }
}

function capture(executable: string, commandArgs: string[], cwd = repoDir): string {
  const result = spawnSync(executable, commandArgs, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    throw new Error(`${basename(executable)} ${commandArgs.join(' ')} 失败：${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function latestBuildToolsDir(sdk: string): string {
  const candidates = readdirSync(join(sdk, 'build-tools'))
    .map((version) => ({ version, parts: version.split('.').map((part) => Number(part) || 0) }))
    .sort((left, right) => {
      for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
        const delta = (right.parts[i] ?? 0) - (left.parts[i] ?? 0);
        if (delta) return delta;
      }
      return 0;
    })
    .map(({ version }) => join(sdk, 'build-tools', version))
    .filter((path) => existsSync(join(path, 'lib', 'apksigner.jar')));
  if (!candidates[0]) throw new Error('Android build-tools 缺少 apksigner.jar');
  return candidates[0];
}

function signerDigest(sdk: string, apk: string): string {
  const configuredJava = process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : '';
  const java = configuredJava && existsSync(configuredJava) ? configuredJava : 'java';
  const signerJar = join(latestBuildToolsDir(sdk), 'lib', 'apksigner.jar');
  const output = capture(java, ['-jar', signerJar, 'verify', '--print-certs', apk]);
  const match = output.match(/certificate SHA-256 digest:\s*([0-9a-f]+)/i);
  if (!match) throw new Error('apksigner 未返回证书 SHA-256 指纹');
  return match[1].toLowerCase();
}

function authorizedDevices(adb: string): string[] {
  return capture(adb, ['devices', '-l']).split(/\r?\n/).slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\sdevice(?:\s|$)/.test(line))
    .map((line) => line.split(/\s+/, 1)[0]);
}

const endpoint = exactTailnetOrigin();
const sdk = resolveSdk();
const version = process.env.JG_APP_VERSION?.trim()
  || (JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')) as { version: string }).version;
const commonEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  JG_PINNED_ENDPOINT: endpoint,
  JG_APP_VERSION: version,
};
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: capture('git', ['rev-parse', 'HEAD']),
  endpointHost: new URL(endpoint).hostname,
  appVersion: version,
  release: { passed: false },
  device: { passed: false },
};

if (runRelease) {
  if (!existsSync(join(androidDir, 'keystore.properties'))) {
    throw new Error('P10-11 缺少 android/keystore.properties；拒绝生成错误签名身份的 release');
  }
  run(process.execPath, [
    '--experimental-strip-types', '--experimental-transform-types',
    'scripts/build-android.ts',
  ], mobileDir, { ...commonEnv, JG_BUILD_TYPE: 'release' });
  const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  evidence.release = {
    passed: true,
    apkSha256: sha256(apk),
    signerCertificateSha256: signerDigest(sdk, apk),
  };
}

if (runDevice) {
  const adb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  const devices = authorizedDevices(adb);
  if (devices.length === 0) {
    throw new Error('P10-12 没有已授权 Android 设备；请连接设备并确认 USB 调试授权');
  }
  run(process.execPath, [
    '--experimental-strip-types', '--experimental-transform-types',
    'scripts/build-android.ts',
  ], mobileDir, { ...commonEnv, JG_BUILD_TYPE: 'debug' });
  const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  run(gradlew, ['connectedDebugAndroidTest'], androidDir, commonEnv);
  evidence.device = {
    passed: true,
    devices: devices.map((serial) => ({
      serialSha256: createHash('sha256').update(serial).digest('hex'),
      model: capture(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model']),
      android: capture(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release']),
      sdk: capture(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk']),
    })),
  };
}

mkdirSync(runtimeDir, { recursive: true });
const temporary = evidencePath + '.tmp';
writeFileSync(temporary, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
renameSync(temporary, evidencePath);
console.log(`\nP10 验收通过；证据已写入 ${evidencePath}`);
