/**
 * 安装根密钥（instance root key）的创建与读取。
 *
 * 硬要求（对应清单 §6.3 与交接说明 §4.2）：
 * - 创建必须**原子 create-new**：已存在就失败，绝不覆盖（覆盖等于静默作废所有已签发凭据）。
 * - 只允许 32 字节、非全零；长度或内容不对一律 fail-closed。
 * - 创建与读取都要拒绝符号链接/reparse point，并验证 OS 保护。
 * - 不向调用方暴露任何"自动补建"路径：缺失就是错误，由显式 bootstrap 负责。
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { AUTH_ROOT_KEY_BYTES } from './crypto.ts';
import {
  assertAncestorChainNoReparsePoint,
  assertPathProtected,
  establishPathProtection,
} from './platform-protection.ts';
import { AuthStorageError } from './storage-error.ts';

function isAllZero(bytes: Uint8Array): boolean {
  let combined = 0;
  for (const byte of bytes) combined |= byte;
  return combined === 0;
}

/**
 * 原子创建一个新的根密钥文件。
 *
 * A1R-03：**先验后写**。旧实现先 `open('wx')` 落盘、再验证目标保护 —— 父级目录若是
 * junction/symlink，密钥会先写到重定向位置，之后虽然报错但秘密已经落地。现在把
 * "祖先链无 reparse point" 与"父目录已受保护"放在创建动作之前，任一不满足就直接拒绝。
 *
 * 失败时不会留下可用的密钥文件：写入或校验任一步失败都会抛错，后续 `readInstanceRootKeyFile`
 * 也会因为长度/内容不符而继续 fail-closed（即使清理未能完成）。
 */
export function createInstanceRootKeyFile(target: string): void {
  // 1) 创建之前：祖先链不得含重定向。
  assertAncestorChainNoReparsePoint(target);
  // 2) 创建之前：父目录必须已经是可验证的受保护目录。
  assertPathProtected(dirname(target), 'directory');
  if (existsSync(target)) {
    throw new AuthStorageError('root-key-exists', `根密钥已存在，拒绝覆盖：${target}`);
  }

  const key = randomBytes(AUTH_ROOT_KEY_BYTES);
  if (isAllZero(key)) {
    // 概率可忽略；仅作为"绝不允许全零根密钥"的显式防线。
    throw new AuthStorageError('root-key-invalid', 'CSPRNG 返回了全零根密钥');
  }

  let fd: number | undefined;
  try {
    // 'wx' = O_CREAT | O_EXCL：并发创建只有一个成功，且不会覆盖已有文件。
    fd = openSync(target, 'wx', 0o600);
    writeSync(fd, key);
    fsyncSync(fd);
  } catch (error) {
    throw new AuthStorageError(
      'io-failed',
      `写入根密钥失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    key.fill(0);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关闭失败不改变"创建是否可信"的结论 */
      }
    }
  }

  // 3) 写入之后：显式收紧并**校验**最终文件的保护，而不是信任父目录继承。
  establishPathProtection(target, 'file');

  // 4) 回读校验：确保落盘内容确实是 32 字节非零密钥。
  const verified = readInstanceRootKeyFile(target);
  verified.fill(0);
}

/**
 * 读取根密钥。根密钥**只能**由显式 bootstrap/启动路径读取，不得进入日志或配置快照。
 */
export function readInstanceRootKeyFile(target: string): Buffer {
  if (!existsSync(target)) {
    throw new AuthStorageError('root-key-missing', `根密钥缺失：${target}`);
  }
  assertPathProtected(target, 'file');

  let size: number;
  try {
    size = statSync(target).size;
  } catch {
    throw new AuthStorageError('io-failed', `无法读取根密钥大小：${target}`);
  }
  if (size !== AUTH_ROOT_KEY_BYTES) {
    throw new AuthStorageError(
      'root-key-invalid',
      `根密钥长度必须是 ${AUTH_ROOT_KEY_BYTES} 字节，实际 ${size}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch {
    throw new AuthStorageError('io-failed', `读取根密钥失败：${target}`);
  }
  if (bytes.length !== AUTH_ROOT_KEY_BYTES || isAllZero(bytes)) {
    bytes.fill(0);
    throw new AuthStorageError('root-key-invalid', '根密钥内容非法');
  }
  return bytes;
}

/** 用后清零；调用方在把密钥交给 createAuthCrypto 之后应尽快调用。 */
export function destroyRootKey(key: Buffer): void {
  key.fill(0);
}
