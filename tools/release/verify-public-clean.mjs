#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ignoredDirs = new Set(['.git', 'node_modules']);
const forbiddenDirSegments = new Set([
  '.workbuddy', '.codex', '.agents', 'data', 'runtime-data', 'captured-requests',
  'coverage', 'vendor', 'review-package',
]);
const forbiddenExtensions = new Set([
  '.apk', '.aab', '.db', '.sqlite', '.sqlite3', '.log', '.pem', '.key', '.p12',
  '.pfx', '.jks', '.keystore', '.zip', '.rar',
]);
const allowedMediaPrefixes = [
  'apps/mobile/android/app/src/main/res/',
  'apps/mobile/android/app/src/debug/res/',
  'apps/web/public/',
];
const allowedSpecialFiles = new Set([
  '.env.example',
  'apps/commandcode-proxy/config.example.json',
  'apps/mobile/android/keystore.properties.example',
  'tools/windows/public-safe-v0.1.env',
]);
const errors = [];
const files = [];

function posix(path) { return path.replaceAll('\\', '/'); }
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = join(directory, entry.name);
    const rel = posix(relative(root, full));
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      errors.push(`${rel}: symbolic links are not allowed in the public source tree`);
      continue;
    }
    if (entry.isDirectory()) {
      if (/^dist(?:-|$)/i.test(entry.name)) errors.push(`${rel}/: generated build directory`);
      if (forbiddenDirSegments.has(entry.name.toLowerCase())) errors.push(`${rel}/: forbidden runtime/internal directory`);
      walk(full);
    } else if (entry.isFile()) files.push({ full, rel, size: stat.size });
  }
}
walk(root);

for (const file of files) {
  const lower = file.rel.toLowerCase();
  const base = lower.split('/').at(-1);
  const extension = extname(lower);
  if (!allowedSpecialFiles.has(file.rel)) {
    if (base === '.env' || base.startsWith('.env.') || base === 'config.json'
      || base === 'local.properties' || base === 'keystore.properties') {
      errors.push(`${file.rel}: forbidden local configuration`);
    }
    if (forbiddenExtensions.has(extension) || /\.(?:db|sqlite)(?:-|$)/i.test(base)) {
      errors.push(`${file.rel}: forbidden runtime/binary artifact`);
    }
  }
  if (lower.includes('/bundle/') && lower.startsWith('plugins/')) {
    errors.push(`${file.rel}: generated plugin bundle`);
  }
  if (/\.(?:png|jpe?g|webp|gif)$/i.test(lower)
    && !allowedMediaPrefixes.some((prefix) => lower.startsWith(prefix))) {
    errors.push(`${file.rel}: media outside the application asset allowlist`);
  }
}

const scannerPath = 'tools/release/verify-public-clean.mjs';
const contentRules = [
  ['personal Windows path', /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings|Desktop|claude cade test)[\\/]|Users[\\/]+PC|command cli)/i],
  ['timestamp-derived session id', /session-[0-9]{10,}/i],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['common API token', /(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|jgp1_[A-Za-z0-9_-]{20,})/],
  ['private IPv4 address', /\b(?:100\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}|10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}|192\.168\.(?:[0-9]{1,3}\.)[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.(?:[0-9]{1,3}\.)[0-9]{1,3})\b/],
];
const privateTerms = [
  'XP' + '大全', '夜' + '璃', '桐月' + '樱佳', '井上' + '枫', '鸿纱' + '由美',
  'inoue' + '_kaede', 'kiritsuki' + '_ouka', '魔法' + '少女', '塞蕾' + '丝',
  '侵蚀技术' + '检证', 'ik.imagekit.io/' + 'yorino',
];

for (const file of files) {
  if (file.rel === scannerPath || file.size > 5_000_000) continue;
  const buffer = readFileSync(file.full);
  if (buffer.includes(0)) continue;
  let text = buffer.toString('utf8');
  text = text.replaceAll('https://your-host.your-tailnet.ts.net', 'https://example.invalid');
  text = text.replaceAll('https://pc.example.ts.net', 'https://example.invalid');
  const realTailnet = /(?:https?:\/\/)?[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net/i;
  if (realTailnet.test(text)) errors.push(`${file.rel}: non-placeholder tailnet hostname`);
  for (const [label, pattern] of contentRules) {
    if (pattern.test(text)) errors.push(`${file.rel}: ${label}`);
  }
  for (const term of privateTerms) {
    if (text.includes(term)) errors.push(`${file.rel}: private asset term`);
  }
}

const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const webPackage = JSON.parse(readFileSync(join(root, 'apps', 'web', 'package.json'), 'utf8'));
if (rootPackage.version !== '0.1.0' || webPackage.version !== '0.1.0') {
  errors.push('package versions must both be 0.1.0');
}
const profile = readFileSync(join(root, 'tools', 'windows', 'public-safe-v0.1.env'), 'utf8');
for (const expected of [
  'JG_AGENT_LANE_ROLLOUT=interactive=off,learning=off,maintenance=off',
  'JG_AGENT_CONTROL_MUTATION=off',
  'JG_AGENT_ADMISSION=off',
  'JG_AGENT_LEARNING_TEXT=off',
  'JG_HARNESS_INTERACTIVE=off',
  'JG_HARNESS_BACKGROUND=off',
  'JG_CONTEXT_COMPILER=off',
  'JG_CONTEXT_COMPILER_KILL_SWITCH=1',
  'JG_MAINTENANCE_ADMISSION=off',
  'JG_MAINTENANCE_APPLY=off',
]) {
  if (!profile.includes(expected)) errors.push(`public-safe profile missing: ${expected}`);
}

if (existsSync(join(root, '.git'))) {
  try {
    const unreachable = execFileSync('git', ['fsck', '--full', '--unreachable', '--no-reflogs'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (unreachable) errors.push('Git object database contains unreachable objects; prune or rebuild it before sharing the directory');
  } catch (error) {
    errors.push(`Git object integrity check failed: ${String(error)}`);
  }
}

if (errors.length > 0) {
  console.error(`Public release verification failed with ${errors.length} finding(s):`);
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Public release verification passed: ${files.length} files scanned; no private runtime artifacts detected.`);
