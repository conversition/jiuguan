/**
 * FE-06.0 最小接口策略（bridge / noop / local）
 *
 * 目的：把「页面真实调用的接口」按**执行者**分流，避免两件事同时发生——
 *   ① 旧后台与 Agent 重复执行同一份业务（重复生成 / 重复变量更新 / 重复摘要记忆）；
 *   ② 把已经真实工作的能力（用户保存开局、状态读取、草稿）一刀切成空操作。
 *
 * 三条纪律（**实现与审计都以本文件为准**）：
 *   1. **禁止按名一刀切**：`replaceMvuData` / `replaceVariables` 既可能来自「用户点击保存开局」
 *      （bridge，必须保留），也可能来自旧变量后台。后者通过**脚本执行清单停用来源**解决，
 *      绝不把这个共享函数全局改成 noop。规则里的 `deactivatedAtSource` 就是这条纪律的载体。
 *   2. **noop 必须形状正确**：同步保持同步、异步正常结束；返回结构与既有契约一致；
 *      不抛未捕获异常、不无限等待、不新增模型请求、不写权威数据、不伪造提交事件。
 *   3. **真实失败不得被吞**：noop 只覆盖「确认不需要的调用」；bridge 路径上的版本冲突 /
 *      权限失败 / 写入失败仍以 error 回给调用方，由页面接住提示。
 *
 * 分层归属同 `session-scripts.ts`：通用核心 / 协议适配 / 卡片配置。
 * 本模块**纯逻辑**（不依赖 DOM / React / 浏览器 API），可 node 直测。
 */

export type IfaceMode = 'bridge' | 'noop' | 'local';
export type IfaceLayer = 'common-core' | 'protocol-adapter' | 'card-config';
/** 接口形态：rpc（宿主 ⇄ iframe 远程调用）/ host-api（注册在 __jgHostApi 的按名能力）/ event（事件订阅） */
export type IfaceKind = 'rpc' | 'host-api' | 'event';

/** 空操作/本地处理的返回形状声明（**必须显式**，否则调用方拿到的结构不可预期） */
export interface IfaceShape {
  /** true → 返回 Promise（正常 resolve，不 reject）；false → 同步返回 */
  async: boolean;
  /** resolve 值 / 同步返回值 */
  value: unknown;
  /** 形状说明（报告与诊断展示） */
  describe: string;
}

export interface IfaceRule {
  kind: IfaceKind;
  /** `ns.op`（rpc）/ 能力名（host-api / event） */
  name: string;
  mode: IfaceMode;
  layer: IfaceLayer;
  reason: string;
  /** noop / local 必须声明返回形状 */
  shape?: IfaceShape;
  /**
   * 该调用若来自「已由 Agent 接管的重复后台」——
   * **停用的是来源（脚本执行清单 / 调度源），不是这个函数本身**。
   */
  deactivatedAtSource?: string;
  /** 业务由谁接管（可审计） */
  supersededBy?: string;
}

/** 已知不支持能力的统一哨兵（可判别，不是 reject —— 避免 fire-and-forget 产生未捕获 rejection） */
export function unsupportedSentinel(name: string): { ok: false; unsupported: string } {
  return { ok: false, unsupported: name };
}

// ────────────────────────── 映射表 ──────────────────────────

/**
 * 页面真实调用的接口清单。
 * 取值依据：`App.tsx` 的 `handleRpcMessage`（rpc）+ `htmlCore.ts` 的 `ST_COMPAT_SNIPPET`（host-api / event）。
 * 新增接口必须先在此登记（**默认拒绝**：未登记即报错，不静默放行）。
 */
export const INTERFACE_RULES: IfaceRule[] = [
  // ═══ rpc：宿主能力往返 ═══
  { kind: 'rpc', name: 'message.send', mode: 'bridge', layer: 'protocol-adapter', reason: '把草稿/发送交给 Agent 主聊天入口（卡内选项与草稿链由此生效）' },
  { kind: 'rpc', name: 'theme.get', mode: 'local', layer: 'common-core', reason: '纯前端状态（主题）', shape: { async: false, value: { theme: 'dark' }, describe: '同步返回当前主题；真实值由调用处注入' } },
  { kind: 'rpc', name: 'viewport.get', mode: 'local', layer: 'common-core', reason: '纯前端状态（视口尺寸）', shape: { async: false, value: { w: 0, h: 0 }, describe: '同步返回视口尺寸；真实值由调用处注入' } },
  {
    kind: 'rpc', name: 'ai.generate', mode: 'bridge', layer: 'protocol-adapter',
    reason: '页面**主动请求**的静默生成（如卡内独立对话）；转发到 Agent /quiet 入口',
    deactivatedAtSource: '旧自动生成后台（卡自带定时/自动调用）由脚本执行清单停用其脚本来源',
    supersededBy: 'Agent 主生成入口',
  },
  { kind: 'rpc', name: 'session.getContext', mode: 'bridge', layer: 'protocol-adapter', reason: '会话真实数据快照（name1/name2/character/chat/worldbooks）' },
  { kind: 'rpc', name: 'variables.get', mode: 'bridge', layer: 'common-core', reason: '读取会话变量（页面展示用）' },
  {
    kind: 'rpc', name: 'variables.replace', mode: 'bridge', layer: 'common-core',
    reason: '**用户保存**路径必须保留（开局写入即走这里）；不得全局改空操作',
    deactivatedAtSource: '重复变量后台的调用来源由脚本执行清单停用（脚本不进执行序即不会发出该调用）',
  },
  {
    kind: 'rpc', name: 'prompt.setExtensionPrompt', mode: 'noop', layer: 'protocol-adapter',
    reason: '旧后台向提示词再注入一遍；提示词统一由 Agent 组装入口产生',
    shape: { async: false, value: unsupportedSentinel('prompt.setExtensionPrompt'), describe: '同步返回 {ok:false, unsupported}（可判别哨兵，不 reject、不排队、不改扩展设置）' },
    deactivatedAtSource: '旧提示词后台由脚本执行清单停用',
    supersededBy: 'Agent 提示词组装入口',
  },
  { kind: 'rpc', name: 'message.lastId', mode: 'bridge', layer: 'common-core', reason: '读取最后一条消息身份（楼层定位需要）' },
  { kind: 'rpc', name: 'worldbook.names', mode: 'bridge', layer: 'protocol-adapter', reason: '世界书名称镜像（卡自身探测依赖）' },
  { kind: 'rpc', name: 'worldbook.get', mode: 'bridge', layer: 'protocol-adapter', reason: '读取世界书条目（卡内逻辑需要）' },
  { kind: 'rpc', name: 'worldbook.update', mode: 'bridge', layer: 'protocol-adapter', reason: '**用户/卡真实写入**路径；applied=0 必须报错而非假成功' },
  { kind: 'rpc', name: 'mvu.get', mode: 'bridge', layer: 'common-core', reason: '按作用域读取权威状态（FE-C1 StateStore）' },
  {
    kind: 'rpc', name: 'mvu.replace', mode: 'bridge', layer: 'common-core',
    reason: '**用户保存开局**路径必须保留；不得全局改空操作',
    deactivatedAtSource: '重复变量后台的来源由脚本执行清单停用',
  },
  { kind: 'rpc', name: 'asset.resolve', mode: 'bridge', layer: 'protocol-adapter', reason: '资产索引查询 + 本地代理 URL（FE-03 统一加载链）' },
  {
    kind: 'rpc', name: 'message.cancel', mode: 'bridge', layer: 'common-core',
    reason: '显式中止进行中的主对话回合（复用既有 /turn/abort + 落库定局）；**只对声明可取消的任务生效**',
  },

  // ═══ host-api：注册在 __jgHostApi / getSTFn 的按名能力 ═══
  { kind: 'host-api', name: 'toastr', mode: 'local', layer: 'common-core', reason: '界面提示，仅宿主侧日志输出', shape: { async: false, value: 'toastrImpl', describe: '同步返回 {info,success,warning,error,remove,clear} 空实现（只托管提示，不触达后端）' } },
  { kind: 'host-api', name: 'getVariables', mode: 'bridge', layer: 'common-core', reason: '同步镜像 + 在途刷新（卡对变量是同步读属性用法）' },
  { kind: 'host-api', name: 'replaceVariables', mode: 'bridge', layer: 'common-core', reason: '用户保存路径；不得改空操作' },
  { kind: 'host-api', name: 'getWorldbook', mode: 'bridge', layer: 'protocol-adapter', reason: '世界书读取' },
  { kind: 'host-api', name: 'getCharWorldbookNames', mode: 'bridge', layer: 'protocol-adapter', reason: '世界书名称镜像（卡检测依赖时同步读）' },
  { kind: 'host-api', name: 'updateWorldbookWith', mode: 'bridge', layer: 'protocol-adapter', reason: '世界书回调式写入（只提交变化条目）' },
  { kind: 'host-api', name: 'getLastMessageId', mode: 'bridge', layer: 'common-core', reason: '消息身份读取' },
  { kind: 'host-api', name: 'Mvu', mode: 'bridge', layer: 'protocol-adapter', reason: '真实状态读写门面（getMvuData/replaceMvuData）' },
  { kind: 'host-api', name: 'waitGlobalInitialized', mode: 'bridge', layer: 'protocol-adapter', reason: '仅在宿主真实往返成功后才 resolve（不无条件冒充已就绪）' },
  { kind: 'host-api', name: 'SillyTavern.getContext', mode: 'bridge', layer: 'protocol-adapter', reason: '会话上下文兼容对象（按需回填真实数据）' },
  { kind: 'host-api', name: 'session.setExtensionPrompt', mode: 'noop', layer: 'protocol-adapter', reason: '同 prompt.setExtensionPrompt：旧后台重复注入提示词', shape: { async: true, value: unsupportedSentinel('prompt.setExtensionPrompt'), describe: '返回 Promise.resolve({ok:false,unsupported})' }, supersededBy: 'Agent 提示词组装入口' },
  { kind: 'host-api', name: 'session.addOneMessage', mode: 'noop', layer: 'protocol-adapter', reason: '旧后台绕过 Agent 直插消息', shape: { async: true, value: unsupportedSentinel('message.addOneMessage'), describe: '返回 Promise.resolve({ok:false,unsupported})' }, deactivatedAtSource: '旧消息后台由脚本执行清单停用', supersededBy: 'Agent 消息入口' },
  { kind: 'host-api', name: 'session.addMessages', mode: 'noop', layer: 'protocol-adapter', reason: '同上（批量）', shape: { async: true, value: unsupportedSentinel('message.addMessages'), describe: '返回 Promise.resolve({ok:false,unsupported})' }, deactivatedAtSource: '旧消息后台由脚本执行清单停用', supersededBy: 'Agent 消息入口' },
  { kind: 'host-api', name: 'session.executeSlashCommands', mode: 'noop', layer: 'protocol-adapter', reason: '斜杠命令桥未接入；空执行不排队、不产生副生成', shape: { async: false, value: '', describe: '同步返回空字符串（与 ST 期望的“无输出”一致）' } },
  { kind: 'host-api', name: 'SillyTavern.saveMacros', mode: 'noop', layer: 'protocol-adapter', reason: '宏保存未接入（宏由 Agent 侧模板处理）', shape: { async: true, value: unsupportedSentinel('macros.save'), describe: '返回 Promise.resolve({ok:false,unsupported})' }, supersededBy: 'Agent 模板/宏处理' },
  { kind: 'host-api', name: 'characters', mode: 'local', layer: 'common-core', reason: '空注册表，仅界面占位', shape: { async: false, value: {}, describe: '同步返回空对象' } },
  { kind: 'host-api', name: 'events', mode: 'local', layer: 'common-core', reason: '事件名注册表占位（真实订阅走本模块 event 规则）', shape: { async: false, value: {}, describe: '同步返回空对象' } },

  // ═══ event：事件订阅（**不得全部清空**）═══
  {
    kind: 'event', name: 'Mvu.on', mode: 'bridge', layer: 'protocol-adapter',
    reason: '**必须真实工作**：宿主状态提交后触发 VARIABLE_UPDATE_ENDED，页面据此刷新镜像',
  },
  {
    kind: 'event', name: 'eventSource.on', mode: 'bridge', layer: 'protocol-adapter',
    reason: '真实事件总线；未订阅到的无关事件保持空订阅（不吞、不伪造）',
  },
  {
    kind: 'event', name: 'eventSource.emit', mode: 'local', layer: 'protocol-adapter',
    reason: '页面内自触发事件（不触达后端）',
    shape: { async: false, value: undefined, describe: '同步返回 undefined，仅在本 iframe 内派发' },
  },
  {
    kind: 'event', name: 'Mvu.off', mode: 'local', layer: 'protocol-adapter',
    reason: '纯前端订阅表操作',
    shape: { async: false, value: undefined, describe: '同步返回 undefined' },
  },
];

// ────────────────────────── 查询与执行策略 ──────────────────────────

export interface IfacePolicyResult {
  /** 未登记时为 undefined —— 调用方必须**明确拒绝**，不得静默放行 */
  rule?: IfaceRule;
  mode: IfaceMode | 'unclaimed';
  reason: string;
}

const RULE_INDEX = new Map<string, IfaceRule>();
for (const r of INTERFACE_RULES) RULE_INDEX.set(`${r.kind}:${r.name}`, r);

/** 查询某个接口的执行策略（纯函数；未登记返回 unclaimed） */
export function resolveIfacePolicy(kind: IfaceKind, name: string): IfacePolicyResult {
  const rule = RULE_INDEX.get(`${kind}:${name}`);
  if (!rule) return { mode: 'unclaimed', reason: `未登记接口 ${kind}:${name}（默认拒绝，不静默放行）` };
  return { rule, mode: rule.mode, reason: rule.reason };
}

/**
 * 构造 noop / local 的返回者。
 * 保证：同步仍同步、异步正常 resolve、**永不 reject**、不排队、不重试。
 */
export function buildStubReturner(shape: IfaceShape): () => unknown {
  if (shape.async) return () => Promise.resolve(shape.value);
  return () => shape.value;
}

/**
 * 诊断/报告用：策略表摘要（按模式分组），供「由 Agent 接管」的表达使用。
 * 注意：这只是**执行策略**的表达，不是「原版引擎已验证」的声明。
 */
export function summarizeIfacePolicy(): {
  bridge: string[]; noop: string[]; local: string[];
  deactivated: { name: string; source: string; supersededBy?: string }[];
} {
  const pick = (m: IfaceMode) => INTERFACE_RULES.filter((r) => r.mode === m).map((r) => `${r.name}`);
  return {
    bridge: pick('bridge'),
    noop: pick('noop'),
    local: pick('local'),
    deactivated: INTERFACE_RULES.filter((r) => r.deactivatedAtSource).map((r) => ({
      name: r.name, source: r.deactivatedAtSource!, supersededBy: r.supersededBy,
    })),
  };
}

/**
 * 「原版变量演化」的表达（FE-06.0 任务 B）：不伪称原版引擎已验证，也不把它当成阻断项。
 * 返回的是**执行策略**，运行时仍以实测为准（见 sharedRuntime 的能力实测）。
 */
export function legacyBackendStatus(): {
  mode: 'agent-led';
  originalVariableTurn: 'not-running';
  businessExecutor: 'agent';
  pageVariableRead: 'state-store-bridge';
  legacyVariableBackend: 'noop';
  note: string;
} {
  return {
    mode: 'agent-led',
    originalVariableTurn: 'not-running',
    businessExecutor: 'agent',
    pageVariableRead: 'state-store-bridge',
    legacyVariableBackend: 'noop',
    note: '原版 MVU 演化路径本轮不运行（未加载，也不伪称已验证）；页面变量读取走 StateStore；'
      + '重复后台保留标准空接口并停用其调度来源。',
  };
}

/**
 * 重复后台是否真的被停用（**证据来自脚本执行清单，而不是本表**）。
 * 未登记 = 该来源没有声明停用依据 → 不得宣称「已让位」。
 */
export function verifyDeactivationEvidence(
  claimed: { name: string; supersededBy?: string }[],
  deferredScriptNames: string[],
): { name: string; ok: boolean; reason: string }[] {
  return claimed.map((c) => {
    const hit = deferredScriptNames.some((n) => {
      const key = c.name.split('.').pop() ?? c.name;
      return n.includes(key) || key.includes(n);
    });
    return {
      name: c.name,
      ok: hit,
      reason: hit
        ? '来源脚本已进入 deferred（执行序外）→ 不会发起该调用'
        : '未找到停用依据：需确认该后台脚本已 deferred，或本项仍会真实发出调用',
    };
  });
}
