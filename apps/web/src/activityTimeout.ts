/**
 * A timeout for a slow transport must measure silence, not total transfer time.
 * Each response header/body chunk is activity and starts a fresh idle window.
 */
export class NetworkInactivityTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`network inactive for ${timeoutMs}ms`);
    this.name = 'NetworkInactivityTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function combineSignals(local: AbortSignal, external?: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([external, local]) : local;
}

function concatenate(chunks: readonly Uint8Array[], total: number): ArrayBuffer {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/**
 * Execute a fetch-like operation and buffer its body with an inactivity watchdog.
 * There is deliberately no absolute transfer deadline: a response that keeps
 * making progress may take as long as the link needs.
 */
export async function fetchWithInactivityTimeout(
  execute: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  if (timeoutMs <= 0) {
    return await execute(externalSignal ?? new AbortController().signal);
  }

  const controller = new AbortController();
  const signal = combineSignals(controller.signal, externalSignal);
  const timeoutError = new NetworkInactivityTimeoutError(timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const waitForActivity = async <T,>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    const response = await waitForActivity(execute(signal));
    if (!response.body) return response;

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = await waitForActivity(reader.read());
      if (chunk.done) break;
      chunks.push(chunk.value);
      total += chunk.value.byteLength;
    }

    const statusHasNoBody = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(statusHasNoBody ? null : concatenate(chunks, total), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (reader) {
      try { await reader.cancel(error); } catch { /* the transport already closed */ }
    }
    throw error;
  } finally {
    if (reader) {
      try { reader.releaseLock(); } catch { /* already released/cancelled */ }
    }
  }
}
