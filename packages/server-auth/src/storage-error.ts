/**
 * 认证存储层的稳定错误码。
 *
 * 与 `AuthCryptoError` 分离：密码学失败与"存储/保护不可信"是两类事故，调用方（A1-03 备份、
 * A2 启动）需要按 code 区分是否需要 fail-closed、是否需要人工介入。
 */
export type AuthStorageErrorCode =
  | 'invalid-layout'
  | 'invalid-generation-id'
  | 'generation-missing'
  | 'active-pointer-missing'
  | 'active-pointer-invalid'
  | 'maintenance-active'
  | 'maintenance-unreadable'
  | 'protection-unverified'
  | 'acl-unsafe'
  | 'reparse-point'
  | 'root-key-exists'
  | 'root-key-missing'
  | 'root-key-invalid'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'auth-db-missing'
  | 'auth-db-corrupt'
  | 'application-id-mismatch'
  | 'schema-future'
  | 'schema-outdated'
  | 'schema-migration-failed'
  | 'record-invalid'
  | 'pairing-unavailable'
  | 'backup-invalid'
  | 'backup-incompatible'
  | 'lease-required'
  | 'lease-mismatch'
  | 'not-found'
  | 'conflict'
  | 'binding-mismatch'
  | 'io-failed';

export class AuthStorageError extends Error {
  readonly code: AuthStorageErrorCode;

  constructor(code: AuthStorageErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthStorageError';
    this.code = code;
  }
}
