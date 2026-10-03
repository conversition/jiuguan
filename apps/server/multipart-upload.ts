/**
 * P8-02：精确资产上传路由的流式 multipart reader。
 *
 * 本模块只负责 framing、预算、临时文件生命周期与最小字段契约；文件内容是否真是
 * PNG/JSON、JSON 深度/字段、图片像素及解压预算属于 P8-03。客户端 filename 永不用于路径。
 */
import type { IncomingMessage } from 'node:http';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { LocalAssetKind } from '../../packages/mobile-contracts/src/index.ts';

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const TEMP_PREFIX = '.asset-upload-';
const TEMP_SUFFIX = '.part';
const BOUNDARY_CHARS = /^[0-9A-Za-z'()+_,\-./:=?]+$/;
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

export const ASSET_UPLOAD_LIMITS = Object.freeze({
  maxTotalBytes: 64 * 1024 * 1024 + 64 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxFieldBytes: 1024,
  maxParts: 3,
  maxHeaderBytes: 8 * 1024,
  maxHeaderLines: 8,
  deadlineMs: 60_000,
});

export type AssetUploadErrorCode =
  | 'multipart_required'
  | 'multipart_boundary_invalid'
  | 'multipart_framing_invalid'
  | 'multipart_header_invalid'
  | 'multipart_field_invalid'
  | 'payload_too_large'
  | 'upload_deadline'
  | 'upload_aborted';

export class AssetUploadError extends Error {
  constructor(
    readonly code: AssetUploadErrorCode,
    readonly status: 400 | 408 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'AssetUploadError';
  }
}

export interface ReceivedAssetUpload {
  kind: LocalAssetKind;
  displayName: string;
  format: 'json' | 'png';
  declaredMediaType: string;
  bytes: number;
  /** 服务端私有临时路径；不得进入 DTO、日志或错误响应。 */
  tempPath: string;
}

interface MultipartUploadOptions {
  tempDir: string;
  limits?: Partial<typeof ASSET_UPLOAD_LIMITS>;
}

interface ActivePart {
  name: 'kind' | 'displayName' | 'file';
  file: boolean;
  filename?: string;
  mediaType?: string;
  bytes: number;
  chunks: Buffer[];
}

function singleContentType(req: IncomingMessage): string | null {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'content-type') count++;
  }
  const value = req.headers['content-type'];
  return count === 1 && typeof value === 'string' ? value : null;
}

export function parseMultipartBoundary(req: IncomingMessage): string {
  const value = singleContentType(req);
  if (!value) throw new AssetUploadError('multipart_required', 415, '需要唯一的 multipart/form-data Content-Type');
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^\s;]+))$/i.exec(value);
  const boundary = match?.[1] ?? match?.[2] ?? '';
  if (boundary.length < 1 || boundary.length > 70 || !BOUNDARY_CHARS.test(boundary)) {
    throw new AssetUploadError('multipart_boundary_invalid', 400, 'multipart boundary 非法');
  }
  return boundary;
}

function contentLength(req: IncomingMessage): number | null {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === 'content-length') count++;
  }
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  if (count !== 1 || typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new AssetUploadError('multipart_framing_invalid', 400, 'Content-Length 非法或重复');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new AssetUploadError('payload_too_large', 413, '请求体超过上传预算');
  }
  return value;
}

function parsePartHeaders(raw: Buffer, maxLines: number): ActivePart {
  const text = raw.toString('latin1');
  const lines = text.length === 0 ? [] : text.split('\r\n');
  if (lines.length < 1 || lines.length > maxLines || lines.some((line) => line.length === 0 || /^[ \t]/.test(line))) {
    throw new AssetUploadError('multipart_header_invalid', 400, 'multipart part header 非法');
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new AssetUploadError('multipart_header_invalid', 400, 'multipart header 缺少冒号');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9-]+$/.test(name) || value.length === 0 || headers.has(name)) {
      throw new AssetUploadError('multipart_header_invalid', 400, 'multipart header 重复或非法');
    }
    if (name !== 'content-disposition' && name !== 'content-type') {
      throw new AssetUploadError('multipart_header_invalid', 400, 'multipart header 不在允许列表');
    }
    headers.set(name, value);
  }

  const disposition = headers.get('content-disposition') ?? '';
  const match = /^form-data;\s*name="(kind|displayName|file)"(?:;\s*filename="([^"\r\n]{1,255})")?$/.exec(disposition);
  if (!match) throw new AssetUploadError('multipart_header_invalid', 400, 'Content-Disposition 非法');
  const name = match[1] as ActivePart['name'];
  const filename = match[2];
  if (name === 'file') {
    if (!filename || /[\\/\u0000-\u001f\u007f]/.test(filename)) {
      throw new AssetUploadError('multipart_field_invalid', 400, 'file part 的 filename 非法');
    }
    const mediaType = (headers.get('content-type') ?? 'application/octet-stream').toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
      throw new AssetUploadError('multipart_header_invalid', 400, 'file Content-Type 非法');
    }
    return { name, file: true, filename, mediaType, bytes: 0, chunks: [] };
  }
  if (filename !== undefined || (headers.has('content-type')
    && !/^text\/plain(?:;\s*charset=utf-8)?$/i.test(headers.get('content-type')!))) {
    throw new AssetUploadError('multipart_field_invalid', 400, `${name} 必须是 UTF-8 文本字段`);
  }
  return { name, file: false, bytes: 0, chunks: [] };
}

function decodeField(part: ActivePart): string {
  try {
    return FATAL_UTF8.decode(Buffer.concat(part.chunks, part.bytes));
  } catch {
    throw new AssetUploadError('multipart_field_invalid', 400, `${part.name} 不是合法 UTF-8`);
  }
}

function safeDisplayName(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function discardAssetUpload(upload: ReceivedAssetUpload | null | undefined): void {
  if (!upload) return;
  try { rmSync(upload.tempPath, { force: true }); } catch { /* 固定临时文件的 best effort 补偿 */ }
}

/** 单实例进程启动后清理上次崩溃遗留的固定前缀临时文件。 */
export function pruneAssetUploadTemps(tempDir: string): number {
  if (!existsSync(tempDir)) return 0;
  let removed = 0;
  for (const name of readdirSync(tempDir)) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
    try { rmSync(resolve(tempDir, name), { force: true }); removed++; } catch { /* 下次启动再清理 */ }
  }
  return removed;
}

export function receiveAssetMultipart(
  req: IncomingMessage,
  options: MultipartUploadOptions,
): Promise<ReceivedAssetUpload> {
  const limits = { ...ASSET_UPLOAD_LIMITS, ...options.limits };
  const boundary = parseMultipartBoundary(req);
  const declaredLength = contentLength(req);
  if (declaredLength !== null && declaredLength > limits.maxTotalBytes) {
    throw new AssetUploadError('payload_too_large', 413, '请求体超过上传预算');
  }
  mkdirSync(options.tempDir, { recursive: true });
  const tempPath = resolve(options.tempDir, `${TEMP_PREFIX}${process.pid}-${randomUUID()}${TEMP_SUFFIX}`);
  const firstBoundary = Buffer.from(`--${boundary}\r\n`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const keepBytes = Math.max(1, delimiter.length - 1);

  return new Promise((resolveUpload, reject) => {
    let buffer = Buffer.alloc(0);
    let state: 'start' | 'headers' | 'body' | 'suffix' | 'final' | 'done' = 'start';
    let active: ActivePart | null = null;
    let fd: number | undefined;
    let totalBytes = 0;
    let partCount = 0;
    let settled = false;
    let kindValue: string | undefined;
    let displayName: string | undefined;
    let fileFormat: 'json' | 'png' | undefined;
    let fileMediaType: string | undefined;
    let fileBytes = 0;
    const seen = new Set<string>();

    const removeListeners = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const cleanup = (): void => {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
        fd = undefined;
      }
      try { rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    };
    const timer = setTimeout(() => {
      fail(new AssetUploadError('upload_deadline', 408, '上传超过时钟预算'));
    }, limits.deadlineMs);
    timer.unref?.();

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListeners();
      cleanup();
      if (!req.complete && !req.destroyed) req.resume();
      reject(error instanceof AssetUploadError
        ? error
        : new AssetUploadError('multipart_framing_invalid', 400, 'multipart 流解析失败'));
    };

    const writePart = (chunk: Buffer): void => {
      if (!active || chunk.length === 0) return;
      active.bytes += chunk.length;
      if (active.file) {
        if (active.bytes > limits.maxFileBytes || fd === undefined) {
          throw new AssetUploadError('payload_too_large', 413, '上传文件超过预算');
        }
        let offset = 0;
        while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
      } else {
        if (active.bytes > limits.maxFieldBytes) {
          throw new AssetUploadError('multipart_field_invalid', 400, `${active.name} 字段过长`);
        }
        active.chunks.push(Buffer.from(chunk));
      }
    };

    const finishPart = (): void => {
      if (!active) throw new AssetUploadError('multipart_framing_invalid', 400, 'multipart part 状态非法');
      if (active.file) {
        if (active.bytes === 0 || fd === undefined || !active.filename) {
          throw new AssetUploadError('multipart_field_invalid', 400, '上传文件为空');
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        const lower = active.filename.toLowerCase();
        fileFormat = lower.endsWith('.png') ? 'png' : lower.endsWith('.json') ? 'json' : undefined;
        if (!fileFormat) throw new AssetUploadError('multipart_field_invalid', 400, '只接受 .json 或 .png 文件');
        fileMediaType = active.mediaType ?? 'application/octet-stream';
        fileBytes = active.bytes;
      } else {
        const value = decodeField(active);
        if (active.name === 'kind') kindValue = value;
        else displayName = value;
      }
      active = null;
    };

    const parseAvailable = (): void => {
      for (;;) {
        if (state === 'start') {
          if (buffer.length < firstBoundary.length) return;
          if (!buffer.subarray(0, firstBoundary.length).equals(firstBoundary)) {
            throw new AssetUploadError('multipart_framing_invalid', 400, 'multipart 起始 boundary 非法');
          }
          buffer = buffer.subarray(firstBoundary.length);
          state = 'headers';
          continue;
        }
        if (state === 'headers') {
          const index = buffer.indexOf(HEADER_END);
          if (index < 0) {
            if (buffer.length > limits.maxHeaderBytes) {
              throw new AssetUploadError('multipart_header_invalid', 400, 'multipart header 超过预算');
            }
            return;
          }
          if (index > limits.maxHeaderBytes) {
            throw new AssetUploadError('multipart_header_invalid', 400, 'multipart header 超过预算');
          }
          partCount++;
          if (partCount > limits.maxParts) {
            throw new AssetUploadError('multipart_field_invalid', 400, 'multipart part 数超过预算');
          }
          active = parsePartHeaders(buffer.subarray(0, index), limits.maxHeaderLines);
          if (seen.has(active.name)) {
            throw new AssetUploadError('multipart_field_invalid', 400, `字段 ${active.name} 重复`);
          }
          seen.add(active.name);
          if (active.file) fd = openSync(tempPath, 'wx', 0o600);
          buffer = buffer.subarray(index + HEADER_END.length);
          state = 'body';
          continue;
        }
        if (state === 'body') {
          const index = buffer.indexOf(delimiter);
          if (index >= 0) {
            writePart(buffer.subarray(0, index));
            finishPart();
            buffer = buffer.subarray(index + delimiter.length);
            state = 'suffix';
            continue;
          }
          if (buffer.length <= keepBytes) return;
          const flush = buffer.length - keepBytes;
          writePart(buffer.subarray(0, flush));
          buffer = buffer.subarray(flush);
          return;
        }
        if (state === 'suffix') {
          if (buffer.length < 2) return;
          if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
            buffer = buffer.subarray(2);
            state = 'final';
            continue;
          }
          if (buffer.subarray(0, 2).equals(CRLF)) {
            buffer = buffer.subarray(2);
            state = 'headers';
            continue;
          }
          throw new AssetUploadError('multipart_framing_invalid', 400, 'multipart boundary 后缀非法');
        }
        if (state === 'final') {
          if (buffer.length === 0) return;
          if (buffer.length === 1 && buffer[0] === 0x0d) return;
          if (!buffer.subarray(0, 2).equals(CRLF)) {
            throw new AssetUploadError('multipart_framing_invalid', 400, 'multipart 结束符非法');
          }
          buffer = buffer.subarray(2);
          state = 'done';
          continue;
        }
        if (buffer.length > 0) {
          throw new AssetUploadError('multipart_framing_invalid', 400, 'multipart 不允许 epilogue');
        }
        return;
      }
    };

    function onData(chunk: Buffer): void {
      if (settled) return;
      try {
        totalBytes += chunk.length;
        if (totalBytes > limits.maxTotalBytes) {
          throw new AssetUploadError('payload_too_large', 413, '请求体超过上传预算');
        }
        buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
        parseAvailable();
      } catch (error) {
        fail(error);
      }
    }

    function onEnd(): void {
      if (settled) return;
      try {
        parseAvailable();
        if (!((state === 'done' && buffer.length === 0) || (state === 'final' && buffer.length === 0))) {
          throw new AssetUploadError('multipart_framing_invalid', 400, 'multipart 请求提前结束');
        }
        if (!seen.has('kind') || !seen.has('displayName') || !seen.has('file') || seen.size !== 3) {
          throw new AssetUploadError('multipart_field_invalid', 400, '必须且只能包含 kind、displayName、file');
        }
        if (kindValue !== 'card' && kindValue !== 'preset' && kindValue !== 'worldbook') {
          throw new AssetUploadError('multipart_field_invalid', 400, 'kind 非法');
        }
        if (!displayName || !safeDisplayName(displayName)) {
          throw new AssetUploadError('multipart_field_invalid', 400, 'displayName 非法');
        }
        if (!fileFormat || !fileMediaType || fileBytes <= 0) {
          throw new AssetUploadError('multipart_field_invalid', 400, 'file part 不完整');
        }
        if (kindValue !== 'card' && fileFormat !== 'json') {
          throw new AssetUploadError('multipart_field_invalid', 400, '预设和世界书只接受 JSON');
        }
        if ((fileFormat === 'png' && !['image/png', 'application/octet-stream'].includes(fileMediaType))
          || (fileFormat === 'json'
            && !['application/json', 'text/json', 'application/octet-stream'].includes(fileMediaType))) {
          throw new AssetUploadError('multipart_field_invalid', 400, '声明的文件媒体类型与扩展名不一致');
        }
        settled = true;
        clearTimeout(timer);
        removeListeners();
        resolveUpload({
          kind: kindValue,
          displayName,
          format: fileFormat,
          declaredMediaType: fileMediaType,
          bytes: fileBytes,
          tempPath,
        });
      } catch (error) {
        fail(error);
      }
    }

    function onError(): void {
      fail(new AssetUploadError('upload_aborted', 400, '上传连接异常中止'));
    }
    function onAborted(): void {
      fail(new AssetUploadError('upload_aborted', 400, '上传连接已中止'));
    }
    function onClose(): void {
      if (!req.complete) onAborted();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}
