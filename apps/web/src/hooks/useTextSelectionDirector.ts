/**
 * 文本选区浮动按钮 hook（导演模式触发）
 * 全局 mouseup 监听：选中消息气泡（.msg[data-message-key]）内 ≥5 字文本时，
 * 返回浮动按钮坐标与选区信息（文本/round/role）；空白处点击或再次空选自动收敛。
 * 点击浮动按钮/弹窗自身不吞事件（供上一层调用）。
 */
import { useEffect, useState, useCallback, useRef } from 'react';

export interface TextSelection {
  /** 浮动按钮锚点（viewport 坐标） */
  x: number;
  y: number;
  text: string;
  /** 形如 "3:assistant"（MessageRow data-message-key） */
  messageKey: string;
  round: number;
  role: string;
}

export function useTextSelectionDirector(enabled: boolean): {
  sel: TextSelection | null;
  dismiss: () => void;
} {
  const [sel, setSel] = useState<TextSelection | null>(null);
  const selRef = useRef<TextSelection | null>(null);
  selRef.current = sel;

  const dismiss = useCallback((): void => {
    setSel(null);
    try { window.getSelection()?.removeAllRanges(); } catch { /* 忽略选区清理异常 */ }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onMouseUp = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      // 浮动按钮 / 弹窗自身 → 不吞，交给组件处理
      if (target.closest('.director-float') || target.closest('.director-modal')) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSel(null);
        return;
      }
      const text = selection.toString().trim();
      if (text.length < 5) { setSel(null); return; }
      const msgEl = selection.anchorNode?.parentElement?.closest('.msg[data-message-key]') as HTMLElement | null;
      if (!msgEl) { setSel(null); return; }
      const messageKey = msgEl.dataset.messageKey ?? '';
      const [roundStr, role] = messageKey.split(':');
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setSel({
        x: rect.left,
        y: rect.bottom + 6,
        text,
        messageKey,
        round: Number(roundStr ?? 0),
        role: role ?? '',
      });
    };
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, [enabled]);

  return { sel, dismiss };
}