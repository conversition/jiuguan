/**
 * P11：封包与 ADB 安装的计划/解析纯函数（可测部分）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PackagingPlanEnv {
  /** apps/mobile 是否存在（P10 是否已合入）。 */
  hasMobileApp: boolean;
  hasGradlew: boolean;
  hasKeystoreProperties: boolean;
  androidHome?: string | undefined;
  jgPinnedEndpoint?: string | undefined;
  jgAppVersion?: string | undefined;
  buildType?: 'debug' | 'release' | undefined;
}

export interface PackagingPlan {
  readonly steps: readonly string[];
  readonly missing: readonly string[];
  readonly feasible: boolean;
}

export function planReleasePackage(env: PackagingPlanEnv): PackagingPlan {
  const missing: string[] = [];
  const buildType = env.buildType ?? 'debug';
  if (!env.hasMobileApp) missing.push('apps/mobile/capacitor.config.ts 不存在');
  if (!env.jgPinnedEndpoint) missing.push('JG_PINNED_ENDPOINT 未设置');
  else {
    try {
      const endpoint = new URL(env.jgPinnedEndpoint);
      if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
        || endpoint.username || endpoint.password || !endpoint.hostname.toLowerCase().endsWith('.ts.net')) {
        throw new Error('invalid endpoint');
      }
    } catch { missing.push('JG_PINNED_ENDPOINT 必须是精确 https://*.ts.net origin'); }
  }
  if (!env.jgAppVersion) missing.push('JG_APP_VERSION 未设置');
  else if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(env.jgAppVersion)) {
    missing.push('JG_APP_VERSION 必须是合法 semver');
  }
  if (!env.hasGradlew) missing.push('android/gradlew 缺失');
  if (!env.androidHome) missing.push('ANDROID_HOME 未设置');
  if (buildType === 'release' && !env.hasKeystoreProperties) {
    missing.push('release 构建缺少 android/keystore.properties');
  }
  const steps = [
    'apps/mobile: prepare-www → cap sync android',
    `gradlew assemble${buildType === 'release' ? 'Release' : 'Debug'}`,
    '收集 APK + 计算 SHA-256',
    '生成 release-manifest.json',
  ];
  return { steps, missing, feasible: missing.length === 0 };
}

export interface AdbInstallPlan {
  readonly adbPath: string;
  readonly missing: readonly string[];
  readonly feasible: boolean;
}

/** adb 可执行文件探测：ANDROID_HOME/platform-tools 优先，其次 PATH（调用方保证）。 */
export function planAdbInstall(env: {
  androidHome?: string | undefined;
  adbOnPath?: boolean;
  devicesOutput?: string | undefined;
  /** 注入存在性检查（测试用）；默认真实 existsSync。 */
  adbExists?: (path: string) => boolean;
}): AdbInstallPlan {
  const missing: string[] = [];
  let adbPath = '';
  const adbExists = env.adbExists ?? ((path: string) => existsSync(path));
  if (env.androidHome) {
    const candidate = join(env.androidHome, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    if (adbExists(candidate)) adbPath = candidate;
  }
  if (!adbPath && env.adbOnPath) adbPath = 'adb';
  if (!adbPath) missing.push('adb 不可用（设置 ANDROID_HOME 或将 platform-tools 加入 PATH）');

  if (adbPath && env.devicesOutput !== undefined) {
    const devices = env.devicesOutput !== undefined
      ? parseAdbDevices(env.devicesOutput)
      : { ready: [], unauthorized: 0, offline: 0 };
    if (devices.ready.length === 0) {
      const hint = devices.unauthorized + devices.offline > 0
        ? `有 ${devices.unauthorized + devices.offline} 台设备未授权/离线，请在手机上确认调试授权`
        : '没有已连接的设备';
      missing.push(`无可用设备：${hint}`);
    }
  }
  return { adbPath, missing, feasible: missing.length === 0 };
}

export interface ParsedAdbDevices {
  readonly ready: string[];
  readonly unauthorized: number;
  readonly offline: number;
}

/** 解析 `adb devices` 输出（跳过 header 与空行）。 */
export function parseAdbDevices(output: string): ParsedAdbDevices {
  const ready: string[] = [];
  let unauthorized = 0;
  let offline = 0;
  for (const line of output.split('\n').map((l) => l.trim())) {
    if (line.length === 0 || line.startsWith('List of devices')) continue;
    const [serial, state] = line.split(/\s+/);
    if (!serial || !state) continue;
    if (state === 'device') ready.push(serial!);
    else if (state === 'unauthorized') unauthorized += 1;
    else if (state === 'offline') offline += 1;
  }
  return { ready, unauthorized, offline };
}
