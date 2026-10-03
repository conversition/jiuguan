#!/usr/bin/env node
/** CLI：装配 bundled www/（env: JG_WEB_DIST, JG_PINNED_ENDPOINT, JG_APP_VERSION）。 */
import { resolve } from 'node:path';
import { prepareBundledWeb } from '../src/prepare-www.ts';

const distDir = resolve(process.env.JG_WEB_DIST ?? '../../apps/web/dist');
const outDir = resolve('www');
const apiOrigin = process.env.JG_PINNED_ENDPOINT ?? '';
const appVersion = process.env.JG_APP_VERSION ?? '';
if (!apiOrigin) {
  console.error('缺少 JG_PINNED_ENDPOINT（构建期固定 endpoint）；拒绝生成 www/');
  process.exit(1);
}
if (!appVersion) {
  console.error('缺少 JG_APP_VERSION（包内版本真值）；拒绝生成 www/');
  process.exit(1);
}
const { files } = prepareBundledWeb({ distDir, outDir, apiOrigin, appVersion });
console.log(`bundled www/ 就绪：${files} 个文件，CSP 已注入（api=${apiOrigin}）`);
