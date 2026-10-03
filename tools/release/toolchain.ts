/**
 * P11-01/P11-02：固定工具链矩阵 + mobile:doctor 检查（不自动安装任何工具）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** P11-01：固定工具链。变更这里必须同时更新报告与 CI 说明。 */
export const TOOLCHAIN = Object.freeze({
  node: '22.22.2',
  pnpm: '10.33.0',
  jdk: 17,
  gradleWrapper: '8.2.1',
  compileSdk: 34,
  minSdk: 23,
  targetSdk: 34,
  capacitor: '6.2.2',
});

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorEnv {
  nodeVersion: string;
  pnpmVersion?: string | undefined;
  javaVersionOutput?: string | undefined;
  androidHome?: string | undefined;
  adbExists(path: string): boolean;
  hasGradlew: boolean;
  gitClean: boolean;
  hasKeystoreProperties: boolean;
  hasMobileApp: boolean;
  buildType?: 'debug' | 'release';
  hasAuthorizedDevice?: boolean;
}

function parseJavaMajor(output: string): number | null {
  const match = /(?:version|"|)(\d+)\.(\d+)/.exec(output) ?? /(\d+)/.exec(output);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : null;
}

/** mobile:doctor 的纯检查逻辑；CLI 只负责执行与展示。 */
export function runDoctorChecks(env: DoctorEnv): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: 'Node 版本',
    ok: env.nodeVersion === TOOLCHAIN.node,
    detail: `${env.nodeVersion}（要求 ${TOOLCHAIN.node}）`,
  });
  checks.push({
    name: 'pnpm 版本',
    ok: env.pnpmVersion === TOOLCHAIN.pnpm,
    detail: env.pnpmVersion ? `${env.pnpmVersion}（要求 ${TOOLCHAIN.pnpm}）` : '未检测到',
  });
  const javaMajor = env.javaVersionOutput ? parseJavaMajor(env.javaVersionOutput) : null;
  checks.push({
    name: 'JDK 版本',
    ok: javaMajor === TOOLCHAIN.jdk,
    detail: javaMajor ? `${javaMajor}（要求 ${TOOLCHAIN.jdk}）` : env.javaVersionOutput ?? '未检测到',
  });
  const adbPath = env.androidHome
    ? join(env.androidHome, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
    : null;
  checks.push({
    name: 'Android SDK/adb',
    ok: Boolean(env.androidHome && adbPath && env.adbExists(adbPath)),
    detail: adbPath && env.adbExists(adbPath) ? adbPath : 'ANDROID_HOME 未设置或 adb 缺失',
  });
  checks.push({ name: 'android 平台（gradlew）', ok: env.hasGradlew, detail: env.hasGradlew ? '存在' : '缺失' });
  checks.push({ name: 'apps/mobile 存在（P10 合入）', ok: env.hasMobileApp, detail: env.hasMobileApp ? '存在' : '缺失' });
  checks.push({
    name: '已授权 Android 设备',
    ok: env.hasAuthorizedDevice === true,
    detail: env.hasAuthorizedDevice ? '至少一台 device' : '无（封包可继续，安装/真机验收不可继续）',
  });
  checks.push({
    name: '签名配置',
    ok: env.buildType !== 'release' || env.hasKeystoreProperties,
    detail: env.hasKeystoreProperties ? 'keystore.properties 已配置' : '未配置（release 打包会被拒绝）',
  });
  checks.push({
    name: '工作区干净',
    ok: env.gitClean,
    detail: env.gitClean ? '干净' : '有未提交改动（release 打包前必须 clean）',
  });
  return checks;
}

export function doctorSummary(checks: DoctorCheck[]): { ok: boolean; failed: DoctorCheck[] } {
  const failed = checks.filter((check) => !check.ok);
  return { ok: failed.length === 0, failed };
}

/** P11-01 parity：gradle wrapper properties 与固定矩阵一致。 */
export function verifyGradleWrapper(propertiesContent: string): DoctorCheck {
  const match = /distributionUrl=.*gradle-([0-9.]+)-/.exec(propertiesContent);
  const version = match?.[1] ?? 'unknown';
  return {
    name: 'Gradle wrapper 版本',
    ok: version === TOOLCHAIN.gradleWrapper,
    detail: `${version}（要求 ${TOOLCHAIN.gradleWrapper}）`,
  };
}

export function hasAndroidPlatform(mobileDir: string): boolean {
  return existsSync(join(mobileDir, 'android', 'gradlew')) || existsSync(join(mobileDir, 'android', 'gradlew.bat'));
}
