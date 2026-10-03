/**
 * P5.2-A2-01：首次认证 bootstrap CLI。
 *
 * 用法：
 *   pnpm auth:bootstrap [--data-dir <dir>]
 *
 * 纪律（清单 A2-01）：
 *  · 只操作电脑数据目录（默认 `data/`，`--data-dir` / `JG_USER_DATA_DIR` 可覆盖）；
 *  · 创建一次性配对码并**只显示一次**——不写文件、不写日志；丢失只能重新生成，不存在补发；
 *  · 首个 code 显式允许 cookie transport，并授予全部五个 scope（含 admin）；
 *  · 已存在有效 admin 设备时默认拒绝再次 bootstrap——恢复必须走显式
 *    root rotation（A1-03 备份恢复 / revoke-all），所有设备需要重新配对；
 *  · 配对码 TTL 15 分钟、最多 5 次尝试（计划未固定数值，这里选保守默认值并写进测试）。
 *
 * 本文件是薄壳：核心逻辑在 `runAuthBootstrap()`，注入 out/err 以便测试断言"只打印一次、不落盘"。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import {
  ACTIVE_POINTER_NAME,
  AuthStorageError,
  createAuthCrypto,
  initializeAuthStorage,
  openAuthStore,
  readActiveGeneration,
  readInstanceRootKeyFile,
  resolveAuthStorageLayout,
  resolveGenerationPaths,
} from '../../packages/server-auth/src/index.ts';
import { AUTH_TRANSPORT_VALUES, DEVICE_SCOPE_VALUES } from '../../packages/server-auth/src/vocabulary.ts';

/** 配对码有效期：15 分钟。 */
export const BOOTSTRAP_PAIRING_TTL_MS = 15 * 60 * 1000;
/** 配对码最大尝试次数。 */
export const BOOTSTRAP_PAIRING_ATTEMPTS = 5;

export interface AuthBootstrapRunOptions {
  readonly dataDir: string;
  readonly now?: () => string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

export interface AuthBootstrapRunResult {
  /** 0 = 已签发；1 = 拒绝（已有有效 admin 设备）。 */
  readonly exitCode: number;
  /** 配对码的公开 selector（可安全出现在输出/测试里；码本身绝不返回）。 */
  readonly pairingSelector?: string;
  readonly expiresAt?: string;
}

/** 收集目录下全部文件路径（用于"码不落盘"的自证）。 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

/**
 * 执行一次 bootstrap：返回 0 表示签发了新的一次性配对码（已打印到 out）；
 * 返回 1 表示拒绝（已存在有效 admin 设备）。存储层错误向上抛出（CLI 顶层统一呈现）。
 */
export function runAuthBootstrap(options: AuthBootstrapRunOptions): AuthBootstrapRunResult {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date().toISOString());
  const dataDir = resolve(options.dataDir);
  const layout = resolveAuthStorageLayout(dataDir);

  let store;
  if (existsSync(layout.activePointerPath)) {
    // 已有激活世代：可能处于正常使用中，也可能全部设备已被撤销。
    store = openAuthStore({ dataDir, now });
    const adminDevices = store.countUnrevokedDevicesByScope('admin');
    if (adminDevices > 0) {
      err(`拒绝 bootstrap：已存在 ${adminDevices} 台持有 admin scope 的有效设备。`);
      err('首次 bootstrap 只允许一次；恢复流程必须显式执行 root rotation + 撤销全部设备：');
      err('  · 备份恢复轮换：restoreAuthBackup（新根密钥，旧凭据全部失效，所有设备重新配对）；');
      err('  · 或逐设备吊销后用剩余 admin 设备重新签发配对码（/api/auth/pairing-codes）。');
      err('本次未创建任何配对码。');
      store.close();
      return { exitCode: 1 };
    }
  } else {
    // 首次：显式 bootstrap 建立安全存储（根密钥 + 世代 + DB）。
    initializeAuthStorage({ dataDir, now });
    store = openAuthStore({ dataDir, now });
  }

  const generationId = readActiveGeneration(layout);
  const generation = resolveGenerationPaths(layout, generationId);
  const keyBytes = readInstanceRootKeyFile(generation.rootKeyPath);
  const crypto = createAuthCrypto(keyBytes);
  try {
    const issued = crypto.issuePairingCode();
    try {
      const createdAt = now();
      const expiresAt = new Date(Date.parse(createdAt) + BOOTSTRAP_PAIRING_TTL_MS).toISOString();
      store.createPairing({
        selector: issued.selector,
        codeDigest: issued.digest,
        allowedScopes: [...DEVICE_SCOPE_VALUES],
        allowedTransports: [...AUTH_TRANSPORT_VALUES],
        displayNameHint: 'bootstrap-admin',
        createdAt,
        expiresAt,
        attemptsRemaining: BOOTSTRAP_PAIRING_ATTEMPTS,
        securityEpoch: store.meta.securityEpoch,
      });
      const code = issued.value.take();
      out(`认证存储就绪：generation ${generationId}（security epoch ${store.meta.securityEpoch}）`);
      out(`一次性配对码已生成：${BOOTSTRAP_PAIRING_ATTEMPTS} 次尝试机会，${expiresAt} 前有效。`);
      out('⚠️ 此码只显示这一次，不会写入任何文件或日志；丢失只能重新生成，不存在补发：');
      out('');
      out(`  ${code}`);
      out('');
      out('在需要配对的客户端用它调用 POST /api/auth/pair 完成配对。');
      // 码不落盘的自证：数据目录下任何文件都不允许包含它。
      for (const path of walkFiles(dataDir)) {
        if (readFileSync(path).includes(code)) {
          err(`内部错误：配对码出现在了 ${path}，这违反"只显示一次"纪律；请立即视为泄露并轮换。`);
          return { exitCode: 1, pairingSelector: issued.selector, expiresAt };
        }
      }
      return { exitCode: 0, pairingSelector: issued.selector, expiresAt };
    } finally {
      issued.value.discard();
      issued.digest.destroy();
    }
  } finally {
    crypto.destroy();
    keyBytes.fill(0);
    store.close();
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dataDir = get('--data-dir')
    ?? process.env.JG_USER_DATA_DIR
    ?? join(process.cwd(), 'data');
  try {
    const result = runAuthBootstrap({ dataDir });
    if (result.exitCode !== 0) {
      console.error(`bootstrap 被拒绝（data dir：${dataDir}）`);
    }
    return result.exitCode;
  } catch (error) {
    console.error(
      `bootstrap 失败：${error instanceof AuthStorageError ? `${error.code}: ${error.message}` : String(error)}`,
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
