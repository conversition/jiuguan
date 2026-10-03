import {
  AbortTurnError,
  OpenAICompatibleClient,
  type ChatProviderCall,
  type ChatRequest,
  type ChatResponse,
  type ChatToolArgumentDelta,
} from './client.ts';
import type { ProviderConfig } from './config.ts';
import {
  PROVIDER_PROTOCOL_VERSION,
  type ProviderAdapter,
  type ProviderDescriptor,
} from './provider-types.ts';

export const OPENAI_PROVIDER_ID = 'builtin.openai' as const;

export interface OpenAIProviderTransport {
  complete(request: ChatRequest, signal?: AbortSignal, call?: ChatProviderCall): Promise<ChatResponse>;
  stream(
    request: ChatRequest,
    onDelta: (delta: string) => void,
    onToolArg?: (name: string, argsDelta: string, delta?: ChatToolArgumentDelta) => void,
    signal?: AbortSignal,
    call?: ChatProviderCall,
  ): Promise<ChatResponse>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export interface OpenAIProviderControllerOptions {
  clientFactory?: (config: ProviderConfig) => OpenAIProviderTransport;
  adapterVersion?: string;
}

export interface OpenAIProviderController {
  readonly adapter: ProviderAdapter;
  /**
   * 原子替换后续调用使用的客户端，并返回应交给 registry.updateDescriptor 的公开描述。
   * 在途调用继续持有旧客户端快照，不会读到半更新配置。
   */
  rebind(config: ProviderConfig): ProviderDescriptor;
}

function cloneConfig(config: ProviderConfig): ProviderConfig {
  return { ...config };
}

function descriptor(config: ProviderConfig, adapterVersion: string): ProviderDescriptor {
  return {
    id: OPENAI_PROVIDER_ID,
    displayName: 'OpenAI Compatible',
    adapterVersion,
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    configured: config.apiKey.trim().length > 0,
    capabilities: {
      listModels: true,
      stream: true,
      tools: true,
      vision: true,
      chatCompletions: true,
    },
  };
}

/**
 * 将历史 OpenAI-compatible 客户端包进 builtin Provider SPI。
 * 配置与凭据只保存在闭包中，adapter.descriptor 永远只返回公开白名单字段。
 */
export function createOpenAIProviderController(
  initialConfig: ProviderConfig,
  options: OpenAIProviderControllerOptions = {},
): OpenAIProviderController {
  const clientFactory = options.clientFactory ?? ((config: ProviderConfig) => (
    new OpenAICompatibleClient(config)
  ));
  const adapterVersion = options.adapterVersion ?? '0.1.0';
  let config = cloneConfig(initialConfig);
  let client = clientFactory(config);

  const adapter: ProviderAdapter = {
    get descriptor() {
      return descriptor(config, adapterVersion);
    },

    async listModels(ctx) {
      const activeClient = client;
      return (await activeClient.listModels(ctx.signal)).map((id) => ({ id }));
    },

    async complete(request, ctx) {
      const activeClient = client;
      return activeClient.complete(request, ctx.signal, ctx.maxTransportAttempts === undefined
        ? undefined
        : { maxTransportAttempts: ctx.maxTransportAttempts });
    },

    async stream(request, sink, ctx) {
      const activeClient = client;
      const toolNames = new Map<number, string>();
      return activeClient.stream(
        request,
        (delta) => sink.onTextDelta(delta),
        (name, argumentsDelta, metadata) => {
          const index = metadata?.index ?? 0;
          const previousName = toolNames.get(index) ?? '';
          let nameDelta = metadata?.nameDelta;
          if (nameDelta === undefined && name !== previousName) {
            nameDelta = name.startsWith(previousName) ? name.slice(previousName.length) : name;
          }
          toolNames.set(index, name || `${previousName}${nameDelta ?? ''}`);
          sink.onToolCallDelta({
            index,
            ...(metadata?.id !== undefined ? { id: metadata.id } : {}),
            ...(nameDelta ? { nameDelta } : {}),
            argumentsDelta,
          });
        },
        ctx.signal,
        ctx.maxTransportAttempts === undefined
          ? undefined
          : { maxTransportAttempts: ctx.maxTransportAttempts },
      );
    },

    async health(ctx) {
      if (!config.apiKey.trim()) {
        return {
          ok: false,
          code: 'not-configured',
          detail: '尚未配置 API key',
        };
      }
      if (ctx.signal?.aborted) throw new AbortTurnError();
      const activeClient = client;
      try {
        await activeClient.listModels(ctx.signal);
        return { ok: true, code: 'ok', detail: '连接正常' };
      } catch (error) {
        if (ctx.signal?.aborted) throw new AbortTurnError();
        // 不回显上游 URL、响应体、凭据或异常文本。
        return {
          ok: false,
          code: 'unreachable',
          detail: 'Provider 连通性检查失败',
        };
      }
    },
  };

  return {
    adapter,
    rebind(nextConfig) {
      const next = cloneConfig(nextConfig);
      const nextClient = clientFactory(next);
      config = next;
      client = nextClient;
      return descriptor(config, adapterVersion);
    },
  };
}
