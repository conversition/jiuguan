/**
 * FE-06.1 标准测试面板（**仅隔离测试装载**）
 *
 * 为什么需要：两张真实卡的面板目前只有只读动作，无法在浏览器里验证"用户动作 → 权限判定 →
 * 稳定操作身份 → 现有 Agent / 状态服务 → 真实结果 → 交回原目标 → 页面确认"这条完整链路。
 * 解决方式**不是**改真实卡加测试按钮，而是提供一个标准面板样本，它：
 *  - 用**同一个** `surfaceRegistry` 登记、**同一个** `SurfaceHost` 渲染、**同一个** `agentActionBridge` 转发；
 *  - 走**同一套**权限判定与生产路由（不绕过鉴权、不直调业务内部函数）；
 *  - 不是第二套简化应用：它只有按钮，没有任何业务实现。
 *
 * 装载条件：URL 带 `?jgTestPanel=1`（隔离验收用）；生产默认不登记。
 */
import React, { useState } from 'react';

export interface TestPanelResult {
  action: string;
  ok: boolean;
  detail: string;
  at: number;
}

export function TestPanel({
  panelId,
  onAction,
  busy,
  subscribed,
  results,
}: {
  panelId: string;
  onAction: (panelId: string, action: string, payload?: Record<string, unknown>) => void;
  /** 主对话生成中（取消按钮仅在此刻对"发送"有效） */
  busy: boolean;
  subscribed: boolean;
  results: TestPanelResult[];
}) {
  const [text, setText] = useState('');
  const last = results[results.length - 1];
  return (
    <div className="test-panel" data-test-panel={panelId}>
      <p className="surface-hint">
        标准测试面板：按钮全部经由同一 action bridge / 权限判定 / 生产路由；本身不含任何业务实现。
      </p>
      <textarea
        className="test-panel-input"
        data-test="text"
        rows={2}
        placeholder="输入要发送/起草的文本…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="surface-actions">
        <button className="surface-btn" data-test="draft" disabled={!text}
          onClick={() => onAction(panelId, 'panel.inject-draft', { text })}>填草稿（不发送）</button>
        <button className="surface-btn" data-test="send" disabled={!text}
          onClick={() => onAction(panelId, 'panel.send-to-main-chat', { text })}>发送到主对话</button>
        <button className="surface-btn" data-test="assist" disabled={!text}
          onClick={() => onAction(panelId, 'panel.assist-generate', { prompt: text })}>辅助生成（结果只回本面板）</button>
        <button className="surface-btn" data-test="commit"
          onClick={() => onAction(panelId, 'panel.commit-session-state', { values: { 'fe06-probe': Date.now() } })}>提交状态（写后读回）</button>
        <button className="surface-btn" data-test="commit-invalid"
          onClick={() => onAction(panelId, 'panel.commit-session-state', { values: null })}>提交非法值（真实失败必须被接住）</button>
        <button className="surface-btn" data-test="cancel" data-supported={busy ? '1' : '0'}
          onClick={() => onAction(panelId, 'panel.cancel-action', {})}>取消在途发送</button>
        <button className="surface-btn" data-test={subscribed ? 'unsubscribe' : 'subscribe'}
          onClick={() => onAction(panelId, subscribed ? 'panel.unsubscribe-state' : 'panel.subscribe-state', {})}>
          {subscribed ? '退订会话状态' : '订阅会话状态'}
        </button>
      </div>
      <div className="surface-row">
        <span className="surface-k">订阅</span>
        <span className="surface-v" data-test="subscribed">{subscribed ? '已订阅会话状态' : '未订阅'}</span>
      </div>
      <div className="surface-row">
        <span className="surface-k">主对话</span>
        <span className="surface-v" data-test="busy">{busy ? '生成中（取消可用）' : '空闲'}</span>
      </div>
      {last && (
        <div className="surface-row" data-test="last-result">
          <span className="surface-k">{last.ok ? '成功' : '失败'}</span>
          <span className="surface-v">[{last.action}] {last.detail}</span>
        </div>
      )}
      <ul className="surface-empty-list" data-test="results">
        {results.slice(-6).map((r, i) => (
          <li key={i}>{r.ok ? '✓' : '✗'} {r.action}：{r.detail}</li>
        ))}
      </ul>
      <p className="surface-hint">
        辅助生成**不可取消**（如实）：只有"发送到主对话"的在途回合可取消，且以服务端落库定局为准。
      </p>
    </div>
  );
}

/** 探针：面板结果（只读，供浏览器验收读取"按钮点下去到底发生了什么"） */
export function installTestPanelProbe(get: () => TestPanelResult[]): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__jgTestPanelResults = () => get();
}
