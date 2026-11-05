/** @author Codex @date 2026-10-19 @version 1.0
 * P17-01.1：全局 Provider / Model 仲裁合同 + **真实模型入口清单**。
 *
 * 这一层先解决「谁在打模型」这个事实问题，再谈仲裁。清单不是文档：每条都由
 * `verify-provider-arbitration` 扫源码复核——文件必须存在、必须仍持有 Provider 客户端，
 * 且任何**没登记**的文件一旦出现 Provider 调用就直接判红（防绕过）。
 *
 * 追踪键保留 `providerId + modelId + profileRef + class`，供审计区分调用用途。
 * 资源池键独立计算：默认同一 Provider/Model 共享容量，宿主可通过资源组共享配额；
 * profile 与优先级不切分容量，否则后台任务与前台任务将无法相互让出资源。
 */
import { createHash } from 'node:crypto';

export const PROVIDER_ARBITRATION_VERSION = 'provider-arbitration-v1' as const;
export const PROVIDER_ARBITRATION_RESOURCE_VERSION = 'provider-arbitration-resource-v1' as const;

export const PROVIDER_ARBITRATION_CLASSES = Object.freeze(['foreground', 'background'] as const);
export type ProviderArbitrationClass = typeof PROVIDER_ARBITRATION_CLASSES[number];

export const MODEL_ENTRY_KINDS = Object.freeze([
  'interactive-final',
  'interactive-prelude',
  'context-compiler',
  'context-compiler-shadow',
  'aql-replan',
  'critic-revision',
  'rp-child-analysis',
  'operational-replay',
  'story-index',
  'director-creative',
  'maintenance',
  'style-compile',
  'learning',
  'quality-judge',
  'recovery',
] as const);
export type ModelEntryKind = typeof MODEL_ENTRY_KINDS[number];

/** 入口决定优先级：只有直接服务当前用户回合的入口是前台。 */
const ENTRY_CLASS: Readonly<Record<ModelEntryKind, ProviderArbitrationClass>> = Object.freeze({
  'interactive-final': 'foreground',
  'interactive-prelude': 'foreground',
  'context-compiler': 'foreground',
  'context-compiler-shadow': 'background',
  'aql-replan': 'foreground',
  'critic-revision': 'foreground',
  'rp-child-analysis': 'foreground',
  // 运维合成回放不能与真实用户回合争前台优先级。
  'operational-replay': 'background',
  'story-index': 'background',
  'director-creative': 'background',
  'maintenance': 'background',
  'style-compile': 'background',
  'learning': 'background',
  'quality-judge': 'background',
  // 恢复是在替一个已经失败/中断的回合收尾，用户还在等，因此按前台处理。
  'recovery': 'foreground',
});

export interface ModelEntryInventoryRowV1 {
  readonly entryKind: ModelEntryKind;
  readonly modulePath: string;
  /** 该文件中必须出现的证据串（源码扫描用），防止「文件还在但入口已被搬走」。 */
  readonly evidence: string;
  readonly note: string;
}

/**
 * 真实入口清单。登记范围：apps/ 与 packages/ 下、非测试、非 dist 的文件。
 * `packages/proxy/*` 与 `apps/commandcode-proxy/*` 是传输层本身（不发业务请求），
 * 单列在 `TRANSPORT_MODULES`；`model-usage-client.ts` 仅记账。server.ts 同时承载装配与少量
 * 独立 Gateway，后者必须逐种类登记并由实际回调执行测试验收，不能只靠装配层豁免。
 */
export const MODEL_ENTRY_INVENTORY: readonly ModelEntryInventoryRowV1[] = Object.freeze([
  { entryKind: 'director-creative', modulePath: 'apps/server/director-creative-service.ts',
    evidence: 'client.complete(', note: '独立改编会话，显式后台、原仲裁器与原用量观察，默认关闭' },
  {
    entryKind: 'rp-child-analysis',
    modulePath: 'apps/server/agent-loop-rp-model.ts',
    evidence: 'AdmittedModelGateway',
    note: '显式宿主单次 RP 只读叶子；未自动挂载生产路由',
  },
  {
    entryKind: 'style-compile',
    modulePath: 'apps/server/skill-hub/style-compile-pilot.ts',
    evidence: 'createStyleCompilePilotClient',
    note: '可选受控验收守卫；仅包raw client内层，server Style入口仍是唯一仲裁装配点',
  },
  {
    entryKind: 'interactive-prelude',
    modulePath: 'packages/harness/src/interactive-turn-runner.ts',
    evidence: 'ChatCompletionClient',
    note: 'runInteractivePrelude：Session 实际调用的前置工具编排',
  },
  {
    entryKind: 'interactive-final',
    modulePath: 'packages/session/src/session.ts',
    evidence: 'ChatCompletionClient',
    note: 'ChatSession 的主回复与回合内前台模型调用',
  },
  {
    entryKind: 'context-compiler',
    modulePath: 'apps/server/server.ts',
    evidence: "arbitratedAgentClient(client, provider, 'context-compiler')",
    note: 'compileContext：当前回合上下文恢复，用户仍在等待',
  },
  {
    entryKind: 'context-compiler-shadow',
    modulePath: 'apps/server/server.ts',
    evidence: "arbitratedAgentClient(counted, provider, 'context-compiler-shadow'",
    note: 'Context Compiler 已提交回合的只读后台观察',
  },
  {
    entryKind: 'aql-replan',
    modulePath: 'apps/server/server.ts',
    evidence: "arbitratedAgentClient(client, provider, 'aql-replan',",
    note: 'requestAqlReplan：当前回合 managed AQL 重规划',
  },
  {
    entryKind: 'critic-revision',
    modulePath: 'apps/server/server.ts',
    evidence: "arbitratedAgentClient(client, provider, 'critic-revision')",
    note: 'repairDraft：提交前当前草稿修复',
  },
  {
    entryKind: 'operational-replay',
    modulePath: 'apps/server/operational-replay-bridge.ts',
    evidence: 'this.options.complete(',
    note: '可选运维回放，宿主固定身份后仲裁；原显式授权与费用上限不变',
  },
  {
    entryKind: 'interactive-prelude',
    modulePath: 'packages/session/src/video-prompt-generator.ts',
    evidence: 'ChatCompletionClient',
    note: '视频提示词生成（用户在等结果，按前台）',
  },
  {
    entryKind: 'story-index',
    modulePath: 'packages/session/src/storyboard-orchestrator.ts',
    evidence: 'ChatCompletionClient',
    note: '剧情分支索引/分镜编排（后台）',
  },
  {
    entryKind: 'maintenance',
    modulePath: 'apps/server/maintenance-model-adapter.ts',
    evidence: 'ChatCompletionClient',
    note: '回合后维护（Memory/Worldbook/Summary）',
  },
  {
    entryKind: 'style-compile',
    modulePath: 'apps/server/skill-compile-model.ts',
    evidence: 'ChatCompletionClient',
    note: '作者显式风格编译',
  },
  {
    entryKind: 'quality-judge',
    modulePath: 'apps/server/skill-evaluate-model.ts',
    evidence: 'ChatCompletionClient',
    note: '候选评测',
  },
  {
    entryKind: 'quality-judge',
    modulePath: 'apps/server/skill-quality-model.ts',
    evidence: 'ChatCompletionClient',
    note: '质量裁判（双评委）',
  },
  {
    entryKind: 'quality-judge',
    modulePath: 'apps/server/skill-sample-model.ts',
    evidence: 'ChatCompletionClient',
    note: '样本生成/评分',
  },
  {
    entryKind: 'quality-judge',
    modulePath: 'apps/server/skill-quality-authority.ts',
    evidence: 'ChatCompletionClient',
    note: '质量执行授权与调度',
  },
  {
    entryKind: 'learning',
    modulePath: 'apps/server/admitted-model-gateway.ts',
    evidence: 'ChatCompletionClient',
    note: '准入网关（AdmittedModelGateway 是所有受控调用的共用出口）',
  },
]);

/**
 * 已声明但**尚无真实入口**的种类。它们必须在清单里缺席得清清楚楚，
 * 否则「没登记」和「不存在」会混成一件事。`recovery` 属 P17-01.3/P17-02 的活。
 */
export const UNIMPLEMENTED_ENTRY_KINDS: readonly ModelEntryKind[] = Object.freeze(['recovery']);

/**
 * **已迁移**入口清单：模块 → 它用哪个 entryKind 接仲裁。
 *
 * 每迁一个，必须同时改实际接线并在这里登记。清单门禁只证明模块有对应包装调用；
 * 独立 Gateway 与 Session 的 AST 提取执行测试进一步验证实际回调持有包装后的客户端，
 * 不能仅凭包装器名称出现在文件里就认定生产接线完成。
 */
export const WIRED_ENTRY_MODULES: readonly Readonly<{
  modulePath: string;
  entryKind: ModelEntryKind;
  note: string;
}>[] = Object.freeze([
  { modulePath: 'apps/server/server.ts', entryKind: 'maintenance', note: '维护链路 2 处：admitted maintenance + rolling_summary' },
  { modulePath: 'apps/server/director-creative-service.ts', entryKind: 'director-creative', note: '独立改编宿主固定后台仲裁及派发前复验' },
  { modulePath: 'apps/server/server.ts', entryKind: 'style-compile', note: '风格编译' },
  { modulePath: 'apps/server/server.ts', entryKind: 'quality-judge', note: '作者候选评测与采样的模型上下文' },
  { modulePath: 'apps/server/server.ts', entryKind: 'context-compiler', note: '当前回合 Context Compiler 独立 Gateway' },
  { modulePath: 'apps/server/server.ts', entryKind: 'context-compiler-shadow', note: '已提交回合的 Context Compiler 后台观察' },
  { modulePath: 'apps/server/server.ts', entryKind: 'aql-replan', note: 'managed AQL 独立 Gateway' },
  { modulePath: 'apps/server/server.ts', entryKind: 'critic-revision', note: 'Critic 修稿独立 Gateway' },
  { modulePath: 'apps/server/server.ts', entryKind: 'operational-replay', note: '运维回放固定 selection/context，后台让位真实对话' },
  { modulePath: 'apps/server/server.ts', entryKind: 'learning', note: '偏好抽取（preference_extract）' },
  { modulePath: 'apps/server/server.ts', entryKind: 'interactive-prelude',
    note: 'prelude 网关、legacy resolveRuntime 与用户触发的视频提示词；均固定实际绑定身份' },
  { modulePath: 'apps/server/server.ts', entryKind: 'interactive-final',
    note: '两处 ChatSession 每请求解析客户端与身份，覆盖 Registry 与 SPI-off 直连' },
  { modulePath: 'apps/server/server.ts', entryKind: 'story-index',
    note: '分镜/导演编排两处（/api/storyboard/run 与 director）' },
  { modulePath: 'apps/server/skill-quality-authority.ts', entryKind: 'quality-judge',
    note: '两个独立质量裁判（createClient 统一包装；独立性检查使用 raw client）' },
]);

/** 传输/装配层：允许直接持有 Provider 客户端，但不得承载业务入口。 */
export const TRANSPORT_MODULES: readonly string[] = Object.freeze([
  'packages/proxy/src/client.ts',
  'packages/proxy/src/index.ts',
  'packages/proxy/src/provider-client.ts',
  'packages/proxy/public/client.ts',
  'apps/commandcode-proxy/src/adapter.ts',
  'apps/server/model-usage-client.ts',
  'apps/server/server.ts',
  // 包装/接线层：只做「包一层仲裁」，不新增调用点；它们发起的调用都会经仲裁器。
  'apps/server/agent-arbitrated-client.ts',
  'apps/server/provider-arbitration-client.ts',
]);

export interface ProviderArbitrationKeyV1 {
  readonly version: typeof PROVIDER_ARBITRATION_VERSION;
  readonly providerId: string;
  readonly modelId: string;
  readonly profileRef: string;
  readonly entryKind: ModelEntryKind;
  readonly class: ProviderArbitrationClass;
  readonly keyDigest: string;
}

export interface ProviderArbitrationResourceKeyV1 {
    readonly version: typeof PROVIDER_ARBITRATION_RESOURCE_VERSION;
    readonly resourceGroupRef?: string;
    readonly resourceKeyDigest: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

function token(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new TypeError(`${label} must be a stable token`);
  }
  return value;
}

export function modelEntryClass(entryKind: ModelEntryKind): ProviderArbitrationClass {
  const value = ENTRY_CLASS[entryKind];
  if (!value) throw new TypeError(`unknown model entry kind: ${String(entryKind)}`);
  return value;
}

/**
 * 生成仲裁键。`class` 由 `entryKind` 推导，**不接受调用方传入**：
 * 后台任务自报 foreground 会让队列优先级彻底失效。
 */
export function providerArbitrationKey(input: Readonly<{
  providerId: string;
  modelId: string;
  profileRef: string;
  entryKind: ModelEntryKind;
}>): ProviderArbitrationKeyV1 {
  if (!input || typeof input !== 'object') {
    throw new TypeError('provider arbitration input is required');
  }
  const entryKind = input.entryKind;
  if (!(MODEL_ENTRY_KINDS as readonly string[]).includes(entryKind)) {
    throw new TypeError(`unknown model entry kind: ${String(entryKind)}`);
  }
  const key = {
    version: PROVIDER_ARBITRATION_VERSION,
    providerId: token(input.providerId, 'providerId'),
    modelId: token(input.modelId, 'modelId'),
    profileRef: token(input.profileRef, 'profileRef'),
    entryKind,
    class: modelEntryClass(entryKind),
  } as const;
  return Object.freeze({
    ...key,
    keyDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify(key), 'utf8').digest('hex')}`,
  });
}

/**
 * 宿主策略决定共享资源组，业务请求不能自行选择资源池以绕过已占用的容量。
 * 两种 namespace 分别序列化，避免显式资源组与默认 Provider/Model 标识碰撞。
 */
export function providerArbitrationResourceKey(input: Readonly<{
    providerId: string;
    modelId: string;
    resourceGroupRef?: string;
}>): ProviderArbitrationResourceKeyV1 {
    if (!input || typeof input !== 'object') {
        throw new TypeError('provider arbitration resource input is required');
    }
    const providerId = token(input.providerId, 'providerId');
    const modelId = token(input.modelId, 'modelId');
    const resourceGroupRef = input.resourceGroupRef === undefined
        ? undefined : token(input.resourceGroupRef, 'resourceGroupRef');
    const key = resourceGroupRef === undefined ? {
        version: PROVIDER_ARBITRATION_RESOURCE_VERSION,
        namespace: 'provider-model',
        providerId,
        modelId,
    } : {
        version: PROVIDER_ARBITRATION_RESOURCE_VERSION,
        namespace: 'resource-group',
        resourceGroupRef,
    };
    return Object.freeze({
        version: PROVIDER_ARBITRATION_RESOURCE_VERSION,
        ...(resourceGroupRef === undefined ? {} : { resourceGroupRef }),
        resourceKeyDigest: `sha256:${createHash('sha256')
            .update(JSON.stringify(key), 'utf8').digest('hex')}`,
    });
}

/** 清单自身的指纹：增删入口必须显式改动它，评审时才看得见。 */
export function modelEntryInventoryDigest(): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    version: PROVIDER_ARBITRATION_VERSION,
    inventory: MODEL_ENTRY_INVENTORY,
    transport: TRANSPORT_MODULES,
  }), 'utf8').digest('hex')}`;
}
