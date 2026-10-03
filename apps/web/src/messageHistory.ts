/**
 * 聊天历史与乐观消息的前端身份管理（纯逻辑，可由 Node 直测）。
 *
 * React 的 key 使用 local id；服务端 chat_log.id 只作为稳定业务身份。
 * 两者必须分开，否则每轮读回历史都会重挂卡面 iframe。
 */
export interface LocalHistoryMessage {
  id: number;
  serverId?: number;
  round: number;
  role: string;
  content: string;
}

export interface ServerHistoryMessage {
  id: number;
  round: number;
  role: string;
  content: string;
}

export interface ServerHistoryPayload {
  messages: ServerHistoryMessage[];
}

/**
 * Treat the network payload as untrusted at the API boundary. TypeScript's generic cast cannot
 * protect a phone from a truncated/malformed response at runtime, so reject it before render code
 * reaches Array.prototype.map with an undefined value.
 */
export function parseHistoryPayload(value: unknown): ServerHistoryPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('会话历史响应格式无效，请检查网络连接后重试');
  }
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    throw new Error('会话历史响应不完整（缺少 messages），请检查网络连接后重试');
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error(`会话历史第 ${index + 1} 条消息格式无效`);
    }
    const row = message as Record<string, unknown>;
    if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.round)
      || typeof row.role !== 'string' || typeof row.content !== 'string') {
      throw new Error(`会话历史第 ${index + 1} 条消息字段无效`);
    }
  }
  return { messages: messages as ServerHistoryMessage[] };
}

const roundRoleKey = (message: Pick<LocalHistoryMessage, 'round' | 'role'>): string =>
  `${message.round}:${message.role}`;

/** 开场白固定为 round 0，正式对话从当前最大轮次 + 1 开始。 */
export function nextOptimisticRound(
  messages: readonly Pick<LocalHistoryMessage, 'round'>[],
  committedRound: number | null | undefined = 0,
): number {
  let maxRound = Number.isFinite(committedRound) ? Math.max(0, Number(committedRound)) : 0;
  for (const message of messages) {
    if (Number.isFinite(message.round)) maxRound = Math.max(maxRound, message.round);
  }
  return Math.floor(maxRound) + 1;
}

/**
 * 服务端历史读回时保留已挂载消息的 React key。
 * 优先按 serverId 精确复用；乐观消息再按 round+role 一对一队列匹配。
 */
export function mergeMessageHistory(
  previous: readonly LocalHistoryMessage[],
  server: readonly ServerHistoryMessage[],
  allocateLocalId: () => number,
): LocalHistoryMessage[] {
  if (!Array.isArray(server)) {
    throw new TypeError('会话历史必须是消息数组');
  }
  const byServerId = new Map<number, number>();
  const byRoundRole = new Map<string, number[]>();
  for (const message of previous) {
    if (message.serverId !== undefined) byServerId.set(message.serverId, message.id);
    const key = roundRoleKey(message);
    const candidates = byRoundRole.get(key) ?? [];
    candidates.push(message.id);
    byRoundRole.set(key, candidates);
  }

  const usedLocalIds = new Set<number>();
  const takeRoundRoleCandidate = (message: ServerHistoryMessage): number | undefined =>
    (byRoundRole.get(roundRoleKey(message)) ?? []).find((id) => !usedLocalIds.has(id));
  const allocateUnusedId = (): number => {
    let id = allocateLocalId();
    while (usedLocalIds.has(id)) id = allocateLocalId();
    return id;
  };

  return server.map((message) => {
    const exact = byServerId.get(message.id);
    const localId = exact !== undefined && !usedLocalIds.has(exact)
      ? exact
      : (takeRoundRoleCandidate(message) ?? allocateUnusedId());
    usedLocalIds.add(localId);
    return { ...message, id: localId, serverId: message.id };
  });
}
