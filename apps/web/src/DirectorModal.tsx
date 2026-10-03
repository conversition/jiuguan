/**
 * 导演模式探窗（对话内选区触发）：POST /api/session/:id/director SSE 流式
 * 展示选中片段 → 分镜各阶段进度 → 完成后渲染后端组装的完整 Markdown（含下载 .md 与重生成）。
 * 分镜完成后可按需生成 MiniMax H3 视频提示词（POST /api/session/:id/director/video-prompt，
 * panels 回传 + 会话上下文提取对白 → 逐镜独立 H3 三字段提示词，复制/下载拼接）。
 * 样式沿用酒馆前端（overlay + 卡片 + markdown 排版），SSE 解析抽 readSse 供两流程共用。
 */
import React, { useState, useEffect, useCallback } from 'react';
import { authFetch, eventUrl } from './authClient.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import type { TextSelection } from './hooks/useTextSelectionDirector.ts';

/** 面板全字段（后端 done payload 已全量下发；视频提示词转写的回传输入） */
interface PanelBrief {
  panel: number; time: string; shot_size: string; angle: string;
  lens_feel: string; camera_support: string; movement: string; subject_relation: string;
  start_frame: string; end_frame: string; fragile_anchors: string;
  canvas: { width: number; height: number; ratio: string };
  camera: string; lighting: string; focus: string;
  positive_prompt: string; positive_prompt_short: string; negative_prompt: string;
  nltags_sentences: string[]; narrative_prompt: string; transition_hint: string;
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
/** H3 视频提示词（逐镜独立，一镜一段视频一份提示词） */
interface VideoPromptItem {
  panel: number; target_duration: number; english_prompt: string;
  chinese_translation: string; assumptions: string;
}
interface VideoPromptResult {
  passed: boolean; speakers: string[]; prompts: VideoPromptItem[];
  validation: ValidationIssue[]; errors: string[]; warnings: string[]; markdown: string;
}
interface StageEvent { label: string; detail: string }

/** SSE 流解析（分镜与视频提示词两流程共用）：逐行剥 data: 前缀 → JSON 事件回调 */
async function readSse(res: Response, onEvent: (ev: Record<string, unknown>) => void): Promise<void> {
  if (!res.body) throw new Error('SSE response body is empty');
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
      try { onEvent(JSON.parse(t.slice(5).trim()) as Record<string, unknown>); } catch { /* 忽略坏 SSE 块 */ }
    }
  }
}

/** 发起 SSE POST（错误响应统一抛 Error(message)），返回 Response 供 readSse 消费 */
async function postSse(path: string, body: unknown): Promise<Response> {
  const res = await authFetch(eventUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res;
}

interface DirectorModalProps {
  open: boolean;
  sessionId: string | null;
  selection: TextSelection | null;
  onClose: () => void;
  /** 分镜结果落库后回调（App 刷新会话预览等） */
  onSaved?: () => void;
}

export function DirectorModal({ open, sessionId, selection, onClose, onSaved }: DirectorModalProps) {
  const [shots, setShots] = useState(3);
  const [voice, setVoice] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<StageEvent[]>([]);
  const [result, setResult] = useState<DirectorResult | null>(null);
  const [error, setError] = useState('');
  // H3 视频提示词（按需旁路）
  const [vpBusy, setVpBusy] = useState(false);
  const [vpStages, setVpStages] = useState<StageEvent[]>([]);
  const [vp, setVp] = useState<VideoPromptResult | null>(null);
  const [vpError, setVpError] = useState('');
  const [copied, setCopied] = useState<number | null>(null);

  // 工作流注册表（导演之声池 + 工作流列表）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    authFetch('/api/storyboard/workflows')
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
    setBusy(true); setError(''); setStages([]); setResult(null); setVp(null); setVpStages([]); setVpError('');
    try {
      const res = await postSse(`/api/session/${sessionId}/director`, {
        selectedText: selection.text,
        round: selection.round,
        role: selection.role,
        shots,
        voice: voice || undefined,
        workflow: workflow || undefined,
      });
      await readSse(res, (ev) => {
        if (ev.type === 'stage') setStages((s) => [...s, { label: String(ev.label ?? ''), detail: String(ev.detail ?? '') }]);
        if (ev.type === 'done') { setResult(ev as unknown as DirectorResult); onSaved?.(); }
        if (ev.type === 'error') setError(String(ev.message ?? '导演分镜执行失败'));
      });
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }, [busy, sessionId, selection, shots, voice, workflow, onSaved]);

  /** H3 视频提示词：分镜完成后按需生成（panels 回传，会话上下文提取对白） */
  const runVideoPrompt = useCallback(async () => {
    if (vpBusy || !sessionId || !result?.panels?.length) return;
    setVpBusy(true); setVpError(''); setVpStages([]); setVp(null);
    try {
      const res = await postSse(`/api/session/${sessionId}/director/video-prompt`, {
        panels: result.panels,
        sequenceSfx: result.sequence?.sfx,
        selectedText: selection?.text,
        round: selection?.round,
      });
      await readSse(res, (ev) => {
        if (ev.type === 'stage') setVpStages((s) => [...s, { label: String(ev.label ?? ''), detail: String(ev.detail ?? '') }]);
        if (ev.type === 'done') setVp(ev as unknown as VideoPromptResult);
        if (ev.type === 'error') setVpError(String(ev.message ?? '视频提示词生成失败'));
      });
    } catch (e) {
      setVpError((e as Error).message);
    }
    setVpBusy(false);
  }, [vpBusy, sessionId, result, selection]);

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
    // 分镜 markdown + 视频提示词小节拼接（按需生成过才追加）
    const base = result?.markdown ?? '';
    const text = vp?.markdown ? `${base}\n\n---\n\n${vp.markdown}` : base;
    if (!text) return;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `导演分镜_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyPrompt = (panel: number, text: string): void => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(panel);
      setTimeout(() => setCopied((c) => (c === panel ? null : c)), 1500);
    }).catch(() => { /* 剪贴板不可用时静默（HTTP 非 https 环境常见） */ });
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
          <button onClick={runVideoPrompt} disabled={!result?.panels?.length || vpBusy}>🎞 {vpBusy ? '生成中…' : '生成视频提示词'}</button>
          <button onClick={download} disabled={!result?.markdown}>📥 下载 .md</button>
          <span className={`director-status ${result && result.passed && !passedErrors ? 'ok' : ''}`}>
            {busy ? '分镜生成中…' : result ? `${result.passed && !passedErrors ? '✅' : '⚠'} ${result.passed ? 'PASS' : 'FAIL'} ｜ ${result.panels.length} 镜 ｜ e${passedErrors}/w${passedWarns}` : '就绪'}
          </span>
        </div>

        {error && <p className="director-error">⚠ {error}</p>}

        {result && (result.errors.length > 0 || passedWarns > 0) && (
          <div className="director-val">
            {result.errors.slice(0, 8).map((e, i) => (
              <p key={`e${i}`} className="director-error">✕ {e}</p>
            ))}
            {result.warnings.slice(0, 5).map((w, i) => (
              <p key={`w${i}`} className="director-warn">△ {w}</p>
            ))}
          </div>
        )}

        {stages.length > 0 && (
          <div className="director-stages">
            {stages.map((s, i) => (
              <span key={i} className="stage-chip">{s.label}{s.detail ? `（${s.detail}）` : ''}</span>
            ))}
          </div>
        )}

        {vpStages.length > 0 && (
          <div className="director-stages">
            <span className="stage-chip vp-chip">🎞 视频提示词</span>
            {vpStages.map((s, i) => (
              <span key={i} className="stage-chip">{s.label}{s.detail ? `（${s.detail}）` : ''}</span>
            ))}
          </div>
        )}

        {vpError && <p className="director-error">⚠ {vpError}</p>}

        {vp && (
          <div className="director-vp">
            {vp.speakers.length > 0 && <p className="vp-speakers">🔊 声源名册：{vp.speakers.join(' ｜ ')}</p>}
            {vp.errors.slice(0, 4).map((e, i) => <p key={`ve${i}`} className="director-error">✕ {e}</p>)}
            {vp.warnings.slice(0, 4).map((w, i) => <p key={`vw${i}`} className="director-warn">△ {w}</p>)}
            {vp.prompts.map((p) => (
              <div key={p.panel} className="vp-card">
                <div className="vp-head">
                  <b>第 {p.panel} 镜（目标 {p.target_duration}s）</b>
                  <button className="vp-copy" onClick={() => copyPrompt(p.panel, p.english_prompt)}>
                    {copied === p.panel ? '✓ 已复制' : '📋 复制'}
                  </button>
                </div>
                <pre className="vp-code">{p.english_prompt}</pre>
                {p.chinese_translation && <p className="vp-zh">{p.chinese_translation}</p>}
                {p.assumptions && <p className="vp-assumption">💡 {p.assumptions}</p>}
              </div>
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
