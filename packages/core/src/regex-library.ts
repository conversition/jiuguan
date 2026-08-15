/**
 * core 包 - 正则库（data/regex-rules.json 持久化 + 用户维护）
 * 合并视图：内置默认（builtin）+ 用户维护（user）+ 卡片自动导入（card），按 source 排序。
 * 用户层路径可用 JG_USER_DATA_DIR 覆盖（测试隔离，同资产用户层）。
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_REGEX_RULES, importCardRegexScripts } from './regex.ts';
import type { RegexRule } from './regex.ts';

const RULES_FILE = 'regex-rules.json';

export class RegexLibrary {
  private file: string;
  private userRules = new Map<string, RegexRule>();

  constructor(private userDataDir = process.env.JG_USER_DATA_DIR ? resolve(process.env.JG_USER_DATA_DIR) : resolve(process.cwd(), 'data')) {
    this.file = resolve(this.userDataDir, RULES_FILE);
    mkdirSync(this.userDataDir, { recursive: true });
    this.load();
  }

  /** 合并视图：builtin + card（自动导入，持久化于 user 文件）+ user 编辑（覆盖同名） */
  list(): RegexRule[] {
    const map = new Map<string, RegexRule>();
    for (const r of DEFAULT_REGEX_RULES) map.set(r.id, r);
    for (const r of this.userRules.values()) {
      if (r.source === 'card' || r.source === 'user') map.set(r.id, r);
    }
    return [...map.values()].sort((a, b) => a.order - b.order || (a.source === 'builtin' ? 0 : 1));
  }

  get(id: string): RegexRule | undefined {
    return this.list().find((r) => r.id === id);
  }

  /** 新增/更新用户规则（builtin 可覆盖启用状态——以 id 覆盖） */
  save(rule: RegexRule): RegexRule {
    const existing = this.userRules.get(rule.id);
    const next: RegexRule = {
      ...(existing ?? { id: rule.id, source: 'user' as const }),
      ...rule,
      source: 'user',
    };
    this.userRules.set(rule.id, next);
    this.persist();
    return next;
  }

  /** 删除用户/卡片规则（builtin 不可删） */
  remove(id: string): boolean {
    const r = this.userRules.get(id);
    if (!r || r.source === 'builtin') return false;
    this.userRules.delete(id);
    this.persist();
    return true;
  }

  /** 智能导入卡片正则脚本（按 findRegex+name 去重；返回新增条数） */
  importFromCard(scripts: { scriptName?: string; findRegex?: string; replaceString?: string; markdownOnly?: boolean; promptOnly?: boolean; disabled?: boolean }[]): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    for (const rule of importCardRegexScripts(scripts)) {
      const dup = [...this.userRules.values()].some((r) => r.source === 'card' && (r.name === rule.name || r.findRegex === rule.findRegex));
      if (dup) { skipped++; continue; }
      this.userRules.set(rule.id, rule);
      imported++;
    }
    if (imported > 0) this.persist();
    return { imported, skipped };
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { rules?: RegexRule[] };
      for (const r of raw.rules ?? []) {
        if (r.source === 'user' || r.source === 'card') this.userRules.set(r.id, r);
      }
    } catch { /* 损坏则重建 */ }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify({ rules: [...this.userRules.values()].sort((a, b) => a.order - b.order) }, null, 2));
  }
}
