/**
 * core 包 - 资产路径与用户层（编辑器 P2：非只读）
 * 分层：可选只读资产库 + 用户层（data/{presets,worldbooks,cards}，编辑器写入）
 * 优先级：用户层 > 源资产（保存/加载统一走 resolveAsset）
 * 用户层目录可用 JG_USER_DATA_DIR 覆盖（测试隔离）。
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { extractCharaFromPng, pngPayloadToJson } from './chara.ts';

export type AssetKind = 'preset' | 'worldbook' | 'card';
export type AssetSource = 'user' | 'asset';
export const ABSENT_ASSET_REVISION = 'absent' as const;

export interface RevisionedAsset {
  path: string;
  source: AssetSource;
  raw: string;
  revision: string;
}

export interface AssetMutationResult {
  path?: string;
  source?: AssetSource;
  removed?: boolean;
  revision: string;
}

export class AssetRevisionConflictError extends Error {
  readonly kind: AssetKind;
  readonly file: string;
  readonly expectedRevision: string;
  readonly actualRevision: string;

  constructor(kind: AssetKind, file: string, expectedRevision: string, actualRevision: string) {
    super(`asset revision conflict: ${kind}/${file}`);
    this.name = 'AssetRevisionConflictError';
    this.kind = kind;
    this.file = file;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export const USER_DATA_DIR = process.env.JG_USER_DATA_DIR
  ? resolve(process.env.JG_USER_DATA_DIR)
  : resolve(process.cwd(), 'data');
/**
 * 公开发行版不绑定作者机器上的素材目录。若需要一套只读共享资产，显式设置
 * JG_ASSET_BASE；否则使用用户数据目录下的 library 子目录。
 */
export const ASSET_BASE = process.env.JG_ASSET_BASE
  ? resolve(process.env.JG_ASSET_BASE)
  : resolve(USER_DATA_DIR, 'library');
export const ASSET_PRESET_DIR = resolve(ASSET_BASE, '预设');
export const ASSET_WORLDBOOK_DIR = resolve(ASSET_BASE, '世界书');
export const ASSET_CARD_DIR = resolve(ASSET_BASE, '角色卡');
export const USER_PRESET_DIR = resolve(USER_DATA_DIR, 'presets');
export const USER_WORLDBOOK_DIR = resolve(USER_DATA_DIR, 'worldbooks');
export const USER_CARD_DIR = resolve(USER_DATA_DIR, 'cards');

export function assetDir(kind: AssetKind, user: boolean): string {
  if (kind === 'preset') return user ? USER_PRESET_DIR : ASSET_PRESET_DIR;
  if (kind === 'worldbook') return user ? USER_WORLDBOOK_DIR : ASSET_WORLDBOOK_DIR;
  return user ? USER_CARD_DIR : ASSET_CARD_DIR;
}

/**
 * 资产文件名守卫：只允许**单个**文件名段。
 *
 * 不允许路径分隔符、NUL、控制字符、首尾空白，不允许 `.` / `..` 或以 `.` 开头
 * （避免 dotfile），不允许 Windows 盘符相对路径，长度上限 200。
 *
 * 背景：保存/删除路径（saveUserAsset / saveAssetBuffer / deleteWorldbookFile /
 * deleteUserCard / deleteUserAsset）早已用 `basename(file) !== file` 拦截，但**读取
 * 路径 `resolveAsset` / `resolveCard` 此前完全没有校验**。由于 server 的
 * `/api/session/:id/worldbook-entries?name=`、`/api/worldbook/:file` 等路由把客户端
 * 输入直接传进来，`?name=../../data/provider.json` 可读到数据目录之外的文件。
 * 读写两侧现在统一走本守卫，避免再出现"写挡住了、读没挡"的单边修复。
 */
export function isSafeAssetFileName(file: unknown): file is string {
  if (typeof file !== 'string') return false;
  if (file.length === 0 || file.length > 200) return false;
  if (file !== file.trim()) return false;
  if (file === '.' || file === '..' || file.startsWith('.')) return false;
  if (/[\\/\u0000-\u001f\u007f]/.test(file)) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  return basename(file) === file;
}

/** 解析资产文件路径（用户层优先；返回 {path, source} 或 null） */
export function resolveAsset(kind: AssetKind, file: string): { path: string; source: 'user' | 'asset' } | null {
  if (!isSafeAssetFileName(file)) return null;
  const user = resolve(assetDir(kind, true), file);
  if (existsSync(user) && statSync(user).isFile()) return { path: user, source: 'user' };
  const src = resolve(assetDir(kind, false), file);
  if (existsSync(src) && statSync(src).isFile()) return { path: src, source: 'asset' };
  return null;
}

/** 列出资产（用户层在前 + source 标记；重名用户层覆盖源） */
export function listAssets(kind: AssetKind): { file: string; name: string; source: 'user' | 'asset' }[] {
  const seen = new Set<string>();
  const out: { file: string; name: string; source: 'user' | 'asset' }[] = [];
  for (const user of [true, false]) {
    const dir = assetDir(kind, user);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ file: f, name: f.replace(/\.json$/, ''), source: user ? 'user' : 'asset' });
    }
  }
  return out;
}

/** 读取资产 JSON 文本（用户层优先） */
export function readAsset(kind: AssetKind, file: string): { path: string; source: 'user' | 'asset'; raw: string } | null {
  const r = resolveAsset(kind, file);
  if (!r) return null;
  return { path: r.path, source: r.source, raw: readFileSync(r.path, 'utf8') };
}

/** revision 同时绑定逻辑身份、覆盖层和实际字节；不泄露本机绝对路径或时间。 */
export function computeAssetRevision(
  kind: AssetKind,
  file: string,
  source: AssetSource,
  content: string | Buffer,
): string {
  const hash = createHash('sha256');
  hash.update(kind);
  hash.update('\0');
  hash.update(file);
  hash.update('\0');
  hash.update(source);
  hash.update('\0');
  hash.update(content);
  return `sha256:${hash.digest('hex')}`;
}

/** 每次从真实有效文件重算，避免缓存把外部编辑伪装成旧 revision。 */
export function readRevisionedAsset(kind: AssetKind, file: string): RevisionedAsset | null {
  const asset = readAsset(kind, file);
  if (!asset) return null;
  return {
    ...asset,
    revision: computeAssetRevision(kind, file, asset.source, asset.raw),
  };
}

/**
 * 读取指定物理层，而不是读取“用户层优先”的有效资产。
 *
 * 这个窄接口用于需要删除用户覆盖的可逆控制面：删除前必须把被遮蔽的
 * asset 层也纳入 CAS，不能等删完覆盖后才发现下层内容已经漂移。
 */
export function readRevisionedAssetLayer(
  kind: AssetKind,
  file: string,
  source: AssetSource,
): RevisionedAsset | null {
  if (!isSafeAssetFileName(file)) return null;
  const path = resolve(assetDir(kind, source === 'user'), file);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const raw = readFileSync(path, 'utf8');
  return {
    path,
    source,
    raw,
    revision: computeAssetRevision(kind, file, source, raw),
  };
}

function requireExpectedRevision(expectedRevision: string): void {
  if (expectedRevision === ABSENT_ASSET_REVISION) return;
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new TypeError('expectedRevision 非法');
  }
}

function assertAssetRevision(
  kind: AssetKind,
  file: string,
  expectedRevision: string,
): RevisionedAsset | null {
  requireExpectedRevision(expectedRevision);
  const current = readRevisionedAsset(kind, file);
  const actualRevision = current?.revision ?? ABSENT_ASSET_REVISION;
  if (actualRevision !== expectedRevision) {
    throw new AssetRevisionConflictError(kind, file, expectedRevision, actualRevision);
  }
  return current;
}

/** 同目录临时文件 + fsync + rename；失败时原目标保持不变。 */
function atomicReplaceFile(target: string, content: string | Buffer): void {
  const temp = resolve(`${target}.tmp-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, content, typeof content === 'string' ? { encoding: 'utf8' } : undefined);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** 比较与原子替换没有 await 点，属于服务进程内同一个文件提交临界区。 */
export function saveUserAssetCas(
  kind: AssetKind,
  file: string,
  content: string | Buffer,
  expectedRevision: string,
): AssetMutationResult {
  if (!isSafeAssetFileName(file) || !/\.[a-zA-Z0-9]+$/.test(file)) {
    throw new Error(`非法文件名: ${file}`);
  }
  assertAssetRevision(kind, file, expectedRevision);
  const dir = assetDir(kind, true);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, file);
  atomicReplaceFile(target, content);
  const saved = readRevisionedAsset(kind, file);
  if (!saved || saved.source !== 'user') throw new Error('资产原子替换后不可读');
  return { path: saved.path, source: saved.source, revision: saved.revision };
}

/** 删除用户覆盖后重新解析有效层；可能回落源层，也可能变为 absent。 */
export function deleteUserAssetCas(
  kind: AssetKind,
  file: string,
  expectedRevision: string,
): AssetMutationResult {
  if (!isSafeAssetFileName(file)) throw new Error(`非法文件名: ${file}`);
  assertAssetRevision(kind, file, expectedRevision);
  const user = resolve(assetDir(kind, true), file);
  const removed = existsSync(user);
  if (removed) rmSync(user, { force: true });
  const next = readRevisionedAsset(kind, file);
  return {
    ...(next ? { path: next.path, source: next.source } : {}),
    removed,
    revision: next?.revision ?? ABSENT_ASSET_REVISION,
  };
}

/**
 * 删除用户覆盖，并同时对被遮蔽的 asset 层做 CAS。
 *
 * expectedAssetRevision 绑定 asset 层的身份、来源和完整字节。调用者通常还会
 * 在进入本函数前读取 raw 做可读的 before-image 校验；这里紧邻 rmSync 再校验
 * 一次，收窄外部进程改写下层文件的竞态窗口。
 */
export function deleteUserAssetOverrideCas(
  kind: AssetKind,
  file: string,
  expectedRevision: string,
  expectedAssetRevision: string,
): AssetMutationResult {
  if (!isSafeAssetFileName(file)) throw new Error(`非法文件名: ${file}`);
  assertAssetRevision(kind, file, expectedRevision);
  requireExpectedRevision(expectedAssetRevision);
  const asset = readRevisionedAssetLayer(kind, file, 'asset');
  const actualAssetRevision = asset?.revision ?? ABSENT_ASSET_REVISION;
  if (actualAssetRevision !== expectedAssetRevision) {
    throw new AssetRevisionConflictError(kind, file, expectedAssetRevision, actualAssetRevision);
  }
  const user = resolve(assetDir(kind, true), file);
  const removed = existsSync(user);
  if (removed) rmSync(user, { force: true });
  const next = readRevisionedAsset(kind, file);
  return {
    ...(next ? { path: next.path, source: next.source } : {}),
    removed,
    revision: next?.revision ?? ABSENT_ASSET_REVISION,
  };
}

/** 保存到用户层（编辑器写入；返回落盘路径） */
export function saveUserAsset(kind: AssetKind, file: string, json: string): string {
  if (basename(file) !== file || !/^[^\\/]+\.[a-zA-Z0-9]+$/.test(file)) {
    throw new Error(`非法文件名: ${file}`);
  }
  const dir = assetDir(kind, true);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, file);
  atomicReplaceFile(target, json);
  return target;
}

/** 删除用户层副本（恢复源资产）；无用户层副本返回 false */
export function deleteUserAsset(kind: AssetKind, file: string): boolean {
  if (basename(file) !== file) return false; // 防路径穿越（与 saveUserAsset 同规则）
  const user = resolve(assetDir(kind, true), file);
  if (!existsSync(user)) return false;
  rmSync(user, { force: true });
  return true;
}

/** 删除世界书（两层兜底）：优先删用户层副本，无用户层副本时删源层文件。
 *  历史导入可能把用户书直接落在只读资产库的世界书目录，source 被标为 asset，
 *  前端按 source==='user' 显示删除按钮导致按钮没有全覆盖；现按钮全覆盖，此处两层都可删。
 *  仅接受裸文件名（防路径穿越）；调用方须已做两步确认。 */
export function deleteWorldbookFile(file: string): { removed: boolean; layer: 'user' | 'asset' | null } {
  if (basename(file) !== file || !/^[^\\/]+\.json$/i.test(file)) return { removed: false, layer: null };
  const user = resolve(assetDir('worldbook', true), file);
  if (existsSync(user)) {
    rmSync(user, { force: true });
    return { removed: true, layer: 'user' };
  }
  const src = resolve(assetDir('worldbook', false), file);
  if (existsSync(src)) {
    rmSync(src, { force: true });
    return { removed: true, layer: 'asset' };
  }
  return { removed: false, layer: null };
}

/** 删除角色卡用户层副本（PNG 卡导入会同时落 .json + .png，须同基名一并删除；源资产只读不删） */
export function deleteUserCard(file: string): boolean {
  if (basename(file) !== file || !/^[^\\/]+\.(json|png)$/i.test(file)) return false; // 防路径穿越
  const base = file.replace(/\.(json|png)$/i, '');
  let removed = false;
  for (const ext of ['json', 'png']) {
    const p = resolve(USER_CARD_DIR, `${base}.${ext}`);
    if (existsSync(p)) { rmSync(p, { force: true }); removed = true; }
  }
  return removed;
}

/** 卡片 revision 绑定客户端实际打开的文件；PNG 使用解包后的规范 JSON 作为业务真值。 */
export function readRevisionedCard(file: string): (ReturnType<typeof readCardText> & { revision: string }) | null {
  const card = readCardText(file);
  if (!card) return null;
  return {
    ...card,
    revision: computeAssetRevision('card', file, card.source, card.raw),
  };
}

/** 角色卡实体删除 CAS；同基名 JSON/PNG 用户副本作为一个删除动作。 */
export function deleteUserCardCas(file: string, expectedRevision: string): AssetMutationResult {
  if (!isSafeAssetFileName(file) || !/\.(json|png)$/i.test(file)) {
    throw new Error(`非法文件名: ${file}`);
  }
  requireExpectedRevision(expectedRevision);
  const current = readRevisionedCard(file);
  const actualRevision = current?.revision ?? ABSENT_ASSET_REVISION;
  if (actualRevision !== expectedRevision) {
    throw new AssetRevisionConflictError('card', file, expectedRevision, actualRevision);
  }
  const removed = deleteUserCard(file);
  const next = readRevisionedCard(file);
  return {
    ...(next ? { path: next.path, source: next.source } : {}),
    removed,
    revision: next?.revision ?? ABSENT_ASSET_REVISION,
  };
}

/** force 世界书删除仍受同一个有效资源 revision 保护；一次只删除当前可见层。 */
export function deleteWorldbookFileCas(file: string, expectedRevision: string): AssetMutationResult & { layer: 'user' | 'asset' | null } {
  if (!isSafeAssetFileName(file) || !/\.json$/i.test(file)) throw new Error(`非法文件名: ${file}`);
  assertAssetRevision('worldbook', file, expectedRevision);
  const result = deleteWorldbookFile(file);
  const next = readRevisionedAsset('worldbook', file);
  return {
    ...(next ? { path: next.path, source: next.source } : {}),
    removed: result.removed,
    layer: result.layer,
    revision: next?.revision ?? ABSENT_ASSET_REVISION,
  };
}

/** 保存二进制到用户层（PNG 卡原件；文件名校验同 saveUserAsset） */
export function saveAssetBuffer(kind: AssetKind, file: string, buf: Buffer): string {
  if (basename(file) !== file || !/^[^\\/]+\.[a-zA-Z0-9]+$/.test(file)) {
    throw new Error(`非法文件名: ${file}`);
  }
  const dir = assetDir(kind, true);
  mkdirSync(dir, { recursive: true });
  const target = resolve(dir, file);
  atomicReplaceFile(target, buf);
  return target;
}

// ── 角色卡资产族（用户层 + PNG 元数据解包）──

export interface CardInfo { file: string; name: string; format: 'json' | 'png'; source: 'user' | 'asset' }

/** 解析卡文件路径（用户层优先；.json/.png 均可） */
export function resolveCard(file: string): { path: string; source: 'user' | 'asset'; format: 'json' | 'png' } | null {
  if (!isSafeAssetFileName(file)) return null;
  const isPng = file.toLowerCase().endsWith('.png');
  for (const user of [true, false]) {
    const p = resolve(assetDir('card', user), file);
    if (existsSync(p) && statSync(p).isFile()) return { path: p, source: user ? 'user' : 'asset', format: isPng ? 'png' : 'json' };
  }
  return null;
}

/** 角色卡 PNG 签名（8 字节）；假 PNG（如 JPEG 改名）无 chara 元数据，不可作卡 */
function isRealPng(path: string): boolean {
  try {
    const sig = readFileSync(path).subarray(0, 8);
    return sig.length === 8 && sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
  } catch { return false; }
}

/** 列出角色卡（源 + 用户，json + 真 png；假 PNG 过滤） */
export function listCards(sortByLatest = false): CardInfo[] {
  const seen = new Set<string>();
  const out: CardInfo[] = [];
  for (const user of [true, false]) {
    const dir = assetDir('card', user);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const lower = f.toLowerCase();
      if (lower.endsWith('.json')) {
        if (seen.has(f)) continue;
        seen.add(f);
        out.push({ file: f, name: f.replace(/\.json$/i, ''), format: 'json', source: user ? 'user' : 'asset' });
      } else if (lower.endsWith('.png')) {
        if (seen.has(f)) continue;
        const p = resolve(dir, f);
        if (!isRealPng(p)) continue; // 假 PNG（JPEG 改名）无 chara 元数据，不可作卡
        seen.add(f);
        out.push({ file: f, name: f.replace(/\.png$/i, ''), format: 'png', source: user ? 'user' : 'asset' });
      }
    }
  }
  return out;
}

/** 读取卡为 JSON 文本（PNG 自动解包 chara tEXt → base64 解码 → JSON） */
export function readCardText(file: string): { path: string; source: 'user' | 'asset'; raw: string; format: 'json' | 'png' } | null {
  const r = resolveCard(file);
  if (!r) return null;
  if (r.format === 'png') {
    const payload = extractCharaFromPng(readFileSync(r.path));
    if (!payload) throw new Error(`PNG 卡无 chara 元数据: ${file}`);
    return { path: r.path, source: r.source, format: 'png', raw: pngPayloadToJson(payload) };
  }
  return { path: r.path, source: r.source, format: 'json', raw: readFileSync(r.path, 'utf8') };
}
