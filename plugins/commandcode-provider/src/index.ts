import {
  createCommandCodeNodeTransport,
  createCommandCodeRuntime,
  createCommandCodeRuntimeConfigSnapshot,
  type CommandCodeRuntimeConfigSources,
} from '../../../packages/commandcode-runtime/src/index.ts';
import {
  createCommandCodeProviderAdapter,
  isCommandCodeApiKey,
} from '../../../apps/commandcode-proxy/src/provider.ts';
import type { DshPluginCtx } from '../../../packages/plugin/src/dsh-host.ts';
import { readCommandCodeProviderFileConfig } from './runtime-config.ts';

export const name = 'commandcode-provider';
export const inject = Object.freeze(['credentials', 'providers']);
/**
 * Stable protocol identity used by CommandCode request builders.
 *
 * Never derive this value from ctx.dataDir: the runtime serializes it as
 * workingDir and also derives x-project-slug from it for upstream requests.
 */
export const COMMANDCODE_PROVIDER_LOGICAL_PROJECT_DIR = 'C:\\jiuguan\\workspace';
/**
 * 酒馆最终回合会携带完整角色/世界书/会话上下文，CommandCode 偶尔会在首个
 * 流式分片前思考较久。这里使用 5 分钟“无任何上游分片”预算；只要持续收到
 * 数据就会重新计时，并可由插件私有配置或 CC_STREAM_IDLE_MS 显式覆盖。
 */
export const COMMANDCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Non-streaming summaries/quiet tasks cannot expose progress, so allow the same bounded wait. */
export const COMMANDCODE_PROVIDER_NONSTREAM_IDLE_TIMEOUT_MS = 300_000;

export async function apply(ctx: DshPluginCtx): Promise<void> {
  const initialCredential = await ctx.credentials.resolve('COMMANDCODE_API_KEY');
  const pluginConfig = readCommandCodeProviderFileConfig(ctx.dataDir);
  const fileConfig = Object.freeze({
    streamIdleTimeoutMs: COMMANDCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
    nonStreamIdleTimeoutMs: COMMANDCODE_PROVIDER_NONSTREAM_IDLE_TIMEOUT_MS,
    ...pluginConfig,
  });
  const sources: CommandCodeRuntimeConfigSources = Object.freeze({
    fileConfig,
    env: process.env,
    hostOverrides: Object.freeze({
      // An explicitly written plugin setting beats ambient environment, while
      // the built-in default remains below an explicit CC_* environment value.
      ...pluginConfig,
      deviceProjectDir: COMMANDCODE_PROVIDER_LOGICAL_PROJECT_DIR,
    }),
  });
  const runtimeConfig = createCommandCodeRuntimeConfigSnapshot(sources);
  const runtime = createCommandCodeRuntime({
    readConfigSources: () => sources,
    transport: createCommandCodeNodeTransport(),
  });
  const resolveApiKey = async (): Promise<string | null> => {
    const credential = await ctx.credentials.resolve('COMMANDCODE_API_KEY');
    return credential?.value ?? null;
  };
  const adapter = createCommandCodeProviderAdapter({
    runtime,
    runtimeConfig,
    resolveApiKey,
    configured: isCommandCodeApiKey(initialCredential?.value),
  });

  // Covers apply/publication failures as well as normal unload. Registry disposal
  // is intentionally allowed to call this again; adapter.dispose is idempotent.
  ctx.effect(() => async () => { await adapter.dispose?.(); });
  ctx.providers.register(adapter);
}
