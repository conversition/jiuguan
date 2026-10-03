import { randomUUID } from 'node:crypto';
import {
  AbortTurnError,
  type ChatCompletionClient,
  type ChatProviderCall,
  type ChatRequest,
  type ChatResponse,
} from './client.ts';
import type { ProviderRegistry } from './provider-registry.ts';
import type { ProviderCallContext } from './provider-types.ts';

export interface RegistryProviderSelection {
  providerId: string;
  model: string;
}

export interface RegistryProviderClientOptions {
  registry: Pick<ProviderRegistry, 'complete' | 'stream' | 'listModels'>
    & Partial<Pick<ProviderRegistry, 'describe'>>;
  /** 每次调用都重新解析，确保 UI 热切换 Provider/模型后无需重建会话。 */
  resolveSelection: () => RegistryProviderSelection;
  /** 测试与宿主追踪注入点；生产默认使用 randomUUID。 */
  createRequestId?: () => string;
}

export class RegistryProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryProviderSelectionError';
  }
}

/**
 * ChatSession 使用的 Registry-backed 窄门面。
 *
 * 此对象不缓存 raw adapter，也不对失效选择做静默回退。Provider 的能力门禁、
 * 结果校验和卸载租约全部由 ProviderRegistry 统一处理。
 */
export class RegistryProviderClient implements ChatCompletionClient {
  private readonly registry: RegistryProviderClientOptions['registry'];
  private readonly resolveSelection: RegistryProviderClientOptions['resolveSelection'];
  private readonly createRequestId: () => string;

  constructor(options: RegistryProviderClientOptions) {
    this.registry = options.registry;
    this.resolveSelection = options.resolveSelection;
    this.createRequestId = options.createRequestId ?? randomUUID;
  }

  async complete(
    request: ChatRequest,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse> {
    if (signal?.aborted) throw new AbortTurnError();
    const selection = this.selection();
    try {
      return await this.registry.complete(
        selection.providerId,
        this.requestWithSelectedModel(request, selection),
        this.callContext(signal, call),
      );
    } catch (error) {
      if (signal?.aborted) throw new AbortTurnError();
      throw error;
    }
  }

  async stream(
    request: ChatRequest,
    onDelta: (delta: string) => void,
    onToolArg?: (
      name: string,
      argsDelta: string,
      delta?: { index: number; id?: string; nameDelta?: string },
    ) => void,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse> {
    if (signal?.aborted) throw new AbortTurnError();
    const selection = this.selection();
    const toolNames = new Map<number, string>();
    try {
      return await this.registry.stream(
        selection.providerId,
        this.requestWithSelectedModel(request, selection),
        {
          onTextDelta: onDelta,
          onToolCallDelta: (delta) => {
            const name = `${toolNames.get(delta.index) ?? ''}${delta.nameDelta ?? ''}`;
            toolNames.set(delta.index, name);
            // 每一个结构化分片都派发，不能因 arguments 暂时为空而丢失 id/name/index。
            onToolArg?.(
              name,
              delta.argumentsDelta ?? '',
              {
                index: delta.index,
                ...(delta.id !== undefined ? { id: delta.id } : {}),
                ...(delta.nameDelta !== undefined ? { nameDelta: delta.nameDelta } : {}),
              },
            );
          },
        },
        this.callContext(signal, call),
      );
    } catch (error) {
      if (signal?.aborted) throw new AbortTurnError();
      throw error;
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (signal?.aborted) throw new AbortTurnError();
    const selection = this.selection();
    try {
      const models = await this.registry.listModels(
        selection.providerId,
        this.callContext(signal),
      );
      return models.map((model) => model.id);
    } catch (error) {
      if (signal?.aborted) throw new AbortTurnError();
      throw error;
    }
  }

  modelName(): string {
    return this.selection().model;
  }

  capabilities(): { readonly stream: boolean; readonly tools: boolean } {
    const selection = this.selection();
    const descriptor = this.registry.describe?.(selection.providerId);
    return {
      stream: descriptor?.configured === true && descriptor.capabilities.stream === true,
      tools: descriptor?.configured === true && descriptor.capabilities.tools === true,
    };
  }

  private selection(): RegistryProviderSelection {
    const selection = this.resolveSelection();
    if (!selection || typeof selection.providerId !== 'string' || selection.providerId.trim() === '') {
      throw new RegistryProviderSelectionError('当前 Provider 选择无效');
    }
    if (typeof selection.model !== 'string' || selection.model.trim() === '') {
      throw new RegistryProviderSelectionError('当前模型选择无效');
    }
    return { providerId: selection.providerId, model: selection.model };
  }

  private requestWithSelectedModel(
    request: ChatRequest,
    selection: RegistryProviderSelection,
  ): ChatRequest {
    return {
      ...request,
      model: request.model ?? selection.model,
    };
  }

  private callContext(signal?: AbortSignal, call?: ChatProviderCall): ProviderCallContext {
    return {
      requestId: this.createRequestId(),
      ...(call?.runId !== undefined ? { runId: call.runId } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(call?.maxTransportAttempts !== undefined
        ? { maxTransportAttempts: call.maxTransportAttempts }
        : {}),
    };
  }
}

export function createRegistryProviderClient(
  options: RegistryProviderClientOptions,
): RegistryProviderClient {
  return new RegistryProviderClient(options);
}
