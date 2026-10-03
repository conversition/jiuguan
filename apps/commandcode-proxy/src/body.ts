import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_DRAIN_BYTES = 32 * 1_024 * 1_024;

export type CommandCodeBodyErrorCode =
  | 'COMMANDCODE_BODY_TOO_LARGE'
  | 'COMMANDCODE_BODY_INVALID_JSON'
  | 'COMMANDCODE_BODY_ABORTED';

export class CommandCodeBodyError extends Error {
  constructor(readonly code: CommandCodeBodyErrorCode) {
    super(code);
    this.name = 'CommandCodeBodyError';
  }
}

function declaredLength(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  if (Array.isArray(raw) || !/^\d+$/.test(raw)) {
    throw new CommandCodeBodyError('COMMANDCODE_BODY_INVALID_JSON');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new CommandCodeBodyError('COMMANDCODE_BODY_INVALID_JSON');
  }
  return parsed;
}

export function drainRejectedRequest(req: IncomingMessage): void {
  let drained = 0;
  req.on('data', (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > MAX_DRAIN_BYTES) req.destroy();
  });
  req.resume();
}

/** Read one JSON body without splitting UTF-8 code points across chunks. */
export function readBoundedJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return Promise.reject(new TypeError('maxBytes must be a positive integer'));
  }
  let length: number | null;
  try { length = declaredLength(req); } catch (error) { return Promise.reject(error); }
  if (length !== null && length > maxBytes) {
    drainRejectedRequest(req);
    return Promise.reject(new CommandCodeBodyError('COMMANDCODE_BODY_TOO_LARGE'));
  }

  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let drained = 0;
    const fail = (error: CommandCodeBodyError): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    req.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (settled) {
        drained += chunk.length;
        if (drained > MAX_DRAIN_BYTES) req.destroy();
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        fail(new CommandCodeBodyError('COMMANDCODE_BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.once('aborted', () => fail(
      new CommandCodeBodyError('COMMANDCODE_BODY_ABORTED'),
    ));
    req.once('error', () => fail(
      new CommandCodeBodyError('COMMANDCODE_BODY_ABORTED'),
    ));
    req.once('end', () => {
      if (settled) return;
      settled = true;
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch {
        reject(new CommandCodeBodyError('COMMANDCODE_BODY_INVALID_JSON'));
        return;
      }
      resolve(parsed);
    });
  });
}

/** Respect Node response backpressure and wake on disconnect/error. */
export function waitForResponseDrain(res: ServerResponse): Promise<void> {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error('client closed')); };
    const onError = (): void => { cleanup(); reject(new Error('client failed')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}
