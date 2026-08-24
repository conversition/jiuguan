/**
 * 卡片前端 ⇄ 宿主 交互桥（__jgfh 协议）
 * iframe（不透明源沙箱）无法直接访问宿主 DOM/状态，唯一通道是 postMessage。
 * 本模块维护"已挂载 iframe 窗口"注册表 + 消息类型校验 + 查帧，供宿主统一分发：
 *  - iframe → 宿主：height/size（测高测宽）、choice（点选项 → 发聊天）、draft（填输入框）、rpc（通用远程调用）
 *  - 宿主 → iframe：host（主题/缩放同步）、rpc 响应（rpc 响应）
 * 纯逻辑可 node 单测（--experimental-strip-types），DOM 类型仅作形状约束不入运行时。
 */

/** iframe → 宿主 消息（保留现有 {__jgfh_h:'height'}，新增 size/choice/draft/rpc） */
export type JgFrameMessage =
  | { __jgfh_h: 'height'; h: number }
  | { __jgfh_h: 'size'; w: number; h: number }
  | { __jgfh: 'choice'; text: string; mode?: 'send' | 'draft' }
  | { __jgfh: 'draft'; text: string }
  | { __jgfh: 'rpc'; id: number; ns: string; op: string; payload?: unknown };

/** 宿主 → iframe 消息（定向 postMessage，不透明源用 '*' 目标，靠 e.source 校验身份） */
export type JgHostMessage =
  | { __jgfh: 'host'; op: 'theme' | 'scale'; value: unknown }
  | { __jgfh: 'rpc'; id: number; ok: boolean; result?: unknown; error?: string };

/** 注册的 iframe 句柄：source 用于 e.source 身份校验，post 用于向该 iframe 定向发消息 */
export interface JgFrameHandle {
  source: MessageEventSource;
  post: (msg: JgHostMessage) => void;
}

const frames = new Set<JgFrameHandle>();

/** 登记一个已挂载 iframe 窗口（返回注销函数）；宿主仅接收来自注册帧的消息 */
export function registerFrame(source: MessageEventSource, post: (msg: JgHostMessage) => void): () => void {
  const h: JgFrameHandle = { source, post };
  frames.add(h);
  return () => { frames.delete(h); };
}

/** 按事件 source 查注册帧 */
export function findFrame(source: MessageEventSource | null): JgFrameHandle | undefined {
  if (!source) return undefined;
  for (const h of frames) if (h.source === source) return h;
  return undefined;
}

/** 构造向某个 iframe 定向发消息的函数（不透明源 targetOrigin 只能 '*'） */
export function buildFramePost(win: Window, targetOrigin = '*'): (msg: JgHostMessage) => void {
  return (msg) => win.postMessage(msg, targetOrigin);
}

/** 校验未知数据是否为合法的 __jgfh 帧消息（字段类型 + 有限性，防止伪造/格式错误消息进入分发） */
export function isJgFrameMessage(data: unknown): data is JgFrameMessage {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.__jgfh_h === 'height') return typeof d.h === 'number' && Number.isFinite(d.h);
  if (d.__jgfh_h === 'size') return typeof d.w === 'number' && typeof d.h === 'number' && Number.isFinite(d.w) && Number.isFinite(d.h);
  if (d.__jgfh === 'choice') return typeof d.text === 'string';
  if (d.__jgfh === 'draft') return typeof d.text === 'string';
  if (d.__jgfh === 'rpc') return typeof d.id === 'number' && typeof d.ns === 'string' && typeof d.op === 'string';
  return false;
}