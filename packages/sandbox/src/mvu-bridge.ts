/**
 * sandbox 包 - MVU 引擎 ↔ VMS 桥（接入回合，Phase 3 收尾）
 *
 * 职责（用户指令：MVU 引擎接入回合）：
 *  1. 在沙箱中零转译运行角色卡原生的 MVU 引擎脚本（魔法少女卡 34.5KB v23.5）
 *  2. 提供 lodash 白名单子集 `_`（引擎硬依赖：cloneDeep/get/set/isEqual/random/sample/uniq）
 *  3. stat_data 全量状态：启动时从 memory_state(entity_type='mvu') 恢复，否则用 schema 默认值起步
 *  4. AI 回合后驱动 tick：追加 assistant 消息到聊天上下文 → emit VARIABLE_UPDATE_ENDED{stat_data}
 *     → 引擎原地变更状态（确定性计算）→ 扁平化叶子 → 同步 VMS（session:mvu:<path>）→ 持久化
 *  5. 回合前：VMS 值经 expandVariables 宏注入提示词（已支持中文/点路径键）
 *
 * 桥接语义（对齐 MagVarUpdate）：
 *  - Mvu.get(name) / Mvu.set(name, value)：点路径读写 state（引擎未来版本/外部工具使用）
 *  - VARIABLE_UPDATE_ENDED 事件载荷：{ stat_data }（引擎 init 订阅时解包 wrapper?.stat_data）
 *  - 引擎的"防火墙"：chat 最后一条是 user/system 时跳过计算 → 只在 AI 回复落库后驱动 tick
 */
import { MvuSandbox } from './mvu-sandbox.ts';
import { lodashGet, lodashSet, lodashIsEqual, lodashCloneDeep } from './lodash.ts';
import type { MemoryDb } from '../../memory/src/db.ts';
import type { VariableManager } from '../../variable/src/vms.ts';
import type { VarValue } from '../../variable/src/dsl.ts';

export interface MvuBridgeOptions {
  /** 角色卡名（持久化 entity_id / VMS source 标识） */
  cardName: string;
  /** 引擎脚本源码（tavern_helper.scripts 中 >10KB 的监控器脚本） */
  engineScript: string;
  /** 记忆库（持久化 stat_data 快照） */
  db: MemoryDb;
  /** 变量管理器（叶子同步目标） */
  vms: VariableManager;
  /** 首次启动的初始状态（缺省用 schema 默认值） */
  starterState?: Record<string, unknown>;
  /** 沙箱同步执行超时（ms） */
  timeoutMs?: number;
}

export interface EngineTickResult {
  /** 本轮引擎变更的叶子路径 */
  changed: string[];
  /** 状态叶子总数 */
  leaves: number;
  /** 引擎计算耗时（ms） */
  elapsedMs: number;
}

/** 引擎状态叶子（path 为点路径，fullName 为 VMS 完整名） */
export interface EngineFlatEntry {
  path: string;
  fullName: string;
  value: VarValue;
}

/** 兼容 zod schema 默认值的起步状态（进程.阶段=幕间休息 → 首轮引擎必然执行幕间回合计数） */
export function defaultStarterState(): Record<string, unknown> {
  return {
    进程: { 阶段: '幕间休息' },
    世界: {
      日期: 305,
      威胁等级: 1,
      世界观备注: { 基础设定: '无任何特殊设定。' },
      当前关卡: { 名称: '无', 战斗类型: '无', Boss韧性值: 0, Boss状态: '完好', 核心主题: [] },
      幕间H事件: { 名称: '无', 核心主题: [] },
    },
    主角: {
      核心状态: {
        人格状态: '善良', 变身状态: false,
        体力值: { 当前: 100, 最大: 100 }, 魔力值: { 当前: 100, 最大: 100 },
        净化之力: 0, 污秽魔力: 0, 当前战斗姿态: '非战斗', 基础强度: 0,
      },
      快感状态: { 快感值: 0, 高潮阈值: 100, 总高潮次数: 0, 污染度: 0, 性癖: {} },
      淫纹: { 经验: 0 },
      生理状态: {
        体液与分泌: { 子宫内精液: { 存量: 0, 来源: {} } },
        阴道状态: { 最大容量: 50 },
        子宫状态: { 受孕状态: '未受孕' },
      },
      战斗临时: { 当前战斗日志: '无', 临时强度加值: 0 },
      身体部位状况: { 面部: '完好', 胸部: '完好', 手臂: '完好', 腰腹: '完好', 臀部: '完好', 私处: '完好', 腿部: '完好' },
    },
    系统状态: { 待处理事件: {}, 主角创建完毕: false, 幕间事件完成: true, 幕间回合计数: 0, Boss生成主题池: [] },
    记录: {},
  };
}

/** 扁平化状态叶子：递归展开对象，跳过 $ 前缀元键，数组整体序列化 */
export function flattenLeaves(obj: unknown, prefix = '', out: Map<string, VarValue> = new Map()): Map<string, VarValue> {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    const path = prefix;
    if (path) out.set(path, JSON.stringify(obj));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('$')) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') {
        flattenLeaves(v, path, out);
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out.set(path, v);
      }
    }
  }
  return out;
}

export class MvuBridge {
  readonly scope = 'session';
  readonly source = 'mvu';

  private state: Record<string, unknown>;
  private sandbox: MvuSandbox;
  private registeredPaths = new Set<string>();
  private synced = new Map<string, VarValue>();
  private ready = false;

  constructor(private opts: MvuBridgeOptions) {
    this.state = this.loadPersisted() ?? opts.starterState ?? defaultStarterState();
    this.sandbox = new MvuSandbox({ timeoutMs: opts.timeoutMs ?? 5000 });
  }

  /** 启动：注入 lodash → 安装 Mvu mock（桥接 state）→ 运行引擎 → 等待 init → 首次同步 */
  async start(): Promise<void> {
    const sb = this.sandbox;
    sb.installLodash();
    sb.installMvuMock({
      get: (name: string) => lodashGet(this.state, name),
      set: (name: string, value: unknown) => { lodashSet(this.state, name, value); },
    });
    sb.setChat([]);
    sb.run(this.opts.engineScript, 'card-engine.js');
    await this.waitForInit(8000);
    this.syncToVms();
    this.persist(0);
    this.ready = true;
  }

  /** AI 回合后驱动引擎 tick（同步）：聊天上下文末条必须是 assistant，否则引擎防火墙跳过 */
  tickAfterAiTurn(chat: { is_user?: boolean; is_system?: boolean; content?: string }[], round: number): EngineTickResult {
    const before = this.getFlatLeaves();
    const t0 = Date.now();
    if (this.ready) {
      this.sandbox.setChat(chat);
      this.sandbox.emitMvuEvent('VARIABLE_UPDATE_ENDED', { stat_data: this.state });
    }
    const after = this.getFlatLeaves();
    const changed: string[] = [];
    for (const [path, value] of after) {
      if (!before.has(path) || !lodashIsEqual(before.get(path), value)) changed.push(path);
    }
    this.syncToVms();
    this.persist(round);
    return { changed, leaves: after.size, elapsedMs: Date.now() - t0 };
  }

  /** 扁平叶子（VMS 完整名 → 值），供提示词宏展开 */
  getFlat(): Record<string, VarValue> {
    const out: Record<string, VarValue> = {};
    for (const [path, value] of this.getFlatLeaves()) {
      out[this.fullName(path)] = value;
    }
    return out;
  }

  /** 引擎状态块（<动态状态> 注入）：稳定排序 + 截断 */
  getStateBlock(maxLen = 600): string {
    const entries = [...this.getFlatLeaves().entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const lines: string[] = [];
    let len = 0;
    for (const [path, value] of entries) {
      const line = `${path} = ${String(value)}`;
      if (len + line.length > maxLen) {
        lines.push(`…（已截断 ${entries.length - lines.length} 项）`);
        break;
      }
      lines.push(line);
      len += line.length + 1;
    }
    return `<引擎状态>\n${lines.join('\n')}\n</引擎状态>`;
  }

  /** 引擎日志（调试/前端展示） */
  getLogs(): string[] {
    return this.sandbox.getLogs();
  }

  isReady(): boolean {
    return this.ready;
  }

  /** 沙箱内调试求值 */
  evalInSandbox(expr: string): unknown {
    return this.sandbox.evalInSandbox(expr);
  }

  dispose(): void {
    this.sandbox.dispose();
  }

  // ── 内部 ──

  private fullName(path: string): string {
    return `${this.scope}:${this.source}:${path}`;
  }

  private getFlatLeaves(): Map<string, VarValue> {
    return flattenLeaves(this.state);
  }

  /** 叶子 → VMS：新路径注册，变更路径 set（version++，layers 可视化可见） */
  private syncToVms(): void {
    for (const [path, value] of this.getFlatLeaves()) {
      const full = this.fullName(path);
      if (!this.registeredPaths.has(full)) {
        this.opts.vms.register({ scope: this.scope, source: this.source, name: path, type: 'literal', value });
        this.registeredPaths.add(full);
        this.synced.set(full, value);
      } else if (!lodashIsEqual(this.synced.get(full), value)) {
        this.opts.vms.set(full, value);
        this.synced.set(full, value);
      }
    }
  }

  /** 持久化 stat_data 全量快照（memory_state entity_type='mvu'，FTS 可检索） */
  private persist(round: number): void {
    const existing = this.opts.db.db.prepare("SELECT id FROM memory_state WHERE entity_type = 'mvu' AND entity_id = ?")
      .get(this.opts.cardName) as { id: number } | undefined;
    const json = JSON.stringify(this.state);
    if (existing) {
      this.opts.db.db.prepare('UPDATE memory_state SET state_json = ?, updated_round = ? WHERE id = ?')
        .run(json, round, existing.id);
    } else {
      this.opts.db.db.prepare(
        "INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round) VALUES ('mvu', ?, '引擎状态', ?, ?)"
      ).run(this.opts.cardName, json, round);
    }
  }

  private loadPersisted(): Record<string, unknown> | undefined {
    try {
      const row = this.opts.db.db.prepare("SELECT state_json FROM memory_state WHERE entity_type = 'mvu' AND entity_id = ?")
        .get(this.opts.cardName) as { state_json: string } | undefined;
      if (!row?.state_json) return undefined;
      const parsed = JSON.parse(row.state_json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 等待引擎 init 完成（setTimeout(1500) → init() → eventOn 订阅 → initialized=true） */
  private async waitForInit(timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ok = this.sandbox.evalInSandbox('(window.MagicGirlEngineInstance && window.MagicGirlEngineInstance.initialized) === true');
      if (ok === true) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    // 超时：引擎 retry 机制（≤10 次 × 2s）可能仍在尝试；不抛错，tick 侧会兜底同步
  }
}
