import { useCallback, useEffect, useRef, useState } from 'react';

export const MOBILE_DRAWER_MEDIA = '(max-width: 840px)';
const HISTORY_KEY = '__jiuguanMobileDrawer';

function currentHistoryState(): Record<string, unknown> {
  const state = window.history.state;
  return state && typeof state === 'object' ? state as Record<string, unknown> : {};
}

/**
 * 移动导航抽屉拥有一层临时 history entry：
 * - Android/浏览器返回键优先关闭抽屉，不离开当前会话；
 * - 点击遮罩/关闭键会消费同一 entry；
 * - 桌面断点不创建 history entry，也不改变原侧栏行为。
 */
export function useMobileDrawer(historyStateKey = HISTORY_KEY) {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_DRAWER_MEDIA).matches);
  const historyTokenRef = useRef<string | null>(null);

  const openDrawer = useCallback(() => {
    if (open) return;
    if (window.matchMedia(MOBILE_DRAWER_MEDIA).matches) {
      const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      window.history.pushState({ ...currentHistoryState(), [historyStateKey]: token }, '');
      historyTokenRef.current = token;
    }
    setOpen(true);
  }, [historyStateKey, open]);

  const closeDrawer = useCallback((consumeHistory = true) => {
    setOpen(false);
    const token = historyTokenRef.current;
    historyTokenRef.current = null;
    if (consumeHistory && token && currentHistoryState()[historyStateKey] === token) {
      window.history.back();
    }
  }, [historyStateKey]);

  useEffect(() => {
    const onPopState = () => {
      if (!historyTokenRef.current) return;
      historyTokenRef.current = null;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !historyTokenRef.current) return;
      event.preventDefault();
      closeDrawer(true);
    };
    const media = window.matchMedia(MOBILE_DRAWER_MEDIA);
    const onMediaChange = (event: MediaQueryListEvent) => {
      setMobile(event.matches);
      if (!event.matches && open) closeDrawer(true);
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('keydown', onKeyDown);
    media.addEventListener('change', onMediaChange);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('keydown', onKeyDown);
      media.removeEventListener('change', onMediaChange);
    };
  }, [closeDrawer, open]);

  return { open, mobile, openDrawer, closeDrawer };
}
