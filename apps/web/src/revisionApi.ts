export const ABSENT_REVISION = 'absent';

export interface RevisionConflictDetails {
  expectedRevision?: string;
  actualRevision: string;
  resourceId?: string;
}

export class RevisionApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RevisionApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 同时理解本地旧错误和 secured 模式的统一错误投影。 */
export async function responseJson<T>(response: Response): Promise<T> {
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch (cause) {
    // A successful status with an unreadable body is never a successful API result. This most
    // commonly happens when a slow mobile/Tailnet transfer is aborted while response.json() is
    // still consuming the body. Returning {} here used to hide the transport failure and caused
    // downstream errors such as `undefined.map`, far away from the actual fault.
    if (response.ok) {
      throw new Error('服务器响应正文不完整或网络传输已中断，请重试', { cause });
    }
    // Error responses from older/local endpoints are not guaranteed to carry JSON. Preserve the
    // HTTP status below so callers still receive a useful bounded error.
    payload = {};
  }
  if (response.ok) return payload as T;
  const nested = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error as Record<string, unknown>
    : undefined;
  const message = typeof payload.error === 'string'
    ? payload.error
    : typeof nested?.message === 'string' ? nested.message : `HTTP ${response.status}`;
  throw new RevisionApiError(
    response.status,
    message,
    typeof nested?.code === 'string' ? nested.code : undefined,
    nested?.details && typeof nested.details === 'object' && !Array.isArray(nested.details)
      ? nested.details as Record<string, unknown>
      : undefined,
  );
}

export function revisionHeaders(revision: string, json = true): Headers {
  const headers = new Headers();
  if (json) headers.set('Content-Type', 'application/json');
  headers.set('If-Match', `"${revision}"`);
  return headers;
}

export function conflictDetails(error: unknown): RevisionConflictDetails | null {
  if (!(error instanceof RevisionApiError) || error.status !== 409) return null;
  const actualRevision = error.details?.actualRevision;
  if (typeof actualRevision !== 'string') return null;
  return {
    actualRevision,
    ...(typeof error.details?.expectedRevision === 'string'
      ? { expectedRevision: error.details.expectedRevision }
      : {}),
    ...(typeof error.details?.resourceId === 'string'
      ? { resourceId: error.details.resourceId }
      : {}),
  };
}
