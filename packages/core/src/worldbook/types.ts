/**
 * core 包 - 世界书语义激活类型定义
 * 语义激活（worldbook 整条目向量化 + 多信号融合）的类型契约。
 * 设计约束：
 *   - 世界书条目以【整条目】为单位向量化，绝不切碎（碎片破坏条目内部上下文关联）。
 *   - 预设（Preset）不参与向量化，保持完整注入（见 prompt/assembly.ts L3 <预设> 固定层）。
 *   - 融合得分 = 加权线性 + sigmoid；确定性触发（关键词/正则/常驻）保证激活不被模糊阈值吞掉。
 */

/** 语义激活会话输入（每回合） */
export interface ActivationContext {
  /** 用户本轮输入 */
  currentInput: string;
  /** 最近对话摘要/远史骨架（可选，增强语义匹配，作为 query 的一部分） */
  recentSummary?: string;
  /** 当前会话活跃实体集合（来自在场实体 / 记忆层） */
  activeEntities?: Set<string>;
}

/** 语义激活内部索引条目（以整条目为单位缓存向量） */
export interface SemanticEntry {
  /** lorebook_entry.id */
  id: number;
  /** 条目标题 */
  comment: string;
  /** 条目完整文本（向量化对象；含 EJS/MVU 代码时需先经 readableLoreContent 清洗） */
  content: string;
  /** 概率门字段（0~100，酒馆语义；未启用概率门视作 100） */
  probability: number;
  /** 是否启用概率门 */
  useProbability: boolean;
  /** 是否长驻条目（恒激活） */
  constant: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 关键词触发列表（key 竖线分隔展开） */
  keywords: string[];
  /** 是否用正则触发（use_regex 条目） */
  useRegex: boolean;
  /** 触发器数组 JSON 字符串（use_regex 时使用） */
  triggersJson: string;
  /** 运行期整条目向量（bge 编码结果；索引就绪才有值） */
  embedding?: number[];
}

/** 单条语义激活结果 */
export interface SemanticActivation {
  entryId: number;
  /** 融合得分（0~1） */
  score: number;
  /** 注入优先级 */
  priority: 'high' | 'medium';
  /** 各信号得分（0~1，可观测性） */
  triggeredBy: {
    keyword: number;
    semantic: number;
    entity: number;
    probability: number;
  };
}

/** 语义激活器配置（权重/阈值/env 可覆盖） */
export interface SemanticActivatorOptions {
  /** 加权线性权重（和不必为 1） */
  weights: { keyword: number; semantic: number; entity: number; probability: number };
  /** sigmoid 全局偏置（控制灵敏度） */
  bias: number;
  /** 高优先级阈值 */
  thresholdHigh: number;
  /** 中优先级阈值（低于此不激活） */
  thresholdMedium: number;
  /** 语义相似度温度缩放因子 */
  semanticTemperature: number;
}

/** 语义索引就绪状态 */
export interface SemanticIndexStatus {
  ready: boolean;
  entryCount: number;
}
