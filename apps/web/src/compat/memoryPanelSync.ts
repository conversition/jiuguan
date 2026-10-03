/**
 * AM-05：记忆面板的自动同步控制器（**纯逻辑，可在 Node 中直接测**）
 *
 * ── 为什么单独成模块 ────────────────────────────────────────────────
 * 旧面板把「读取」挂在刷新按钮上（`onClick={loadTables}`），于是：
 *   · 打开面板不请求 → 必须手动点；
 *   · `fetch().then(r=>r.json())` 不判 `res.ok` → 404/500 被 `?? []` 洗成"（空）"，
 *     看起来像"没数据/要刷新"而不是"失败"；
 *   · 无订阅 → 真实记忆提交后面板不会更新；
 *   · 无作用域/版本守卫 → 切会话时旧响应迟到会覆盖新会话。
 *
 * 本模块把上述行为收口成**一个可核查的状态机**：
 *   作用域（sessionId）+ 请求身份（requestId）+ 头版本（headVersion）+ 订阅就绪握手。
 *
 * 纪律（对应任务书 §6.3/§6.4）：
 *   · 订阅**先于**快照读取建立；期间到达的更新被缓冲，读取完成后立刻补一次版本核对（关闭空窗）
 *   · 同作用域内按 headVersion 拒绝旧响应；跨会话一律丢弃
 *   · 打开即读（可见 + 就绪），关闭即取消在途读取并退订
 *   · 只做只读读取：不调模型、不写记忆、不重建向量
 *   · 不使用固定 setTimeout、不循环点击、不 reload、不改 srcdoc、不反复 remount
 */
import type { PanelEventPurpose, PanelSubscription, PanelEvent } from './panelProjection.ts';
import { subscribePanel, unsubscribePanel, routePanelEvent } from './panelProjection.ts';

/** 面板可见/就绪状态：真实可见性与会话就绪都由调用方给出（不靠轮询猜测） */
export interface PanelVisibility {
  /** 面板是否对用户可见（tab/抽屉打开） */
  visible: boolean;
  /** 会话是否就绪（sessionId 已确定且宿主可用） */
  sessionReady: boolean;
  /** 当前会话运行实例（用于过滤已失效实例的事件；不传 = 不过滤） */
  sessionRunId?: string;
}

export type MemoryPanelPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'pending';

/** 只读数据（全部来自既有只读入口；本类型不引入任何权威状态） */
export interface MemoryPanelData {
  states: unknown[];
  arcs: unknown[];
  meta: unknown;
  turnState: unknown;
  variables: unknown;
  characters: unknown[];
  /** 后端给出的头版本（会话状态版本 + 人物投影版本）；缺省 0 */
  headVersion: number;
  /** 待校验/未就绪项（关键人物事实存在待处理或冲突时显式暴露） */
  pending: string[];
  /**
   * AM-07：人物临时层只读投影 —— 已出现但**未到促升阈值**的候选，附促升阈值。
   * 与 `characters`（已准入投影）是不同层：这里的人**还没有**任何权威事实。
   * 绝不参与 prompt 装配，也不作为"记忆已完成"的依据。
   */
  pool: { threshold: number; entries: unknown[] };
}

export interface MemoryPanelState {
  phase: MemoryPanelPhase;
  sessionId: string | null;
  /** 会话是否就绪（未就绪时不得把空结果当最终成功） */
  sessionReady: boolean;
  error?: string;
  data?: MemoryPanelData;
  headVersion: number;
  /** 面板自身订阅是否已建立（就绪握手） */
  subscribed: boolean;
  /** 首次快照与订阅之间到达并被缓冲的更新数（空窗已关闭的证据） */
  bufferedUpdates: number;
  /** 被拒绝的旧响应/旧会话响应次数 */
  rejectedStale: number;
  /** 主动版本核对次数（再次打开时不只等未来事件） */
  versionChecks: number;
  /** 只读读取次数（供 T24 计数：必须与模型调用/记忆写入无关） */
  reads: number;
  /** 打开周期序号（同一作用域内的请求身份） */
  generation: number;
}

export interface MemoryPanelSyncOptions {
  /** 只读加载：由调用方注入真实 HTTP 入口（同一入口同时服务首开与手动刷新） */
  load: (sessionId: string, signal: AbortSignal) => Promise<MemoryPanelData>;
  /** 事件订阅标识（默认 'memory-console'；同一面板固定） */
  panelId?: string;
  /** 时间源（测试可注入） */
  now?: () => number;
}

const EMPTY: MemoryPanelState = {
  phase: 'idle',
  sessionId: null,
  sessionReady: false,
  headVersion: 0,
  subscribed: false,
  bufferedUpdates: 0,
  rejectedStale: 0,
  versionChecks: 0,
  reads: 0,
  generation: 0,
};

export class MemoryPanelSync {
  private state: MemoryPanelState = { ...EMPTY };
  private listeners = new Set<() => void>();
  private requestSeq = 0;
  /** 在途读取的取消标记（关闭面板/切会话时置位，响应回来即丢弃） */
  private inflight: { requestId: number; sessionId: string; cancelled: boolean; controller: AbortController } | null = null;
  /** 首次快照读取期间到达的更新：缓冲，读完立刻补一次核对 */
  private dirty = false;
  /** 已完成读取的完整数据（手动刷新失败时保留旧值，不清空） */
  private lastData: MemoryPanelData | null = null;
  private visibility: PanelVisibility = { visible: false, sessionReady: false };

  constructor(private opts: MemoryPanelSyncOptions) {}

  // ── React 外部存储接口（useSyncExternalStore） ──

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): MemoryPanelState => this.state;

  private emit(patch: Partial<MemoryPanelState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ── 打开 / 关闭 / 可见性 ──

  /**
   * 声明真实可见性与就绪条件。可见且就绪 → 自动读取（复用同一只读入口）；
   * 不可见 → 取消在途读取 + 退订（不取消 Agent 正常任务）。
   */
  async setVisibility(next: PanelVisibility, sessionId: string | null): Promise<void> {
    const prev = this.visibility;
    this.visibility = next;
    const sessionChanged = this.state.sessionId !== sessionId;

    if (!next.visible || !sessionId) {
      this.close();
      if (sessionChanged) this.emit({ sessionId: sessionId ?? null, sessionReady: next.sessionReady });
      return;
    }

    if (sessionChanged) {
      // 切换会话：先丢掉旧会话的一切（含在途读取），再按新作用域重建
      this.reset(sessionId, next.sessionReady);
      if (!next.sessionReady) {
        // 打开早于就绪：不请求、不缓存空结果，停留在明确的"等待就绪"状态
        this.emit({ phase: 'idle' });
        return;
      }
      await this.readOnce();
      return;
    }

    // 同会话：可见性变化
    if (!prev.visible && next.visible) {
      // 重新打开：主动核对版本（不能只等未来更新事件）
      if (!next.sessionReady) { this.emit({ phase: 'idle', sessionReady: false }); return; }
      await this.recheck();
      return;
    }
    if (!prev.sessionReady && next.sessionReady) {
      // 打开早于 session ready → 就绪后自动读取，不把之前的空结果当终态
      await this.recheck();
      return;
    }
    if (prev.sessionReady !== next.sessionReady) this.emit({ sessionReady: next.sessionReady });
  }

  private reset(sessionId: string, sessionReady: boolean): void {
    // 取消在途读取（请求身份推进 → 迟到响应被丢弃）
    if (this.inflight) { this.inflight.cancelled = true; this.inflight.controller.abort(); }
    this.inflight = null;
    this.dirty = false;
    this.lastData = null;
    if (this.state.subscribed) { unsubscribePanel(this.opts.panelId ?? 'memory-console'); }
    // 计数是**跨开关周期的累计诊断量**（不随切换/关闭归零，否则无法核查"是否真的零副作用"）
    this.emit({ ...EMPTY, ...this.carryCounters(), sessionId, sessionReady, generation: this.state.generation + 1 });
  }

  /** 需跨作用域保留的累计计数（诊断用；不参与业务判定） */
  private carryCounters(): Pick<MemoryPanelState, 'reads' | 'bufferedUpdates' | 'rejectedStale' | 'versionChecks' | 'generation'> {
    return {
      reads: this.state.reads, bufferedUpdates: this.state.bufferedUpdates,
      rejectedStale: this.state.rejectedStale, versionChecks: this.state.versionChecks,
      generation: this.state.generation,
    };
  }

  /** 再次打开时的主动版本核对：有数据且未标脏 → 仍读一次头版本（幂等只读） */
  async recheck(): Promise<void> {
    if (!this.state.sessionId) return;
    this.emit({ versionChecks: this.state.versionChecks + 1 });
    await this.readOnce();
  }

  /** 关闭：取消面板自己的在途读取 + 清理面板自己的订阅（不动 Agent 任务） */
  close(): void {
    if (this.inflight) { this.inflight.cancelled = true; this.inflight.controller.abort(); }
    this.inflight = null;
    this.dirty = false;
    // 关闭后可见性归位：再次打开必须被识别为"从关到开"，从而走主动版本核对
    this.visibility = { ...this.visibility, visible: false };
    if (this.state.subscribed) unsubscribePanel(this.opts.panelId ?? 'memory-console');
    this.emit({ ...EMPTY, ...this.carryCounters(), sessionId: this.state.sessionId, generation: this.state.generation + 1 });
  }

  /**
   * 真实提交事件：仅同会话、已订阅、头版本前进时才触发重读。
   * 重复通知（head 未前进）不重复读取，更不触发记忆写入。
   */
  onCommitted(ev: { sessionId?: string; headVersion?: number; purpose?: PanelEventPurpose }): void {
    if (!this.state.subscribed) return;
    if (ev.sessionId && ev.sessionId !== this.state.sessionId) return; // 其它会话不串数据
    // 必须携带**记忆作用域头版本**才算"记忆已完成"：正文流结束（message）不携带，
    // 因此不会冒充记忆提交、也不会为了无信息的通知反复读取。
    const head = ev.headVersion ?? 0;
    if (head <= 0) return;
    if (head <= this.state.headVersion) return; // 旧/重复通知不回退
    if (this.inflight) {
      // 首快照与订阅之间的空窗：先记脏，读完立即补一次
      this.dirty = true;
      this.emit({ bufferedUpdates: this.state.bufferedUpdates + 1 });
      return;
    }
    void this.readOnce();
  }

  /** 宿主事件入口（复用既有面板事件路由做目标过滤，不新增机制） */
  handleHostEvent(ev: PanelEvent): void {
    const panelId = this.opts.panelId ?? 'memory-console';
    const sub: PanelSubscription = {
      purposes: ['session-state', 'message-state', 'message'],
      target: { sessionId: this.state.sessionId ?? '', sessionRunId: this.visibility.sessionRunId ?? '' },
    };
    const d = routePanelEvent(sub, ev);
    if (!d.deliver) return;
    this.onCommitted({ sessionId: ev.sessionId, purpose: ev.purpose });
  }

  // ── 读取（唯一入口：首开 / 再次打开 / 手动刷新 / 提交后同步都走它） ──

  /** 手动刷新 = 人工重试；与非手动路径同一入口，只是允许重试失败态 */
  async refreshManually(): Promise<void> {
    await this.readOnce();
  }

  private async readOnce(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId || !this.visibility.visible || !this.visibility.sessionReady) return;

    // ① 订阅先于快照读取建立（就绪握手）——避免"订阅前发生提交 → 永久漏掉"
    if (!this.state.subscribed) {
      subscribePanel(this.opts.panelId ?? 'memory-console', {
        purposes: ['session-state', 'message-state', 'message'],
        target: { sessionId, sessionRunId: this.visibility.sessionRunId ?? '' },
        watchMessages: true,
      });
      this.emit({ subscribed: true });
    }

    const requestId = ++this.requestSeq;
    const controller = new AbortController();
    const handle = { requestId, sessionId, cancelled: false, controller };
    this.inflight = handle;
    this.emit({ phase: 'loading', error: undefined, reads: this.state.reads + 1 });
    try {
      // 真实取消：关闭面板/切会话时中止在途 HTTP（不只是丢弃结果）
      const data = await this.opts.load(sessionId, controller.signal);
      // ② 请求身份 / 会话作用域双重守卫：迟到或跨会话响应一律丢弃
      if (handle.cancelled || this.requestSeq !== requestId || this.state.sessionId !== sessionId) {
        this.emit({ rejectedStale: this.state.rejectedStale + 1 });
        return;
      }
      // ③ 同作用域内按头版本拒绝旧响应（不回退显示）
      if (this.lastData && data.headVersion < this.state.headVersion) {
        this.emit({ rejectedStale: this.state.rejectedStale + 1, phase: 'ready' });
        return;
      }
      this.lastData = data;
      // 「空」的判据含池子：有排队候选时不该显示"本会话暂无记忆数据"（会误导成"什么都没发生"）
      const empty = data.states.length === 0 && data.arcs.length === 0
        && data.characters.length === 0 && data.pool.entries.length === 0;
      const phase: MemoryPanelPhase = data.pending.length > 0 ? 'pending' : empty ? 'empty' : 'ready';
      this.emit({
        phase, data, headVersion: Math.max(this.state.headVersion, data.headVersion), error: undefined,
      });
    } catch (e) {
      if (handle.cancelled) {
        // 主动取消：若原因是**切换了会话**，这条响应就是"旧会话迟到响应" → 记为拒绝（不回退、不串数据）
        if (this.state.sessionId !== sessionId) this.emit({ rejectedStale: this.state.rejectedStale + 1 });
        return;
      }
      if (this.state.sessionId !== sessionId) return;
      // 失败**保留**上一次成功数据（不清空），并明确标识失败态（区别于"空数据"）
      this.emit({ phase: 'error', error: (e as Error).message || '读取失败' });
    } finally {
      if (this.inflight?.requestId === requestId) this.inflight = null;
      // ④ 关闭空窗：读取期间到达的更新，读完立即补一次核对
      if (this.dirty) {
        this.dirty = false;
        if (this.visibility.visible && this.state.sessionReady) void this.readOnce();
      }
    }
  }

  /** 只读诊断（测试与真实验收共用；不产生任何业务副作用） */
  diagnostics(): {
    phase: MemoryPanelPhase; sessionId: string | null; headVersion: number; subscribed: boolean;
    reads: number; bufferedUpdates: number; rejectedStale: number; versionChecks: number; modelCalls: number; memoryWrites: number;
  } {
    return {
      phase: this.state.phase, sessionId: this.state.sessionId, headVersion: this.state.headVersion,
      subscribed: this.state.subscribed, reads: this.state.reads, bufferedUpdates: this.state.bufferedUpdates,
      rejectedStale: this.state.rejectedStale, versionChecks: this.state.versionChecks,
      // 本控制器**不拥有**任何写入口：这两项恒为 0，是结构保证而非运行期侥幸
      modelCalls: 0, memoryWrites: 0,
    };
  }
}
