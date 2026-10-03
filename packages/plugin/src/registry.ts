/**
 * plugin 包 - 插件注册表（04 §4.1 Plugin Registry + 07 §7 插件市场）
 * 管理：安装（git/本地/zip）/ 卸载 / 启用禁用 / 更新 / 服务端入口读取
 * 持久化：data/plugins/registry.json（插件本体在 data/plugins/<name>/）
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { installFromSource, type InstallResult } from './installer.ts';
import { DshPluginHost } from './dsh-host.ts';
import { PluginManifestSchema, type PluginManifest } from './manifest.ts';

export interface PluginRecord {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  license?: string;
  includes: string[];
  server?: string;
  hooks: string[];
  /** 权限声明（0.5.0 沙箱强化；未声明 = 最小） */
  permissions: { network?: boolean; fs?: boolean; runtime?: boolean };
  /** 插件标准：st = ST 风格沙箱钩子（manifest.json）；dsh = DSH bundle 宿主直跑（package.json+main） */
  kind: 'st' | 'dsh';
  enabled: boolean;
  /** 安装来源（git URL / 本地路径 / zip），update 复用 */
  source: string;
  installedAt: string;
  updatedAt: string;
}

const REGISTRY_FILE = 'registry.json';
const PLUGIN_ID_RE = /^[a-z0-9_-]+$/;

const PersistedPluginRecordSchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE),
  name: z.string().regex(PLUGIN_ID_RE),
  displayName: z.string(),
  version: z.string(),
  description: z.string().default(''),
  author: z.string().default(''),
  homepage: z.string().optional(),
  license: z.string().optional(),
  includes: PluginManifestSchema.shape.includes,
  server: PluginManifestSchema.shape.server,
  hooks: z.array(z.string()).default([]),
  permissions: PluginManifestSchema.shape.permissions,
  kind: z.enum(['st', 'dsh']).optional(),
  enabled: z.boolean(),
  source: z.string().min(1),
  installedAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((record, ctx) => {
  if (record.id !== record.name) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'registry 的 id 与 name 必须一致' });
  }
});

function cloneRecord(record: PluginRecord): PluginRecord {
  return {
    ...record,
    includes: [...record.includes],
    hooks: [...record.hooks],
    permissions: { ...record.permissions },
  };
}

function resolveContainedPath(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} 超出插件目录边界: ${candidate}`);
  }
  return target;
}

function assertRealPathContained(root: string, target: string, label: string): void {
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  const rel = relative(realRoot, realTarget);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} 的真实路径超出插件目录边界: ${target}`);
  }
}

function atomicWriteFile(path: string, contents: string): void {
  const tmp = path + '.tmp-' + process.pid + '-' + randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx');
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { rmSync(tmp, { force: true }); } catch { /* 保留主错误 */ }
    throw error;
  }
}

export interface PluginUpdateTransaction {
  readonly previous: PluginRecord;
  readonly record: PluginRecord;
  readonly state: PluginUpdateState;
  readonly recoveryError?: PluginUpdateRecoveryError;
  commit(): PluginRecord;
  rollback(): void;
}

export type PluginUpdateState = 'prepared' | 'committed' | 'rolled-back' | 'rollback-failed';

export class PluginUpdateRecoveryError extends Error {
  constructor(
    readonly pluginId: string,
    readonly backupDir: string | undefined,
    cause: unknown,
  ) {
    super(
      `插件 ${pluginId} 自动回滚失败，进入 recovery-required 状态`
        + (backupDir ? `；旧版本备份: ${backupDir}` : ''),
      { cause },
    );
    this.name = 'PluginUpdateRecoveryError';
  }
}

export class PluginRegistry {
  private file: string;
  private records = new Map<string, PluginRecord>();
  private generations = new Map<string, number>();
  private updateReservations = new Map<string, symbol>();

  constructor(readonly pluginsDir: string) {
    this.file = join(pluginsDir, REGISTRY_FILE);
    mkdirSync(pluginsDir, { recursive: true });
    this.load();
  }

  list(): PluginRecord[] {
    return [...this.records.values()]
      .map(cloneRecord)
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  get(id: string): PluginRecord | undefined {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async install(source: string): Promise<PluginRecord> {
    const r = await installFromSource(this.pluginsDir, source);
    const rec = this.recordFromInstall(r, source);
    const next = new Map(this.records);
    next.set(rec.id, rec);
    try {
      this.persist(next);
    } catch (error) {
      // 注册表未提交时撤销新安装；内存仍保持旧快照。
      const target = this.pluginDirectory(rec.name);
      try { rmSync(target, { recursive: true, force: true }); } catch { /* 原错误优先 */ }
      throw error;
    }
    this.records = next;
    this.bumpGeneration(rec.id);
    return cloneRecord(rec);
  }

  /** 准备更新：切换磁盘但保留旧 backup；运行态验证成功后才 commit。 */
  async prepareUpdate(id: string, sourceOverride?: string): Promise<PluginUpdateTransaction> {
    const current = this.records.get(id);
    if (!current) throw new Error(`插件不存在: ${id}`);
    const updateSource = sourceOverride ?? current.source;
    if (!updateSource.trim()) throw new Error(`插件 ${id} 的更新来源不能为空`);
    this.assertNotReserved(id);
    const reservation = Symbol(`plugin-update:${id}`);
    this.updateReservations.set(id, reservation);
    const baseGeneration = this.generations.get(id) ?? 0;
    const previous = cloneRecord(current);
    let r: InstallResult;
    try {
      r = await installFromSource(this.pluginsDir, updateSource, {
        replace: true,
        expectedId: current.id,
        deferCommit: true,
      });
      if (!r.deployment) throw new Error('插件更新未返回部署事务');
    } catch (error) {
      this.releaseReservation(id, reservation);
      throw error;
    }

    let nextRecord: PluginRecord;
    try {
      nextRecord = this.recordFromInstall(r, updateSource, previous);
      if (sourceOverride !== undefined) {
        nextRecord = { ...nextRecord, source: updateSource };
      }
    } catch (error) {
      try {
        r.deployment.rollback();
        this.releaseReservation(id, reservation);
      } catch (rollbackError) {
        throw new PluginUpdateRecoveryError(id, r.deployment.backupDir, rollbackError);
      }
      throw error;
    }
    let state: PluginUpdateState = 'prepared';
    let recoveryError: PluginUpdateRecoveryError | undefined;

    const rollbackDeployment = (): void => {
      try {
        r.deployment!.rollback();
        state = 'rolled-back';
        recoveryError = undefined;
        this.releaseReservation(id, reservation);
      } catch (error) {
        state = 'rollback-failed';
        recoveryError = new PluginUpdateRecoveryError(id, r.deployment?.backupDir, error);
        // 保持 reservation：恢复旧版本前拒绝其他 mutation 覆盖唯一 backup。
        throw recoveryError;
      }
    };

    return {
      get previous() { return cloneRecord(previous); },
      get record() { return cloneRecord(nextRecord); },
      get state() { return state; },
      get recoveryError() { return recoveryError; },
      commit: () => {
        if (state === 'committed') return cloneRecord(nextRecord);
        if (state === 'rollback-failed') throw recoveryError;
        if (state !== 'prepared') throw new Error('插件更新已回滚，不能提交');
        const liveGeneration = this.generations.get(id) ?? 0;
        if (this.records.get(id) !== current || liveGeneration !== baseGeneration) {
          rollbackDeployment();
          throw new Error(`插件 ${id} 在更新期间被其他操作修改，已回滚磁盘`);
        }
        const next = new Map(this.records);
        next.set(id, nextRecord);
        try {
          this.persist(next);
        } catch (error) {
          rollbackDeployment();
          throw error;
        }
        this.records = next;
        this.bumpGeneration(id);
        state = 'committed';
        this.releaseReservation(id, reservation);
        try {
          r.deployment?.commit();
        } catch (error) {
          // registry 与 target 已提交；收尾失败只能留下可恢复 backup，不能伪装成更新失败。
          console.warn(`[插件] ${id} 更新已提交，但部署收尾失败: ${(error as Error).message}`);
        }
        return cloneRecord(nextRecord);
      },
      rollback: () => {
        if (state === 'rolled-back') return;
        if (state === 'rollback-failed') {
          rollbackDeployment();
          return;
        }
        if (state !== 'prepared') throw new Error('插件更新已提交，不能回滚');
        rollbackDeployment();
      },
    };
  }

  /** 非运行时调用的兼容入口：准备后立即提交；server 使用 prepareUpdate 做 apply 验证。 */
  async update(id: string, sourceOverride?: string): Promise<PluginRecord> {
    const transaction = await this.prepareUpdate(id, sourceOverride);
    return transaction.commit();
  }

  setEnabled(id: string, enabled: boolean): PluginRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`插件不存在: ${id}`);
    this.assertNotReserved(id);
    const changed = { ...cloneRecord(rec), enabled };
    const next = new Map(this.records);
    next.set(id, changed);
    this.persist(next);
    this.records = next;
    this.bumpGeneration(id);
    return cloneRecord(changed);
  }

  uninstall(id: string): void {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`插件不存在: ${id}`);
    this.assertNotReserved(id);
    const target = this.pluginDirectory(rec.name);
    const tombstone = resolveContainedPath(
      this.pluginsDir,
      `.removed-${rec.name}-${randomUUID()}`,
      '插件卸载 tombstone',
    );
    let moved = false;
    if (existsSync(target)) {
      renameSync(target, tombstone);
      moved = true;
    }
    const next = new Map(this.records);
    next.delete(id);
    try {
      this.persist(next);
    } catch (error) {
      if (moved && existsSync(tombstone)) {
        try { renameSync(tombstone, target); } catch (rollbackError) {
          throw new Error('注册表卸载提交失败且插件目录恢复失败；残件: ' + tombstone, { cause: rollbackError });
        }
      }
      throw error;
    }
    this.records = next;
    this.generations.delete(id);
    if (moved) {
      try { rmSync(tombstone, { recursive: true, force: true }); } catch {
        console.warn('[插件] 卸载已提交，但目录残件清理失败: ' + tombstone);
      }
    }
  }

  /** 读取服务端入口源码（沙箱执行用） */
  serverSource(id: string): string | null {
    const rec = this.records.get(id);
    if (!rec?.server) return null;
    const root = this.pluginDirectory(rec.name);
    const p = resolveContainedPath(root, rec.server, '插件 server');
    if (!existsSync(p)) return null;
    if (!existsSync(root) || lstatSync(root).isSymbolicLink() || lstatSync(p).isSymbolicLink()) return null;
    try { assertRealPathContained(root, p, '插件 server'); } catch { return null; }
    return readFileSync(p, 'utf8');
  }

  private recordFromInstall(result: InstallResult, source: string, previous?: PluginRecord): PluginRecord {
    const now = new Date().toISOString();
    const manifest = result.manifest;
    const kind: PluginRecord['kind'] = DshPluginHost.isDshPackage(this.pluginDirectory(manifest.name)) ? 'dsh' : 'st';
    return {
      id: result.id,
      name: manifest.name,
      displayName: manifest.display_name || manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      license: manifest.license,
      includes: [...manifest.includes],
      server: manifest.server,
      hooks: [...(manifest.hooks ?? [])],
      permissions: { ...(manifest.permissions ?? {}) },
      kind,
      enabled: previous?.enabled ?? true,
      source: previous?.source ?? source,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
    };
  }

  private persist(records: Map<string, PluginRecord>): void {
    const plugins = [...records.values()]
      .map(cloneRecord)
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const payload = JSON.stringify({ plugins }, null, 2);
    const backup = this.file + '.bak';
    const previousBackup = existsSync(backup) ? readFileSync(backup, 'utf8') : undefined;
    // backup 镜像本次待提交的完整 payload。若主文件替换失败，旧主文件仍优先加载；
    // 若主文件日后损坏，backup 与已提交的插件代码/权限保持同一代。
    atomicWriteFile(backup, payload);
    try {
      atomicWriteFile(this.file, payload);
    } catch (error) {
      try {
        if (previousBackup !== undefined) atomicWriteFile(backup, previousBackup);
        else rmSync(backup, { force: true });
      } catch (backupError) {
        throw new Error(
          '插件注册表主文件写入失败，且 last-known-good 备份恢复失败: ' + backup,
          { cause: new AggregateError([error, backupError]) },
        );
      }
      throw error;
    }
  }

  private load(): void {
    const backup = this.file + '.bak';
    const candidates = [this.file, backup].filter((path) => existsSync(path));
    if (candidates.length === 0) return;
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const text = readFileSync(candidate, 'utf8');
        const raw = JSON.parse(text) as { plugins?: unknown };
        if (!raw || !Array.isArray(raw.plugins)) throw new Error('plugins 数组缺失');
        const loaded = new Map<string, PluginRecord>();
        for (const [index, value] of raw.plugins.entries()) {
          const parsed = PersistedPluginRecordSchema.safeParse(value);
          if (!parsed.success) {
            throw new Error(`plugins[${index}] 非法: ${parsed.error.issues[0]?.message ?? '未知错误'}`);
          }
          const pluginDir = this.pluginDirectory(parsed.data.name);
          if (existsSync(pluginDir) && lstatSync(pluginDir).isSymbolicLink()) {
            throw new Error(`plugins[${index}] 目录不能是符号链接: ${parsed.data.name}`);
          }
          const kind = parsed.data.kind
            ?? (DshPluginHost.isDshPackage(pluginDir) ? 'dsh' : 'st');
          const record: PluginRecord = { ...parsed.data, kind };
          if (loaded.has(record.id)) throw new Error(`registry 含重复插件 id: ${record.id}`);
          loaded.set(record.id, cloneRecord(record));
        }
        this.records = loaded;
        this.generations = new Map([...loaded.keys()].map((id) => [id, 1]));
        if (candidate === backup) {
          console.warn('[插件] registry.json 损坏或缺失，已从 last-known-good 备份恢复');
          atomicWriteFile(this.file, text);
        }
        return;
      } catch (error) {
        errors.push(candidate + ': ' + (error as Error).message);
      }
    }
    throw new Error('插件注册表损坏且无法恢复：' + errors.join('；'));
  }

  private pluginDirectory(name: string): string {
    if (!PLUGIN_ID_RE.test(name)) throw new Error(`插件目录名非法: ${name}`);
    return resolveContainedPath(this.pluginsDir, name, '插件目录');
  }

  private assertNotReserved(id: string): void {
    if (this.updateReservations.has(id)) {
      throw new Error(`插件 ${id} 正在更新或等待人工恢复，拒绝并发修改`);
    }
  }

  private releaseReservation(id: string, reservation: symbol): void {
    if (this.updateReservations.get(id) === reservation) this.updateReservations.delete(id);
  }

  private bumpGeneration(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }
}

export type { PluginManifest };
