import { authFetch } from './authClient.ts';

export type AgentProviderMode = 'inherit-main' | 'override';

export interface AgentProviderCapabilities {
  readonly listModels: boolean;
  readonly stream: boolean;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly chatCompletions: boolean;
  readonly responses?: boolean;
  readonly messages?: boolean;
}

/** 只包含 Provider SPI 允许公开的描述字段，不含凭据或连接地址。 */
export interface AgentProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly protocolVersion: number;
  readonly capabilities: AgentProviderCapabilities;
  readonly configured: boolean;
}

export interface AgentProviderModelInfo {
  readonly id: string;
  readonly displayName?: string;
}

export interface AgentProviderRouting {
  readonly ok: true;
  readonly mode: AgentProviderMode;
  readonly providerId?: string;
  readonly model?: string;
  readonly effectiveProviderId: string;
  readonly effectiveModel: string;
  readonly available: boolean;
  readonly provider?: AgentProviderDescriptor;
}

export interface AgentProviderDirectory {
  readonly providers: readonly AgentProviderDescriptor[];
  readonly selectedProviderId: string;
  readonly model: string;
}

export type AgentProviderRoutingUpdate =
  | { readonly mode: 'inherit-main' }
  | { readonly mode: 'override'; readonly providerId: string; readonly model: string };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AgentProviderRequestOptions {
  readonly signal?: AbortSignal;
  /** 测试注入点；产品代码始终使用带认证与 CSRF 的 authFetch。 */
  readonly fetchImpl?: FetchLike;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!body.trim()) throw new Error(`${label} 返回空响应（HTTP ${response.status}）`);
  try {
    const parsed = recordOf(JSON.parse(body));
    if (!parsed) throw new Error('响应根节点不是对象');
    return parsed;
  } catch (error) {
    throw new Error(`${label} 返回了无效 JSON（HTTP ${response.status}）：${(error as Error).message}`);
  }
}

function responseError(data: Record<string, unknown>, status: number): string {
  const nested = recordOf(data.error);
  if (nested && typeof nested.message === 'string' && nested.message.trim()) return nested.message;
  if (typeof data.error === 'string' && data.error.trim()) return data.error;
  return `请求失败（HTTP ${status}）`;
}

function requiredString(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺少 ${key}`);
  return value.trim();
}

function optionalBoolean(row: Record<string, unknown>, key: string): boolean | undefined {
  return typeof row[key] === 'boolean' ? row[key] : undefined;
}

function parseCapabilities(value: unknown): AgentProviderCapabilities {
  const row = recordOf(value);
  if (!row) throw new Error('Provider descriptor 缺少 capabilities');
  for (const key of ['listModels', 'stream', 'tools', 'vision', 'chatCompletions'] as const) {
    if (typeof row[key] !== 'boolean') throw new Error(`Provider capability ${key} 非法`);
  }
  return {
    listModels: row.listModels as boolean,
    stream: row.stream as boolean,
    tools: row.tools as boolean,
    vision: row.vision as boolean,
    chatCompletions: row.chatCompletions as boolean,
    ...(optionalBoolean(row, 'responses') === undefined ? {} : { responses: row.responses as boolean }),
    ...(optionalBoolean(row, 'messages') === undefined ? {} : { messages: row.messages as boolean }),
  };
}

export function parseAgentProviderDescriptor(value: unknown): AgentProviderDescriptor {
  const row = recordOf(value);
  if (!row) throw new Error('Provider descriptor 非法');
  if (typeof row.protocolVersion !== 'number' || !Number.isInteger(row.protocolVersion)) {
    throw new Error('Provider descriptor 缺少 protocolVersion');
  }
  if (typeof row.configured !== 'boolean') throw new Error('Provider descriptor 缺少 configured');
  return {
    id: requiredString(row, 'id', 'Provider descriptor'),
    displayName: requiredString(row, 'displayName', 'Provider descriptor'),
    adapterVersion: requiredString(row, 'adapterVersion', 'Provider descriptor'),
    protocolVersion: row.protocolVersion,
    capabilities: parseCapabilities(row.capabilities),
    configured: row.configured,
  };
}

export function parseAgentProviderRouting(value: unknown): AgentProviderRouting {
  const row = recordOf(value);
  if (!row || row.ok !== true) throw new Error('Agent Provider 路由响应不符合协议');
  if (row.mode !== 'inherit-main' && row.mode !== 'override') {
    throw new Error('Agent Provider 路由 mode 非法');
  }
  if (typeof row.available !== 'boolean') throw new Error('Agent Provider 路由缺少 available');
  const providerId = typeof row.providerId === 'string' && row.providerId.trim()
    ? row.providerId.trim() : undefined;
  const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : undefined;
  if (row.mode === 'override' && (!providerId || !model)) {
    throw new Error('独立 Agent 路由缺少 providerId 或 model');
  }
  return {
    ok: true,
    mode: row.mode,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    effectiveProviderId: requiredString(row, 'effectiveProviderId', 'Agent Provider 路由'),
    effectiveModel: requiredString(row, 'effectiveModel', 'Agent Provider 路由'),
    available: row.available,
    ...(row.provider === undefined ? {} : { provider: parseAgentProviderDescriptor(row.provider) }),
  };
}

async function request(
  path: string,
  init: RequestInit | undefined,
  options: AgentProviderRequestOptions,
  label: string,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? authFetch;
  const response = await fetchImpl(path, { ...init, signal: options.signal ?? init?.signal });
  const data = await readJson(response, label);
  if (!response.ok || data.ok === false) throw new Error(responseError(data, response.status));
  return data;
}

export async function fetchAgentProviderRouting(
  options: AgentProviderRequestOptions = {},
): Promise<AgentProviderRouting> {
  const data = await request('/api/agent-provider', { cache: 'no-store' }, options, 'Agent Provider 路由');
  return parseAgentProviderRouting(data);
}

export async function updateAgentProviderRouting(
  input: AgentProviderRoutingUpdate,
  options: AgentProviderRequestOptions = {},
): Promise<AgentProviderRouting> {
  const body = input.mode === 'inherit-main'
    ? { mode: 'inherit-main' as const }
    : {
        mode: 'override' as const,
        providerId: input.providerId.trim(),
        model: input.model.trim(),
      };
  const data = await request('/api/agent-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, options, 'Agent Provider 路由更新');
  return parseAgentProviderRouting(data);
}

export async function fetchAgentProviderDirectory(
  options: AgentProviderRequestOptions = {},
): Promise<AgentProviderDirectory> {
  const data = await request('/api/providers', { cache: 'no-store' }, options, 'Provider 目录');
  if (!Array.isArray(data.providers)) throw new Error('Provider 目录缺少 providers');
  return {
    providers: data.providers.map(parseAgentProviderDescriptor),
    selectedProviderId: typeof data.selectedProviderId === 'string' ? data.selectedProviderId.trim() : '',
    model: typeof data.model === 'string' ? data.model.trim() : '',
  };
}

export async function fetchAgentProviderModels(
  providerId: string,
  options: AgentProviderRequestOptions = {},
): Promise<readonly AgentProviderModelInfo[]> {
  const normalized = providerId.trim();
  if (!normalized) throw new Error('缺少 Provider ID');
  const data = await request(
    `/api/providers/${encodeURIComponent(normalized)}/models`,
    { cache: 'no-store' },
    options,
    'Provider 模型列表',
  );
  if (!Array.isArray(data.models)) throw new Error('Provider 模型列表缺少 models');
  const seen = new Set<string>();
  return data.models.flatMap((value): AgentProviderModelInfo[] => {
    const row = recordOf(value);
    const id = row && typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      ...(typeof row?.displayName === 'string' && row.displayName.trim()
        ? { displayName: row.displayName.trim() }
        : {}),
    }];
  });
}
