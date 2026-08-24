/**
 * GLA 运行时交互入口（模块单例）
 * App 每渲染用最新闭包更新本单例；GalStage/ChoiceOverlay/外部卡页经 getGalRuntime() 获取稳定发送入口。
 * 引用稳定 → React.memo 比较字段不新增 → 舞台组件不因回调更新而重渲染。
 */

export interface GalRuntime {
  busy: boolean;
  sessionId: string | null;
  /** 把文本送入聊天：mode 'send' → 直接作为用户消息发出触发 AI；'draft' → 填入输入框不自动发送 */
  sendText: (text: string, mode?: 'send' | 'draft') => void;
}

let runtime: GalRuntime = { busy: false, sessionId: null, sendText: () => {} };

export function setGalRuntime(r: GalRuntime): void {
  runtime = r;
}

export function getGalRuntime(): GalRuntime {
  return runtime;
}