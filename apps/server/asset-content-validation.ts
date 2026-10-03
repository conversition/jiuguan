/**
 * P8-03: uploaded asset content validation.
 *
 * The multipart layer only establishes framing and writes an opaque temporary
 * file. This module is the first layer allowed to interpret those bytes. It
 * deliberately runs before JSON.parse/Zod and before any asset identity or
 * final file is created.
 */
import { readFileSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { ReceivedAssetUpload } from './multipart-upload.ts';

export const ASSET_CONTENT_LIMITS = Object.freeze({
  maxJsonBytes: 16 * 1024 * 1024,
  maxJsonChars: 16 * 1024 * 1024,
  maxJsonDepth: 128,
  maxJsonNodes: 250_000,
  maxJsonContainers: 50_000,
  maxJsonObjectKeys: 100_000,
  maxJsonKeysPerObject: 20_000,
  maxJsonStringBytes: 4 * 1024 * 1024,
  maxPngBytes: 64 * 1024 * 1024,
  maxPngChunks: 4_096,
  maxPngChunkBytes: 32 * 1024 * 1024,
  maxPngTextBytes: 24 * 1024 * 1024,
  maxPngTextChunks: 128,
  maxPngTextInflatedBytes: 22 * 1024 * 1024,
  maxPngDimension: 16_384,
  maxPngPixels: 16_000_000,
});

export type AssetContentLimits = typeof ASSET_CONTENT_LIMITS;

export class AssetContentValidationError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'AssetContentValidationError';
  }
}

export interface ValidatedAssetContent {
  raw: string;
  pngBuffer: Buffer | null;
  actualFormat: 'json' | 'png';
}

interface ScanFrame {
  type: 'array' | 'object';
  keys: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalid(reason: string, message: string): never {
  throw new AssetContentValidationError(reason, message);
}

function utf8WidthAt(text: string, index: number): { bytes: number; advance: number } {
  const code = text.charCodeAt(index);
  if (code <= 0x7f) return { bytes: 1, advance: 1 };
  if (code <= 0x7ff) return { bytes: 2, advance: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return { bytes: 4, advance: 2 };
  }
  return { bytes: 3, advance: 1 };
}

/** Budget scanner. JSON.parse remains the syntax authority, but only after this pass. */
export function scanJsonBudgets(
  text: string,
  limits: AssetContentLimits = ASSET_CONTENT_LIMITS,
): void {
  if (text.length > limits.maxJsonChars) invalid('json_chars', 'JSON 解码字符数超过预算');
  const stack: ScanFrame[] = [];
  let nodes = 0;
  let containers = 0;
  let objectKeys = 0;
  const countNode = (): void => {
    nodes++;
    if (nodes > limits.maxJsonNodes) invalid('json_nodes', 'JSON 节点数超过预算');
  };

  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (/\s/.test(char)) { index++; continue; }
    if (char === '{' || char === '[') {
      countNode();
      containers++;
      if (containers > limits.maxJsonContainers) invalid('json_containers', 'JSON 容器数超过预算');
      stack.push({ type: char === '{' ? 'object' : 'array', keys: 0 });
      if (stack.length > limits.maxJsonDepth) invalid('json_depth', 'JSON 嵌套深度超过预算');
      index++;
      continue;
    }
    if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (!frame || (char === '}' ? frame.type !== 'object' : frame.type !== 'array')) {
        invalid('json_structure', 'JSON 容器闭合顺序非法');
      }
      index++;
      continue;
    }
    if (char === '"') {
      let escaped = false;
      let stringBytes = 0;
      let closed = false;
      index++;
      for (; index < text.length; index++) {
        const current = text[index]!;
        if (!escaped && current === '"') { closed = true; index++; break; }
        const width = utf8WidthAt(text, index);
        stringBytes += width.bytes;
        if (stringBytes > limits.maxJsonStringBytes) invalid('json_string', 'JSON 单字符串超过预算');
        if (!escaped && current === '\\') escaped = true;
        else escaped = false;
        index += width.advance - 1;
      }
      if (!closed) invalid('json_structure', 'JSON 字符串未闭合');
      let lookahead = index;
      while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead++;
      if (text[lookahead] === ':') {
        const frame = stack.at(-1);
        if (!frame || frame.type !== 'object') invalid('json_structure', 'JSON key 不在 object 中');
        frame.keys++;
        objectKeys++;
        if (frame.keys > limits.maxJsonKeysPerObject || objectKeys > limits.maxJsonObjectKeys) {
          invalid('json_keys', 'JSON object key 数超过预算');
        }
      } else {
        countNode();
      }
      continue;
    }
    if (char === ',' || char === ':') { index++; continue; }

    // number / true / false / null. Syntax is intentionally left to JSON.parse.
    let end = index + 1;
    while (end < text.length && !/[\s,\]\}]/.test(text[end]!)) end++;
    countNode();
    index = end;
  }
  if (stack.length !== 0) invalid('json_structure', 'JSON 容器未闭合');
}

function decodeJsonBytes(bytes: Buffer, limits: AssetContentLimits): string {
  if (bytes.length === 0) invalid('json_empty', 'JSON 文件为空');
  if (bytes.length > limits.maxJsonBytes) invalid('json_bytes', 'JSON 文件超过内容预算');
  if (bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    invalid('json_bom', 'JSON 不接受 UTF-8 BOM');
  }
  let text: string;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch {
    invalid('json_utf8', 'JSON 必须是严格 UTF-8');
  }
  const first = text.search(/\S/);
  if (first < 0 || text[first] !== '{') invalid('json_root', '资产 JSON 顶层必须是 object');
  scanJsonBudgets(text, limits);
  return text;
}

function crc32Parts(type: Buffer, data: Buffer): number {
  let crc = 0xffffffff;
  const update = (buffer: Buffer): void => {
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  };
  update(type);
  update(data);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeTextPayload(data: Buffer, type: string, limits: AssetContentLimits): Buffer | null {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 1 || keywordEnd > 79) invalid('png_text_keyword', 'PNG 文本 keyword 非法');
  const keywordBytes = data.subarray(0, keywordEnd);
  if ([...keywordBytes].some((byte) => byte < 32 || (byte > 126 && byte < 161))) {
    invalid('png_text_keyword', 'PNG 文本 keyword 含控制字符');
  }
  const keyword = keywordBytes.toString('latin1');
  if (keyword !== 'chara' && keyword !== 'chara-ext') return null;

  if (type === 'tEXt') return data.subarray(keywordEnd + 1);
  if (type === 'zTXt') {
    if (data[keywordEnd + 1] !== 0 || keywordEnd + 2 >= data.length) {
      invalid('png_text_compression', 'PNG zTXt 压缩字段非法');
    }
    try {
      return inflateSync(data.subarray(keywordEnd + 2), {
        maxOutputLength: limits.maxPngTextInflatedBytes,
      });
    } catch {
      invalid('png_text_compression', 'PNG zTXt 解压失败或超过预算');
    }
  }

  // iTXt: keyword\0 flag method language\0 translated-keyword\0 text
  const flagOffset = keywordEnd + 1;
  const flag = data[flagOffset];
  const method = data[flagOffset + 1];
  if ((flag !== 0 && flag !== 1) || method !== 0) invalid('png_text_compression', 'PNG iTXt 压缩字段非法');
  const languageEnd = data.indexOf(0, flagOffset + 2);
  const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
  if (languageEnd < 0 || translatedEnd < 0) invalid('png_text_structure', 'PNG iTXt 字段不完整');
  const payload = data.subarray(translatedEnd + 1);
  if (flag === 0) return payload;
  try {
    return inflateSync(payload, { maxOutputLength: limits.maxPngTextInflatedBytes });
  } catch {
    invalid('png_text_compression', 'PNG iTXt 解压失败或超过预算');
  }
}

function decodeCharaPayload(payload: Buffer, limits: AssetContentLimits): string {
  if (payload.length > limits.maxPngTextInflatedBytes) invalid('png_chara_bytes', 'PNG chara 文本超过预算');
  let encoded: string;
  try { encoded = FATAL_UTF8.decode(payload).trim(); }
  catch { invalid('png_chara_utf8', 'PNG chara 文本不是严格 UTF-8'); }
  if (encoded.startsWith('{')) return decodeJsonBytes(Buffer.from(encoded, 'utf8'), limits);
  if (!BASE64.test(encoded)) invalid('png_chara_base64', 'PNG chara 元数据不是规范 base64');
  const decoded = Buffer.from(encoded, 'base64');
  return decodeJsonBytes(decoded, limits);
}

function validateIhdr(data: Buffer, limits: AssetContentLimits): void {
  if (data.length !== 13) invalid('png_ihdr', 'PNG IHDR 长度必须为 13');
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  if (width === 0 || height === 0 || width > limits.maxPngDimension || height > limits.maxPngDimension
    || width * height > limits.maxPngPixels) {
    invalid('png_dimensions', 'PNG 尺寸或像素数超过预算');
  }
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  const allowedDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
  };
  if (!allowedDepths[colorType]?.includes(bitDepth)
    || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) {
    invalid('png_ihdr', 'PNG IHDR 编码参数非法');
  }
}

function validatePng(bytes: Buffer, limits: AssetContentLimits): { raw: string; pngBuffer: Buffer } {
  if (bytes.length > limits.maxPngBytes) invalid('png_bytes', 'PNG 文件超过内容预算');
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) invalid('png_signature', 'PNG magic bytes 非法');
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let textChunks = 0;
  let textBytes = 0;
  let seenIhdr = false;
  let seenPlte = false;
  let seenIdat = false;
  let idatEnded = false;
  let seenIend = false;
  let charaRaw: string | null = null;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid('png_truncated', 'PNG chunk header 截断');
    const length = bytes.readUInt32BE(offset);
    if (length > limits.maxPngChunkBytes) invalid('png_chunk_bytes', 'PNG 单 chunk 超过预算');
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) invalid('png_truncated', 'PNG chunk 数据截断');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) invalid('png_chunk_type', 'PNG chunk type 非法');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32Parts(typeBytes, data) !== expectedCrc) invalid('png_crc', `PNG ${type} CRC 校验失败`);
    chunkCount++;
    if (chunkCount > limits.maxPngChunks) invalid('png_chunks', 'PNG chunk 数超过预算');
    if (seenIend) invalid('png_after_iend', 'PNG IEND 后存在额外数据');

    if (chunkCount === 1 && type !== 'IHDR') invalid('png_ihdr_order', 'PNG 首块必须是 IHDR');
    if (type === 'IHDR') {
      if (seenIhdr || chunkCount !== 1) invalid('png_duplicate_critical', 'PNG IHDR 重复或顺序非法');
      validateIhdr(data, limits);
      seenIhdr = true;
    } else if (type === 'PLTE') {
      if (seenPlte || seenIdat || length === 0 || length % 3 !== 0 || length > 768) {
        invalid('png_duplicate_critical', 'PNG PLTE 重复或非法');
      }
      seenPlte = true;
    } else if (type === 'IDAT') {
      if (!seenIhdr || idatEnded) invalid('png_idat_order', 'PNG IDAT 顺序非法');
      seenIdat = true;
    } else {
      if (seenIdat) idatEnded = true;
      if (type === 'IEND') {
        if (length !== 0 || !seenIdat) invalid('png_iend', 'PNG IEND 非法或缺少 IDAT');
        seenIend = true;
      } else if ((typeBytes[0]! & 0x20) === 0) {
        invalid('png_unknown_critical', `PNG 含未知 critical chunk ${type}`);
      }
    }

    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      textChunks++;
      textBytes += length;
      if (textChunks > limits.maxPngTextChunks || textBytes > limits.maxPngTextBytes) {
        invalid('png_text_budget', 'PNG 文本 chunk 超过预算');
      }
      const payload = decodeTextPayload(data, type, limits);
      if (payload) {
        if (charaRaw !== null) invalid('png_chara_duplicate', 'PNG 含多个 chara 元数据');
        charaRaw = decodeCharaPayload(payload, limits);
      }
    }
    offset = end;
  }
  if (!seenIhdr || !seenIend || offset !== bytes.length) invalid('png_truncated', 'PNG 缺少完整 IHDR/IEND');
  if (charaRaw === null) invalid('png_chara_missing', 'PNG 卡无 chara 元数据');
  return { raw: charaRaw, pngBuffer: bytes };
}

function assertMediaType(actual: 'json' | 'png', mediaType: string): void {
  const allowed = actual === 'png'
    ? ['image/png', 'application/octet-stream']
    : ['application/json', 'text/json', 'application/octet-stream'];
  if (!allowed.includes(mediaType)) invalid('media_type_mismatch', '声明 MIME 与实际内容不一致');
}

export function validateAssetContent(
  upload: ReceivedAssetUpload,
  overrides: Partial<AssetContentLimits> = {},
): ValidatedAssetContent {
  const limits = Object.freeze({ ...ASSET_CONTENT_LIMITS, ...overrides }) as AssetContentLimits;
  const stat = statSync(upload.tempPath);
  if (!stat.isFile() || stat.size !== upload.bytes) invalid('temp_file_changed', '上传临时文件状态不一致');
  const maxBytes = upload.format === 'png' ? limits.maxPngBytes : limits.maxJsonBytes;
  if (stat.size > maxBytes) invalid(upload.format === 'png' ? 'png_bytes' : 'json_bytes', '资产文件超过内容预算');
  const bytes = readFileSync(upload.tempPath);
  const actual: 'json' | 'png' = bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? 'png' : 'json';
  if (actual !== upload.format) invalid('format_mismatch', '扩展名与实际内容格式不一致');
  if (upload.kind !== 'card' && actual !== 'json') invalid('kind_format_mismatch', '此资产类型只接受 JSON');
  assertMediaType(actual, upload.declaredMediaType);
  if (actual === 'png') {
    const png = validatePng(bytes, limits);
    return { raw: png.raw, pngBuffer: png.pngBuffer, actualFormat: 'png' };
  }
  return { raw: decodeJsonBytes(bytes, limits), pngBuffer: null, actualFormat: 'json' };
}
