/**
 * 错误边界（v0.6.1）
 * 捕获子树 render/lifecycle 抛出的异常，阻止其卸载整个 React 树（防白屏），
 * 并记录到日志模块 + 展示可恢复的兜底面板（下载日志 / 重试）。
 * 两层用法：顶层包 <App/>（全场兜底）、聊天消息列表外包一层（单条坏消息不拖垮侧栏/输入框）。
 */
import { Component, type ReactNode } from 'react';
import { logger } from '../lib/logger.ts';

interface Props {
  children: ReactNode;
  /** 兜底面板要清空消息时调用（可选） */
  onReset?: () => void;
  /** 用于区分日志 scope 的标签 */
  scope?: string;
}

interface State {
  hasError: boolean;
  message: string;
  stack?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string }): void {
    logger.error((this.props.scope ?? 'render') as 'render', '渲染/异常被 ErrorBoundary 捕获', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: info?.componentStack,
    });
  }

  handleReset = (): void => {
    this.props.onReset?.();
    this.setState({ hasError: false, message: '', stack: undefined });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="boundary-fallback" role="alert">
        <h3>界面出错了（已阻止整页崩溃）</h3>
        <pre className="boundary-msg">{this.state.message}</pre>
        {this.state.stack && <pre className="boundary-stack">{this.state.stack}</pre>}
        <div className="boundary-actions">
          <button className="op-btn" onClick={() => logger.download()}>📄 下载日志</button>
          <button className="op-btn" onClick={this.handleReset}>重试</button>
        </div>
      </div>
    );
  }
}
