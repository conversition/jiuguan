import {
  AGENT_LANE_RECOVERY_ACK,
  isPublicAgentControlReadModel,
  type AgentSubcapabilityId,
  type PublicAgentRolloutLane,
  type PublicAgentControlReadModel,
  type StyleProposalControlMutation,
  type WorldbookRepairControlMutation,
} from '../../../packages/mobile-contracts/src/agent-control.ts';
import { authFetch } from './authClient.ts';
import { fetchWithInactivityTimeout } from './activityTimeout.ts';

const AGENT_CONTROL_IDLE_TIMEOUT_MS = 12_000;
const PREFERENCE_CLEAR_STORAGE_PREFIX = 'jiuguan:agent-control:clear-preference-profile:v1:';
const PREFERENCE_CLEAR_OPERATION_ID_RE = /^pclear:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type PreferenceClearStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface PendingPreferenceClearOperation {
  readonly operationId: string;
  readonly expectedRevision: string;
}

const volatilePreferenceClearOperations = new Map<string, PendingPreferenceClearOperation>();

export class AgentControlMutationError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'AgentControlMutationError';
    this.status = status;
    this.code = code;
  }
}

export type AgentLaneControlMutation =
  | { readonly operation: 'kill'; readonly lane: PublicAgentRolloutLane; readonly expectedRevision: string; readonly reasonCode: string }
  | { readonly operation: 'clear-kill'; readonly lane: PublicAgentRolloutLane; readonly expectedRevision: string }
  | {
      readonly operation: 'recover';
      readonly lane: PublicAgentRolloutLane;
      readonly expectedRevision: string;
      readonly evidenceDigest: string;
      readonly maxProviderCalls: number;
      readonly acknowledgement: typeof AGENT_LANE_RECOVERY_ACK;
    }
  | { readonly operation: 'downgrade'; readonly lane: PublicAgentRolloutLane; readonly expectedRevision: string; readonly desiredState: 'off' | 'shadow' }
  | { readonly operation: 'kill-capability'; readonly capabilityId: AgentSubcapabilityId; readonly expectedRevision: string; readonly reasonCode: string }
  | { readonly operation: 'clear-capability-kill'; readonly capabilityId: AgentSubcapabilityId; readonly expectedRevision: string }
  | StyleProposalControlMutation
  | {
      readonly operation: 'clear-preference-profile';
      readonly sessionId: string;
      readonly expectedRevision: string;
      readonly operationId: string;
    }
  | { readonly operation: 'approve-maintenance-proposal' | 'rollback-maintenance-proposal'; readonly proposalId: string; readonly expectedRevision: number }
  | { readonly operation: 'reject-maintenance-proposal'; readonly proposalId: string; readonly expectedRevision: number; readonly reasonCode: string }
  | WorldbookRepairControlMutation;

export function parseAgentControlResponse(value: unknown): PublicAgentControlReadModel {
  if (!isPublicAgentControlReadModel(value)) throw new Error('Agent 状态响应不符合当前协议');
  return value;
}

function preferenceClearStorageKey(sessionId: string): string {
  return `${PREFERENCE_CLEAR_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

function resolvePreferenceClearStorage(storage?: PreferenceClearStorage | null): PreferenceClearStorage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function createUuidV4(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getOrCreatePreferenceClearOperationId(
  sessionId: string,
  expectedRevision: string,
  options: {
    storage?: PreferenceClearStorage | null;
    operationIdFactory?: () => string;
  } = {},
): string {
  const key = preferenceClearStorageKey(sessionId);
  const storage = resolvePreferenceClearStorage(options.storage);
  let stored: PendingPreferenceClearOperation | null = null;
  try {
    const serialized = storage?.getItem(key);
    if (serialized) {
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      if (typeof parsed.operationId === 'string' && typeof parsed.expectedRevision === 'string') {
        stored = { operationId: parsed.operationId, expectedRevision: parsed.expectedRevision };
      }
    }
  } catch { /* fall back to volatile storage */ }
  const current = stored ?? volatilePreferenceClearOperations.get(key) ?? null;
  if (current?.expectedRevision === expectedRevision
    && PREFERENCE_CLEAR_OPERATION_ID_RE.test(current.operationId)) {
    volatilePreferenceClearOperations.set(key, current);
    return current.operationId;
  }
  const operationId = `pclear:${options.operationIdFactory?.() ?? createUuidV4()}`;
  if (!PREFERENCE_CLEAR_OPERATION_ID_RE.test(operationId)) {
    throw new Error('偏好清空 operationId 必须是 pclear:<UUID v4>');
  }
  const pending = { operationId, expectedRevision };
  volatilePreferenceClearOperations.set(key, pending);
  try { storage?.setItem(key, JSON.stringify(pending)); } catch { /* volatile map keeps this tab retry-safe */ }
  return operationId;
}

export function clearPreferenceClearOperationId(
  sessionId: string,
  operationId: string,
  options: { storage?: PreferenceClearStorage | null } = {},
): void {
  const key = preferenceClearStorageKey(sessionId);
  const storage = resolvePreferenceClearStorage(options.storage);
  try {
    const serialized = storage?.getItem(key);
    if (serialized) {
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      if (parsed.operationId === operationId) storage?.removeItem(key);
    }
  } catch { /* volatile cleanup still applies */ }
  if (volatilePreferenceClearOperations.get(key)?.operationId === operationId) {
    volatilePreferenceClearOperations.delete(key);
  }
}

export async function fetchSessionAgentControl(
  sessionId: string,
  options: { fetchImpl?: typeof authFetch; signal?: AbortSignal } = {},
): Promise<PublicAgentControlReadModel> {
  if (!sessionId || /[\u0000-\u001f]/u.test(sessionId)) throw new Error('会话 ID 非法');
  const execute = options.fetchImpl ?? authFetch;
  const response = await fetchWithInactivityTimeout(
    (signal) => execute(`/api/session/${encodeURIComponent(sessionId)}/agent-control`, {
      method: 'GET', signal,
    }),
    AGENT_CONTROL_IDLE_TIMEOUT_MS,
    options.signal,
  );
  if (!response.ok) throw new Error(`Agent 状态读取失败（HTTP ${response.status}）`);
  return parseAgentControlResponse(await response.json());
}

export async function mutateAgentLaneControl(
  mutation: AgentLaneControlMutation,
  options: { fetchImpl?: typeof authFetch; signal?: AbortSignal } = {},
): Promise<void> {
  const execute = options.fetchImpl ?? authFetch;
  const response = await fetchWithInactivityTimeout(
    (signal) => execute('/api/agent-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mutation),
      signal,
    }),
    AGENT_CONTROL_IDLE_TIMEOUT_MS,
    options.signal,
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const errorCode = typeof payload?.code === 'string' ? payload.code : undefined;
    const code = errorCode ? `：${errorCode}` : '';
    throw new AgentControlMutationError(
      response.status,
      `Agent 控制失败（HTTP ${response.status}${code}）`,
      errorCode,
    );
  }
}

export async function clearPreferenceProfileControl(
  input: { readonly sessionId: string; readonly expectedRevision: string },
  options: {
    fetchImpl?: typeof authFetch;
    signal?: AbortSignal;
    storage?: PreferenceClearStorage | null;
    operationIdFactory?: () => string;
  } = {},
): Promise<void> {
  const operationId = getOrCreatePreferenceClearOperationId(
    input.sessionId,
    input.expectedRevision,
    options,
  );
  try {
    await mutateAgentLaneControl({
      operation: 'clear-preference-profile',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      operationId,
    }, options);
    clearPreferenceClearOperationId(input.sessionId, operationId, options);
  } catch (reason) {
    if (reason instanceof AgentControlMutationError && reason.status === 409) {
      clearPreferenceClearOperationId(input.sessionId, operationId, options);
    }
    throw reason;
  }
}
