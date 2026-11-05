import { authFetch } from './authClient.ts';
import { fetchWithInactivityTimeout } from './activityTimeout.ts';

const NSFW_SCENE_SAFETY_IDLE_TIMEOUT_MS = 12_000;

export interface NsfwSceneSafetyState {
  readonly enabled: boolean;
  readonly adultAttestation: 'verified' | 'revoked';
  readonly participantsAdult: boolean;
  readonly consent: 'confirmed' | 'revoked';
  readonly allowedWorldbooks: readonly string[];
  readonly sourceRevision: string;
  readonly updatedAt: string | null;
  readonly revision: number;
  readonly reasonCode:
    | 'active'
    | 'not-configured'
    | 'revoked'
    | 'source-revision-mismatch'
    | 'worldbook-binding-mismatch'
    | 'session-binding-mismatch';
}

export interface NsfwSceneSafetyReadModel {
  readonly safety: NsfwSceneSafetyState;
  readonly manifest: {
    readonly books: readonly string[];
    readonly sourceRevision: string;
  };
  /**
   * Device-level attestation pre-fill, returned only while this session has no stored grant
   * (`reasonCode === 'not-configured'`). Pre-fill only — enabling still needs an explicit POST.
   */
  readonly inheritedAttestation?: {
    readonly adultAttestation: 'verified';
    readonly participantsAdult: true;
    readonly consent: 'confirmed';
    readonly books: readonly string[];
    readonly confirmedAt: string;
  };
}

export interface NsfwSceneSafetyMutation {
  readonly adultAttestation: 'verified' | 'revoked';
  readonly participantsAdult: boolean;
  readonly consent: 'confirmed' | 'revoked';
  readonly allowedWorldbooks: readonly string[];
  readonly expectedRevision?: number;
}

export class NsfwSceneSafetyError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'NsfwSceneSafetyError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const SAFETY_REASON_CODES = new Set([
  'active', 'not-configured', 'revoked', 'source-revision-mismatch',
  'worldbook-binding-mismatch', 'session-binding-mismatch',
]);

export function parseNsfwSceneSafetyReadModel(value: unknown): NsfwSceneSafetyReadModel {
  if (!isRecord(value) || !isRecord(value.safety) || !isRecord(value.manifest)) {
    throw new Error('场景策展状态响应不符合当前协议');
  }
  const safety = value.safety;
  const manifest = value.manifest;
  if (typeof safety.enabled !== 'boolean'
    || (safety.adultAttestation !== 'verified' && safety.adultAttestation !== 'revoked')
    || typeof safety.participantsAdult !== 'boolean'
    || (safety.consent !== 'confirmed' && safety.consent !== 'revoked')
    || !isStringArray(safety.allowedWorldbooks)
    || typeof safety.sourceRevision !== 'string'
    || (safety.updatedAt !== null && typeof safety.updatedAt !== 'string')
    || !Number.isSafeInteger(safety.revision) || Number(safety.revision) < 0
    || typeof safety.reasonCode !== 'string' || !SAFETY_REASON_CODES.has(safety.reasonCode)
    || !isStringArray(manifest.books)
    || typeof manifest.sourceRevision !== 'string') {
    throw new Error('场景策展状态响应不符合当前协议');
  }
  const inherited = isRecord(value.inheritedAttestation)
    && value.inheritedAttestation.adultAttestation === 'verified'
    && value.inheritedAttestation.participantsAdult === true
    && value.inheritedAttestation.consent === 'confirmed'
    && isStringArray(value.inheritedAttestation.books)
    && typeof value.inheritedAttestation.confirmedAt === 'string'
    ? {
        adultAttestation: 'verified' as const,
        participantsAdult: true as const,
        consent: 'confirmed' as const,
        books: Object.freeze([...value.inheritedAttestation.books]),
        confirmedAt: value.inheritedAttestation.confirmedAt,
      }
    : undefined;
  return {
    safety: value.safety as unknown as NsfwSceneSafetyState,
    manifest: value.manifest as unknown as NsfwSceneSafetyReadModel['manifest'],
    ...(inherited ? { inheritedAttestation: inherited } : {}),
  };
}

function validateSessionId(sessionId: string): void {
  if (!sessionId || /[\u0000-\u001f]/u.test(sessionId)) throw new Error('会话 ID 非法');
}

async function readError(response: Response): Promise<{ code?: string; message?: string }> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const nested = isRecord(payload?.error) ? payload.error : null;
  const details = isRecord(payload?.details) ? payload.details : null;
  return {
    code: typeof payload?.code === 'string'
      ? payload.code
      : typeof details?.reasonCode === 'string' ? details.reasonCode
      : typeof nested?.code === 'string' ? nested.code : undefined,
    message: typeof payload?.message === 'string'
      ? payload.message
      : typeof payload?.error === 'string'
        ? payload.error
        : typeof nested?.message === 'string' ? nested.message : undefined,
  };
}

async function readModel(response: Response): Promise<NsfwSceneSafetyReadModel> {
  try {
    return parseNsfwSceneSafetyReadModel(await response.json());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('场景策展服务返回不完整，请稍后重试');
    throw error;
  }
}

export async function fetchNsfwSceneSafety(
  sessionId: string,
  options: { fetchImpl?: typeof authFetch; signal?: AbortSignal } = {},
): Promise<NsfwSceneSafetyReadModel> {
  validateSessionId(sessionId);
  const execute = options.fetchImpl ?? authFetch;
  const response = await fetchWithInactivityTimeout(
    (signal) => execute(`/api/session/${encodeURIComponent(sessionId)}/nsfw-scene-safety`, {
      method: 'GET', signal,
    }),
    NSFW_SCENE_SAFETY_IDLE_TIMEOUT_MS,
    options.signal,
  );
  if (!response.ok) {
    const error = await readError(response);
    throw new NsfwSceneSafetyError(
      response.status,
      error.message ?? `场景策展状态读取失败（HTTP ${response.status}${error.code ? `：${error.code}` : ''}）`,
      error.code,
    );
  }
  return readModel(response);
}

export async function updateNsfwSceneSafety(
  sessionId: string,
  mutation: NsfwSceneSafetyMutation,
  options: { fetchImpl?: typeof authFetch; signal?: AbortSignal } = {},
): Promise<NsfwSceneSafetyReadModel> {
  validateSessionId(sessionId);
  if (mutation.allowedWorldbooks.some((book) => !book || /[\u0000-\u001f]/u.test(book))) {
    throw new Error('允许检索的世界书引用非法');
  }
  const execute = options.fetchImpl ?? authFetch;
  const response = await fetchWithInactivityTimeout(
    (signal) => execute(`/api/session/${encodeURIComponent(sessionId)}/nsfw-scene-safety`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mutation),
      signal,
    }),
    NSFW_SCENE_SAFETY_IDLE_TIMEOUT_MS,
    options.signal,
  );
  if (!response.ok) {
    const error = await readError(response);
    throw new NsfwSceneSafetyError(
      response.status,
      error.message ?? `场景策展控制失败（HTTP ${response.status}${error.code ? `：${error.code}` : ''}）`,
      error.code,
    );
  }
  return readModel(response);
}
