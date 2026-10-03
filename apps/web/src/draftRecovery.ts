export interface ComposerDraft {
  version: 1;
  text: string;
  updatedAt: number;
  state: 'editing' | 'submitted';
}

export function readComposerDraft(storage: Pick<Storage, 'getItem'>, key: string): ComposerDraft | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ComposerDraft>;
    if (value.version !== 1 || typeof value.text !== 'string' || typeof value.updatedAt !== 'number') return null;
    if (value.state !== 'editing' && value.state !== 'submitted') return null;
    return value as ComposerDraft;
  } catch {
    // P9 之前的草稿若是纯文本，仍可无损恢复并在下次输入时迁移。
    return { version: 1, text: raw, updatedAt: 0, state: 'editing' };
  }
}

export function writeComposerDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  text: string,
  state: ComposerDraft['state'] = 'editing',
  now = Date.now(),
): void {
  if (!text) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ version: 1, text, updatedAt: now, state } satisfies ComposerDraft));
}

export function clearComposerDraft(storage: Pick<Storage, 'removeItem'>, key: string): void {
  storage.removeItem(key);
}
