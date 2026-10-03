import type { ChatRequest, ChatResponse } from './client.ts';

/** 酒馆内部 Provider SPI 版本。与移动端 HTTP API 版本分别演进。 */
export const PROVIDER_PROTOCOL_VERSION = 1 as const;

/** 可公开给客户端的能力；不得在此结构中增加密钥、Base URL 或 Cookie。 */
export interface ProviderCapabilities {
  listModels: boolean;
  stream: boolean;
  tools: boolean;
  vision: boolean;
  chatCompletions: boolean;
  responses?: boolean;
  messages?: boolean;
}

/** Provider 的公开描述。 */
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  adapterVersion: string;
  protocolVersion: typeof PROVIDER_PROTOCOL_VERSION;
  capabilities: ProviderCapabilities;
  configured: boolean;
}

export interface ProviderModelInfo {
  id: string;
  displayName?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

/** 单次调用上下文。requestId 标识一次传输尝试，runId 标识一次逻辑生成。 */
export interface ProviderCallContext {
  requestId: string;
  runId?: string;
  signal?: AbortSignal;
  /** 宿主签发的传输尝试硬上限；Provider 适配器不得提高或忽略。 */
  maxTransportAttempts?: number;
}

/** 直接复用现有 OpenAI-compatible 请求/结果，不建立第二套完成协议。 */
export type ProviderCompletionRequest = ChatRequest;
export type ProviderCompletionResult = ChatResponse;

export interface ProviderStreamSink {
  /** 已归一化的可见文本增量。 */
  onTextDelta(delta: string): void;
  /**
   * 工具调用的结构化增量。index 在一次生成内稳定；id/name 可以分片到达，
   * argumentsDelta 保留上游的增量 JSON 文本，宿主不得提前拼装或执行。
   */
  onToolCallDelta(delta: {
    index: number;
    id?: string;
    nameDelta?: string;
    argumentsDelta?: string;
  }): void;
}

export interface ProviderHealth {
  ok: boolean;
  code?: string;
  /** 只能放脱敏、适合展示给管理员的诊断信息。 */
  detail?: string;
}

/**
 * 酒馆内部 Provider 适配器。
 *
 * adapter 只接收已经归一化的请求，不接触 HTTP req/res；上游凭据由实现自行
 * 从电脑端凭据层解析，绝不能放入 descriptor。
 */
export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  listModels?(ctx: ProviderCallContext): Promise<ProviderModelInfo[]>;
  complete(req: ProviderCompletionRequest, ctx: ProviderCallContext): Promise<ProviderCompletionResult>;
  stream?(
    req: ProviderCompletionRequest,
    sink: ProviderStreamSink,
    ctx: ProviderCallContext,
  ): Promise<ProviderCompletionResult>;
  health?(ctx: ProviderCallContext): Promise<ProviderHealth>;
  dispose?(): void | Promise<void>;
}
