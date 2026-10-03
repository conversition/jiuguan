export const GENERATION_STATE_EVENT = 'jg:generation-state';
const GENERATION_STORAGE_PREFIX = 'jg-generation-active-v1:';
const GENERATION_ACTIVITY_TTL_MS = 10 * 60_000;
const GENERATION_ACTIVITY_REFRESH_MS = 15_000;
const GENERATION_TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2);
let lastActivityWriteAt = 0;

/** Refresh the cross-tab/PWA update lease during a long-running turn without high-frequency storage writes. */
export function touchGenerationActivity(storage: Storage = localStorage, now = Date.now()): void {
  if (now - lastActivityWriteAt < GENERATION_ACTIVITY_REFRESH_MS) return;
  try {
    storage.setItem(GENERATION_STORAGE_PREFIX + GENERATION_TAB_ID, String(now));
    lastActivityWriteAt = now;
  } catch { /* current document marker remains authoritative when storage is unavailable */ }
}

function storageHasActiveGeneration(storage: Storage = localStorage, now = Date.now()): boolean {
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (!key?.startsWith(GENERATION_STORAGE_PREFIX)) continue;
      const seenAt = Number(storage.getItem(key));
      if (Number.isFinite(seenAt) && now - seenAt <= GENERATION_ACTIVITY_TTL_MS) return true;
      storage.removeItem(key);
    }
  } catch { /* localStorage 不可用时退回当前 document 标记 */ }
  return false;
}

export function generationIsActive(doc: Document = document): boolean {
  return doc.documentElement.dataset.jgGenerationActive === '1' || storageHasActiveGeneration();
}

export function setGenerationActivity(active: boolean, doc: Document = document, target: Window = window): void {
  doc.documentElement.dataset.jgGenerationActive = active ? '1' : '0';
  try {
    const key = GENERATION_STORAGE_PREFIX + GENERATION_TAB_ID;
    if (active) {
      const now = Date.now();
      localStorage.setItem(key, String(now));
      lastActivityWriteAt = now;
    } else {
      localStorage.removeItem(key);
      lastActivityWriteAt = 0;
    }
  } catch { /* PWA 更新仍可按当前 document 状态门控 */ }
  target.dispatchEvent(new CustomEvent(GENERATION_STATE_EVENT, { detail: { active } }));
}

export function subscribeGenerationActivity(
  listener: (active: boolean) => void,
  target: Window = window,
): () => void {
  const onState = (): void => listener(generationIsActive());
  const onStorage = (event: StorageEvent): void => {
    if (event.key?.startsWith(GENERATION_STORAGE_PREFIX)) onState();
  };
  target.addEventListener(GENERATION_STATE_EVENT, onState);
  target.addEventListener('storage', onStorage);
  return () => {
    target.removeEventListener(GENERATION_STATE_EVENT, onState);
    target.removeEventListener('storage', onStorage);
  };
}
