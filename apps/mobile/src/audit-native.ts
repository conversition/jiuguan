/**
 * P10-08：原生桥/插件审计（P10 计划第 6 条）。
 *
 * 静态审计 android 生成物：插件清单必须为空或全在白名单、无 cleartext、
 * 无 addJavascriptInterface 风险标记、MainActivity 未启用旧桥。
 * 结果只列违规项，不修改文件。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface NativeAuditInput {
  androidDir: string;
  /** 允许出现的原生插件包名前缀；默认仅允许 Capacitor 官方核心。 */
  allowedPluginPrefixes?: readonly string[];
}

export interface NativeAuditFinding {
  readonly kind: 'plugin' | 'manifest' | 'gradle' | 'bridge';
  readonly detail: string;
}

export interface NativeAuditResult {
  readonly findings: NativeAuditFinding[];
  readonly pluginCount: number;
  readonly passed: boolean;
}

const DEFAULT_ALLOWED = ['com.capacitorjs.', 'com.getcapacitor.'] as const;
const ALLOWED_MANUAL_PLUGINS = new Set(['JiuguanNativePlugin']);
const withoutComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

export function auditNativeProject(input: NativeAuditInput): NativeAuditResult {
  const findings: NativeAuditFinding[] = [];
  const allowed = input.allowedPluginPrefixes ?? DEFAULT_ALLOWED;
  const appDir = join(input.androidDir, 'app');
  const assetsDir = join(appDir, 'src', 'main', 'assets');

  // 1) 插件清单
  const pluginsPath = join(assetsDir, 'capacitor.plugins.json');
  let pluginCount = 0;
  if (existsSync(pluginsPath)) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(readFileSync(pluginsPath, 'utf8'));
    } catch {
      findings.push({ kind: 'plugin', detail: 'capacitor.plugins.json 不是合法 JSON' });
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      pluginCount = parsed.length;
      for (const plugin of parsed) {
        const id = typeof plugin === 'object' && plugin !== null
          ? String((plugin as Record<string, unknown>).id ?? '')
          : String(plugin);
        if (!allowed.some((prefix) => id.startsWith(prefix))) {
          findings.push({ kind: 'plugin', detail: `未审计的原生插件: ${id}` });
        }
      }
    }
  }

  // 2) manifest：cleartext / debuggable / 明文域名
  const manifestPath = join(appDir, 'src', 'main', 'AndroidManifest.xml');
  if (existsSync(manifestPath)) {
    const manifest = readFileSync(manifestPath, 'utf8');
    if (/usesCleartextTraffic\s*=\s*"true"/.test(manifest)) {
      findings.push({ kind: 'manifest', detail: 'usesCleartextTraffic=true' });
    }
    if (/android:debuggable\s*=\s*"true"/.test(manifest)) {
      findings.push({ kind: 'manifest', detail: 'manifest 写死 debuggable=true' });
    }
    for (const match of manifest.matchAll(/android:host="([^"]+)"/g)) {
      // allowNavigation/自定义 host：列出让审计者确认
      findings.push({ kind: 'manifest', detail: `自定义 intent host: ${match[1]}（确认是否允许 WebView 导航）` });
    }
  } else {
    findings.push({ kind: 'manifest', detail: 'AndroidManifest.xml 缺失' });
  }

  // 3) Java 源码：addJavascriptInterface / setAllowFileAccess 风险标记
  const javaDir = join(appDir, 'src', 'main', 'java');
  if (existsSync(javaDir)) {
      const stack = [javaDir];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          let isDirectory = false;
          try { isDirectory = statSync(full).isDirectory(); } catch { continue; }
          if (isDirectory) stack.push(full);
          else if (name.endsWith('.java') || name.endsWith('.kt')) {
            const source = withoutComments(readFileSync(full, 'utf8'));
            for (const match of source.matchAll(/registerPlugin\(\s*([A-Za-z0-9_$.]+)\.class\s*\)/g)) {
              pluginCount += 1;
              const simpleName = match[1]!.split('.').at(-1)!;
              if (!ALLOWED_MANUAL_PLUGINS.has(simpleName)) {
                findings.push({ kind: 'plugin', detail: `未审计的手工注册插件: ${match[1]}` });
              }
            }
            if (source.includes('addJavascriptInterface')) {
              findings.push({ kind: 'bridge', detail: `addJavascriptInterface 出现于 ${full}` });
            }
            if (source.includes('setAllowFileAccess(true)') || source.includes('setAllowUniversalAccessFromFileURLs(true)')) {
              findings.push({ kind: 'bridge', detail: `WebView 文件域放开于 ${full}` });
            }
          }
        }
      }
  }

  const mainActivity = join(javaDir, 'com', 'jiuguan', 'app', 'MainActivity.java');
  if (existsSync(mainActivity)) {
    const source = readFileSync(mainActivity, 'utf8');
    if (!source.includes('WebViewFeature.WEB_MESSAGE_LISTENER')
      || !source.includes('CAPACITOR_APP_ORIGIN.equals(actual)')) {
      findings.push({ kind: 'bridge', detail: 'MainActivity 缺少主 frame message listener/origin fail-closed 断言' });
    }
  }

  // 4) gradle：debuggable release
  const gradlePath = join(appDir, 'build.gradle');
  if (existsSync(gradlePath)) {
    const gradle = readFileSync(gradlePath, 'utf8');
    const releaseBlock = /release\s*{[^}]*}/s.exec(gradle)?.[0] ?? '';
    if (releaseBlock && /debuggable\s+true/.test(releaseBlock)) {
      findings.push({ kind: 'gradle', detail: 'release 构建开启 debuggable' });
    }
  }

  return { findings, pluginCount, passed: findings.length === 0 };
}
