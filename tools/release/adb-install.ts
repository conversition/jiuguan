#!/usr/bin/env node
/** P11：校验 manifest/APK/目标设备/签名后再执行 ADB 安装。 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { adbPathFor, apkCertificateSha256, apkManifestFacts, installedCertificateSha256, resolveAndroidSdk } from './android-tools.ts';
import { parseAdbDevices } from './packaging-plan.ts';
import { verifyReleaseManifest } from './release-manifest.ts';

const root = resolve(import.meta.dirname ?? '.', '..', '..');
const distRoot = join(root, 'dist-release');
const uninstall = process.argv.includes('--uninstall');
const serialArg = process.argv.find((arg) => arg.startsWith('--serial='))?.slice('--serial='.length);
const pointerPath = join(distRoot, 'current.json');
if (!existsSync(pointerPath)) throw new Error('缺少 dist-release/current.json（先运行 mobile:package）');
const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as { manifest?: unknown };
if (typeof pointer.manifest !== 'string' || !/^releases\/[A-Za-z0-9._-]+\/release-manifest\.json$/.test(pointer.manifest)) {
  throw new Error('current.json manifest 指针非法');
}
const manifestPath = join(distRoot, ...pointer.manifest.split('/'));
const manifest = verifyReleaseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
const apkPath = join(dirname(manifestPath), manifest.artifact.fileName);
if (!existsSync(apkPath)) throw new Error('manifest 引用的 APK 不存在');
const actualSha = createHash('sha256').update(readFileSync(apkPath)).digest('hex');
if (actualSha !== manifest.artifact.sha256) throw new Error('APK SHA-256 与 manifest 不一致');

const sdk = resolveAndroidSdk();
const adb = adbPathFor(sdk);
const facts = apkManifestFacts(sdk, apkPath);
const certificate = apkCertificateSha256(sdk, apkPath);
if (facts.applicationId !== manifest.application.applicationId
    || facts.versionName !== manifest.application.versionName
    || facts.versionCode !== manifest.application.versionCode
    || certificate !== manifest.signing.certificateSha256) {
  throw new Error('APK 实际身份/版本/签名与 manifest 不一致');
}
const devicesResult = spawnSync(adb, ['devices', '-l'], { encoding: 'utf8' });
if (devicesResult.status !== 0) throw new Error(`adb devices 失败：${devicesResult.stderr}`);
const devices = parseAdbDevices(devicesResult.stdout);
if (devices.ready.length === 0) throw new Error('没有已授权且在线的 Android 设备');
if (!serialArg && devices.ready.length !== 1) throw new Error('存在多台设备；必须显式传 --serial=<设备序列号>');
const serial = serialArg ?? devices.ready[0];
if (!devices.ready.includes(serial)) throw new Error('--serial 指定的设备不在线或未授权');

if (!uninstall) {
  const installedCertificate = installedCertificateSha256(sdk, adb, serial, facts.applicationId);
  if (installedCertificate !== null && installedCertificate !== certificate) {
    throw new Error('设备上同 applicationId 的签名不同；拒绝覆盖，请显式卸载并重新配对');
  }
}
const commandArgs = uninstall
  ? ['-s', serial, 'uninstall', facts.applicationId]
  : ['-s', serial, 'install', '-r', apkPath];
const result = spawnSync(adb, commandArgs, { encoding: 'utf8' });
if (result.status !== 0) throw new Error(`ADB ${uninstall ? '卸载' : '安装'}失败：${result.stderr || result.stdout}`);
console.log(uninstall ? `已卸载 ${facts.applicationId}` : `已安装 ${facts.versionName} (${facts.versionCode})`);
