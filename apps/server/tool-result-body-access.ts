/** Host liveness only; Session owns the body ref's session, mode and history epoch. */
import { types } from 'node:util';

export function createToolResultBodyAccess(input: {
  readonly serverAllowed: () => boolean;
  readonly isCurrentSession: () => boolean;
  readonly deletionOpen: () => boolean;
}): () => { readonly readAllowed: boolean; readonly writeAllowed: boolean; readonly deletionOpen: boolean } {
  return () => {
    const deletionOpen = input.deletionOpen() === true;
    const allowed = deletionOpen && input.serverAllowed() === true && input.isCurrentSession() === true;
    return Object.freeze({ readAllowed: allowed, writeAllowed: allowed, deletionOpen });
  };
}

/** No filesystem locations, URLs or caller-selected content mode enter a body read. */
export function parseToolResultBodyRead(input: unknown): Readonly<{ refId: string; maxChars: number }> | null {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('refId') || !keys.includes('maxChars')) return null;
  const fields = Object.getOwnPropertyDescriptors(input);
  const refId = fields.refId;
  const maxChars = fields.maxChars;
  if (!refId || !maxChars || !('value' in refId) || !('value' in maxChars)
    || typeof refId.value !== 'string' || !/^tool-result-body:[a-f0-9]{64}$/u.test(refId.value)
    || typeof maxChars.value !== 'number' || !Number.isSafeInteger(maxChars.value)
    || maxChars.value < 1 || maxChars.value > 262_144) return null;
  return Object.freeze({ refId: refId.value, maxChars: maxChars.value });
}
