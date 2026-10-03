/**
 * plugin 包 - 安装器（参考 SillyTavern git 插件接口）
 * 来源：
 *  - git URL（*.git / github.com / gitlab / file://）→ `git clone --depth 1`（ST 同款）
 *  - 本地目录（开发/测试）→ 拷贝
 *  - 本地 .zip → PowerShell Expand-Archive（运行时；沙箱测试用目录夹具）
 * 安装后：manifest 校验 → 拷贝到 data/plugins/<name>/（排除 .git / 临时目录）
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PluginManifestSchema } from './manifest.ts';
import type { PluginManifest } from './manifest.ts';
import { DshPluginHost } from './dsh-host.ts';
import type { PluginRecord } from './registry.ts';

export interface DirectoryActivationOps {
  existsSync(path: string): boolean;
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
}

const directoryActivationOps: DirectoryActivationOps = { existsSync, renameSync, rmSync };

function removeDirectoryBestEffort(path: string, ops: DirectoryActivationOps): boolean {
  try {
    ops.rmSync(path, { recursive: true, force: true });
  } catch {
    // 保留残件比用清理异常覆盖安装/恢复结果更安全。
  }
  return ops.existsSync(path);
}

function resolveContained(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} 必须位于插件目录内: ${candidate}`);
  }
  return target;
}

/**
 * 将已完整复制的 staging 目录原子切换为目标目录。
 *
 * 失败语义：
 * - 新版本激活失败且旧目录可恢复：恢复旧目录并抛出原始激活错误；
 * - 自动恢复也失败：绝不删除 backup，并在错误中给出人工恢复路径；
 * - 新版本已激活但旧 backup 清理失败：安装仍成功，保留 backup 供人工清理。
 *
 * ops 仅用于故障注入测试，生产调用使用 node:fs。
 */
export function activateStagedDirectory(
  target: string,
  stagedTarget: string,
  backupTarget: string,
  expectedTargetExists: boolean,
  ops: DirectoryActivationOps = directoryActivationOps,
  retainBackup = false,
): { backupRetained: boolean } {
  if (ops.existsSync(target) !== expectedTargetExists) {
    removeDirectoryBestEffort(stagedTarget, ops);
    throw new Error('插件目录在安装期间发生并发变化，已中止切换: ' + target);
  }

  let oldMoved = false;
  try {
    if (expectedTargetExists) {
      ops.renameSync(target, backupTarget);
      oldMoved = true;
    }

    try {
      ops.renameSync(stagedTarget, target);
    } catch (activationError) {
      if (oldMoved) {
        try {
          ops.renameSync(backupTarget, target);
          oldMoved = false;
        } catch (restoreError) {
          const message = restoreError instanceof Error ? restoreError.message : String(restoreError);
          throw new Error(
            '新版本激活失败，旧版本自动恢复也失败；备份已保留在 ' + backupTarget
              + '，请勿删除并手工恢复（' + message + '）',
            { cause: activationError },
          );
        }
      }
      throw activationError;
    }
  } catch (error) {
    // 激活失败时 staging 已无继续使用价值；backup 必须原样保留，不能在 finally 误删。
    removeDirectoryBestEffort(stagedTarget, ops);
    throw error;
  }

  // 新 target 已经原子就位。旧 backup 清理只是维护动作，失败不能反向撤销可用的新版本。
  const backupRetained = oldMoved && (retainBackup || removeDirectoryBestEffort(backupTarget, ops));
  return { backupRetained };
}

export interface InstallResult {
  id: string;
  manifest: PluginManifest;
  /** 插件最终目录（data/plugins/<name>/） */
  dir: string;
  /** deferCommit 更新事务；调用方验证运行态后 commit，失败时 rollback。 */
  deployment?: InstallDeployment;
}

export interface InstallDeployment {
  readonly backupDir?: string;
  commit(): void;
  rollback(): void;
}

function createInstallDeployment(
  target: string,
  backupTarget: string,
  hadTarget: boolean,
): InstallDeployment {
  let state: 'active' | 'committed' | 'rolled-back' = 'active';
  return {
    backupDir: hadTarget ? backupTarget : undefined,
    commit() {
      if (state === 'committed') return;
      if (state !== 'active') throw new Error('插件部署已回滚，不能再次提交');
      state = 'committed';
      if (hadTarget && removeDirectoryBestEffort(backupTarget, directoryActivationOps)) {
        console.warn('[插件] 更新已提交，但旧版本备份清理失败，已保留: ' + backupTarget);
      }
    },
    rollback() {
      if (state === 'rolled-back') return;
      if (state !== 'active') throw new Error('插件部署已提交，不能回滚');

      if (!hadTarget) {
        if (removeDirectoryBestEffort(target, directoryActivationOps)) {
          throw new Error('插件更新回滚失败，新目录无法删除: ' + target);
        }
        state = 'rolled-back';
        return;
      }
      if (!existsSync(backupTarget)) {
        throw new Error('插件更新回滚失败，旧版本备份不存在: ' + backupTarget);
      }

      const failedTarget = backupTarget + '-failed-new';
      let newMoved = false;
      try {
        if (existsSync(target)) {
          renameSync(target, failedTarget);
          newMoved = true;
        }
        renameSync(backupTarget, target);
      } catch (error) {
        if (newMoved && !existsSync(target) && existsSync(failedTarget)) {
          try { renameSync(failedTarget, target); } catch { /* 两份均保留，交由人工恢复 */ }
        }
        throw new Error(
          '插件更新回滚失败；旧版本备份保留在 ' + backupTarget + '，请勿删除并手工恢复',
          { cause: error },
        );
      }
      if (newMoved && removeDirectoryBestEffort(failedTarget, directoryActivationOps)) {
        console.warn('[插件] 旧版本已恢复，但失败的新版本残件未清理: ' + failedTarget);
      }
      state = 'rolled-back';
    },
  };
}

/** 手动递归拷贝（fs.cpSync 在本机 Node 22.22.2 上原生崩溃 0xC0000409，规避） */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.name === '.git') continue;
    if (ent.isSymbolicLink()) throw new Error(`插件安装包不接受符号链接: ${s}`);
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

/** 远程 zip URL（GitHub release/archive 等）；须先于 isGitUrl 判断（archive URL 也含三段路径） */
function isRemoteZipUrl(source: string): boolean {
  return /^https?:\/\/.+\.zip(\?.*)?$/.test(source);
}

/**
 * GitHub archive zip → codeload 直连。
 * github.com/<o>/<r>/archive/... 的 302 跳转流在本机网络下 body 常挂死（headers 快、body 不结束），
 * codeload.github.com 同一资源直连稳定；其余域名原样返回。
 */
function normalizeZipUrl(url: string): string {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/archive\/(?:refs\/)?(heads|tags)\/(.+?)\.zip(\?.*)?$/.exec(url);
  if (m) return `https://codeload.github.com/${m[1]}/${m[2]}/zip/refs/${m[3]}/${m[4]}`;
  return url;
}

/** npm 包名 → 插件 id（小写字母/数字/-/_）：scope 展开为前缀、大写折叠、非法字符折叠为 - */
function normalizePluginId(name: string): string {
  const folded = name.trim().toLowerCase()
    .replace(/^@/, '')          // @scope/name → scope/name
    .replace(/[^a-z0-9_-]+/g, '-');
  return folded || 'unnamed-plugin';
}

/** 下载远程文件到本地路径（Node 22 全局 fetch；60s 超时 + 失败重试 1 次） */
async function downloadTo(url: string, destPath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import('node:fs');
      writeFileSync(destPath, buf);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`下载失败: ${url}（${(lastErr as Error)?.message?.slice(0, 120) ?? '未知'}）`);
}

/** 把 tmp 根下的 subDir 子目录内容提升为 tmp 根（monorepo 插件包定位；原根其余内容丢弃） */
function promoteSubdir(tmp: string, subDir: string): void {
  const sub = resolveContained(tmp, subDir, '来源子目录');
  if (lstatSync(sub).isSymbolicLink()) throw new Error(`来源子目录不接受符号链接: ${subDir}`);
  const staging = mkdtempSync(join(dirname(tmp), '.tmp-promote-'));
  try {
    copyDir(sub, staging);
    rmSync(tmp, { recursive: true, force: true });
    renameSync(staging, tmp);
  } catch (error) {
    removeDirectoryBestEffort(staging, directoryActivationOps);
    throw error;
  }
}

export async function installFromSource(
  pluginsDir: string,
  source: string,
  opts: { replace?: boolean; expectedId?: string; deferCommit?: boolean } = {},
): Promise<InstallResult> {
  mkdirSync(pluginsDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'jg-plugin-install-'));
  try {
    if (existsSync(source) && statSync(source).isDirectory()) {
      // 本地目录（开发/测试）
      if (lstatSync(source).isSymbolicLink()) throw new Error('插件来源目录不能是符号链接');
      copyDir(source, tmp);
    } else if (existsSync(source) && source.endsWith('.zip')) {
      // 本地 zip：PowerShell Expand-Archive（Windows 内置；运行时进程不受 DSH 沙箱约束）
      const code = run('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${source.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`]);
      if (code !== 0) throw new Error(`zip 解压失败（exit ${code}）: ${source}`);
    } else if (isRemoteZipUrl(source)) {
      // 远程 zip（GitHub release/archive 等）：下载到临时文件再解压
      const zipPath = `${tmp}.zip`;
      try {
        await downloadTo(normalizeZipUrl(source), zipPath);
        const code = run('powershell.exe', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`]);
        if (code !== 0) throw new Error(`zip 解压失败（exit ${code}）: ${source}`);
      } finally {
        rmSync(zipPath, { force: true });
      }
    } else if (isGitUrl(source)) {
      // ST 同款：git clone --depth 1；URL 可带 #子目录 后缀指定 monorepo 内插件包
      // （如 https://github.com/x/y.git#packages/foo → 克隆根，取 packages/foo 为插件根）
      let url = source;
      let subDir = '';
      const hashAt = url.indexOf('#');
      if (hashAt !== -1) {
        subDir = url.slice(hashAt + 1).replace(/^\/+/, '');
        url = url.slice(0, hashAt);
      }
      const code = run('git', ['clone', '--depth', '1', url, tmp]);
      if (code !== 0) throw new Error(`git clone 失败（exit ${code}）: ${source}`);
      if (subDir) {
        const resolvedSubDir = resolveContained(tmp, subDir, '来源子目录');
        if (!existsSync(resolvedSubDir)) throw new Error(`来源指定的子目录不存在: ${subDir}`);
        promoteSubdir(tmp, subDir);
      }
    } else {
      throw new Error(`不支持的插件来源: ${source}（支持 git URL / 本地目录 / .zip）`);
    }

    // 校验 manifest：两套标准并存（04 §4.1 ST 风格 / DSH bundle 风格）
    //  1) DSH 标准包：package.json（name+main）+ ESM apply 入口 → 归一化为 manifest
    //  2) ST 风格：manifest.json（zod 校验）
    // monorepo 兼容：根目录无 package.json/manifest.json 时，向下扫描插件包
    // （一级 x/ 与二级常见工作区目录 packages|plugins|libs|bundles/*；DSH 多插件仓库常见形态）。
    // 唯一候选自动提升；多个候选报错列出，让用户用 #子路径 来源指定。
    if (!existsSync(join(tmp, 'package.json')) && !existsSync(join(tmp, 'manifest.json'))) {
      const scanDirs = readdirSync(tmp, { withFileTypes: true }).filter((e) => e.isDirectory());
      const candidates: { dir: string; sub: string }[] = [];
      for (const lvl1 of scanDirs) {
        if (DshPluginHost.isDshPackage(join(tmp, lvl1.name))) {
          candidates.push({ dir: lvl1.name, sub: lvl1.name });
          continue;
        }
        // 二级：仅进入常见工作区目录，避免误入 .git/assets 等深扫
        if (!/^(packages|plugins|libs|bundles|workspaces)$/.test(lvl1.name)) continue;
        for (const lvl2 of readdirSync(join(tmp, lvl1.name), { withFileTypes: true })) {
          if (lvl2.isDirectory() && DshPluginHost.isDshPackage(join(tmp, lvl1.name, lvl2.name))) {
            candidates.push({ dir: `${lvl1.name}/${lvl2.name}`, sub: join(lvl1.name, lvl2.name) });
          }
        }
      }
      if (candidates.length === 1) {
        promoteSubdir(tmp, candidates[0].sub);
      } else if (candidates.length > 1) {
        throw new Error(`仓库根无插件清单，且发现 ${candidates.length} 个插件包（${candidates.map((c) => c.dir).join(', ')}）。请在来源后追加 #子目录 指定其一，如 ${source}#${candidates[0].dir}`);
      }
    }
    let manifest: PluginManifest;
    if (DshPluginHost.isDshPackage(tmp)) {
      const pkg = JSON.parse(readFileSync(join(tmp, 'package.json'), 'utf8')) as {
        name?: string; version?: string; description?: string; author?: string; homepage?: string; license?: string; main?: string;
      };
      const rawName = pkg.name ?? '';
      manifest = PluginManifestSchema.parse({
        name: normalizePluginId(rawName),   // npm 包名（@scope/name、大写）折叠为合法 id
        display_name: rawName || undefined,
        version: pkg.version ?? '0.1.0',
        description: pkg.description ?? '',
        author: typeof pkg.author === 'object' ? ((pkg.author as { name?: string }).name ?? '') : (pkg.author ?? ''),
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

    // update 必须保持插件身份稳定。若上游改包名，不能把新目录落地后仍让旧 registry 指向旧代码。
    if (opts.expectedId !== undefined && manifest.name !== opts.expectedId) {
      throw new Error('插件更新后的 id 与已安装记录不一致: 期望 '
        + opts.expectedId + '，实际 ' + manifest.name);
    }

    // 定位插件根（build_dir 存在则用构建产物目录）
    let srcRoot = tmp;
    if (manifest.build_dir) {
      const bd = resolveContained(tmp, manifest.build_dir, 'build_dir');
      if (existsSync(bd) && statSync(bd).isDirectory()) {
        if (lstatSync(bd).isSymbolicLink()) throw new Error('build_dir 不能是符号链接');
        srcRoot = bd;
      }
    }

    const target = join(pluginsDir, manifest.name);
    const targetExists = existsSync(target);
    if (targetExists && !opts.replace) {
      throw new Error(`插件已存在: ${manifest.name}（先卸载，或用 update）`);
    }

    // 先在同一 pluginsDir 完整复制 staging，再用同卷 rename 切换；任何失败都恢复旧目录。
    // 这样 update 不会在慢复制中向运行实例暴露半套文件，也不会因复制失败丢掉旧版本。
    // mkdtempSync 保证并发/进程残留场景不复用旧 staging；backup 名随唯一 staging 派生。
    const stagedTarget = mkdtempSync(join(pluginsDir, `.staged-${manifest.name}-`));
    const backupTarget = stagedTarget + '-backup';
    try {
      copyDir(srcRoot, stagedTarget);
    } catch (error) {
      if (removeDirectoryBestEffort(stagedTarget, directoryActivationOps)) {
        console.warn('[插件] staging 复制失败且清理未完成，残件已保留: ' + stagedTarget);
      }
      throw error;
    }
    const { backupRetained } = activateStagedDirectory(
      target,
      stagedTarget,
      backupTarget,
      targetExists,
      directoryActivationOps,
      opts.deferCommit === true,
    );
    if (backupRetained && !opts.deferCommit) {
      console.warn('[插件] 新版本已激活，但旧版本备份清理失败，已保留: ' + backupTarget);
    }
    const deployment = opts.deferCommit
      ? createInstallDeployment(target, backupTarget, targetExists)
      : undefined;
    return { id: manifest.name, manifest, dir: target, deployment };
  } finally {
    if (removeDirectoryBestEffort(tmp, directoryActivationOps)) {
      console.warn('[插件] 安装临时目录清理失败，已保留: ' + tmp);
    }
  }
}
