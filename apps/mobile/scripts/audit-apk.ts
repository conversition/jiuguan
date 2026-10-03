#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { scanApkEvidence } from '../src/apk-audit.ts';

const apk = resolve(process.argv[2] ?? '');
const allowDebuggable = process.argv.includes('--allow-debuggable');
if (!existsSync(apk)) { console.error('APK 不存在: ' + apk); process.exit(1); }
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '';
const analyzerJar = join(sdk, 'cmdline-tools', 'latest', 'lib', 'apkanalyzer-classpath.jar');
if (!sdk || !existsSync(analyzerJar)) {
  console.error('缺少 apkanalyzer；P10-11 APK 审计拒绝降级为仅源码扫描');
  process.exit(1);
}
const javaHome = process.env.JAVA_HOME ?? '';
const javaCandidate = javaHome
  ? join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : '';
const java = javaCandidate && existsSync(javaCandidate) ? javaCandidate : 'java';
const manifest = spawnSync(java, [
  `-Dcom.android.sdklib.toolsdir=${join(sdk, 'cmdline-tools', 'latest')}`,
  '-classpath', analyzerJar,
  'com.android.tools.apk.analyzer.ApkAnalyzerCli',
  'manifest', 'print', apk,
], { encoding: 'utf8' });
if (manifest.status !== 0) { console.error(manifest.stderr || 'apkanalyzer 失败'); process.exit(1); }
const buildConfig = spawnSync(java, [
  `-Dcom.android.sdklib.toolsdir=${join(sdk, 'cmdline-tools', 'latest')}`,
  '-classpath', analyzerJar,
  'com.android.tools.apk.analyzer.ApkAnalyzerCli',
  'dex', 'code', '--class', 'com.jiuguan.app.BuildConfig', apk,
], { encoding: 'utf8' });
// R8 may inline/remove BuildConfig in release; bundled assets still carry the
// pinned endpoint and remain part of ownedPolicyEvidence.
const buildConfigEvidence = buildConfig.status === 0 ? buildConfig.stdout : '';
const jarCandidate = javaHome
  ? join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar')
  : '';
const jar = jarCandidate && existsSync(jarCandidate) ? jarCandidate : 'jar';
const unpacked = mkdtempSync(join(tmpdir(), 'jiuguan-apk-audit-'));
let allEvidence = manifest.stdout;
let ownedPolicyEvidence = manifest.stdout + '\n' + buildConfigEvidence;
try {
  const extracted = spawnSync(jar, ['-xf', apk], { cwd: unpacked, encoding: 'utf8' });
  if (extracted.status !== 0) {
    console.error(extracted.stderr || 'APK 解包失败；拒绝退化为仅扫描 ZIP 外层');
    process.exit(1);
  }
  const stack = [unpacked];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else {
        const visible = readFileSync(path).toString('latin1').replace(/[^\x20-\x7e]+/g, '\n');
        allEvidence += '\n' + visible;
        const entry = relative(unpacked, path).replaceAll('\\', '/');
        if (entry.startsWith('assets/public/') || entry === 'assets/capacitor.config.json') {
          ownedPolicyEvidence += '\n' + visible;
        }
      }
    }
  }
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
const secretKinds = new Set(['openai-key', 'device-token', 'signing-secret-name']);
const findings = [
  ...scanApkEvidence(allEvidence).filter((finding) => secretKinds.has(finding.kind)),
  ...scanApkEvidence(ownedPolicyEvidence).filter((finding) => !secretKinds.has(finding.kind)),
]
  .filter((finding) => !(allowDebuggable && finding.kind === 'debuggable'));
if (findings.length > 0) {
  for (const finding of findings) console.error(`${finding.kind}: ${finding.evidence}`);
  process.exit(1);
}
const buildTools = join(sdk, 'build-tools');
const versions = existsSync(buildTools) ? readdirSync(buildTools).sort().reverse() : [];
const signerJar = versions.map((version) => join(buildTools, version, 'lib', 'apksigner.jar')).find(existsSync);
if (!signerJar) { console.error('缺少 apksigner；无法验证签名身份'); process.exit(1); }
const signature = spawnSync(java, ['-jar', signerJar, 'verify', '--verbose', '--print-certs', apk], { encoding: 'utf8' });
if (signature.status !== 0) { console.error(signature.stderr || signature.stdout); process.exit(1); }
console.log(allowDebuggable
  ? 'P10-11 debug APK 审计通过：无凭据/测试 URL/cleartext，debug 签名有效。'
  : 'P10-11 release APK 审计通过：无凭据/测试 URL/cleartext/debuggable，签名有效。');
