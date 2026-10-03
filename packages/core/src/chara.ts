/**
 * core 包 - chara_card v1/v2/v3 解析器
 * 依据审查 §7：解析范围含卡本体 + extensions(regex_scripts/tavern_helper) + 内嵌 character_book + use_regex 条目。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

// ── 世界书条目（lorebook entry，v1.12 格式含 use_regex/triggers）──
// 宽松校验：真实导出数据存在字符串数字（如 position: "2"），统一 coerce
const coerceNum = (fallback = 0) => z.coerce.number().catch(fallback);

export const WorldInfoEntrySchema = z.object({
  uid: coerceNum().optional(),
  key: z.array(z.string()).optional(),
  keysecondary: z.array(z.string()).optional(),
  comment: z.string().optional(),
  content: z.string(),
  constant: z.boolean().optional(),
  selective: z.boolean().optional(),
  selectiveLogic: coerceNum().optional(),
  addMemo: z.boolean().optional(),
  order: coerceNum().optional(),
  position: coerceNum().optional(),
  disable: z.boolean().optional(),
  excludeRecursion: z.boolean().optional(),
  preventRecursion: z.boolean().optional(),
  probability: coerceNum().optional(),
  useProbability: z.boolean().optional(),
  depth: coerceNum().nullable().optional(),
  scanDepth: coerceNum().nullable().optional(),
  group: z.string().optional(),
  role: coerceNum().optional(),
  sticky: coerceNum().optional(),
  cooldown: coerceNum().optional(),
  delay: coerceNum().optional(),
  displayIndex: coerceNum().optional(),
  ignoreBudget: z.boolean().optional(),
  triggers: z.array(z.union([z.string(), z.object({ key: z.string(), text: z.string() }).passthrough()])).optional(),
  characterFilter: z.record(z.string(), z.unknown()).optional(),
  use_regex: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
}).passthrough();

export type WorldInfoEntry = z.infer<typeof WorldInfoEntrySchema>;

// ── character_book（卡片内嵌世界书）──
export const CharacterBookSchema = z.object({
  entries: z.array(WorldInfoEntrySchema),
  name: z.string().optional(),
}).passthrough();

// ── chara_card_v3 的 data 子结构 ──
export const CharaDataV3Schema = z.object({
  name: z.string(),
  description: z.string().default(''),
  personality: z.string().default(''),
  scenario: z.string().default(''),
  first_mes: z.string().default(''),
  mes_example: z.string().default(''),
  creator_notes: z.string().default(''),
  system_prompt: z.string().default(''),
  post_history_instructions: z.string().default(''),
  tags: z.array(z.string()).default([]),
  creator: z.string().default(''),
  character_version: z.string().default(''),
  alternate_greetings: z.array(z.string()).default([]),
  group_only_greetings: z.array(z.string()).default([]),
  extensions: z.record(z.string(), z.unknown()).default({}),
  character_book: CharacterBookSchema.optional(),
}).passthrough();

export type CharaDataV3 = z.infer<typeof CharaDataV3Schema>;

// ── 完整卡（顶层 + data）──
export const CharaCardV3Schema = z.object({
  spec: z.literal('chara_card_v3').or(z.string()),
  spec_version: z.string().optional(),
  name: z.string(),
  description: z.string().default(''),
  personality: z.string().default(''),
  scenario: z.string().default(''),
  first_mes: z.string().default(''),
  mes_example: z.string().default(''),
  creatorcomment: z.string().default(''),
  avatar: z.string().default('none'),
  talkativeness: z.coerce.number().catch(0.5),
  fav: z.boolean().catch(false),
  tags: z.array(z.string()).default([]),
  create_date: z.string().optional(),
  data: CharaDataV3Schema,
}).passthrough();

export type CharaCardV3 = z.infer<typeof CharaCardV3Schema>;

export interface NormalizedCardScript {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  order: number;
  sourcePath: string;
  content: string;
  contentHash: string;
  dataHash: string;
  hasRemoteImport: boolean;
  remoteImports: string[];
  exportWith?: unknown;
  unknownKeys: string[];
  raw: Record<string, unknown>;
}

export interface CardCapabilityList {
  hasRegexScripts: boolean;
  hasCharacterBook: boolean;
  hasTavernHelper: boolean;
  hasMvuCandidate: boolean;
  scriptCount: number;
  enabledScriptCount: number;
  disabledScriptCount: number;
  remoteImportCount: number;
  variableStoreCount: number;
  extensionPaths: string[];
  conflicts: string[];
}

export interface CardImportManifest {
  version: 1;
  cardName: string;
  spec: string;
  specVersion: string;
  contentHash: string;
  extensionHash: string;
  scripts: NormalizedCardScript[];
  variableStores: { sourcePath: string; keys: string[]; dataHash: string }[];
  capabilities: CardCapabilityList;
  warnings: string[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function entriesFromMapLike(value: unknown): [string, unknown][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is [string, unknown] => Array.isArray(x) && typeof x[0] === 'string' && x.length >= 2)
    .map((x) => [x[0], x[1]]);
}

function unwrapScriptRecord(value: unknown): Record<string, unknown> | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (rec.type === 'script' && asRecord(rec.value)) return rec.value as Record<string, unknown>;
  return rec;
}

function scriptContent(script: Record<string, unknown>): string {
  return String(script.content ?? script.script ?? script.code ?? '');
}

function scriptEnabled(script: Record<string, unknown>): boolean {
  if (typeof script.enabled === 'boolean') return script.enabled;
  if (typeof script.disabled === 'boolean') return !script.disabled;
  return true;
}

function remoteImports(content: string): string[] {
  const out = new Set<string>();
  const re = /\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(re)) {
    if (/^https?:\/\//i.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

function normalizeScript(script: Record<string, unknown>, sourcePath: string, order: number): NormalizedCardScript {
  const content = scriptContent(script);
  const imports = remoteImports(content);
  const name = String(script.name ?? script.scriptName ?? script.id ?? `script-${order}`);
  const id = String(script.id ?? sha256(`${sourcePath}:${order}:${name}:${content}`).slice(0, 16));
  const known = new Set(['id', 'name', 'scriptName', 'type', 'enabled', 'disabled', 'content', 'script', 'code', 'info', 'button', 'buttons', 'data', 'export_with', 'value']);
  return {
    id,
    name,
    type: String(script.type ?? 'script'),
    enabled: scriptEnabled(script),
    order,
    sourcePath,
    content,
    contentHash: sha256(content),
    dataHash: sha256(script.data ?? {}),
    hasRemoteImport: imports.length > 0,
    remoteImports: imports,
    exportWith: script.export_with,
    unknownKeys: Object.keys(script).filter((k) => !known.has(k)).sort(),
    raw: script,
  };
}

function collectScripts(ext: Record<string, unknown>): NormalizedCardScript[] {
  const scripts: NormalizedCardScript[] = [];
  let order = 0;
  const add = (value: unknown, sourcePath: string) => {
    const rec = unwrapScriptRecord(value);
    if (!rec) return;
    if (!scriptContent(rec) && !rec.id && !rec.name && !rec.scriptName) return;
    scripts.push(normalizeScript(rec, sourcePath, order++));
  };

  const th = ext.tavern_helper ?? ext.tavernHelper ?? ext.TavernHelper;
  const thRecord = asRecord(th);
  if (thRecord && Array.isArray(thRecord.scripts)) {
    thRecord.scripts.forEach((s, i) => add(s, `data.extensions.tavern_helper.scripts[${i}]`));
  } else {
    for (const [key, value] of entriesFromMapLike(th)) {
      if (key === 'scripts' && Array.isArray(value)) {
        value.forEach((s, i) => add(s, `data.extensions.tavern_helper[Map].scripts[${i}]`));
      }
    }
  }

  const legacy = ext.TavernHelper_scripts;
  if (Array.isArray(legacy)) {
    legacy.forEach((s, i) => add(s, `data.extensions.TavernHelper_scripts[${i}]`));
  }

  return scripts;
}

function collectVariableStores(ext: Record<string, unknown>): { sourcePath: string; keys: string[]; dataHash: string }[] {
  const out: { sourcePath: string; keys: string[]; dataHash: string }[] = [];
  const add = (value: unknown, sourcePath: string) => {
    const rec = asRecord(value);
    if (!rec) return;
    out.push({ sourcePath, keys: Object.keys(rec).sort(), dataHash: sha256(rec) });
  };
  const th = ext.tavern_helper ?? ext.tavernHelper ?? ext.TavernHelper;
  const thRecord = asRecord(th);
  if (thRecord) add(thRecord.variables, 'data.extensions.tavern_helper.variables');
  for (const [key, value] of entriesFromMapLike(th)) {
    if (key === 'variables') add(value, 'data.extensions.tavern_helper[Map].variables');
  }
  return out;
}

export function buildCardImportManifest(card: CharaCardV3, raw: unknown, warnings: string[]): CardImportManifest {
  const ext = card.data.extensions as Record<string, unknown>;
  const scripts = collectScripts(ext);
  const variableStores = collectVariableStores(ext);
  const ids = new Map<string, NormalizedCardScript[]>();
  for (const s of scripts) ids.set(s.id, [...(ids.get(s.id) ?? []), s]);
  const conflicts = [...ids.values()]
    .filter((group) => new Set(group.map((s) => s.contentHash)).size > 1 || new Set(group.map((s) => s.enabled)).size > 1)
    .map((group) => group[0].id);
  const extensionPaths = Object.keys(ext).filter((k) => /tavern|regex|world|depth/i.test(k)).sort();
  const mvuCandidates = scripts.filter((s) => /mvu|magvar|variable|变量/i.test(`${s.name}\n${s.content}`));
  return {
    version: 1,
    cardName: card.name,
    spec: card.spec,
    specVersion: card.spec_version ?? '',
    contentHash: sha256(raw),
    extensionHash: sha256(ext),
    scripts,
    variableStores,
    capabilities: {
      hasRegexScripts: Array.isArray(ext.regex_scripts),
      hasCharacterBook: Boolean(card.data.character_book?.entries?.length),
      hasTavernHelper: scripts.length > 0 || variableStores.length > 0,
      hasMvuCandidate: mvuCandidates.length > 0,
      scriptCount: scripts.length,
      enabledScriptCount: scripts.filter((s) => s.enabled).length,
      disabledScriptCount: scripts.filter((s) => !s.enabled).length,
      remoteImportCount: scripts.reduce((n, s) => n + s.remoteImports.length, 0),
      variableStoreCount: variableStores.length,
      extensionPaths,
      conflicts,
    },
    warnings,
  };
}

/** 解析结果：卡 + 校验信息 */
export interface ParseResult {
  card: CharaCardV3;
  spec: string;
  worldbookEntries: WorldInfoEntry[];
  regexScripts: { name: string; findRegex: string; replaceString: string; disabled: boolean; markdownOnly: boolean; promptOnly: boolean }[];
  tavernHelperScripts: { name: string; content: string }[];
  cardImport: CardImportManifest;
  warnings: string[];
}

/** 解析 chara_card JSON 字符串 */
export function parseCharaCard(json: string): ParseResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`角色卡 JSON 解析失败: ${(e as Error).message}`);
  }

  const parsed = CharaCardV3Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`角色卡 schema 校验失败: ${issues.join('; ')}`);
  }
  const card = parsed.data;

  // 提取内嵌世界书条目
  const worldbookEntries = card.data.character_book?.entries ?? [];

  // 提取 extensions.regex_scripts
  // FE-06.0 修正：**必须保留作者字段**（disabled / markdownOnly / promptOnly）。
  // 此前只映射 name/findRegex/replaceString，`disabled` 在解析层就被丢掉 → 导入路径
  // `importCardRegexScripts` 永远看到 disabled=undefined → 作者标"禁用"的规则被当成启用导入。
  // 这是"作者禁用测试页却默认生效"的根因；来源诊断据以判定冲突也失去依据。
  const ext = card.data.extensions as Record<string, unknown> | undefined;
  const regexScripts = Array.isArray(ext?.regex_scripts)
    ? (ext.regex_scripts as {
        scriptName?: string; name?: string; findRegex?: string; replaceString?: string;
        disabled?: boolean; markdownOnly?: boolean; promptOnly?: boolean;
      }[]).map((r) => ({
        name: r.scriptName ?? r.name ?? 'unnamed',
        findRegex: r.findRegex ?? '',
        replaceString: r.replaceString ?? '',
        disabled: r.disabled === true,
        markdownOnly: r.markdownOnly === true,
        promptOnly: r.promptOnly === true,
      }))
    : [];

  // 提取 extensions.tavern_helper.scripts
  const cardImport = buildCardImportManifest(card, raw, warnings);
  const tavernHelperScripts = cardImport.scripts.map((s) => ({
    name: s.name,
    content: s.content,
  }));

  if (!worldbookEntries.length && !regexScripts.length && !tavernHelperScripts.length) {
    warnings.push('卡未携带内嵌世界书/正则/脚本（可能是纯聊天卡）');
  }
  if (card.spec !== 'chara_card_v3') {
    warnings.push(`非 v3 规范: spec=${card.spec}`);
  }

  return { card, spec: card.spec, worldbookEntries, regexScripts, tavernHelperScripts, cardImport, warnings };
}

/** 从 PNG 中提取内嵌角色卡（chara tEXt 块，base64 JSON） */
export function extractCharaFromPng(buffer: Buffer): string | null {
  // PNG 块结构: 8 字节签名 + (length[4] + type[4] + data + crc[4])*
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > buffer.length) break;
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      // 关键词以 \0 结尾
      const nullIdx = buffer.indexOf(0, dataStart);
      if (nullIdx > dataStart && nullIdx < dataEnd) {
        const keyword = buffer.toString('ascii', dataStart, nullIdx);
        if (keyword === 'chara' || keyword === 'chara-ext') {
          let payload = buffer.toString('utf8', nullIdx + 1, dataEnd);
          if (type === 'zTXt') {
            try {
              payload = inflateSync(buffer.subarray(nullIdx + 2, dataEnd)).toString('utf8');
            } catch { /* 解压失败返回 null */ }
          }
          return payload;
        }
      }
    }
    offset = dataEnd + 4; // 跳过 CRC
  }
  return null;
}

/** 延迟导入 zlib 的旧辅助已移除（ESM 下 require 不可用）；改用顶层 import */
import { inflateSync, deflateSync } from 'node:zlib';

// ── PNG 角色卡导出（酒馆兼容：chara tEXt 块，base64 JSON）──

/** 从酒馆 PNG 中提取的 tEXt payload → 角色卡 JSON 文本（payload 为 base64，需解码） */
export function pngPayloadToJson(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.startsWith('{')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

/** CRC32（PNG 块校验） */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG 块：length + type + data + crc */
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 角色卡 JSON → 酒馆兼容 PNG（chara tEXt 元数据 + 1×1 占位图）。酒馆只读取 tEXt 元数据，图画尺寸无关 */
export function buildCharaPng(json: string): Buffer {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);   // width
  ihdr.writeUInt32BE(1, 4);   // height
  ihdr[8] = 8;                // bit depth
  ihdr[9] = 2;                // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rawScanline = Buffer.from([0x00, 0x22, 0x22, 0x33]); // filter 0 + 1px RGB
  const idat = deflateSync(rawScanline);
  const charaKey = Buffer.from('chara\0', 'ascii');
  charaKey.writeUInt8(0, 5);
  const charaVal = Buffer.from(Buffer.from(json, 'utf8').toString('base64'), 'ascii');
  return Buffer.concat([
    pngSignature,
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.concat([charaKey, charaVal])),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
