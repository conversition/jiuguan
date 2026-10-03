import {
  ABSENT_REVISION,
  formatStrongEtag,
  isEntityRevision,
} from '@jiuguan/mobile-contracts';
import type { ApiClient, ApiClientResult } from './api-client.ts';
import { ClientRuntimeError } from './errors.ts';
import type { ClientUrlResolver } from './url-resolver.ts';

export interface RevisionedEntity<T> {
  value: T;
  revision: string;
  requestId: string;
}

export interface RevisionWriteOptions<TDraft> {
  expectedRevision: string;
  draft: TDraft;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  signal?: AbortSignal;
}

export class RevisionConflictError<TDraft = unknown> extends ClientRuntimeError {
  readonly expectedRevision: string;
  readonly actualRevision: string;
  readonly resourceId?: string;
  /** 原引用原样保留；运行时不克隆、不清空、不自动重试草稿。 */
  readonly draft: TDraft;

  constructor(input: {
    expectedRevision: string;
    actualRevision: string;
    resourceId?: string;
    draft: TDraft;
    requestId: string;
  }) {
    super('revision_conflict', {
      details: {
        expectedRevision: input.expectedRevision,
        actualRevision: input.actualRevision,
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        requestId: input.requestId,
      },
    });
    this.name = 'RevisionConflictError';
    this.expectedRevision = input.expectedRevision;
    this.actualRevision = input.actualRevision;
    this.resourceId = input.resourceId;
    this.draft = input.draft;
  }
}

type ApiClientLike = Pick<ApiClient, 'request'>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function jsonBody(result: ApiClientResult): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await result.response.json(); }
  catch (cause) {
    throw new ClientRuntimeError('invalid_revision_response', {
      details: { requestId: result.requestId, status: result.response.status },
      cause,
    });
  }
  const record = asRecord(value);
  if (!record) {
    throw new ClientRuntimeError('invalid_revision_response', {
      details: { requestId: result.requestId, status: result.response.status },
    });
  }
  return record;
}

function responseRevision(
  response: Response,
  body: Record<string, unknown>,
  allowAbsent: boolean,
): string {
  const revision = body.revision;
  if (!isEntityRevision(revision, allowAbsent)) {
    throw new ClientRuntimeError('invalid_revision_response');
  }
  const etag = response.headers.get('etag');
  if (revision === ABSENT_REVISION) {
    if (etag !== null) throw new ClientRuntimeError('invalid_revision_response');
  } else if (etag !== formatStrongEtag(revision)) {
    throw new ClientRuntimeError('invalid_revision_response');
  }
  return revision;
}

export class RevisionedEntityClient {
  readonly #api: ApiClientLike;
  readonly #urls: ClientUrlResolver;

  constructor(options: { apiClient: ApiClientLike; urlResolver: ClientUrlResolver }) {
    this.#api = options.apiClient;
    this.#urls = options.urlResolver;
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<RevisionedEntity<T>> {
    const result = await this.#api.request(this.#urls.api(path), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    const body = await jsonBody(result);
    if (!result.response.ok) this.#throwApiError(result, body);
    const revision = responseRevision(result.response, body, false);
    return { value: body as T, revision, requestId: result.requestId };
  }

  async write<TResponse, TDraft>(
    path: string,
    options: RevisionWriteOptions<TDraft>,
  ): Promise<RevisionedEntity<TResponse>> {
    if (!isEntityRevision(options.expectedRevision, true)) {
      throw new ClientRuntimeError('transport_violation', {
        details: { reason: 'invalid-expected-revision' },
      });
    }
    const result = await this.#api.request(this.#urls.api(path), {
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': formatStrongEtag(options.expectedRevision),
      },
      body: JSON.stringify(options.draft),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const body = await jsonBody(result);
    if (result.response.status === 409) {
      const error = asRecord(body.error);
      const details = asRecord(error?.details);
      const actualRevision = details?.actualRevision;
      const expectedRevision = details?.expectedRevision;
      const resourceId = details?.resourceId;
      if (error?.code !== 'conflict'
        || !isEntityRevision(actualRevision, true)
        || (expectedRevision !== undefined && !isEntityRevision(expectedRevision, true))
        || (resourceId !== undefined && typeof resourceId !== 'string')) {
        throw new ClientRuntimeError('invalid_revision_response', {
          details: { requestId: result.requestId, status: 409 },
        });
      }
      throw new RevisionConflictError({
        expectedRevision: typeof expectedRevision === 'string'
          ? expectedRevision
          : options.expectedRevision,
        actualRevision,
        ...(typeof resourceId === 'string' ? { resourceId } : {}),
        draft: options.draft,
        requestId: result.requestId,
      });
    }
    if (!result.response.ok) this.#throwApiError(result, body);
    const revision = responseRevision(result.response, body, true);
    return { value: body as TResponse, revision, requestId: result.requestId };
  }

  #throwApiError(result: ApiClientResult, body: Record<string, unknown>): never {
    const error = asRecord(body.error);
    if (result.response.status === 428 || error?.code === 'precondition_required') {
      throw new ClientRuntimeError('precondition_required', {
        details: { requestId: result.requestId, status: result.response.status },
      });
    }
    throw new ClientRuntimeError('api_error', {
      retryable: result.response.status === 429 || result.response.status >= 500,
      details: { requestId: result.requestId, status: result.response.status },
    });
  }
}
