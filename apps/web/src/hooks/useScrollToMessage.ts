import { useCallback } from 'react';
import type { MessageKey } from './useMessageRefs.ts';

/**
 * 楼层滚动定位（v0.6.0）
 * 手动 scrollTo 到目标消息开头（手动计算而非 scrollIntoView，避免滚动到整页 window）。
 */
export function useScrollToMessage(
  getElement: (key: MessageKey) => HTMLElement | undefined,
  scrollContainerRef: React.RefObject<HTMLElement | null>,
) {
  return useCallback(
    (key: MessageKey, behavior: ScrollBehavior = 'smooth') => {
      const el = getElement(key);
      const container = scrollContainerRef.current;
      if (!el || !container) return;

      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const targetScrollTop = container.scrollTop + elRect.top - containerRect.top - 12;

      container.scrollTo({ top: targetScrollTop, behavior });
    },
    [getElement, scrollContainerRef],
  );
}
