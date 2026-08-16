/**
 * core 包 - chara_card v1/v2/v3 解析器
 * 依据审查 §7：解析范围含卡本体 + extensions(regex_scripts/tavern_helper) + 内嵌 character_book + use_regex 条目。
 */
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
  characterFilter: z.record(z.unknown()).optional(),
  use_regex: z.boolean().optional(),
  extensions: z.record(z.unknown()).optional(),
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
  extensions: z.record(z.unknown()).default({}),
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

/** 解析结果：卡 + 校验信息 */
export interface ParseResult {
  card: CharaCardV3;
  spec: string;
  worldbookEntries: WorldInfoEntry[];
  regexScripts: { name: string; findRegex: string; replaceString: string }[];
  tavernHelperScripts: { name: string; content: string }[];
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
  const ext = card.data.extensions as Record<string, unknown> | undefined;
  const regexScripts = Array.isArray(ext?.regex_scripts)
    ? (ext.regex_scripts as { scriptName?: string; findRegex?: string; replaceString?: string }[]).map((r) => ({
        name: r.scriptName ?? 'unnamed',
        findRegex: r.findRegex ?? '',
        replaceString: r.replaceString ?? '',
      }))
    : [];

  // 提取 extensions.tavern_helper.scripts
  const th = ext?.tavern_helper as { scripts?: { name?: string; content?: string }[] } | undefined;
  const tavernHelperScripts = (th?.scripts ?? []).map((s) => ({
    name: s.name ?? 'unnamed',
    content: s.content ?? '',
  }));

  if (!worldbookEntries.length && !regexScripts.length && !tavernHelperScripts.length) {
    warnings.push('卡未携带内嵌世界书/正则/脚本（可能是纯聊天卡）');
  }
  if (card.spec !== 'chara_card_v3') {
    warnings.push(`非 v3 规范: spec=${card.spec}`);
  }

  return { card, spec: card.spec, worldbookEntries, regexScripts, tavernHelperScripts, warnings };
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
