/** P8-04: recoverable publication of canonical asset files plus stable identity. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  assetDir,
  computeAssetRevision,
  isSafeAssetFileName,
  type AssetKind,
} from '../../packages/core/src/asset-paths.ts';
import {
  AssetIdentityRegistry,
  isLocalAssetId,
  type LocalAssetIdentity,
} from '../../packages/core/src/asset-identity.ts';

const TRANSACTION_VERSION = 1 as const;
const ROOT_NAME = '.asset-import-staging';
const TX_RE = /^tx-([a-f0-9]{24})$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export type AssetImportCommitPhase =
  | 'staged-json'
  | 'staged-png'
  | 'prepared'
  | 'committing'
  | 'renamed-json'
  | 'renamed-png'
  | 'identity'
  | 'committed';

interface IntentFile {
  role: 'json' | 'png';
  stageName: 'canonical.json' | 'original.png';
  finalName: string;
  bytes: number;
  sha256: string;
}

interface AssetImportIntent {
  version: typeof TRANSACTION_VERSION;
  txId: string;
  state: 'prepared' | 'committing' | 'committed';
  identity: LocalAssetIdentity;
  files: IntentFile[];
}

export interface PreparedAssetImport {
  txId: string;
}

export interface CommittedAssetImport {
  identity: LocalAssetIdentity;
  revision: string;
}

interface AssetImportTransactionOptions {
  dataDir: string;
  identities: AssetIdentityRegistry;
  resolveUserDir?: (kind: AssetKind) => string;
  onPhase?: (phase: AssetImportCommitPhase, txId: string) => void;
}

function ownKeys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',');
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} 必须是普通对象`);
  return value as Record<string, unknown>;
}

function parseIdentity(value: unknown): LocalAssetIdentity {
  const row = asObject(value, 'identity');
  if (ownKeys(row) !== 'assetId,displayName,kind,storageKey'
    || !isLocalAssetId(row.assetId)
    || (row.kind !== 'card' && row.kind !== 'preset' && row.kind !== 'worldbook')
    || !isSafeAssetFileName(row.storageKey)
    || typeof row.displayName !== 'string'
    || row.displayName.length < 1
    || row.displayName.length > 256
    || row.displayName !== row.displayName.trim()
    || /[\u0000-\u001f\u007f]/.test(row.displayName)) throw new Error('identity 字段非法');
  return {
    assetId: row.assetId,
    kind: row.kind,
    storageKey: row.storageKey,
    displayName: row.displayName,
  };
}

function parseIntent(raw: string, expectedTxId: string): AssetImportIntent {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('资产提交 intent JSON 损坏'); }
  const row = asObject(value, 'intent');
  if (ownKeys(row) !== 'files,identity,state,txId,version'
    || row.version !== TRANSACTION_VERSION
    || row.txId !== expectedTxId
    || (row.state !== 'prepared' && row.state !== 'committing' && row.state !== 'committed')
    || !Array.isArray(row.files)) throw new Error('资产提交 intent 版本或字段非法');
  const identity = parseIdentity(row.identity);
  if (row.files.length < 1 || row.files.length > 2) throw new Error('资产提交文件数量非法');
  const roles = new Set<string>();
  const files = row.files.map((entry): IntentFile => {
    const file = asObject(entry, 'intent file');
    if (ownKeys(file) !== 'bytes,finalName,role,sha256,stageName'
      || (file.role !== 'json' && file.role !== 'png')
      || (file.stageName !== 'canonical.json' && file.stageName !== 'original.png')
      || (file.role === 'json' ? file.stageName !== 'canonical.json' : file.stageName !== 'original.png')
      || !isSafeAssetFileName(file.finalName)
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) <= 0
      || typeof file.sha256 !== 'string' || !HASH_RE.test(file.sha256)) throw new Error('资产提交文件字段非法');
    if (roles.has(file.role)) throw new Error('资产提交文件 role 重复');
    roles.add(file.role);
    return {
      role: file.role,
      stageName: file.stageName,
      finalName: file.finalName,
      bytes: file.bytes as number,
      sha256: file.sha256,
    };
  });
  if (!roles.has('json') || identity.storageKey !== files.find((file) => file.role === 'json')?.finalName
    || (identity.kind !== 'card' && roles.has('png'))
    || (roles.has('png') && files.find((file) => file.role === 'png')?.finalName
      !== identity.storageKey.replace(/\.json$/i, '.png'))) throw new Error('资产提交 intent 关系非法');
  return {
    version: TRANSACTION_VERSION,
    txId: expectedTxId,
    state: row.state,
    identity,
    files,
  };
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function writeDurableFile(path: string, content: Buffer | string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, content, typeof content === 'string' ? { encoding: 'utf8' } : undefined);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function replaceIntent(path: string, intent: AssetImportIntent): void {
  const temporary = resolve(`${path}.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeDurableFile(temporary, `${JSON.stringify(intent, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function assertFileHash(path: string, expected: IntentFile): void {
  if (!statSync(path).isFile()) throw new Error('资产提交目标不是普通文件');
  const content = readFileSync(path);
  if (content.length !== expected.bytes || sha256(content) !== expected.sha256) {
    throw new Error('资产提交文件 hash 不匹配');
  }
}

export class AssetImportTransactionCoordinator {
  readonly rootDir: string;
  private readonly identities: AssetIdentityRegistry;
  private readonly resolveUserDir: (kind: AssetKind) => string;
  private readonly onPhase?: AssetImportTransactionOptions['onPhase'];

  constructor(options: AssetImportTransactionOptions) {
    this.rootDir = resolve(options.dataDir, ROOT_NAME);
    this.identities = options.identities;
    this.resolveUserDir = options.resolveUserDir ?? ((kind) => assetDir(kind, true));
    this.onPhase = options.onPhase;
  }

  private phase(phase: AssetImportCommitPhase, txId: string): void {
    this.onPhase?.(phase, txId);
  }

  private txDir(txId: string): string {
    if (!/^[a-f0-9]{24}$/.test(txId)) throw new Error('资产提交 txId 非法');
    return resolve(this.rootDir, `tx-${txId}`);
  }

  private readIntent(txId: string): AssetImportIntent {
    return parseIntent(readFileSync(resolve(this.txDir(txId), 'intent.json'), 'utf8'), txId);
  }

  prepare(input: {
    kind: AssetKind;
    storageKey: string;
    displayName: string;
    raw: string;
    pngBuffer?: Buffer | null;
  }): PreparedAssetImport {
    if (!isSafeAssetFileName(input.storageKey) || !/\.json$/i.test(input.storageKey)) {
      throw new Error('资产提交 storageKey 非法');
    }
    const txId = randomBytes(12).toString('hex');
    mkdirSync(this.rootDir, { recursive: true });
    const txDir = this.txDir(txId);
    mkdirSync(txDir);
    let intentDurable = false;
    try {
      const identity = this.identities.prepareNew(input.kind, input.storageKey, input.displayName);
      const json = Buffer.from(input.raw, 'utf8');
      const jsonFile: IntentFile = {
        role: 'json', stageName: 'canonical.json', finalName: input.storageKey,
        bytes: json.length, sha256: sha256(json),
      };
      writeDurableFile(resolve(txDir, jsonFile.stageName), json);
      this.phase('staged-json', txId);
      const files = [jsonFile];
      if (input.pngBuffer) {
        const pngFile: IntentFile = {
          role: 'png', stageName: 'original.png', finalName: input.storageKey.replace(/\.json$/i, '.png'),
          bytes: input.pngBuffer.length, sha256: sha256(input.pngBuffer),
        };
        writeDurableFile(resolve(txDir, pngFile.stageName), input.pngBuffer);
        files.push(pngFile);
        this.phase('staged-png', txId);
      }
      const intent: AssetImportIntent = {
        version: TRANSACTION_VERSION, txId, state: 'prepared', identity, files,
      };
      replaceIntent(resolve(txDir, 'intent.json'), intent);
      intentDurable = true;
      this.phase('prepared', txId);
      return { txId };
    } catch (error) {
      if (!intentDurable) rmSync(txDir, { recursive: true, force: true });
      throw error;
    }
  }

  private finish(intent: AssetImportIntent): CommittedAssetImport {
    const txDir = this.txDir(intent.txId);
    const finalDir = resolve(this.resolveUserDir(intent.identity.kind));
    mkdirSync(finalDir, { recursive: true });
    for (const file of intent.files) {
      const staged = resolve(txDir, file.stageName);
      const final = resolve(finalDir, file.finalName);
      const stagedExists = existsSync(staged);
      const finalExists = existsSync(final);
      if (stagedExists && finalExists) throw new Error('资产提交同时存在 staged 与 final 文件');
      if (!stagedExists && !finalExists) throw new Error('资产提交文件丢失');
      if (stagedExists) renameSync(staged, final);
      assertFileHash(final, file);
      this.phase(file.role === 'json' ? 'renamed-json' : 'renamed-png', intent.txId);
    }
    const identity = this.identities.commitPrepared(intent.identity);
    this.phase('identity', intent.txId);
    const canonical = readFileSync(resolve(finalDir, intent.identity.storageKey));
    const revision = computeAssetRevision(
      intent.identity.kind, intent.identity.storageKey, 'user', canonical,
    );
    const committed = { ...intent, state: 'committed' as const };
    replaceIntent(resolve(txDir, 'intent.json'), committed);
    this.phase('committed', intent.txId);
    rmSync(txDir, { recursive: true, force: true });
    return { identity, revision };
  }

  commit(prepared: PreparedAssetImport): CommittedAssetImport {
    const intent = this.readIntent(prepared.txId);
    if (intent.state !== 'prepared') throw new Error('资产提交不在 prepared 状态');
    const committing = { ...intent, state: 'committing' as const };
    replaceIntent(resolve(this.txDir(intent.txId), 'intent.json'), committing);
    this.phase('committing', intent.txId);
    return this.finish(committing);
  }

  /** Called after the process lock is held and before HTTP starts accepting traffic. */
  recover(): { rolledBack: number; completed: number } {
    if (!existsSync(this.rootDir)) return { rolledBack: 0, completed: 0 };
    let rolledBack = 0;
    let completed = 0;
    for (const name of readdirSync(this.rootDir).sort()) {
      const match = TX_RE.exec(name);
      if (!match) throw new Error('资产提交 staging 含未知条目');
      const txId = match[1]!;
      const txDir = this.txDir(txId);
      const intentPath = resolve(txDir, 'intent.json');
      if (!existsSync(intentPath)) {
        rmSync(txDir, { recursive: true, force: true });
        rolledBack++;
        continue;
      }
      const intent = this.readIntent(txId);
      if (intent.state === 'prepared') {
        const finalDir = resolve(this.resolveUserDir(intent.identity.kind));
        if (intent.files.some((file) => existsSync(resolve(finalDir, file.finalName)))
          || this.identities.get(intent.identity.kind, intent.identity.assetId)
          || this.identities.findByStorageKey(intent.identity.kind, intent.identity.storageKey)) {
          throw new Error('prepared 资产提交出现可见副作用');
        }
        rmSync(txDir, { recursive: true, force: true });
        rolledBack++;
        continue;
      }
      this.finish(intent);
      completed++;
    }
    return { rolledBack, completed };
  }
}
