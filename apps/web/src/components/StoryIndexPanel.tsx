import type { Ref } from 'react';

interface StoryIndexPanelProps {
  className?: string;
  content: string;
  branches: readonly string[];
  round: number;
  loading: boolean;
  error: string;
  staleSourceRound: number | null;
  busy: boolean;
  onRefresh: () => void;
  onSelect: (branch: string) => void;
  onClose?: () => void;
  closeButtonRef?: Ref<HTMLButtonElement>;
}

export function StoryIndexPanel({
  className = '',
  content,
  branches,
  round,
  loading,
  error,
  staleSourceRound,
  busy,
  onRefresh,
  onSelect,
  onClose,
  closeButtonRef,
}: StoryIndexPanelProps) {
  const empty = !content && branches.length === 0;
  return (
    <section
      className={`status-box story-box ${className}`.trim()}
      aria-label="剧情分支索引"
      aria-busy={loading}
    >
      <div className="status-head story-box__head">
        <span className="status-round">剧情分支索引</span>
        <span className="status-event">{round > 0 ? `R${round}` : '等待回合'}</span>
        <div className="story-box__actions">
          <button
            type="button"
            className="mini-btn"
            title="重新生成剧情索引（跳过缓存）"
            aria-label="重新生成剧情索引"
            onClick={onRefresh}
            disabled={loading || round < 1}
          >↻</button>
          {onClose && (
            <button
              ref={closeButtonRef}
              type="button"
              className="story-sheet__close"
              aria-label="关闭剧情索引"
              onClick={onClose}
            >×</button>
          )}
        </div>
      </div>
      {loading && empty && <p className="story-box__state" role="status">正在读取剧情索引…</p>}
      {error && (
        <div className="story-box__error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRefresh} disabled={loading}>重试</button>
        </div>
      )}
      {staleSourceRound !== null && (
        <div className="story-box__error" role="status">
          <span>本轮新索引暂不可用，当前展示 R{staleSourceRound} 的只读参考；请稍后重试。</span>
        </div>
      )}
      {!loading && !error && empty && (
        <p className="story-box__state">本轮暂时没有剧情索引，可点击刷新生成。</p>
      )}
      {content && <div className="story-index">{content}</div>}
      {branches.length > 0 && (
        <div className="story-branches">
          {branches.map((branch, index) => (
            <button
              key={`${index}-${branch}`}
              type="button"
              className="branch-btn"
              onClick={() => onSelect(branch)}
              disabled={busy || staleSourceRound !== null}
            >{branch}</button>
          ))}
        </div>
      )}
      <p className="story-hint">
        {staleSourceRound === null ? 'AI 生成 · 点击分支填入输入框' : '历史参考 · 已禁止选择，避免误写偏好'}
      </p>
    </section>
  );
}
