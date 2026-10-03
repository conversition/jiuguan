import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageKey } from '../hooks/useMessageRefs.ts';
import { MOBILE_DRAWER_MEDIA } from '../hooks/useMobileDrawer.ts';

export interface RulerMessage {
  round: number;
  role: string;
}

interface MessageRulerProps {
  messages: RulerMessage[];
  activeKey: MessageKey | null;
  sessionKey: string | null;
  onJump: (key: MessageKey) => void;
}

/**
 * 右侧楼层刻度表（v0.6.0）
 * 每个刻度 = 一轮；点击跳到该轮 AI 回复（assistant）开头；当前所在轮高亮。
 * 轮次多时刻度条自身可滚动（max-height + overflow-y-auto）。
 */
export function MessageRuler({ messages, activeKey, sessionKey, onJump }: MessageRulerProps) {
  const [mobileLayout, setMobileLayout] = useState(() => window.matchMedia(MOBILE_DRAWER_MEDIA).matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const rulerRef = useRef<HTMLElement>(null);
  const rounds = useMemo(() => {
    const set = new Set<number>();
    messages.forEach((m) => set.add(m.round));
    return Array.from(set).sort((a, b) => a - b);
  }, [messages]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_DRAWER_MEDIA);
    const onMediaChange = (event: MediaQueryListEvent) => {
      setMobileLayout(event.matches);
      if (!event.matches) setMobileOpen(false);
    };
    media.addEventListener('change', onMediaChange);
    return () => media.removeEventListener('change', onMediaChange);
  }, []);

  useEffect(() => {
    if (rulerRef.current) rulerRef.current.inert = mobileLayout && !mobileOpen;
  }, [mobileLayout, mobileOpen]);

  useEffect(() => {
    setMobileOpen(false);
  }, [sessionKey]);

  useEffect(() => {
    if (rounds.length === 0) setMobileOpen(false);
  }, [rounds.length]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  if (rounds.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="message-ruler-toggle"
        data-mobile-open={mobileOpen ? '1' : '0'}
        aria-label={mobileOpen ? '收起楼层进度' : '打开楼层进度'}
        aria-controls="message-ruler"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((open) => !open)}
      >
        <span aria-hidden="true">{mobileOpen ? '收起' : '楼层'}</span>
      </button>
      <aside
        ref={rulerRef}
        id="message-ruler"
        className="message-ruler"
        data-mobile-open={mobileOpen ? '1' : '0'}
        aria-label="楼层进度"
        aria-hidden={mobileLayout && !mobileOpen ? true : undefined}
      >
        <div className="message-ruler__track">
          {rounds.map((round) => {
            const isActive = activeKey?.startsWith(`${round}-`) ?? false;
            return (
              <button
                key={round}
                className={`message-ruler__tick${isActive ? ' is-active' : ''}`}
                onClick={() => {
                  onJump(`${round}-assistant`);
                  setMobileOpen(false);
                }}
                title={`第 ${round} 轮`}
              >
                <span className="message-ruler__dot" />
                <span className="message-ruler__label">{round}</span>
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}
