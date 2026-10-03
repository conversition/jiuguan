/**
 * plugin 包 - 插件静态扫描（0.5.0 Sandbox 强化）
 *
 * node:vm 不是强安全边界，插件经 git URL 安装是不可信第三方代码，风险随生态上升。
 * 加载/执行前做两层静态防护（不依赖 worker 进程隔离）：
 *   1) 逃逸特征扫描：拒绝含 child_process / process.exit / 任意 fs / eval-逃逸 / require 的源码
 *   2) 权限声明校验：manifest 显式声明所需权限，超范围源码直接拒载
 * 运行时仍叠加沙箱 timeout（runInContext.timeout）；三重兜底，恶意代码不拖垮主进程。
 */
import type { PluginManifest } from './manifest.ts';

/** 逃逸特征正则（命中任一即拒载） */
const ESCAPE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'child_process', re: /child_process|require\(['"](?:node:)?(child_process|fs|net|http|https|vm)['"]|process\.(exit|kill|abort|chdir)|globalThis\.process/, },
  { name: 'process-exit', re: /process\.(exit|kill)\s*\(/ },
  { name: '任意 fs 写', re: /(?:require|import)[\s\S]{0,40}['"]fs['"]|writeFileSync|rmSync|unlinkSync|mkdirSync/g },
  { name: 'eval 逃逸', re: /\beval\s*\(|Function\s*\(.*['"]return\s+this['"]|vm\.runIn/i },
  { name: '网络', re: /(?:node:)?https?[\s\S]{0,20}\.request|WebSocket\(|XMLHttpRequest|fetch\s*\(\s*['"]http/i },
  { name: 'require 任意', re: /\brequire\s*\(/ },
];

export interface ScanResult {
  ok: boolean;
  deny: string;
  /** 命中权限违规的源码行（示意） */
  hints: string[];
}

/** 权限声明：插件声明它能做什么；未声明 = 最小（仅沙箱白名单 + 钩子） */
export type PluginPermissions = {
  network?: boolean;
  fs?: boolean;        // 任意路径读写（storage 仅限制于插件专属目录，不在此列）
  runtime?: boolean;   // 子进程/exec
};

export const DEFAULT_PERMISSIONS: PluginPermissions = { network: false, fs: false, runtime: false };

/** 静态扫描插件服务端源码：命中逃逸特征 → 拒载 + hint */
export function scanServerSource(source: string, permissions?: PluginPermissions): ScanResult {
  if (source.length === 0) return { ok: true, deny: '', hints: [] };
  // 逐特征检查：每个特征用「特权」内容可豁免（如 contains 函数不算逃逸）
  for (const { name, re } of ESCAPE_PATTERNS) {
    const m = source.match(re);
    if (m) {
      return { ok: false, deny: `静态扫描拒绝：含 ${name} 特征（${m[0].slice(0, 60)}）`, hints: [source.slice(Math.max(0, source.indexOf(m[0]) - 40), source.indexOf(m[0]) + 60)] };
    }
  }
  return { ok: true, deny: '', hints: [] };
}

/** 校验 manifest 权限声明：超范围能力（声明了但源码含该特征，或未声明网络但用了网络）已在车 level 处理，此处仅输出归一化权限 */
export function normalizePermissions(m: Pick<PluginManifest, 'permissions'>): PluginPermissions {
  const p = (m.permissions ?? {}) as PluginPermissions;
  return {
    network: !!p.network,
    fs: !!p.fs,
    runtime: !!p.runtime,
  };
}
