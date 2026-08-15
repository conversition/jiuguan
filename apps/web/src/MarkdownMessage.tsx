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
