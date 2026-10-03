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
  | { __jgfh_h: 'height'; h: number; token?: string }
  | { __jgfh_h: 'size'; w: number; h: number; token?: string }
  | { __jgfh: 'choice'; text: string; mode?: 'send' | 'draft'; token?: string }
  | { __jgfh: 'draft'; text: string; token?: string }
  | { __jgfh: 'rpc'; id: number; ns: string; op: string; payload?: unknown; token?: string };

/** 宿主 → iframe 消息（定向 postMessage，不透明源用 '*' 目标，靠 e.source 校验身份）
 *  op 语义：
 *   - theme / scale：外观同步
 *   - state：某条**消息状态已提交**（FE-04-B：必须带消息身份；无消息身份的状态更新不得应用到具体视图）
 *   - session-state：**当前会话状态变化**（给显式订阅会话状态的模块；不冒充历史楼层）
 *   - message：消息生命周期（sent / received）——**会话级通知**，供列表/未读/订阅者刷新视图
 *  未提交成功的事实不得广播（不伪造提交事件）。 */
export type JgHostMessage =
  | { __jgfh: 'host'; op: 'theme' | 'scale'; value: unknown; token?: string }
  | { __jgfh: 'host'; op: 'visibility'; value: { visible: boolean }; target?: HostEventTarget; token?: string }
  /** FE-06.0：宿主 → 子文档**心跳**（要求回一次状态上报，用于证明同一子文档持续存活） */
  | { __jgfh: 'host'; op: 'ping'; value?: unknown; token?: string }
  | { __jgfh: 'host'; op: 'state' | 'session-state' | 'message'; value: Record<string, unknown>; target?: HostEventTarget; token?: string }
  | { __jgfh: 'rpc'; id: number; ok: boolean; result?: unknown; error?: string; token?: string };

/** 宿主事件的**目标绑定**（FE-04.2）：视图据此只更新相关页面，而不是收到广播后都去读"最新状态"。 */
export interface HostEventTarget {
  sessionId?: string;
  /** 会话运行实例（新增消息不轮换） */
  sessionRunId?: string;
  /** 目标消息稳定键 */
  messageKey?: string;
  /** 目标消息内部身份 */
  messageId?: number;
  /** 目标回复版本 */
  revision?: string;
}

/** 注册的 iframe 句柄：source 用于 e.source 身份校验，post 用于向该 iframe 定向发消息 */
export interface JgFrameHandle {
  source: MessageEventSource;
  token: string;
  post: (msg: JgHostMessage) => void;
}

const frames = new Set<JgFrameHandle>();

export function createFrameToken(): string {
  const bytes = new Uint32Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 0xffffffff);
  return Array.from(bytes, (n) => n.toString(36)).join('-');
}

/** 登记一个已挂载 iframe 窗口（返回注销函数）；宿主仅接收来自注册帧的消息 */
export function registerFrame(source: MessageEventSource, post: (msg: JgHostMessage) => void, token = createFrameToken()): () => void {
  const h: JgFrameHandle = { source, token, post };
  frames.add(h);
  return () => { frames.delete(h); };
}

/** 按事件 source 查注册帧 */
export function findFrame(source: MessageEventSource | null, token?: string): JgFrameHandle | undefined {
  if (!source) return undefined;
  for (const h of frames) if (h.source === source && (token === undefined || h.token === token)) return h;
  return undefined;
}

/** 向所有已注册 iframe 广播（宿主 → iframe：主题/缩放同步等） */
export function broadcastToFrames(msg: JgHostMessage): void {
  for (const h of frames) h.post(msg);
}

/** 构造向某个 iframe 定向发消息的函数（不透明源 targetOrigin 只能 '*'） */
export function buildFramePost(win: Window, targetOrigin = '*', token?: string): (msg: JgHostMessage) => void {
  return (msg) => win.postMessage(token ? { ...msg, token } : msg, targetOrigin);
}

/** 校验未知数据是否为合法的 __jgfh 帧消息（字段类型 + 有限性，防止伪造/格式错误消息进入分发） */
export function isJgFrameMessage(data: unknown, expectedToken?: string): data is JgFrameMessage {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (expectedToken !== undefined && d.token !== expectedToken) return false;
  if (d.token !== undefined && typeof d.token !== 'string') return false;
  if (d.__jgfh_h === 'height') return typeof d.h === 'number' && Number.isFinite(d.h);
  if (d.__jgfh_h === 'size') return typeof d.w === 'number' && typeof d.h === 'number' && Number.isFinite(d.w) && Number.isFinite(d.h);
  if (d.__jgfh === 'choice') return typeof d.text === 'string';
  if (d.__jgfh === 'draft') return typeof d.text === 'string';
  if (d.__jgfh === 'rpc') return typeof d.id === 'number' && typeof d.ns === 'string' && typeof d.op === 'string';
  return false;
}
