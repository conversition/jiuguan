import { useMemo } from 'react';
import type { MessageKey } from '../hooks/useMessageRefs.ts';

export interface RulerMessage {
  round: number;
  role: string;
}

interface MessageRulerProps {
  messages: RulerMessage[];
  activeKey: MessageKey | null;
  onJump: (key: MessageKey) => void;
}

/**
 * 右侧楼层刻度表（v0.6.0）
 * 每个刻度 = 一轮；点击跳到该轮 AI 回复（assistant）开头；当前所在轮高亮。
 * 轮次多时刻度条自身可滚动（max-height + overflow-y-auto）。
 */
export function MessageRuler({ messages, activeKey, onJump }: MessageRulerProps) {
  const rounds = useMemo(() => {
    const set = new Set<number>();
    messages.forEach((m) => set.add(m.round));
    return Array.from(set).sort((a, b) => a - b);
  }, [messages]);

  if (rounds.length === 0) return null;

  return (
    <aside className="message-ruler" aria-label="楼层刻度">
      <div className="message-ruler__track">
        {rounds.map((round) => {
          const isActive = activeKey?.startsWith(`${round}-`) ?? false;
          return (
            <button
              key={round}
              className={`message-ruler__tick${isActive ? ' is-active' : ''}`}
              onClick={() => onJump(`${round}-assistant`)}
              title={`第 ${round} 轮`}
            >
              <span className="message-ruler__dot" />
              <span className="message-ruler__label">{round}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
