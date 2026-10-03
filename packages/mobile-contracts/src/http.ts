export const REQUEST_ID_HEADER = 'X-Request-Id' as const;
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key' as const;
export const REVISION_HEADER = 'ETag' as const;
export const EXPECTED_REVISION_HEADER = 'If-Match' as const;
export const ABSENT_REVISION = 'absent' as const;

const ENTITY_REVISION_RE = /^sha256:[a-f0-9]{64}$/;

const OPAQUE_ID_RE = /^[A-Za-z0-9._:-]+$/;

export function isSafeOpaqueId(value: unknown, maxLength = 160): value is string {
  return typeof value === 'string'
    && Number.isInteger(maxLength)
    && maxLength > 0
    && value.length > 0
    && value.length <= maxLength
    && OPAQUE_ID_RE.test(value);
}

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_required'
  | 'rate_limited'
  | 'incompatible_client'
  | 'internal_error';

export interface ApiErrorPayload {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

export interface RevisionedResource {
  revision: string;
}

export type IfMatchParseResult =
  | { ok: true; revision: string }
  | { ok: false; reason: 'missing' | 'malformed' };

/** 业务实体 revision；`absent` 只允许作为创建时的前置状态。 */
export function isEntityRevision(value: unknown, allowAbsent = false): value is string {
  return typeof value === 'string'
    && (ENTITY_REVISION_RE.test(value) || (allowAbsent && value === ABSENT_REVISION));
}

/** 实体存在时的强 ETag。调用方不得用它为 `absent` 生成 GET 响应头。 */
export function formatStrongEtag(revision: string): string {
  if (!isEntityRevision(revision, true)) throw new TypeError('invalid entity revision');
  return `"${revision}"`;
}

/**
 * P7-08 写前置条件只接受一个由本服务签发的强 ETag。
 * 明确拒绝 wildcard、弱 ETag 和逗号列表，避免不同客户端产生含糊覆盖语义。
 */
export function parseIfMatch(value: string | readonly string[] | undefined): IfMatchParseResult {
  if (value === undefined) return { ok: false, reason: 'missing' };
  if (Array.isArray(value)) return { ok: false, reason: 'malformed' };
  if (typeof value !== 'string' || value !== value.trim() || value.includes(',')) {
    return { ok: false, reason: 'malformed' };
  }
  const match = /^"([^"\\]+)"$/.exec(value);
  if (!match || !isEntityRevision(match[1], true)) return { ok: false, reason: 'malformed' };
  return { ok: true, revision: match[1] };
}

export interface RevisionConflictPayload extends ApiErrorPayload {
  error: ApiErrorPayload['error'] & {
    code: 'conflict';
    details: {
      expectedRevision?: string;
      actualRevision: string;
      resourceId?: string;
    };
  };
}
