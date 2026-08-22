/**
 * 导演模式探窗（对话内选区触发）：POST /api/session/:id/director SSE 流式
 * 展示选中片段 → 分镜各阶段进度 → 完成后渲染后端组装的完整 Markdown（含下载 .md 与重生成）。
 * 样式沿用酒馆前端（overlay + 卡片 + markdown 排版），复用 StoryboardPanel 的 SSE 解析逻辑。
 */
import React, { useState, useEffect, useCallback } from 'react';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import type { TextSelection } from './hooks/useTextSelectionDirector.ts';

const API = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_BASE ?? '';

interface PanelBrief {
  panel: number; time: string; shot_size: string; angle: string;
  transition_hint: string; positive_prompt_short: string;
}
interface ValidationIssue { stage: string; errors: string[]; warnings: string[] }
interface DirectorResult {
  passed: boolean; voice: string; intention: string;
  panels: PanelBrief[];
  sequence: { master_prompt: string; narrative: string; consistency: string; sfx: string } | null;
  humanized: string;
  validation: ValidationIssue[];
  errors: string[];
  warnings: string[];
  markdown: string;
}
interface StageEvent { label: string; detail: string }

interface DirectorModalProps {
  open: boolean;
  sessionId: string | null;
  selection: TextSelection | null;
  onClose: () => void;
  /** 分镜结果落库后回调（App 刷新会话预览等） */
  onSaved?: () => void;
}

export function DirectorModal({ open, sessionId, selection, onClose, onSaved }: DirectorModalProps) {
  const [shots, setShots] = useState(9);
  const [voice, setVoice] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<StageEvent[]>([]);
  const [result, setResult] = useState<DirectorResult | null>(null);
  const [error, setError] = useState('');

  // 工作流注册表（导演之声池 + 工作流列表）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(`${API}/api/storyboard/workflows`)
      .then((r) => r.json())
      .then((d: { workflows?: string[]; defaultWorkflow?: string; voices?: string[] }) => {
        if (!alive) return;
        setWorkflows(d.workflows ?? []);
        setVoices(d.voices ?? []);
        setWorkflow(d.defaultWorkflow ?? '');
      })
      .catch(() => { /* 工作流列表拉取失败不阻塞分镜（服务端会回落默认） */ });
    return () => { alive = false; };
  }, [open]);

  const run = useCallback(async () => {
    if (busy || !sessionId || !selection || !selection.text.trim()) return;
    setBusy(true); setError(''); setStages([]); setResult(null);
    try {
      const res = await fetch(`${API}/api/session/${sessionId}/director`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          selectedText: selection.text,
          round: selection.round,
          role: selection.role,
          shots,
          voice: voice || undefined,
          workflow: workflow || undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;
            if (ev.type === 'stage') setStages((s) => [...s, { label: String(ev.label ?? ''), detail: String(ev.detail ?? '') }]);
            if (ev.type === 'done') { setResult(ev as unknown as DirectorResult); onSaved?.(); }
            if (ev.type === 'error') setError(String(ev.message ?? '导演分镜执行失败'));
          } catch { /* 忽略坏 SSE 块 */ }
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }, [busy, sessionId, selection, shots, voice, workflow, onSaved]);

  // 打开 + 有选中文本 → 立即执行一次（调整镜数/导演之声后由按钮手动重跑）
  useEffect(() => {
    if (open && selection && selection.text.trim() && sessionId) {
      run();
    }
    // 仅在打开/选文变化时自动执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selection?.text]);

  if (!open) return null;

  const download = (): void => {
    const text = result?.markdown ?? '';
    if (!text) return;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `导演分镜_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const passedErrors = (result?.validation ?? []).flatMap((v) => v.errors).length;
  const passedWarns = (result?.validation ?? []).flatMap((v) => v.warnings).length;

  return (
    <div className="director-modal" role="dialog" aria-modal="true">
      <div className="director-panel">
        <div className="director-head">
          <div>
            <h2>🎬 导演模式</h2>
            <p className="director-source" title={selection?.text}>
              选中片段：{selection?.text.slice(0, 60)}{(selection?.text.length ?? 0) > 60 ? '…' : ''}
              <span className="muted">　(第 {selection?.round || '-'} 轮 · {selection?.role || 'assistant'})</span>
            </p>
          </div>
          <button className="op-btn" title="关闭" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="director-bar">
          <label className="edit-check">镜数
            <input type="number" min={1} max={30} value={shots} onChange={(e) => setShots(Math.max(1, Math.min(30, Number(e.target.value))))} style={{ width: 56 }} />
          </label>
          <select value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="">导演之声（自动选择）</option>
            {voices.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
          <button onClick={run} disabled={busy || !sessionId}>🔄 {busy ? '执行中…' : '重新生成'}</button>
          <button onClick={download} disabled={!result?.markdown}>📥 下载 .md</button>
          <span className={`director-status ${result && !passedErrors ? 'ok' : ''}`}>
            {busy ? '分镜生成中…' : result ? `✅ ${result.passed ? 'PASS' : 'FAIL'} ｜ ${result.panels.length} 镜 ｜ e${passedErrors}/w${passedWarns}` : '就绪'}
          </span>
        </div>

        {error && <p className="director-error">⚠ {error}</p>}

        {stages.length > 0 && (
          <div className="director-stages">
            {stages.map((s, i) => (
              <span key={i} className="stage-chip">{s.label}{s.detail ? `（${s.detail}）` : ''}</span>
            ))}
          </div>
        )}

        {result?.markdown ? (
          <div className="director-markdown">
            <MarkdownMessage text={result.markdown} />
          </div>
        ) : (
          <div className="director-empty">{busy ? '🎬 正在组装剧本上下文并生成分镜…' : '选中一条 AI 回复中的文字，点击 🎬 开始导演分镜。'}</div>
        )}
      </div>
    </div>
  );
}