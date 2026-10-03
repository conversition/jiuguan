import type { HarnessModel } from '../../packages/harness/src/types.ts';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../packages/proxy/src/client.ts';

export type MaintenanceCostEstimator = (input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}) => number;

export function maintenanceHarnessRequest(
  model: string,
  input: Parameters<HarnessModel['complete']>[0],
  tools?: ChatRequest['tools'],
): ChatRequest {
  return {
    model,
    messages: [
      { role: 'system', content: input.system },
      ...input.messages.map((message) => message.role === 'tool'
        // Harness 使用文本 JSON 协议而非 Provider 原生 tool_calls。伪造 role=tool 会被
        // OpenAI/Anthropic 兼容层拒绝；作为 user 数据回灌同时保持最低指令优先级。
        ? { role: 'user' as const, content: message.content }
        : { role: message.role, content: message.content }),
    ],
    ...(tools ? { tools, tool_choice: 'auto' as const } : {}),
    temperature: 0,
    max_tokens: input.maxOutputTokens,
    stream: false,
  };
}

/** Convert one native Provider tool call back into the Harness text protocol. */
export function maintenanceHarnessContent(response: ChatResponse): string {
  if (response.toolCalls.length > 1) throw new Error('maintenance-provider-tool-calls-ambiguous');
  const toolCall = response.toolCalls[0];
  if (toolCall) {
    let args: unknown;
    try { args = JSON.parse(toolCall.arguments); }
    catch { throw new Error('maintenance-provider-tool-arguments-invalid'); }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('maintenance-provider-tool-arguments-invalid');
    }
    return JSON.stringify({ tool: { name: toolCall.name, args } });
  }
  if (!response.content) throw new Error('maintenance-provider-content-unavailable');
  return response.content;
}

/**
 * 生产 Provider 的窄适配器。usage 或价格未知时 fail-closed，防止绕过 token/费用硬预算。
 */
export function createMaintenanceHarnessModel(
  client: ChatCompletionClient,
  fallbackModel: string,
  estimateCostMicrousd: MaintenanceCostEstimator,
  runId: string,
  sessionId?: string,
  parentRunId?: string,
): HarnessModel {
  const model = client.modelName?.() || fallbackModel;
  if (!model) throw new Error('maintenance-model-unavailable');
  return {
    name: model,
    async complete(input) {
      const response = await client.complete(maintenanceHarnessRequest(model, input), input.signal, {
        runId,
        ...(parentRunId ? { parentRunId } : {}),
        ...(sessionId ? { sessionId } : {}),
        lane: 'maintenance',
      });
      if (!response.usage || !Number.isSafeInteger(response.usage.prompt_tokens)
        || !Number.isSafeInteger(response.usage.completion_tokens)) {
        throw new Error('maintenance-provider-usage-unavailable');
      }
      const costMicrousd = estimateCostMicrousd({
        model,
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      });
      if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0) {
        throw new Error('maintenance-provider-cost-unavailable');
      }
      return {
        content: maintenanceHarnessContent(response),
        usage: {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          costMicrousd,
        },
      };
    },
  };
}
