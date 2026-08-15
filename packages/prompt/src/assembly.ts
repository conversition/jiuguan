/**
 * prompt 包 - 提示词装配管道（v2 07 §3 ① / 04 §4.3）
 * 输入各层（L0 系统核心 + L1 静态设定 + L2 动态状态 + L3 记忆块 + 对话历史 + 用户输入）
 * → OpenAI 兼容消息数组 + tools 定义。
 * 铁律：稳定前缀在前（L0/L1/L2 静态部分），易变内容（记忆/输入）在后，缓存友好。
 */
import { gameTurnTool } from './turn.ts';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AssembleInput {
  /** L0 系统核心（稳定前缀，逐字不变） */
  systemCore: string;
  /** L1 静态设定（角色卡描述 + 激活世界书条目，平台注入） */
  staticSettings?: string;
  /** L2 动态状态（表0-5 紧凑表格 + 推进槽 + 平行事件） */
  dynamicState?: string;
  /** L3 记忆召回块（<记忆召回> 注入块，来自记忆服务） */
  memoryBlock?: string;
  /** 对话历史（近 N 轮原文 + 更早滚动摘要） */
  chatHistory?: Message[];
  /** 用户本轮输入（已包裹 <最新互动>） */
  userInput: string;
  /** 上一轮 game.turn 结果（首轮为空） */
  lastTurn?: string;
  /** 注入点：NSFW/NSF 分支模块（默认空） */
  nsfwModule?: string;
  /** 预设生效块（启动流程审查 P0：用户选定预设 + 块勾选 → <预设> 注入） */
  presetBlocks?: string[];
  /** 是否附加 tools 定义（模式 A）；false 时使用 XML 降级指令 */
  useTools?: boolean;
  /** 稳定前缀目标（OpenAI 兼容隐式前缀缓存 ≥1024 tokens 门槛；审查 §4.2） */
  prefixCacheThreshold?: number;
  /** VMS 变量值（宏展开用，06 §6） */
  variableValues?: Record<string, string | number | boolean>;
}

export interface AssembleResult {
  messages: Message[];
  tools?: Record<string, unknown>[];
  /** 稳定前缀长度（缓存断点参考） */
  stablePrefixTokens: number;
}

/** 粗估 token：中文 1 字 ≈ 1.5 token，英文 1 词 ≈ 1.3 token */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest * 0.4);
}

/** 宏展开：替换 {{var:key}} / {{var:ns:key}} / {{getvar::key}} / {{getvar::key::default}} 为变量值（VMS 集成点，06 §6）
 * 查找策略：完整键 > 短名（key 尾部段）> 后缀匹配（:name 结尾）
 * 键放宽：支持中文与点路径（引擎变量如 {{var:主角.核心状态.魔力值.当前}}），见 v1.1 引擎桥接 */
export function expandVariables(text: string, values: Record<string, string | number | boolean>): string {
  const lookup = (key: string): string | number | boolean | undefined => {
    if (key in values) return values[key];
    const short = key.split(':').pop() ?? key;
    for (const [k, v] of Object.entries(values)) {
      if (k === short || k.endsWith(`:${short}`)) return v;
    }
    return undefined;
  };
  return text
    .replace(/\{\{var:([^}\s]+?)\}\}/g, (_m, key: string) => {
      const v = lookup(key);
      return v === undefined ? '' : String(v);
    })
    .replace(/\{\{getvar::([^}]+?)(?:::(.*?))?\}\}/g, (_m, key: string, def: string) => {
      const v = lookup(key);
      return v === undefined ? (def ?? '') : String(v);
    });
}

/** 组装本轮请求 */
export function assembleTurn(input: AssembleInput): AssembleResult {
  const messages: Message[] = [];
  const threshold = input.prefixCacheThreshold ?? 1024;

  // 1. L0 系统核心 + NSFW 分支 + 稳定静态层（全部进 system，稳定前缀）
  let system = input.systemCore;
  if (input.nsfwModule) system += `\n\n${input.nsfwModule}`;
  if (input.staticSettings) system += `\n\n<静态设定>\n${input.staticSettings}\n</静态设定>`;
  if (input.presetBlocks && input.presetBlocks.length > 0) {
    system += `\n\n<预设>\n${input.presetBlocks.join('\n\n')}\n</预设>`;
  }
  if (input.dynamicState) system += `\n\n<动态状态>\n${input.dynamicState}\n</动态状态>`;
  // 2. 前缀缓存填充：稳定前缀不足阈值时循环追加固定平台声明段（每段逐字不变，审查 §4.2 门槛）
  // 修复 §5.3：去掉硬上限（仅以防卫上限 256 防止异常阈值死循环，模运算循环段可无限扩展）
  let guard = 0;
  while (estimateTokens(system) < threshold && guard < 256) {
    system += `\n\n${PLATFORM_PADDING_SEGMENTS[guard % PLATFORM_PADDING_SEGMENTS.length]}`;
    guard++;
  }
  messages.push({ role: 'system', content: system });

  // 2. 对话历史（user/assistant 交替）
  if (input.chatHistory) messages.push(...input.chatHistory);

  // 3. 用户输入（记忆块 + 上轮结果 + 输入，均为易变尾部）；宏展开（VMS 变量）
  let userContent = '';
  if (input.memoryBlock) userContent += `${input.memoryBlock}\n\n`;
  if (input.lastTurn) userContent += `<上一轮编排>\n${input.lastTurn}\n</上一轮编排>\n\n`;
  const inputExpanded = input.variableValues ? expandVariables(input.userInput, input.variableValues) : input.userInput;
  if (input.useTools) {
    userContent += `${inputExpanded}\n\n请调用 game.turn 工具完成本轮回合。`;
  } else {
    // XML 降级：输出契约指令（对齐 L4 降级模板）
    userContent += `${inputExpanded}\n\n严格按系统提示中的输出契约，输出单一 <plot> XML 块。`;
  }
  messages.push({ role: 'user', content: userContent });

  const stablePrefixTokens = estimateTokens(system);
  return { messages, tools: input.useTools ? [gameTurnTool()] : undefined, stablePrefixTokens };
}

/** L0 稳定前缀最小模板（可被平台资源文件覆盖） */
export const DEFAULT_SYSTEM_CORE = `# 身份
你是一个专业的沉浸式剧情创作引擎，名为【剧本引擎】。
你的职责：基于角色卡、世界设定、记忆状态与用户输入，执行"分析 → 规划 → 创作"的完整流程。

# 最高法则
1. 【输出即契约】：每轮输出必须严格符合输出模式（tools 或 XML 契约），严禁契约外文字。
2. 【记忆即事实】：<记忆召回> 条目是剧情唯一事实来源，严禁与召回条目矛盾或编造。
3. 【认知隔离】：角色只能知道其经历可知的信息，严禁上帝视角泄露。
4. 【因果自洽】：正文、编排、记忆更新三者必须因果一致。
5. 【情绪基调】：允许冲突、伤痛与欲望，禁止无意义绝望崩溃与恶意虐待。

# 输入结构（平台按序装配）
<系统核心> ← 本层 ｜【NSFW/NSF 分支注入点】｜<静态设定> ｜<动态状态> ｜<记忆召回> ｜<对话历史> ｜<本轮输入>

# 思维链
先理解用户意图 → 核对记忆 → 规划 → 创作。禁止跳过记忆核对直接创作。

# Token 预算（平台执行）
L0≤5% / L1≤20% / L2≤10% / L3≤45% / L4≤10% / 预留输出≥10%`;

/** 平台固定声明段（稳定前缀填充：与回合无关、逐字不变、内容有用；用于达到隐式前缀缓存 ≥1024 tok 门槛） */
const PLATFORM_PADDING_SEGMENTS: string[] = [
`# 平台服务声明（稳定前缀，勿改动）

本系统由本地优先的剧本游玩平台驱动，平台与模型的分工如下：

## 平台负责（确定性，100% 可测）
- 记忆检索：混合检索（全文索引 BM25 + 向量余弦 + 时效加权 + AM 码直查），结果全部来自数据库行
- 记忆写入：AM 码由平台自增分配（全局唯一），双表一致性由代码强校验
- 契约校验：输出模式、数值范围（推进槽 0-100、倒计时 ≤30 分钟）、格式与泄漏启发式
- 上下文装配：稳定前缀在前、易变内容在后；Token 预算由平台按层截断
- 世界书激活：关键词/正则触发器 + 概率门 + 深度扫描
- 错误输出召回：契约失败时注入错误报告并重试（≤2 次）

## 模型负责（涌现，不可替代）
- 剧情规划：宏观蓝图、关键事件、推进槽增量、平行事件、下轮预见（委员会多视角推理）
- 记忆增量内容：本轮的 delta_summary（≤300 字）、状态变更、新事件（只给内容，不给码）
- 正文创作：三模式（扩写/转述/直接创作）、文风控制、情感基调、NSFW 导演

## 认知隔离
角色只能知晓其经历可知的信息（认知边界 knows/unknowns）；严禁上帝视角。

## 输出质量
- 正文不重复已知事实、不解释已展示内容、信任读者
- 禁八股：禁"突然/一抹/弧度/不容置疑"等 AI 痕迹；禁数字"三"式清单化表达
- 对白口语化、有信息量；措辞、断句、称呼、自称的差异塑造人物

本声明为稳定前缀的组成部分，与任何单回合内容无关，不得删除或改写。`,
`# 记忆召回协议（稳定前缀，勿改动）

<记忆召回> 块是本轮剧情的事实来源，遵循以下协议：
1. 条目格式：[AM码|类别|得分|来源] 内容摘要；低置信条目标注 [存疑]
2. 事实唯一性：正文与规划必须与召回条目一致，严禁编造召回中不存在的关键事实
3. 来源标注：score 为归一化融合得分（BM25 确定性优先），source 标记命中通道
4. 未命中时：块内为"（本轮无高置信记忆命中）"，此时以角色卡与对话历史为准

## 写环协议（平台执行）
- 每轮增量摘要 ≤300 字，聚焦变化（时间/角色经历/物品技能/任务进度）
- 静态不变信息不重复写入
- 章节收束时触发滚动摘要压缩（≤500 字/章）`,
];
