/**
 * core 包 - Skill 系统
 * 公共格式：data/skills/<skill-name>/SKILL.md
 *   ---
 *   name: 技能名
 *   description: 何时使用（触发判断依据）
 *   version: 1.0
 *   enabled: true
 *   ---
 *   <指令正文（markdown，平台读取后注入 <Skill 指令> 块）>
 *
 * 用法：
 *   - listSkills()      扫描文件夹，识别公共格式
 *   - addSkill / setEnabled / deleteSkill   增删改
 *   - matchSkills(query) 并行匹配用户输入 vs 各 skill 描述 → 命中的 skill 正文
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';

export const DEFAULT_SKILLS_DIR = join('data', 'skills');

export interface SkillInfo {
  name: string;
  description: string;
  /** 显式触发词（逗号分隔；命中即强相关，补足语义泛化不足） */
  keywords: string[];
  version: string;
  enabled: boolean;
  /** SKILL.md 路径 */
  path: string;
}

/** 解析 SKILL.md：frontmatter（--- 包裹的 key: value）+ 正文 */
export function parseSkillMd(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  let body = content;
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
    body = m[2].trim();
  }
  return { meta, body };
}

/** 序列化为 SKILL.md（frontmatter 规范化） */
export function renderSkillMd(name: string, description: string, version: string, enabled: boolean, body: string, keywords: string[] = []): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\nenabled: ${enabled}${keywords.length ? `\nkeywords: ${keywords.join(',')}` : ''}\n---\n\n${body.trim()}\n`;
}

/** 解析 keywords 字段（逗号分隔） */
function parseKeywords(meta: Record<string, string>): string[] {
  return (meta.keywords ?? '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 扫描 data/skills 下的 skill 目录（各含 SKILL.md），返回全部 skill（按名称排序） */
export function listSkills(dir = DEFAULT_SKILLS_DIR): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const raw = readFileSync(mdPath, 'utf8');
    const { meta } = parseSkillMd(raw);
    out.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? '',
      keywords: parseKeywords(meta),
      version: meta.version ?? '1.0',
      enabled: meta.enabled !== 'false',
      path: mdPath,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 新增 skill：写 data/skills/<name>/SKILL.md（目录已存在则更新） */
export function addSkill(
  input: { name: string; description: string; content: string; keywords?: string[]; version?: string; enabled?: boolean },
  dir = DEFAULT_SKILLS_DIR,
): SkillInfo {
  const name = input.name.trim();
  if (!name) throw new Error('技能名不能为空');
  // 防路径穿越：技能名只允许 [\w] 或中文字符（CJK 统一表意 + 扩展）
  if (!/^[\w一-鿿-]+$/.test(name)) throw new Error(`非法技能名: ${name}（仅允许中文/字母/数字/下划线/中划线）`);
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const mdPath = join(skillDir, 'SKILL.md');
  const body = input.content.trim();
  if (!body) throw new Error('技能指令正文不能为空');
  const keywords = (input.keywords ?? []).map((s) => s.trim()).filter(Boolean);
  writeFileSync(mdPath, renderSkillMd(name, input.description.trim(), input.version ?? '1.0', input.enabled ?? true, body, keywords), 'utf8');
  return { name, description: input.description.trim(), keywords, version: input.version ?? '1.0', enabled: input.enabled ?? true, path: mdPath };
}

/** 启停 */
export function setSkillEnabled(name: string, enabled: boolean, dir = DEFAULT_SKILLS_DIR): SkillInfo {
  const skill = findSkill(name, dir);
  if (!skill) throw new Error(`技能不存在: ${name}`);
  const { meta, body } = parseSkillMd(readFileSync(skill.path, 'utf8'));
  writeFileSync(skill.path, renderSkillMd(meta.name ?? name, meta.description ?? '', meta.version ?? '1.0', enabled, body, parseKeywords(meta)), 'utf8');
  return { ...skill, enabled };
}

/** 删除（仅删用户层目录） */
export function deleteSkill(name: string, dir = DEFAULT_SKILLS_DIR): void {
  const skill = findSkill(name, dir);
  if (!skill) throw new Error(`技能不存在: ${name}`);
  rmSync(skill.dir, { recursive: true, force: true });
}

export function findSkill(name: string, dir = DEFAULT_SKILLS_DIR): (SkillInfo & { dir: string }) | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const { meta } = parseSkillMd(readFileSync(mdPath, 'utf8'));
    if ((meta.name ?? entry.name) === name) {
      return {
        name: meta.name ?? entry.name,
        description: meta.description ?? '',
        keywords: parseKeywords(meta),
        version: meta.version ?? '1.0',
        enabled: meta.enabled !== 'false',
        path: mdPath,
        dir: join(dir, entry.name),
      };
    }
  }
  return null;
}

/** 读取 skill 指令正文 */
export function readSkillBody(name: string, dir = DEFAULT_SKILLS_DIR): string {
  const skill = findSkill(name, dir);
  if (!skill) return '';
  const { body } = parseSkillMd(readFileSync(skill.path, 'utf8'));
  return body;
}

/** 语义匹配：字符 n-gram 余弦（零依赖；description 较短时足够区分意图） */
function ngramVec(text: string, n = 2): Map<string, number> {
  const v = new Map<string, number>();
  const t = text.replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i + n <= t.length; i++) {
    const g = t.slice(i, i + n);
    v.set(g, (v.get(g) ?? 0) + 1);
  }
  return v;
}
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; if (b.has(k)) dot += v * b.get(k)!; }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SkillMatch {
  skill: SkillInfo;
  score: number;
  body: string;
}

/** 并行匹配用户输入 vs 各启用 skill → 命中的 skill 正文
 *  双通道：① keywords 关键词命中（确定性，强相关，记 1.0）② description 语义（n-gram 余弦）
 *  最终得分 = max(关键词命中 ? 1.0 : 0, 语义分)，阈值过滤 + topK 截断 */
export function matchSkills(
  query: string,
  opts: { dir?: string; threshold?: number; topK?: number; onlyEnabled?: boolean } = {},
): SkillMatch[] {
  const { dir, threshold = 0.18, topK = 3, onlyEnabled = true } = opts;
  const skills = listSkills(dir).filter((s) => (onlyEnabled ? s.enabled : true));
  if (skills.length === 0) return [];
  const qv = ngramVec(query);
  const scored: SkillMatch[] = [];
  for (const skill of skills) {
    // 通道①：关键词命中（任一触发词出现在输入中 → 强相关）
    let score = 0;
    if (skill.keywords.length > 0 && skill.keywords.some((k) => query.includes(k))) {
      score = 1.0;
    } else {
      // 通道②：description 语义相似度
      score = cosine(qv, ngramVec(skill.description));
    }
    if (score >= threshold) {
      scored.push({ skill, score, body: readSkillBody(skill.name, dir) });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 注入块渲染：<Skill 指令> 包裹命中技能正文 */
export function renderSkillBlock(matches: SkillMatch[], budgetChars = 2000): string {
  if (matches.length === 0) return '';
  let used = 0;
  const lines: string[] = [];
  for (const m of matches) {
    const block = `[${m.skill.name}|${m.score.toFixed(2)}]\n${m.body}`;
    used += block.length;
    if (used > budgetChars && lines.length > 0) break;
    lines.push(block);
  }
  return `<Skill 指令>\n${lines.join('\n\n')}\n</Skill 指令>`;
}

/** 默认技能目录名（供 UI 展示） */
export const skillDirName = (dir = DEFAULT_SKILLS_DIR) => basename(dir);
