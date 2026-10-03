export interface FrameSizeState {
  width: number;
  height: number;
  rawHeight: number;
  viewportHeight: number;
}

export interface FrameSizeReport {
  w?: unknown;
  h?: unknown;
  contentHeight?: unknown;
  viewportHeight?: unknown;
}

export function createInitialFrameSize(): FrameSizeState {
  return { width: 0, height: 480, rawHeight: 0, viewportHeight: 0 };
}

export function clampFrameDimension(value: number | undefined, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Number(value) : fallback));
}

/**
 * Browser scrollHeight is never smaller than the iframe viewport. When the
 * host changes iframe height, contentHeight and viewportHeight can therefore
 * move by the same amount even though document content did not change.
 */
export function mergeFrameSize(previous: FrameSizeState, report: FrameSizeReport): FrameSizeState {
  const width = Number(report.w);
  const contentHeight = Number(report.contentHeight ?? report.h);
  const viewportHeight = Number(report.viewportHeight);
  const hasContentHeight = Number.isFinite(contentHeight) && contentHeight > 0;
  const hasViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0;
  const nextRaw = hasContentHeight ? contentHeight : previous.rawHeight;
  const nextViewport = hasViewportHeight ? viewportHeight : previous.viewportHeight;
  const contentDelta = nextRaw - previous.rawHeight;
  const viewportDelta = nextViewport - previous.viewportHeight;
  const followsViewport = previous.rawHeight > 0
    && previous.viewportHeight > 0
    && contentDelta !== 0
    && viewportDelta !== 0
    && Math.sign(contentDelta) === Math.sign(viewportDelta)
    && Math.abs(Math.abs(contentDelta) - Math.abs(viewportDelta)) <= 2;
  const contentChanged = hasContentHeight
    && (previous.rawHeight === 0 || Math.abs(contentDelta) > 1);
  return {
    width: Number.isFinite(width) && width > 0 ? width : previous.width,
    height: contentChanged && !followsViewport ? nextRaw : previous.height,
    rawHeight: nextRaw,
    viewportHeight: nextViewport,
  };
}
