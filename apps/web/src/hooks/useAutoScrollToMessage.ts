import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from './useMessageRefs.ts';

/**
 * 生成完成智能定位（v0.6.0）
 * 生成期：用户未主动上滚 → 跟随滚动，让新内容持续可见。
 * 生成结束：未上滚 → 自动滚到新 AI 回复开头；已上滚（在读旧内容）→ 不打断，显示"查看新回复"浮窗。
 */
export function useAutoScrollToMessage(
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  getElement: (key: MessageKey) => HTMLElement | undefined,
  lastAssistantKey: MessageKey | null,
  isGenerating: boolean,
  streamCompleted: boolean,
) {
  const userScrolledUpRef = useRef(false);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [jumpKey, setJumpKey] = useState<MessageKey | null>(null);

  // 监听用户滚动：生成期离底部超阈值（读取旧内容）→ 记为上滚
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (isGenerating && distanceFromBottom > 80) {
        userScrolledUpRef.current = true;
      }
      if (distanceFromBottom < 40) {
        userScrolledUpRef.current = false;
        setShowJumpButton(false);
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isGenerating, scrollContainerRef]);

  // 生成期跟随：未主动上滚时，内容持续可见地钉在流式尾部（新内容增长不跳动）
  useEffect(() => {
    if (!isGenerating) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let raf = 0;
    const follow = () => {
      if (!userScrolledUpRef.current) {
        container.scrollTop = container.scrollHeight;
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [isGenerating, scrollContainerRef]);

  // 生成结束：未上滚 → 滚到新回复开头；已上滚 → 浮窗提示，不打断阅读
  useEffect(() => {
    if (!streamCompleted || !lastAssistantKey) return;
    const container = scrollContainerRef.current;
    const el = getElement(lastAssistantKey);
    if (!container || !el) {
      setShowJumpButton(true);
      setJumpKey(lastAssistantKey);
      return;
    }

    requestAnimationFrame(() => {
      if (!userScrolledUpRef.current) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        container.scrollTo({
          top: container.scrollTop + elRect.top - containerRect.top - 12,
          behavior: 'smooth',
        });
      } else {
        setShowJumpButton(true);
        setJumpKey(lastAssistantKey);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamCompleted, lastAssistantKey, scrollContainerRef, isGenerating]);

  const dismissJump = useCallback(() => setShowJumpButton(false), []);

  return { showJumpButton, jumpKey, dismissJump };
}
