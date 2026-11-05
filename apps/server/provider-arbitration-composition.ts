/** @author Codex @date 2026-10-19 @version 1.0
 * P17-01.3 组合根：全进程**唯一**一个仲裁 runtime。
 *
 * 为什么必须有单例：前台优先只有在「所有入口共用一个队列」时才成立。每个模块各自
 * `new ProviderArbitrationRuntime()` 会得到互不相干的队列，后台照样能在前台排队时开跑。
 * 因此真实调用方只允许拿 `arbitrationRuntime()`，构造器仅供测试使用。
 */
import { ProviderArbiter } from './provider-arbiter.ts';
import { ProviderArbitrationRuntime } from './provider-arbitration-runtime.ts';

let singleton: ProviderArbitrationRuntime | null = null;

export function arbitrationRuntime(): ProviderArbitrationRuntime {
  if (!singleton) {
    singleton = new ProviderArbitrationRuntime(new ProviderArbiter());
  }
  return singleton;
}

/** 仅供测试：更换或清空单例，避免用例之间互相污染队列。 */
export function resetArbitrationRuntimeForTests(
  runtime: ProviderArbitrationRuntime | null = null,
): void {
  singleton = runtime;
}
