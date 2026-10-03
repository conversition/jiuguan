import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';

/** 正文 Markdown 渲染
 *  - remarkGfm：GFM（表格/删除线/任务列表）
 *  - remarkBreaks：单换行 → <br>（酒馆正文习惯，避免被折叠成空格）
 *  - rehypeHighlight：代码块语法高亮（github-dark）
 */
export function MarkdownMessage({ text }: { text: string }) {
  if (!text || !text.trim()) return null;
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 流式正文纯文本预览（07 架构 §3d：正则管道后 → 流式渲染）
 *  仅 busy 阶段使用：单层 pre-wrap 文本，不解析 markdown / 不 inject HTML。
 *  避免流式期对不完整正文逐 delta 全量 re-parse（react-markdown + rehype-highlight）导致主线程卡死；
 *  回合结束（done / 历史回填）后由调用方切回完整 MarkdownMessage / HtmlMessage。
 *  打字机光标由外层 .bubble.streaming::after 提供（见 style.css）。
 */
export function StreamText({ text }: { text: string }) {
  return (
    <div className="stream-text">
      <span>{text}</span>
    </div>
  );
}
