import React, { useEffect, useMemo, useRef, useState } from 'react';
import { clampFrameDimension } from '../frameSize.ts';

const MIN_HEIGHT = 320;
const COMPACT_MAX_HEIGHT = 760;
const EXPANDED_MAX_HEIGHT = 6000;
const MIN_WIDTH = 320;
const MAX_WIDTH = 4096;

/**
 * Heavy card frontends share one viewport. Height/fit/fullscreen only change
 * wrappers and styles; the iframe node and browsing context stay mounted.
 */
export function FrameViewport({
  title,
  reportedWidth,
  reportedHeight,
  children,
}: {
  title: string;
  reportedWidth?: number;
  reportedHeight?: number;
  children: (style: React.CSSProperties) => React.ReactNode;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fit, setFit] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);

  const naturalHeight = clampFrameDimension(reportedHeight, MIN_HEIGHT, EXPANDED_MAX_HEIGHT, 480);
  const naturalWidth = reportedWidth && reportedWidth > 0
    ? clampFrameDimension(reportedWidth, MIN_WIDTH, MAX_WIDTH, MIN_WIDTH)
    : 0;
  const rawHeight = expanded ? naturalHeight : Math.min(naturalHeight, COMPACT_MAX_HEIGHT);
  const scale = fit && naturalWidth > 0 && availableWidth > 0
    ? Math.min(1, availableWidth / naturalWidth)
    : 1;
  // Keep the document's measured layout width stable. Expanding it to the
  // host width would make clientWidth feed back as a new natural width after
  // fullscreen/sidebar resizes, progressively shrinking the card on return.
  const layoutWidth = naturalWidth;
  const visualWidth = layoutWidth > 0 ? layoutWidth * scale : availableWidth;
  const visualHeight = Math.max(MIN_HEIGHT * Math.min(1, scale), rawHeight * scale);
  const frameStyle = useMemo<React.CSSProperties>(() => ({
    width: layoutWidth > 0 ? layoutWidth + 'px' : '100%',
    height: rawHeight + 'px',
    transform: scale < 0.999 ? 'scale(' + scale + ')' : undefined,
    transformOrigin: 'top left',
  }), [layoutWidth, rawHeight, scale]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setAvailableWidth(body.clientWidth);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(body);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const root = rootRef.current;
    const scrollHost = root?.closest('.messages') as HTMLElement | null;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHostOverflow = scrollHost?.style.overflow ?? '';
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    if (scrollHost) scrollHost.style.overflow = 'hidden';
    root?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (scrollHost) scrollHost.style.overflow = previousHostOverflow;
      window.removeEventListener('keydown', onKey);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [fullscreen]);

  return (
    <section
      ref={rootRef}
      className='frame-viewport'
      data-fullscreen={fullscreen ? '1' : '0'}
      data-fit={fit ? '1' : '0'}
      role={fullscreen ? 'dialog' : undefined}
      aria-modal={fullscreen || undefined}
      aria-label={title}
      tabIndex={fullscreen ? -1 : undefined}
    >
      <div className='frame-viewport-toolbar'>
        <span className='frame-viewport-title'>{title}</span>
        {reportedWidth && reportedHeight ? (
          <span className='frame-viewport-size'>{Math.round(reportedWidth)} × {Math.round(reportedHeight)}</span>
        ) : null}
        <button type='button' onClick={() => setFit((v) => !v)} aria-pressed={fit}>
          {fit ? '原始尺寸' : '适应宽度'}
        </button>
        <button type='button' onClick={() => setExpanded((v) => !v)} aria-pressed={expanded}>
          {expanded ? '收起高度' : '展开高度'}
        </button>
        <button type='button' onClick={() => setFullscreen((v) => !v)} aria-pressed={fullscreen}>
          {fullscreen ? '退出全屏' : '全屏'}
        </button>
      </div>
      <div
        ref={bodyRef}
        className='frame-viewport-body'
        style={fullscreen ? undefined : { height: visualHeight + 'px' }}
      >
        <div
          className='frame-viewport-scale-layer'
          style={{ width: visualWidth > 0 ? visualWidth + 'px' : '100%', height: visualHeight + 'px' }}
        >
          {children(frameStyle)}
        </div>
      </div>
    </section>
  );
}
