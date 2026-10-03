/** P11：Android SDK/APK/设备身份的窄工具层。 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ApkManifestFacts {
  applicationId: string;
  versionName: string;
  versionCode: number;
  minSdk: number;
  targetSdk: number;
}

function capture(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function resolveAndroidSdk(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  const conventional = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : '';
  const sdk = configured || conventional;
  if (!sdk || !existsSync(join(sdk, 'platform-tools'))) throw new Error('缺少 Android SDK');
  return sdk;
}

export function adbPathFor(sdk: string): string {
  const path = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  if (!existsSync(path)) throw new Error('Android SDK 缺少 adb');
  return path;
}

function latestBuildToolsDir(sdk: string): string {
  const root = join(sdk, 'build-tools');
  const candidates = existsSync(root) ? readdirSync(root) : [];
  const selected = candidates
    .map((version) => ({ version, parts: version.split('.').map((part) => Number(part) || 0) }))
    .sort((left, right) => {
      for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
        const delta = (right.parts[index] ?? 0) - (left.parts[index] ?? 0);
        if (delta) return delta;
      }
      return 0;
    })
    .map(({ version }) => join(root, version))
    .find((path) => existsSync(join(path, 'lib', 'apksigner.jar')));
  if (!selected) throw new Error('Android build-tools 缺少 apksigner.jar');
  return selected;
}

function javaPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.JAVA_HOME
    ? join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : '';
  return configured && existsSync(configured) ? configured : 'java';
}

export function apkCertificateSha256(sdk: string, apk: string): string {
  const output = capture(javaPath(), [
    '-jar', join(latestBuildToolsDir(sdk), 'lib', 'apksigner.jar'),
    'verify', '--print-certs', apk,
  ]);
  const match = output.match(/certificate SHA-256 digest:\s*([0-9a-f]{64})/i);
  if (!match) throw new Error('apksigner 未返回证书 SHA-256 指纹');
  return match[1].toLowerCase();
}

export function apkManifestFacts(sdk: string, apk: string): ApkManifestFacts {
  const analyzer = join(sdk, 'cmdline-tools', 'latest', 'lib', 'apkanalyzer-classpath.jar');
  if (!existsSync(analyzer)) throw new Error('Android SDK 缺少 apkanalyzer');
  const xml = capture(javaPath(), [
    `-Dcom.android.sdklib.toolsdir=${join(sdk, 'cmdline-tools', 'latest')}`,
    '-classpath', analyzer, 'com.android.tools.apk.analyzer.ApkAnalyzerCli',
    'manifest', 'print', apk,
  ]);
  const value = (pattern: RegExp, label: string): string => {
    const match = pattern.exec(xml);
    if (!match) throw new Error(`APK manifest 缺少 ${label}`);
    return match[1];
  };
  return {
    applicationId: value(/<manifest[^>]+\bpackage="([^"]+)"/s, 'package'),
    versionName: value(/android:versionName="([^"]+)"/, 'versionName'),
    versionCode: Number(value(/android:versionCode="(\d+)"/, 'versionCode')),
    minSdk: Number(value(/android:minSdkVersion="(\d+)"/, 'minSdkVersion')),
    targetSdk: Number(value(/android:targetSdkVersion="(\d+)"/, 'targetSdkVersion')),
  };
}

/** 已安装包不存在返回 null；存在则 pull base.apk 后读取真实签名证书。 */
export function installedCertificateSha256(
  sdk: string,
  adb: string,
  serial: string,
  applicationId: string,
): string | null {
  const query = spawnSync(adb, ['-s', serial, 'shell', 'pm', 'path', applicationId], { encoding: 'utf8' });
  if (query.status !== 0 || !query.stdout.trim()) return null;
  const remote = query.stdout.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line.startsWith('package:') && line.endsWith('base.apk'))?.slice('package:'.length);
  if (!remote) throw new Error(`无法解析设备上 ${applicationId} 的 base.apk`);
  const directory = mkdtempSync(join(tmpdir(), 'jiuguan-installed-apk-'));
  const local = join(directory, 'base.apk');
  try {
    capture(adb, ['-s', serial, 'pull', remote, local]);
    return apkCertificateSha256(sdk, local);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
