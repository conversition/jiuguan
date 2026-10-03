#!/usr/bin/env node
/** P11-10-R：安装后的冷启动/进程存活 smoke；协议握手仍由真机矩阵补录。 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { adbPathFor, resolveAndroidSdk } from './android-tools.ts';
import { parseAdbDevices } from './packaging-plan.ts';
import { verifyReleaseManifest } from './release-manifest.ts';

const root = resolve(import.meta.dirname ?? '.', '..', '..');
const distRoot = join(root, 'dist-release');
const pointerPath = join(distRoot, 'current.json');
if (!existsSync(pointerPath)) throw new Error('缺少 dist-release/current.json（先封包）');
const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as { manifest?: unknown };
if (typeof pointer.manifest !== 'string' || !/^releases\/[A-Za-z0-9._-]+\/release-manifest\.json$/.test(pointer.manifest)) {
  throw new Error('current.json manifest 指针非法');
}
const manifest = verifyReleaseManifest(JSON.parse(readFileSync(join(distRoot, ...pointer.manifest.split('/')), 'utf8')));
const sdk = resolveAndroidSdk();
const adbPath = adbPathFor(sdk);
const adb = (args: string[]): string => {
  const result = spawnSync(adbPath, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`adb ${args.join(' ')} 失败: ${result.stderr ?? ''}`);
  return result.stdout;
};
const devices = parseAdbDevices(adb(['devices', '-l'])).ready;
const requested = process.argv.find((arg) => arg.startsWith('--serial='))?.slice('--serial='.length);
if (devices.length === 0) throw new Error('无已授权设备');
if (!requested && devices.length !== 1) throw new Error('存在多台设备；必须传 --serial=<设备序列号>');
const serial = requested ?? devices[0];
if (!devices.includes(serial)) throw new Error('--serial 指定的设备不可用');
const appId = manifest.application.applicationId;
adb(['-s', serial, 'shell', 'am', 'force-stop', appId]);
adb(['-s', serial, 'shell', 'am', 'start', '-W', '-n', `${appId}/.MainActivity`]);
const pid = adb(['-s', serial, 'shell', 'pidof', appId]).trim();
if (!pid) throw new Error('smoke 失败：冷启动后 app 进程未存活');
console.log(`冷启动 smoke 通过：${appId}`);
console.log('注意：capabilities 握手、后台清理和 credential 保留仍属于 P11-10-R 真机证据。');
