#!/usr/bin/env node
/**
 * P10-09 CLI：Android 构建管线。用法：
 *   node scripts/build-android.mjs --check-only   # 只体检前置
 *   node scripts/build-android.mjs                # 执行：prepare-www → cap sync → gradlew
 * 环境变量：JG_PINNED_ENDPOINT / JG_APP_VERSION / JG_BUILD_TYPE / ANDROID_HOME
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planAndroidBuild } from '../src/build-pipeline.ts';
import { CAPACITOR_APP_ORIGIN } from '../../../packages/mobile-contracts/src/platform.ts';

const mobileDir = resolve(import.meta.dirname ?? '.', '..');
const projectDir = resolve(mobileDir, '..', '..');
const androidDir = join(mobileDir, 'android');
const checkOnly = process.argv.includes('--check-only');
const buildType: 'debug' | 'release' = process.env.JG_BUILD_TYPE === 'release' ? 'release' : 'debug';
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const env = {
  androidHome: process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT,
  jgPinnedEndpoint: process.env.JG_PINNED_ENDPOINT,
  jgAppVersion: process.env.JG_APP_VERSION,
  buildType,
  hasGradlew: existsSync(join(androidDir, 'gradlew')) || existsSync(join(androidDir, 'gradlew.bat')),
  hasKeystoreProperties: existsSync(join(androidDir, 'keystore.properties')),
};

const plan = planAndroidBuild(env);
console.log(`构建类型: ${env.buildType}`);
console.log('步骤:', plan.steps.join(' → '));
if (!plan.feasible) {
  console.error('\n前置缺失，拒绝构建：');
  for (const item of plan.missing) console.error(`  - ${item}`);
  process.exit(1);
}
if (checkOnly) {
  console.log('\n前置检查通过（--check-only，未执行构建）。');
  process.exit(0);
}

// 执行：android profile Web build → prepare-www → cap sync → gradlew
const run = (command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): number => {
  console.log(`\n$ ${command} ${args.join(' ')}  (cwd=${cwd})`);
  // Windows 只需要通过 shell 解析 Gradle 的 .bat 入口。其余命令必须直接
  // spawn，否则工作区/APK 绝对路径中的空格会被 cmd.exe 再次拆词，导致
  // apkanalyzer 把路径片段误当成 CLI 参数。
  const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    console.error(`步骤失败（exit=${result.status ?? 'signal'}）: ${command}`);
    return result.status ?? 1;
  }
  return 0;
};

let exit = 0;
exit ||= run(pnpmCommand, ['--filter', '@jiuguan/web', 'build'], projectDir, {
  VITE_JG_CLIENT_PROFILE: 'android-bundled',
  VITE_API_BASE: env.jgPinnedEndpoint!,
});
exit ||= run('node', [
  '--experimental-strip-types', '--experimental-transform-types', 'scripts/prepare-www.ts',
], mobileDir);
if (exit === 0) {
  exit ||= run(pnpmCommand, ['exec', 'cap', 'sync', 'android'], mobileDir, {
    JG_BUILD_TYPE: env.buildType,
    JG_CAPACITOR_APP_ORIGIN: CAPACITOR_APP_ORIGIN,
  });
}

const versionCodeFor = (version: string): number => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/.exec(version);
  if (!match) throw new TypeError('JG_APP_VERSION 无法编码为 Android versionCode');
  const major = Number(match[1]); const minor = Number(match[2]); const patch = Number(match[3]);
  if (major > 999 || minor > 99 || patch > 99) throw new TypeError('JG_APP_VERSION 段超出 versionCode 编码范围');
  return major * 10_000 + minor * 100 + patch;
};
const versionCode = versionCodeFor(env.jgAppVersion!);
if (exit === 0) {
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  exit ||= run(gradlew, [`assemble${env.buildType === 'release' ? 'Release' : 'Debug'}`], androidDir, {
    JG_CAPACITOR_APP_ORIGIN: CAPACITOR_APP_ORIGIN,
    JG_VERSION_CODE: String(versionCode),
  });
}
if (exit === 0) {
  const apkName = env.buildType === 'release' ? 'app-release.apk' : 'app-debug.apk';
  exit ||= run('node', [
    '--experimental-strip-types', '--experimental-transform-types', 'scripts/audit-apk.ts',
    join(androidDir, 'app', 'build', 'outputs', 'apk', env.buildType, apkName),
    ...(env.buildType === 'debug' ? ['--allow-debuggable'] : []),
  ], mobileDir);
}
process.exit(exit);
