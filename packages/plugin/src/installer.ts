/**
 * plugin 包 - 安装器（参考 SillyTavern git 插件接口）
 * 来源：
 *  - git URL（*.git / github.com / gitlab / file://）→ `git clone --depth 1`（ST 同款）
 *  - 本地目录（开发/测试）→ 拷贝
 *  - 本地 .zip → PowerShell Expand-Archive（运行时；沙箱测试用目录夹具）
 * 安装后：manifest 校验 → 拷贝到 data/plugins/<name>/（排除 .git / 临时目录）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PluginManifestSchema } from './manifest.ts';
import type { PluginManifest } from './manifest.ts';
import { DshPluginHost } from './dsh-host.ts';
import type { PluginRecord } from './registry.ts';

export interface InstallResult {
  id: string;
  manifest: PluginManifest;
  /** 插件最终目录（data/plugins/<name>/） */
  dir: string;
}

/** 手动递归拷贝（fs.cpSync 在本机 Node 22.22.2 上原生崩溃 0xC0000409，规避） */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.name === '.git') continue;
    if (ent.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

/** 运行命令（同步 + stdio 忽略；仅依赖退出码——DSH 沙箱禁异步 spawn 管道，同步版全环境可测） */
function run(cmd: string, args: string[], cwd?: string): number {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'ignore' });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

function isGitUrl(source: string): boolean {
  return /\.git(\/)?$/.test(source) || /^https?:\/\/[^/]+\/[^/]+\/[^/]+/.test(source) || source.startsWith('file://');
}

export async function installFromSource(pluginsDir: string, source: string, opts: { replace?: boolean } = {}): Promise<InstallResult> {
  const tmp = join(pluginsDir, `.tmp-install-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  mkdirSync(tmp, { recursive: true });
  try {
    if (existsSync(source) && statSync(source).isDirectory()) {
      // 本地目录（开发/测试）
      copyDir(source, tmp);
    } else if (existsSync(source) && source.endsWith('.zip')) {
      // 本地 zip：PowerShell Expand-Archive（Windows 内置；运行时进程不受 DSH 沙箱约束）
      const code = run('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${source.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`]);
      if (code !== 0) throw new Error(`zip 解压失败（exit ${code}）: ${source}`);
    } else if (isGitUrl(source)) {
      // ST 同款：git clone --depth 1
      const code = run('git', ['clone', '--depth', '1', source, tmp]);
      if (code !== 0) throw new Error(`git clone 失败（exit ${code}）: ${source}`);
    } else {
      throw new Error(`不支持的插件来源: ${source}（支持 git URL / 本地目录 / .zip）`);
    }

    // 校验 manifest：两套标准并存（04 §4.1 ST 风格 / DSH bundle 风格）
    //  1) DSH 标准包：package.json（name+main）+ ESM apply 入口 → 归一化为 manifest
    //  2) ST 风格：manifest.json（zod 校验）
    let manifest: PluginManifest;
    if (DshPluginHost.isDshPackage(tmp)) {
      const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8')) as {
        name?: string; version?: string; description?: string; author?: string; homepage?: string; license?: string; main?: string;
      };
      manifest = PluginManifestSchema.parse({
        name: pkg.name,
        display_name: pkg.name,
        version: pkg.version ?? '0.1.0',
        description: pkg.description ?? '',
        author: pkg.author ?? '',
        homepage: pkg.homepage,
        license: pkg.license,
        includes: [],
        server: pkg.main,   // DSH main 复用 server 字段记录入口路径
      });
    } else {
      const manifestPath = join(tmp, 'manifest.json');
      if (!existsSync(manifestPath)) throw new Error('插件缺少 manifest.json 或 package.json+main（支持 ST 风格与 DSH 标准包）');
      const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf8')));
      if (!parsed.success) throw new Error(`manifest 校验失败: ${parsed.error.issues[0]?.message ?? '未知'}`);
      manifest = parsed.data;
    }

    // 定位插件根（build_dir 存在则用构建产物目录）
    let srcRoot = tmp;
    if (manifest.build_dir) {
      const bd = join(tmp, manifest.build_dir);
      if (existsSync(bd) && statSync(bd).isDirectory()) srcRoot = bd;
    }

    const target = join(pluginsDir, manifest.name);
    if (existsSync(target)) {
      if (!opts.replace) throw new Error(`插件已存在: ${manifest.name}（先卸载，或用 update）`);
      rmSync(target, { recursive: true, force: true });
    }
    copyDir(srcRoot, target);
    return { id: manifest.name, manifest, dir: target };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
