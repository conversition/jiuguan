#!/usr/bin/env node
/** P11-02：只读 mobile doctor；不安装工具、不启动 Tailscale。 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adbPathFor, resolveAndroidSdk } from './android-tools.ts';
import { parseAdbDevices } from './packaging-plan.ts';
import { doctorSummary, runDoctorChecks, verifyGradleWrapper } from './toolchain.ts';

const root = resolve(import.meta.dirname ?? '.', '..', '..');
const androidDir = join(root, 'apps', 'mobile', 'android');
const capture = (command: string, args: string[]): string | undefined => {
  const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : undefined;
};
let sdk: string | undefined;
let adb: string | undefined;
let hasDevice = false;
try {
  sdk = resolveAndroidSdk(); adb = adbPathFor(sdk);
  hasDevice = parseAdbDevices(capture(adb, ['devices', '-l']) ?? '').ready.length > 0;
} catch { /* 由 doctor 输出缺失 */ }
const checks = runDoctorChecks({
  nodeVersion: process.version.slice(1),
  pnpmVersion: capture(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version']),
  javaVersionOutput: capture('java', ['-version']),
  androidHome: sdk,
  adbExists: (path) => existsSync(path),
  hasGradlew: existsSync(join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')),
  gitClean: capture('git', ['status', '--porcelain']) === '',
  hasKeystoreProperties: existsSync(join(androidDir, 'keystore.properties')),
  hasMobileApp: existsSync(join(root, 'apps', 'mobile', 'capacitor.config.ts')),
  buildType: process.argv.includes('--release') ? 'release' : 'debug',
  hasAuthorizedDevice: hasDevice,
});
const wrapperPath = join(androidDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
if (existsSync(wrapperPath)) checks.push(verifyGradleWrapper(readFileSync(wrapperPath, 'utf8')));
for (const check of checks) console.log(`${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`);
process.exit(doctorSummary(checks).ok ? 0 : 1);
