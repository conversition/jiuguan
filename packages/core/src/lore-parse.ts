/**
 * core 包 - 世界书条目标题解析与别名索引（RAG 语义通道前置）
 *
 * 背景：角色卡/世界书的 lorebook_entry.content 绝大多数是「{{//…}} 注释 + <%_…%> EJS/MVU 变量逻辑」
 * 混合体，直接整条向量化会把模板/代码语言当成语义特征，导致「会长」这类称谓检索不到
 * 「角色乙（学生会长）」。本模块把每条切成三类段：
 *   ① 注释段（{{//…}}）   —— 人设/指令说明，提取为设定候选
 *   ② EJS/MVU 代码段     —— 识别其中变量读写并结构化保留（variableRules，不参与向量切分、不丢失）
 *   ③ 纯设定文本段       —— markdown/YAML 正文，作为可检索的自然语言设定（语义切分对象）
 *
 * 别名策略：除逐条 alias/identity 外，做「职位简写推导」——把「示例学园学生会长」推导出
 * 「学生会长/会长」，仅当全库该简写唯一映射时注册（避免「大小姐」等多实体歧义）。
 * 建成全局别名索引后，检索「会长」即可确定性命中「角色乙」条目。
 */
import type { LoreRow } from './scanner.ts';

/** 原始世界书条目的最小兼容结构（覆盖酒馆导出 WorldInfoEntry 常见字段 + DB 行形态） */
export interface WorldInfoEntryLike {
  uid?: number | string;
  /** 触发关键词：ST 世界书的 key 数组（部分文件为竖线串或单串） */
  key?: string[] | string;
  keysecondary?: string[];
  comment?: string;
  content: string;
  constant?: boolean;
  disable?: boolean;
  enabled?: boolean;
  use_regex?: boolean;
  /** 触发词/正则串 */
  triggers?: (string | { key: string; text: string })[];
  extensions?: { book?: string } | Record<string, unknown>;
}

export type LoreEntryLike = WorldInfoEntryLike | Pick<LoreRow, 'id' | 'book' | 'comment' | 'content' | 'key' | 'constant' | 'active'>;

/** 统一解析入口的中间结构 */
interface NormalizedEntry {
  id: number;
  book: string;
  comment: string;
  content: string;
  keywords: string[];   // 触发关键词（key + keysecondary + triggers.text）
  constant: boolean;
  active: boolean;
}

/** 把两种输入（原始条目 / DB 行）归一化为统一结构 */
function normalizeEntry(raw: LoreEntryLike): NormalizedEntry {
  const toStrArr = (k: unknown): string[] => {
    if (Array.isArray(k)) return k.map((x) => String(x)).filter(Boolean);
    if (typeof k === 'string' && k.trim()) return k.split('|').map((x) => x.trim()).filter(Boolean);
    if (typeof k === 'string' && k.trim()) return [k.trim()];
    return [];
  };
  const c = ((raw as WorldInfoEntryLike).content ?? '').toString();
  const w = raw as WorldInfoEntryLike;
  const r = raw as Pick<LoreRow, 'id' | 'book' | 'comment' | 'key' | 'constant' | 'active'>;
  const id = Number((w.uid ?? r.id ?? 0) ?? 0);
  const book = String(((w.extensions as { book?: string } | undefined)?.book) ?? r.book ?? '');
  // key + keysecondary + triggers.text 全并入关键词（triggers 正则串仅取 text 形式）
  const keyArr = toStrArr(w.key ?? r.key);
  const keySec = toStrArr(w.keysecondary);
  const trigArr: string[] = Array.isArray(w.triggers)
    ? w.triggers.map((t) => (typeof t === 'string' ? t : t.text)).filter((x): x is string => Boolean(x))
    : [];
  const keywords = [...keyArr, ...keySec, ...trigArr].map((s) => s.trim()).filter(Boolean);
  const constant = Boolean(w.constant ?? r.constant ?? false);
  const active = 'disable' in w ? !Boolean(w.disable) : 'enabled' in w ? Boolean(w.enabled) : Boolean(r.active ?? true);
  return { id, book, comment: String((w.comment ?? r.comment) ?? ''), content: c, keywords, constant, active };
}

/** 单个条目解析结果 */
export interface ParsedLoreEntry {
  /** 记忆服务 row id（回溯原条目用） */
  id: number;
  /** 可检索的自然语言设定（剥离 EJS 与注释；语义切分对象） */
  settingText: string;
  /** 显式别名（alias/identity/身份 数组 + comment 抽取） */
  aliases: string[];
  /** EJS/MVU 变量规则（原文 + 涉及变量名）；保留供运行时 VMS 绑定，不参与向量切分 */
  variableRules: { raw: string; mvuVars: string[] }[];
  /** 条目关键词（lorebook_entry.key，竖线分隔） */
  keywords: string[];
  /** 元信息 */
  meta: {
    book: string;
    comment: string;
    constant: boolean;
    active: boolean;
    /** 是否恒常激活（constant=1 或注释标记 alwaysOn） */
    alwaysOn: boolean;
    /** 注释里显式标记「关闭/不要打开」→ 不应参与检索注入 */
    disabledByNote: boolean;
    /** 提取到的标签块（[era_plot]、@INJECT 等首行标记） */
    tags: string[];
  };
  raw: string;
}

/** 别名索引条目 */
export interface AliasEntry {
  /** 实体规范名（如 角色乙） */
  entityName: string;
  /** 该别名的所有条目 id（通常多个条目描述同一实体） */
  entryIds: number[];
  /** 高置信（显式 alias/identity）；false=职位简写推导 */
  explicit: boolean;
}

/** EJS 代码段正则：<%_ … _%>、<% … %>、<%= … %>、<%- … %>（含下划线去空白变体） */
const EJS_RE = /<%[-=_]?[\s\S]*?[-=_]?%>/g;

/** 注释段正则：{{// … }} */
const COMMENT_RE = /\{\{\/\/[\s\S]*?\}\}/g;

/** 标签/指令首行，如 [era_plot]、[核心规则]、@INJECT、@INJECT target=…（用于 meta.tags） */
const TAG_RE = /^\s*((?:\[[一-龥A-Za-z0-9_-]+\](?:[\s\S]*?))?|@INJECT[\s\S]*?)$/;

/** 变量读取：getvar('path') / getvalues 等 */
const GETVAR_RE = /\bgetvar\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 变量写入候选：setvar(...) / storage.setItem / 赋值语句 */
const WRITEVAR_RE = /\b(setvar|setReplacement|storage\.setItem)\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * 解析单条世界书条目（兼容原始 WorldInfoEntry 与 DB lorebook_entry 行），
 * 切分三类段并抽取别名/变量规则/关键词。纯函数，无副作用，可单测。
 */
export function parseLoreEntry(raw: LoreEntryLike): ParsedLoreEntry {
  const n = normalizeEntry(raw);
  const content = n.content;
  const comment = n.comment;

  // 1) 切分：先抠出 EJS 段，再抠出注释段，剩余为设定文本
  const variableRules: ParsedLoreEntry['variableRules'] = [];
  let settingText = content;

  // EJS 段：收集原文 + 变量读写
  settingText = settingText.replace(EJS_RE, (ejsBlock) => {
    const mvuVars: string[] = [];
    for (const m of ejsBlock.matchAll(GETVAR_RE)) mvuVars.push(`read:${m[1]}`);
    for (const m of ejsBlock.matchAll(WRITEVAR_RE)) mvuVars.push(`write:${m[2]}`);
    if (mvuVars.length > 0) variableRules.push({ raw: ejsBlock.slice(0, 400), mvuVars });
    return '\n';
  });

  // 注释段：提取为设定候选（拼到 settingText 尾部，供检索），并识别 disabled/tags
  const noteLines: string[] = [];
  let disabledByNote = false;
  settingText = settingText.replace(COMMENT_RE, (noteBlock) => {
    const inner = noteBlock.replace(/^\{\{\/\/\s*/, '').replace(/\s*\}\}$/, '');
    noteLines.push(inner);
    if (/(不要|禁止|切勿|keep.*closed|关闭状态).*(打开|开启)/.test(inner) || /(请勿|不要)打开/.test(inner)) {
      disabledByNote = true;
    }
    return '\n';
  });

  // tags：首行 [era_xxx] / @INJECT / [mvu_update] 等 comment 前缀标签
  const tags: string[] = [];
  const firstLine = (content.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  const injectMatch = firstLine.match(/^@INJECT\b([\s\S]*)$/);
  if (injectMatch) tags.push('@INJECT');
  const eraMatch = (comment.match(/^\[([^\]]+)\]/) || firstLine.match(/^\[([^\]]+)\]/));
  if (eraMatch) tags.push(eraMatch[1]);

  // 2) 设定文本清理：去掉模板残留空行/虚线分隔，保留可读正文
  settingText = [settingText, ...noteLines].join('\n')
    .replace(/^\s*---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 3) 别名抽取：key 触发词（本身就是别名/命中词）优先并入，再叠加 YAML/identity/comment 抽取
  const yamlAliases = extractAliases(content, comment);
  const aliases = [...new Set([...n.keywords, ...yamlAliases])];

  return {
    id: n.id,
    settingText: settingText.slice(0, 6000),
    aliases,
    variableRules,
    keywords: n.keywords,
    meta: {
      book: n.book,
      comment,
      constant: n.constant,
      active: n.active,
      alwaysOn: n.constant || !/打开|开启/.test(comment),
      disabledByNote,
      tags,
    },
    raw: content,
  };
}

/**
 * 批量解析（泛用入口）：直接对接 parseWorldBook / loadWorldbooks 的原始条目数组。
 * 无 uid 的条目用序号兜底 id，保证 entryId 稳定；任一异常不阻断整体。
 */
export function parseLoreEntries(entries: LoreEntryLike[], book = ''): ParsedLoreEntry[] {
  return entries.map((e, i) => {
    const cand = e as WorldInfoEntryLike;
    const hasUid = cand.uid != null;
    const raw: LoreEntryLike = hasUid ? e : { ...e, uid: i } as WorldInfoEntryLike;
    try {
      return parseLoreEntry(raw);
    } catch {
      return parseLoreEntry({ uid: i, content: '', comment: '' });
    }
  });
}

/**
 * 解析「名册式」YAML：`- 实体名:` 头下的 `alias:` 子项绑定为「实体名 → 别名」。
 * 例：角色名册条目里 each `- 角色乙:` → alias: [示例学园学生会长, 角色乙…]。
 * 返回：{ entityName, aliases }[]（entityName 由实体头规范化，如 角色乙）。
 */
export function extractYamlEntities(content: string): { entityName: string; aliases: string[] }[] {
  const out: { entityName: string; aliases: string[] }[] = [];
  // 实体头：`- <名>:`
  const headerRe = /^([ \t]*)-?\s*([^\n:：]+):\s*$/gm;
  for (const hm of content.matchAll(headerRe)) {
    const headIndent = hm[1].length;
    let name = hm[2].trim();
    // 规范化实体名：剥掉列表符号「- 」、去「（…」、合并空格（角色 乙 → 角色乙）
    name = name.replace(/^[-·•]\s*/, '').split('（')[0].replace(/\s+/g, '').trim();
    if (!name || name.length < 2 || /^(alias|mahoshojos|characters|entity)$/.test(name)) continue;
    if (name.endsWith('）')) name = name.slice(0, -1);

    const block = content.slice(hm.index! + hm[0].length);
    const aliases: string[] = [];
    // 找该实体块内的第一个 `alias:`（缩进 > headIndent）；m 标志让 `$` 匹配行尾
    const aliasM = block.match(/\n([ \t]*)alias\s*:\s*$/m);
    if (aliasM) {
      const aliasIndent = aliasM[1].length;
      if (aliasIndent > headIndent) {
        const after = block.slice(aliasM.index! + aliasM[0].length);
        for (const m of after.matchAll(/^([ \t]*)-\s*['"']?([^'"#\n]+)['"']?\s*$/gm)) {
          if (m[1].length <= aliasIndent) break;
          const a = m[2].trim();
          if (/[:：]$/.test(a)) break;
          if (a.length >= 2) aliases.push(a);
        }
      }
    }
    if (aliases.length > 0) out.push({ entityName: name, aliases });
  }
  return out;
}

/**
 * 从 content + comment 提取显式别名。
 * 来源：
 *   - YAML alias: 列表（角色名册等）
 *   - YAML identity: / 身份: 数组字面量
 *   - comment 开头的人名（如「角色 乙」）
 */
export function extractAliases(content: string, comment: string): string[] {
  const out = new Set<string>();

  // (a) YAML identity/身份 数组：`identity: [A, B, C]` 或 `身份: [A, B]` 或 `身份: A、B`
  for (const m of content.matchAll(/(?:identity|身份|别名)\s*:\s*(\[[^\]]*\]|[^#\n]+)/g)) {
    const value = m[1].trim();
    if (value.startsWith('[')) {
      for (const piece of value.replace(/[[\]]/g, '').split(',')) {
        const a = piece.trim().replace(/^['"']|['"']$/g, '');
        if (a.length >= 2 && !/^(女|男|无|人)$/.test(a)) out.add(a);
      }
    } else if (value.length >= 2) {
      out.add(value.replace(/^['"']|['"']$/g, ''));
    }
  }

  // (b) YAML alias 列表：遍历每个 `alias:` 块，取缩进更深且不以冒号结尾的项；
  //  遇到「- 实体名:」这类带冒号的实体头即停止本块
  const aliasBlocks = [...content.matchAll(/^(([ \t]*)alias)\s*:\s*$/gm)];
  for (const am of aliasBlocks) {
    const baseIndent = am[2].length;
    const after = content.slice(am.index! + am[0].length);
    for (const m of after.matchAll(/^([ \t]*)-\s*['"']?([^'"#\n]+)['"']?\s*$/gm)) {
      if (m[1].length <= baseIndent) break; // 离开本块缩进层级
      const a = m[2].trim();
      if (/[:：]$/.test(a)) break; // 下一个实体头（- 角色丙:）
      if (a.length >= 2) out.add(a);
    }
  }

  // (c) comment 里的人名（形如「角色 乙」「【线索】角色 乙」）
  const nameM = comment.match(/([一-龥]{2,4})\s*([一-龥]{1,3})/);
  if (nameM) {
    const full = nameM[1] + nameM[2];
    out.add(full);
  }
  if (/[一-龥]/.test(comment)) {
    out.add(comment.trim().slice(0, 8));
  }

  return [...out].filter((a) => a.length >= 2);
}

/** 职位称谓词（用于简写推导）→ 检测后缀 */
const POSITION_SUFFIXES = ['学生会长', '会长', '委员长', '大小姐', '大天使', '巫女', '偶像', '大姐头', '前辈姐姐', '千金', '继承人'];

/** 实体名规范化：去掉尾随括号/冒号，合并空格（角色 乙 → 角色乙） */
function normalizeEntityName(name: string): string {
  return name.trim().split('（')[0].replace(/[:：]\s*$/, '').replace(/\s+/g, '');
}

/**
 * 从全量条目构建全局别名索引。
 * 跨条目汇总显式别名 → 实体名；并对「职位型别名」做简写推导（学生会长→会长），
 * 仅当全库该简写唯一映射时才注册（避免多实体歧义）。
 * 返回值：alias → AliasEntry
 */
export function buildAliasIndex(parsed: ParsedLoreEntry[]): Map<string, AliasEntry> {
  const index = new Map<string, AliasEntry>();
  const entityByName = new Map<string, { alias: string; entryId: number }[]>();

  const add = (alias: string, entryId: number, entityName: string, explicit: boolean) => {
    if (alias.length < 2) return;
    const entry = index.get(alias);
    if (entry) {
      if (!entry.entryIds.includes(entryId)) entry.entryIds.push(entryId);
      if (explicit) entry.explicit = true;
      return;
    }
    index.set(alias, { entityName, entryIds: [entryId], explicit });
  };

  /** 注册别名 + 「·」分隔后缀简写（示例组织·角色甲 → 角色甲），登记 entityByName */
  const addWithDot = (a: string, entryId: number, entityName: string) => {
    add(a, entryId, entityName, true);
    const list = entityByName.get(entityName) ?? [];
    list.push({ alias: a, entryId });
    entityByName.set(entityName, list);
    const dot = a.indexOf('·') !== -1 ? '·' : a.indexOf('・') !== -1 ? '・' : '';
    if (dot) {
      const tail = a.slice(a.lastIndexOf(dot) + 1).trim();
      if (tail.length >= 2) {
        const existing = index.get(tail);
        if (!existing) add(tail, entryId, entityName, true);
        else if (!existing.explicit && existing.entityName === entityName) {
          existing.explicit = true;
          if (!existing.entryIds.includes(entryId)) existing.entryIds.push(entryId);
        }
      }
    }
  };

  // 第一遍：显式别名 + 实体名登记（优先「名册式结构」，否则回退摊平 infer）
  for (const p of parsed) {
    const yamlEntities = extractYamlEntities(p.raw);
    if (yamlEntities.length > 0) {
      for (const { entityName, aliases } of yamlEntities) {
        for (const a of aliases) addWithDot(a, p.id, normalizeEntityName(entityName));
      }
      continue;
    }
    const entityName = inferEntityName(p.meta.comment, p.aliases);
    for (const a of p.aliases) addWithDot(a, p.id, entityName);
  }

  // 第二遍：职位简写唯一性推导
  const positionOwner = new Map<string, Set<string>>(); // 职位后缀 → 实体名集合
  for (const [alias, entry] of index) {
    for (const sfx of POSITION_SUFFIXES) {
      if (alias.endsWith(sfx)) {
        if (!positionOwner.has(sfx)) positionOwner.set(sfx, new Set());
        positionOwner.get(sfx)!.add(entry.entityName);
      }
    }
  }
  for (const [sfx, owners] of positionOwner) {
    if (owners.size === 1 && sfx !== '继承人' && sfx !== '千金') {
      const owner = [...owners][0];
      if (!index.has(sfx)) {
        const entryIds = [...index.values()]
          .filter((e) => e.entityName === owner)
          .flatMap((e) => e.entryIds);
        index.set(sfx, { entityName: owner, entryIds: [...new Set(entryIds)], explicit: false });
      }
    }
  }

  return index;
}

/** 从 comment 推断实体规范名（姓+名，如 角色乙）。优先取「像人名」的候选，排除列表/职位/非人名。 */
const NAME_SUFFIX_ALLOW = 4;
const NON_NAME_SUFFIX = /(列表|大全|索引|标题|知识库|名册|概要|规则|奖励|记录|档案|库|表)$/;
const SURNAME_HINTS = '桐物神月森因宇井白夜夏星雾天宫飞千高坂上凉道';
const POSITION_LIKE = new Set(POSITION_SUFFIXES);

/** 是否像「人名」（2-4 字、纯汉字、非职位/非文档名） */
function looksLikeName(a: string): boolean {
  if (a.length < 2 || a.length > NAME_SUFFIX_ALLOW) return false;
  if (!/^[一-龥]{2,4}$/.test(a)) return false;
  if (NON_NAME_SUFFIX.test(a)) return false;
  if ([...POSITION_LIKE].some((s) => a.endsWith(s))) return false;
  return true;
}

function inferEntityName(comment: string, aliases: string[]): string {
  // 1) 优先：comment 里的「姓 名」格式，且名前缀命中常见姓氏
  const m = comment.match(/([一-龥]{2,4})\s*([一-龥]{1,3})/);
  if (m) {
    const cand = m[1] + m[2];
    if (looksLikeName(cand)) return cand;
  }
  // 2) 从别名里找带姓氏的人名（角色乙、角色丙…）
  for (const a of aliases) {
    const head = a.slice(0, 1);
    if (SURNAME_HINTS.includes(head) && looksLikeName(a)) return a;
  }
  // 3) 退化为任意像人名的别名
  const any = aliases.find((a) => looksLikeName(a));
  return any ?? 'unknown';
}
