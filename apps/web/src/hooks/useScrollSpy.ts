import { useEffect, useState } from 'react';
import type { MessageKey } from './useMessageRefs.ts';

export interface AnchorableMessage {
  round: number;
  role: string;
}

/**
 * 当前楼层检测（v0.6.0）：监听滚动视口，遍历消息 DOM 找视口顶线(top+80)下最近的一条。
 * deps 用 messagesKey（结构串）保证消息结构不变时不重建监听（流式期引用频变但不重建）。
 */
export function useScrollSpy(
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  refMap: React.MutableRefObject<Map<MessageKey, HTMLElement>>,
  messages: AnchorableMessage[],
) {
  const [activeKey, setActiveKey] = useState<MessageKey | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const topThreshold = container.getBoundingClientRect().top + 80;
      let currentKey: MessageKey | null = null;
      let currentTop = -Infinity;

      refMap.current.forEach((el, key) => {
        const rect = el.getBoundingClientRect();
        if (rect.top <= topThreshold && rect.top > currentTop) {
          currentTop = rect.top;
          currentKey = key;
        }
      });

      setActiveKey(currentKey);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollContainerRef, refMap, messagesKey(messages)]);

  return activeKey;
}

/** 消息结构签名：仅按 round+role 组合判变（content 变化不触发重建） */
function messagesKey(messages: AnchorableMessage[]): string {
  return messages.map((m) => `${m.round}-${m.role}`).join('|');
}
