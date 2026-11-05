import { AsyncLocalStorage } from 'node:async_hooks';

/** Host-only accounting scope; never placed in adapter context or model payloads. */
const workSettlementScope = new AsyncLocalStorage<Set<Promise<void>>>();

/** Registry-internal: register the real adapter work, not its cancellable caller facade. */
export function registerProviderWorkSettlement(work: Promise<unknown>): void {
  const pending = workSettlementScope.getStore();
  if (!pending) return;
  pending.add(work.then(() => undefined, () => undefined));
}

/**
 * Retain a host physical permit until every Registry adapter invocation in this scope
 * actually settles. Caller cancellation/forced unload may reject the Registry facade
 * sooner; the outer arbitration runtime is responsible for returning that cancellation
 * promptly. Late errors are observed without replacing the original value or error.
 */
export async function withProviderWorkSettlement<T>(invoke: () => Promise<T>): Promise<T> {
  const parent = workSettlementScope.getStore();
  const pending = new Set<Promise<void>>();
  const completion = workSettlementScope.run(pending, async () => {
    try {
      return await invoke();
    } finally {
      // Work can start nested Registry calls before settling. Drain another batch when
      // those calls register while the first batch is being awaited.
      while (pending.size > 0) {
        const batch = [...pending];
        await Promise.all(batch);
        for (const settled of batch) pending.delete(settled);
      }
    }
  });
  // A detached nested host scope must not escape the physical lifetime of its parent.
  if (parent) parent.add(completion.then(() => undefined, () => undefined));
  return await completion;
}
