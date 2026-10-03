/**
 * P10-06：安全区适配（P10 计划第 3 条）。
 *
 * 纯函数生成 viewport/安全区 CSS，注入函数做薄 DOM 绑定（可注入最小假件测试）。
 * Android edge-to-edge 下 WebView 不自动避让刘海/手势条，必须 viewport-fit=cover
 * + env(safe-area-inset-*) 由 UI 自行消费。
 */

export const SAFE_AREA_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, viewport-fit=cover';

/** 合并既有 viewport content：保留缩放相关键，强制 viewport-fit=cover。 */
export function mergeViewportContent(existing: string | undefined | null): string {
  const source = typeof existing === 'string' ? existing : '';
  const parts = source.split(',').map((part) => part.trim()).filter(Boolean)
    .filter((part) => !/^viewport-fit\s*=/i.test(part));
  parts.push('viewport-fit=cover');
  return parts.join(', ');
}

export function buildSafeAreaCss(): string {
  return [
    ':root {',
    '  --safe-area-inset-top: env(safe-area-inset-top, 0px);',
    '  --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);',
    '  --safe-area-inset-left: env(safe-area-inset-left, 0px);',
    '  --safe-area-inset-right: env(safe-area-inset-right, 0px);',
    '}',
  ].join('\n');
}

/** 注入所需的最小 DOM 抽象，避免测试依赖真实 document。 */
export interface MinimalElement {
  getAttribute?(name: string): string | null | undefined;
  setAttribute?(name: string, value: string): void;
  textContent?: string;
}

export interface MinimalDocument {
  head: { querySelectorAll(selectors: string): MinimalElement[] };
  createElement(tag: 'meta' | 'style'): MinimalElement;
  headAppendChild(node: unknown): void;
}

export function applySafeArea(documentLike: MinimalDocument): void {
  // 1) viewport meta：存在则合并，缺失则创建
  const existing = documentLike.head.querySelectorAll('meta[name="viewport"]')[0];
  if (existing && typeof existing.getAttribute === 'function') {
    existing.setAttribute?.('content', mergeViewportContent(existing.getAttribute?.('content') as string | undefined));
  } else {
    const meta = documentLike.createElement('meta');
    meta.setAttribute?.('name', 'viewport');
    meta.setAttribute?.('content', SAFE_AREA_VIEWPORT_CONTENT);
    documentLike.headAppendChild(meta);
  }
  // 2) 安全区 CSS 变量：幂等（按 id 查重）
  const styleId = 'jg-safe-area-css';
  const already = documentLike.head.querySelectorAll(`style#${styleId}`).length > 0;
  if (!already) {
    const style = documentLike.createElement('style');
    style.setAttribute?.('id', styleId);
    style.textContent = buildSafeAreaCss();
    documentLike.headAppendChild(style);
  }
}
