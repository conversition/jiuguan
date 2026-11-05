/** @author Codex @date 2026-10-20 @version 1.0
 * P17-01.3 接线层：把 agent 侧 client 包进**全局仲裁**，并用真实 provider 身份组键。
 *
 * 为什么单独一层：`AdmittedModelGateway` / `createAdmittedMaintenanceModel` 都拿不到
 * `providerId`（只有 model 与 binding），而仲裁键需要 providerId。唯一同时知道
 * providerId + model 的地方是装配层（`agentModelBinding()` 的 selection）。
 * 所以在这里包，而不是在 adapter 内部猜一个 provider 名。
 *
 * `entryKind` 必须由调用方显式给出：它是「这次调用属于哪条业务线」的事实，
 * 不能从 client 反推，也不能默认成前台。
 */
import type { ChatCompletionClient } from '../../packages/proxy/public/client.ts';
import { arbitrateChatClient } from './provider-arbitration-client.ts';
import type { ModelEntryKind } from './provider-arbitration.ts';
import type { ProviderArbitrationRuntime } from './provider-arbitration-runtime.ts';

export interface AgentSelectionIdentity {
  readonly providerId: string;
  readonly model: string;
}

export function arbitratedAgentClient(
  client: ChatCompletionClient,
  selection: AgentSelectionIdentity,
  entryKind: ModelEntryKind,
  runtime?: ProviderArbitrationRuntime,
  beforeDispatch?: () => void,
): ChatCompletionClient {
  if (!selection.providerId || !selection.model) {
    // 缺身份时 fail closed：用假 providerId 组键会让队列分叉，比直接不启动更糟。
    throw new Error('agent-arbitration-identity-unavailable');
  }
  return arbitrateChatClient(client, {
    entryKind,
    site: {
      providerId: selection.providerId,
      modelId: selection.model,
      profileRef: `agent.${selection.providerId}.${entryKind}`,
    },
    ...(runtime === undefined ? {} : { runtime }),
    ...(beforeDispatch === undefined ? {} : { beforeDispatch }),
  });
}

/**
 * 每次调用取得一组相配的客户端与身份；排队期间也沿用该快照，避免热更新后模型身份漂移。
 * 请求显式选择模型时，资源池必须与客户端收到的实际模型一致。
 */
export function resolvedArbitratedAgentClient(
    resolveBinding: () => Readonly<{ client: ChatCompletionClient; selection: AgentSelectionIdentity }>,
    entryKind: ModelEntryKind,
    runtime?: ProviderArbitrationRuntime,
): ChatCompletionClient {
    const snapshot = () => {
        const binding = resolveBinding();
        const identity = binding.selection;
        const selection = Object.freeze({ providerId: identity.providerId, model: identity.model });
        if (!selection.providerId || !selection.model) {
            throw new Error('agent-arbitration-identity-unavailable');
        }
        return Object.freeze({ client: binding.client, selection });
    };
    const forModel = (requestModel: string | undefined): ChatCompletionClient => {
        const { client, selection } = snapshot();
        return arbitratedAgentClient(client, Object.freeze({
            providerId: selection.providerId,
            model: requestModel ?? selection.model,
        }), entryKind, runtime);
    };
    return {
        complete: (req, signal, call) => forModel(req.model).complete(req, signal, call),
        stream: (req, onDelta, onToolArg, signal, call) => forModel(req.model)
            .stream(req, onDelta, onToolArg, signal, call),
        modelName: () => {
            const { client, selection } = snapshot();
            return client.modelName?.() ?? selection.model;
        },
        listModels: (signal) => {
            const { client } = snapshot();
            return client.listModels?.(signal) ?? Promise.resolve([]);
        },
        capabilities: () => {
            const { client } = snapshot();
            return client.capabilities?.() ?? { stream: false, tools: false };
        },
    };
}

/**
 * 可选 client 版本：`providerClientForServer()` 在 SPI 关闭时返回 undefined，
 * 会话会走自己的内部回退路径。包装器对 undefined 原样放行，避免改变回退语义。
 */
export function arbitrateOptionalAgentClient(
  client: ChatCompletionClient | undefined,
  selection: AgentSelectionIdentity,
  entryKind: ModelEntryKind,
  runtime?: ProviderArbitrationRuntime,
): ChatCompletionClient | undefined {
  if (!client) return undefined;
  return arbitratedAgentClient(client, selection, entryKind, runtime);
}
