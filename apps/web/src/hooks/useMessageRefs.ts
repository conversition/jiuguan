import { useCallback, useRef } from 'react';

/** 楼层锚点键：`${round}-${role}`（round+role 服务端每轮成对唯一） */
export type MessageKey = string;

export function toMessageKey(round: number, role: string): MessageKey {
  return `${round}-${role}`;
}

/**
 * 消息 DOM 锚点管理（v0.6.0）
 * 收集每条消息行的 DOM 元素，供楼层刻度表定位/滚动 spy 检测当前楼层。
 * register 返回 ref callback（挂载写 Map、卸载删），引用稳定（useCallback []）。
 */
export function useMessageRefs() {
  const refMap = useRef(new Map<MessageKey, HTMLElement>());

  const register = useCallback((key: MessageKey) => {
    return (el: HTMLDivElement | null) => {
      if (el) {
        refMap.current.set(key, el);
      } else {
        refMap.current.delete(key);
      }
    };
  }, []);

  const getElement = useCallback((key: MessageKey): HTMLElement | undefined => {
    return refMap.current.get(key);
  }, []);

  return { refMap, register, getElement };
}
