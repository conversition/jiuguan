export const MAINTENANCE_DRAIN_BATCH_SIZE = 2 as const;

export type MaintenanceDrainPumpOptions = {
  drain: (maxJobs: typeof MAINTENANCE_DRAIN_BATCH_SIZE) => Promise<unknown>;
  onFailure?: (error: unknown) => void;
};

export type MaintenanceDrainPump = {
  /** Records a wake; wakes received during a drain are retained. */
  request(): void;
  /** Resolves after every wake recorded so far has been handled. */
  whenIdle(): Promise<void>;
  /** Stops accepting wakes and waits for the active bounded drain to settle. */
  close(): Promise<void>;
};

export function createMaintenanceDrainPump(
  options: MaintenanceDrainPumpOptions,
): MaintenanceDrainPump {
  let pendingWakes = 0;
  let scheduled = false;
  let running = false;
  let closed = false;
  let idleWaiters: Array<() => void> = [];

  const isIdle = (): boolean => !scheduled && !running && pendingWakes === 0;

  const resolveIdleWaiters = (): void => {
    if (!isIdle() || idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const schedule = (): void => {
    if (closed || scheduled || running || pendingWakes === 0) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void run();
    });
  };

  const run = async (): Promise<void> => {
    if (closed || running) {
      resolveIdleWaiters();
      return;
    }

    running = true;
    try {
      while (!closed && pendingWakes > 0) {
        pendingWakes -= 1;
        try {
          await options.drain(MAINTENANCE_DRAIN_BATCH_SIZE);
        } catch (error) {
          try {
            options.onFailure?.(error);
          } catch {
            // Failure reporting must never wedge the durable queue pump.
          }
        }
      }
    } finally {
      running = false;
      if (!closed && pendingWakes > 0) schedule();
      resolveIdleWaiters();
    }
  };

  const whenIdle = (): Promise<void> => {
    if (isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
    });
  };

  return {
    request(): void {
      if (closed) return;
      if (pendingWakes === Number.MAX_SAFE_INTEGER) {
        throw new Error('maintenance-drain-pump wake counter overflow');
      }
      pendingWakes += 1;
      schedule();
    },
    whenIdle,
    async close(): Promise<void> {
      closed = true;
      pendingWakes = 0;
      scheduled = false;
      resolveIdleWaiters();
      await whenIdle();
    },
  };
}
