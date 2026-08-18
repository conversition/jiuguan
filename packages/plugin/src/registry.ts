/**
 * plugin 包 - 插件注册表（04 §4.1 Plugin Registry + 07 §7 插件市场）
 * 管理：安装（git/本地/zip）/ 卸载 / 启用禁用 / 更新 / 服务端入口读取
 * 持久化：data/plugins/registry.json（插件本体在 data/plugins/<name>/）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFromSource } from './installer.ts';
import type { PluginManifest } from './manifest.ts';

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
  enabled: boolean;
  /** 安装来源（git URL / 本地路径 / zip），update 复用 */
  source: string;
  installedAt: string;
  updatedAt: string;
}

const REGISTRY_FILE = 'registry.json';

export class PluginRegistry {
  private file: string;
  private records = new Map<string, PluginRecord>();

  constructor(readonly pluginsDir: string) {
    this.file = join(pluginsDir, REGISTRY_FILE);
    mkdirSync(pluginsDir, { recursive: true });
    this.load();
  }

  list(): PluginRecord[] {
    return [...this.records.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id);
  }

  async install(source: string): Promise<PluginRecord> {
    const r = await installFromSource(this.pluginsDir, source);
    const now = new Date().toISOString();
    const rec: PluginRecord = {
      id: r.id, name: r.manifest.name, displayName: r.manifest.display_name || r.manifest.name,
      version: r.manifest.version, description: r.manifest.description, author: r.manifest.author,
      homepage: r.manifest.homepage, license: r.manifest.license, includes: r.manifest.includes,
      server: r.manifest.server, hooks: r.manifest.hooks ?? [], permissions: r.manifest.permissions ?? {}, enabled: true, source,
      installedAt: now, updatedAt: now,
    };
    this.records.set(rec.id, rec);
    this.save();
    return rec;
  }

  /** 从原来源重装（git pull / 重新拷贝），版本号更新 */
  async update(id: string): Promise<PluginRecord> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`插件不存在: ${id}`);
    const r = await installFromSource(this.pluginsDir, rec.source, { replace: true });
    rec.version = r.manifest.version;
    rec.displayName = r.manifest.display_name || r.manifest.name;
    rec.description = r.manifest.description;
    rec.includes = r.manifest.includes;
    rec.server = r.manifest.server;
    rec.hooks = r.manifest.hooks ?? [];
    rec.updatedAt = new Date().toISOString();
    this.save();
    return rec;
  }

  setEnabled(id: string, enabled: boolean): PluginRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`插件不存在: ${id}`);
    rec.enabled = enabled;
    this.save();
    return rec;
  }

  uninstall(id: string): void {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`插件不存在: ${id}`);
    rmSync(join(this.pluginsDir, rec.name), { recursive: true, force: true });
    this.records.delete(id);
    this.save();
  }

  /** 读取服务端入口源码（沙箱执行用） */
  serverSource(id: string): string | null {
    const rec = this.records.get(id);
    if (!rec?.server) return null;
    const p = join(this.pluginsDir, rec.name, rec.server);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8');
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { plugins?: PluginRecord[] };
      for (const r of raw.plugins ?? []) this.records.set(r.id, r);
    } catch { /* 损坏则空表（重新安装） */ }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify({ plugins: this.list() }, null, 2));
  }
}

export type { PluginManifest };
