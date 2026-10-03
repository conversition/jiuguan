/**
 * P10-01：把 apps/web 构建产物装配为 bundled www/，并注入 Android 专用安全头。
 *
 * 规则（P10 计划第 1/7 条）：不复制业务源码，只消费 web 构建产物；
 * 为 bundled mobile index/local origin 注入单独的 CSP（由构建期 pinned endpoint 生成）
 * 与 Referrer-Policy；Android profile 不注册 Service Worker——已存在的 SW 注册脚本
 * 与 manifest 链接在此剥离，历史 Cache Storage 由首次启动清理（见 webview-guard）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePinnedEndpoint } from './pinned-endpoint.ts';
import { buildBundledCsp } from './webview-guard.ts';
import { mergeViewportContent, SAFE_AREA_VIEWPORT_CONTENT } from './safe-area.ts';
import { buildVersionJson, type PackagedVersion } from './app-version.ts';

export interface PrepareBundledWebInput {
  distDir: string;
  outDir: string;
  apiOrigin: string;
  /** 包内版本（P10 计划第 7 条：包内版本是 UI 唯一真值）。 */
  appVersion: string;
}

const MOBILE_BOOTSTRAP = '<script src="./mobile-bootstrap.js"></script>';

const CSP_META = (csp: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`;
const REFERRER_META = '<meta name="referrer" content="no-referrer">';

/** 剥离 PWA 专属行：Android profile 不注册 SW、不显示安装提示。 */
function stripPwaMarkers(html: string): string {
  return html
    .replace(/<link[^>]+rel=["']?manifest["']?[^>]*>\s*/gi, '')
    .replace(/<script[^>]+serviceWorker[^>]*>\s*<\/script>\s*/gi, '')
    .replace(/navigator\.serviceWorker\s*\.\s*register\s*\([^)]*\)\s*;?/g, 'void 0;');
}

export function prepareBundledWeb(input: PrepareBundledWebInput): { files: number } {
  const api = resolvePinnedEndpoint(input.apiOrigin);
  const distDir = resolve(input.distDir);
  const outDir = resolve(input.outDir);
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    throw new Error(`web 构建产物不存在: ${distDir}（先运行 pnpm build:web）`);
  }
  const indexHtml = join(distDir, 'index.html');
  if (!existsSync(indexHtml)) throw new Error('web 构建产物缺少 index.html');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let files = 0;
  const copy = (from: string, to: string): void => {
    const stats = statSync(from);
    if (stats.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from)) copy(join(from, entry), join(to, entry));
      return;
    }
    writeFileSync(to, readFileSync(from));
    files += 1;
  };
  copy(distDir, outDir);
  const bootstrapSource = resolve(import.meta.dirname ?? '.', '..', 'runtime', 'mobile-bootstrap.js');
  if (!existsSync(bootstrapSource)) throw new Error('缺少 mobile-bootstrap.js');
  writeFileSync(join(outDir, 'mobile-bootstrap.js'), readFileSync(bootstrapSource));
  files += 1;

  // Android bundled profile 不分发 PWA 入口文件；即便未来错误引用也只能 404。
  for (const pwaFile of ['sw.js', 'manifest.webmanifest']) {
    const target = join(outDir, pwaFile);
    if (existsSync(target)) {
      rmSync(target, { force: true });
      files -= 1;
    }
  }

  const csp = buildBundledCsp(api.origin);
  const outIndex = join(outDir, 'index.html');
  let html = readFileSync(outIndex, 'utf8');
  html = stripPwaMarkers(html);
  html = html.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>\s*/gi, '');
  html = html.replace(/<meta[^>]+name=["']?referrer["']?[^>]*>\s*/gi, '');
  // P10-06：viewport 强制 viewport-fit=cover（安全区），缺失则创建
  if (/<meta[^>]+name=["']?viewport["']?[^>]*>/i.test(html)) {
    html = html.replace(/<meta[^>]+name=["']?viewport["']?[^>]*>/i, (metaTag) => {
      const content = /content=["']([^"']*)["']/i.exec(metaTag)?.[1];
      return metaTag.replace(/content=["'][^"']*["']/i,
        `content="${mergeViewportContent(content).replace(/"/g, '&quot;')}"`);
    });
  } else {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n    <meta name="viewport" content="${SAFE_AREA_VIEWPORT_CONTENT}">`);
  }
  html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${CSP_META(csp)}\n    ${REFERRER_META}`);
  html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${MOBILE_BOOTSTRAP}`);
  if (!html.includes('Content-Security-Policy')) {
    throw new Error('CSP 注入失败：index.html 缺少 <head>');
  }
  if (!html.includes('viewport-fit=cover')) {
    throw new Error('viewport-fit=cover 注入失败');
  }
  writeFileSync(outIndex, html, 'utf8');

  // P10-06：包内版本文件——UI 唯一真值，不向远端查询版本
  const version: PackagedVersion = buildVersionJson(input.appVersion);
  writeFileSync(join(outDir, 'version.json'), `${JSON.stringify(version)}\n`, 'utf8');
  return { files: files + 1 };
}
