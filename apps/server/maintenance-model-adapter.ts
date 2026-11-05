import type { HarnessMessage, HarnessModel } from '../../packages/harness/src/types.ts';
import { TOOL_RESULT_CONTRACT_VERSION } from '../../packages/harness/public/tool-result-contract.ts';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../packages/proxy/src/client.ts';

/** Versioned identity beside the bounded rejection-repair instruction family. */
export { MAINTENANCE_REPAIR_INSTRUCTION_VERSION } from './maintenance-model-contract.ts';

export type MaintenanceCostEstimator = (input: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}) => number;

const REJECTION_ENVELOPE = /^UNTRUSTED_TOOL_RESULT\n([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const ARC_SCHEMA_REJECTIONS = new Set([
  'schema-rejected',
  'proposal-shape-invalid',
  'proposal-binding-mismatch',
  'proposal-field-invalid',
  'proposal-duplicate-target',
  'source-ref-not-allowed',
  'source-ref-duplicate',
]);

/**
 * A rejected proposal gets one bounded correction turn. Keep the repair hint
 * value-free and selected only from local stable codes: tool output is still
 * untrusted data and must never be interpolated into the system prompt.
 */
function maintenanceRepairHint(tool: string, content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const code = REJECTION_ENVELOPE.exec(content)?.[1];
  if (tool === 'propose_memory_consolidation' && code === 'memory-context-mismatch') {
    return '本次拒绝是记忆提案顶层结构或上下文绑定错误：原生工具的 arguments 必须直接是提案对象，只允许 version、sessionId、sourceRevision、facts 四个字段；禁止再包一层 args、tool、payload 或 proposal，也不要把 name 当作参数字段。version 必须是 memory-consolidation-proposal-v1；sessionId 和 sourceRevision 必须逐字复制当前 proposalContext 的对应值。不要把 proposalContext 整个对象、allowedSourceRefs、maxRound 或解释字段放入参数。只有不调用原生工具而返回纯文本时才使用 JSON tool envelope，不能把该信封放进原生工具参数。保留有证据支持的 facts，按当前工具 schema 重新提交；不得修改证据或编造引用来规避校验。';
  }
  if (tool === 'propose_npc_state' && code === 'evidence-classification-invalid') {
    return '本次拒绝是 NPC 证据分类错误：objective_fact 与 objective relationship 必须同时使用 status=confirmed、confidence=high；belief 与 goal 禁止 confirmed，只能使用 pending、unresolved、last-known 或 unknown；identity_resolution 只能使用 high 或 medium。不得改变证据、人物或引用来规避分类约束。';
  }
  if (tool === 'propose_branch_index' && ARC_SCHEMA_REJECTIONS.has(code ?? '')) {
    return '本次拒绝是剧情弧提案结构或语义错误：args 顶层必须是且只是 version、sessionId、sourceRevision、actions 四个字段；字段名是 actions，绝不能写成 branches、proposal、payload、actionsList，也不要再包一层 args、tool 或 name+args，不要附加 reason、summary、explanation 等字段。version 必须是 arc-maintenance-proposal-v1；sessionId 和 sourceRevision 必须逐字复制当前 proposalContext 的对应值；不要把 proposalContext 整个对象复制进 args。每个 action 只允许其 kind 的固定字段：set_status={kind,arcId,status,sourceRefs}；merge={kind,arcIds,targetArcId,sourceRefs}；chapter_boundary={kind,arcIds,boundaryRound,sourceRefs}；order_dependencies={kind,arcId,dependencyArcIds,sourceRefs}；mark_source_conflict={kind,arcIds,sourceRefs}，多一个或少一个字段都会被整份拒绝。只使用当前 schema 允许的 arcId 与 sourceRefs；set_status 的 status 只能是 open、closed 或 dormant，并且必须不同于 arcProjection 给出的当前状态；不得返回 final 或借用人物/记忆状态。只有不调用原生工具而返回纯文本时才使用 {"tool":{"name":"propose_branch_index","args":<提案对象>}} 信封，不能把该信封放进原生工具参数。保留有证据支持的动作，按当前工具 schema 重新提交；不得修改证据或编造引用来规避校验。';
  }
  return null;
}

/** Fixed framing only: a tiny payload cap can leave no room for the in-payload partial marker. */
function toolResultContent(message: HarnessMessage): string {
  const metadata = message.toolResultMetadata;
  return metadata?.version === TOOL_RESULT_CONTRACT_VERSION && metadata.state === 'partial'
    && metadata.reason === 'result-limit-too-small-for-marker'
    ? `[PARTIAL_TOOL_RESULT payload=unavailable parseability=not-complete-json]\n${message.content}`
    : message.content;
}

export function maintenanceHarnessRequest(
  model: string,
  input: Parameters<HarnessModel['complete']>[0],
  tools?: ChatRequest['tools'],
): ChatRequest {
  const last = input.messages.at(-1);
  const registeredToolNames = new Set((tools ?? []).flatMap((tool) => {
    const fn = tool.function as { name?: unknown } | undefined;
    return typeof fn?.name === 'string' ? [fn.name] : [];
  }));
  const repairTool = last?.role === 'tool'
    && typeof last.toolCallId === 'string'
    && /^(?:propose_[a-z0-9_]+|complete_npc_state_noop)$/u.test(last.toolCallId)
    && registeredToolNames.has(last.toolCallId)
    ? last.toolCallId
    : null;
  const repairHint = repairTool === null ? null : maintenanceRepairHint(repairTool, last?.content);
  const system = repairTool === null
    ? input.system
    : [
      input.system,
      `协议纠正：上一次 ${repairTool} 参数被拒绝。必须立即重新调用 ${repairTool}，只返回一个 native tool call 或严格 JSON tool envelope，不得返回正文、Markdown、解释或 final。`,
      repairHint,
    ].filter((line): line is string => line !== null).join('\n');
  return {
    model,
    messages: [
      { role: 'system', content: system },
      ...input.messages.map((message) => message.role === 'tool'
        // Harness 使用文本 JSON 协议而非 Provider 原生 tool_calls。伪造 role=tool 会被
        // OpenAI/Anthropic 兼容层拒绝；作为 user 数据回灌同时保持最低指令优先级。
        ? { role: 'user' as const, content: toolResultContent(message) }
        : { role: message.role, content: message.content }),
    ],
    // CommandCode/Gemini compatibility requires auto: some deployments return
    // a usage-only empty completion for named/required choices. The fixed
    // repair directive above keeps a rejected proposal in the tool protocol.
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
    // Some native callers echo the text fallback's `args` envelope. Decode
    // exactly one unambiguous wrapper; do not repair identifiers, drop sibling
    // fields or change text-protocol payloads. The ordinary fixed-snapshot
    // validator still authorizes every field before a proposal can be stored.
    if (toolCall.name === 'propose_memory_consolidation'
      && Object.keys(args).length === 1 && Object.hasOwn(args, 'args')) {
      const inner = (args as Record<string, unknown>).args;
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) args = inner;
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
