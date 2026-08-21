/**
 * prompt 包 - game.turn 单轮结构化输出契约（v2 07 §3 / L4-编排层）
 * Zod 定义：plan(编排) + memory_delta(记忆增量内容) + prose(正文)。
 * 平台负责检索/写库/校验；模型只输出涌现内容。
 */
import { z } from 'zod';

// ── plan ──
export const CharacterFocusSchema = z.object({
  name: z.string(),
  knows: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
});
export type CharacterFocus = z.infer<typeof CharacterFocusSchema>;

export const KeyEventSchema = z.object({
  description: z.string().describe('高信息浓度事件描述（第三人称、无修辞、无对话）'),
  character_focus: z.array(CharacterFocusSchema).default([]),
  reference_source: z.array(z.string()).default([]).describe('参考桥段（缝合来源）'),
});
export type KeyEvent = z.infer<typeof KeyEventSchema>;

export const RoadmapSchema = z.object({
  current_arc: z.string().default(''),
  current_stage: z.string().default(''),
  next_milestone: z.string().default(''),
  active_foreshadowing: z.array(z.object({ clue: z.string(), status: z.string().default('pending') })).default([]),
});
export type Roadmap = z.infer<typeof RoadmapSchema>;

export const BarsDeltaSchema = z.object({
  personal: z.number().default(0),
  accident: z.number().default(0),
  main: z.number().default(0),
  erotic: z.number().default(0),
});
export type BarsDelta = z.infer<typeof BarsDeltaSchema>;

export const ParallelEventSchema = z.object({
  kind: z.enum(['antagonist', 'normal']),
  actor: z.string(),
  location: z.string().default(''),
  action: z.string(),
  countdown_min: z.number().min(1).max(180).describe('倒计时（分钟）；>30 由平台归一化拆分') ,
});
export type ParallelEvent = z.infer<typeof ParallelEventSchema>;

export const PlanSchema = z.object({
  thought: z.string().default('').describe('委员会思考摘要（宏观/事件推进/平行/剧情规划/预见 五视角协同推理结论）'),
  roadmap: RoadmapSchema.default({}),
  key_events: z.array(KeyEventSchema).min(1),
  bars_delta: BarsDeltaSchema.default({}),
  parallel: z.array(ParallelEventSchema).default([]),
  next_plan: z.string().describe('下一轮剧情焦点简述'),
  event_type: z.enum(['normal', 'fused', 'shadow', 'nsfw']).describe('普通/多事件融合/暗线转移/色情事件锁定'),
  nsfw_lock: z.object({ locked: z.boolean().default(false), round: z.number().default(0) }).default({}),
});
export type Plan = z.infer<typeof PlanSchema>;

// ── memory_delta（模型只给内容，AM 码由平台分配）──
export const StateChangeSchema = z.object({
  entity_type: z.enum(['time', 'protagonist', 'npc', 'skill', 'item', 'quest']),
  entity_id: z.string(),
  field: z.string().optional(),
  value: z.string().optional(),
  action: z.enum(['upsert', 'delete']),
});
export type StateChange = z.infer<typeof StateChangeSchema>;

export const MemoryDeltaSchema = z.object({
  delta_summary: z.string().max(300).describe('本轮增量摘要（聚焦变化，≤300字）'),
  state_changes: z.array(StateChangeSchema).default([]),
  new_events: z.array(z.object({ description: z.string(), characters: z.string().optional() })).default([]),
});
export type MemoryDelta = z.infer<typeof MemoryDeltaSchema>;

// ── game.turn 完整契约 ──
export const GameTurnSchema = z.object({
  plan: PlanSchema,
  memory_delta: MemoryDeltaSchema,
  prose: z.string().describe('最终正文（纯正文，不含编排数据/思考块/元评论）'),
});
export type GameTurn = z.infer<typeof GameTurnSchema>;

/** 校验 game.turn 输出，返回问题清单（L6 校验器复用） */
export function validateGameTurn(input: unknown): { ok: boolean; issues: string[] } {
  const parsed = GameTurnSchema.safeParse(input);
  if (parsed.success) return { ok: true, issues: [] };
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  return { ok: false, issues: issues.slice(0, 10) };
}

/** 流式 prose 提取器：从不断增长的 game_turn 工具参数 JSON 中渐进提取 prose 字段增量
 *  - 原理：prose 是契约最后一个字段，流式到达时前面的 plan/memory_delta 已完整闭合
 *  - 用法：每次收到 tool_calls.arguments 增量就调用一次，返回新增的 prose 文本（已解码转义）
 *  - 安全性：prose 值未闭合时只返回已完整部分；末尾 done 事件会用完整 prose 兜底覆盖
 */
export function createProseStreamExtractor(): (delta: string) => string {
  let buf = '';          // 累积的 arguments
  let scanFrom = 0;      // scan 阶段搜索起点
  let state: 'scan' | 'value' | 'done' = 'scan';
  let emitFrom = 0;      // proseBuf 中已发出的长度
  let proseBuf = '';     // 已提取的 prose 值（解码后）

  return (delta: string): string => {
    buf += delta;
    // 循环处理直到状态转移完成；无进展（数据未到齐）则退出等下一次增量
    let progressed = true;
    while (state !== 'done' && progressed) {
      progressed = false;
      if (state === 'scan') {
        const k = buf.indexOf('"prose"', scanFrom);
        if (k < 0) {
          scanFrom = Math.max(0, buf.length - 12);
          break;
        }
        const colon = buf.indexOf(':', k);
        if (colon < 0) { scanFrom = k; break; }
        let q = colon + 1;
        while (q < buf.length && (buf[q] === ' ' || buf[q] === '\t' || buf[q] === '\n')) q++;
        if (q >= buf.length || buf[q] !== '"') { scanFrom = Math.max(k + 1, colon + 1); break; }
        state = 'value';
        scanFrom = q + 1;
        progressed = true;
      } else {
        // value 状态：扫描到字符串闭合引号或缓冲末尾
        let i = scanFrom;
        let advanced = false;
        while (i < buf.length) {
          const c = buf[i];
          if (c === '\\') {
            if (i + 1 >= buf.length) break; // 转义未完整，等下一次增量
            const e = buf[i + 1];
            proseBuf += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e;
            i += 2;
            advanced = true;
          } else if (c === '"') {
            state = 'done';
            i++;
            advanced = true;
            break;
          } else {
            proseBuf += c;
            i++;
            advanced = true;
          }
        }
        if (i > scanFrom) {
          scanFrom = i;
          progressed = true;
        }
        if (state !== 'done') break; // 未闭合：等下一次增量
      }
    }
    const fresh = proseBuf.slice(emitFrom);
    emitFrom = proseBuf.length;
    return fresh;
  };
}

/** 容错解析模型输出的 game_turn 参数 JSON（L6 错误输出召回：修复截断/尾随字符/嵌套字符串） */
export function safeParseTurn(args: string): GameTurn | null {
  if (!args || !args.trim()) return null;
  const attempts: string[] = [args.trim()];
  const start = args.indexOf('{');
  const end = args.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(args.slice(start, end + 1));
  const balanced = extractBalancedJson(args);
  if (balanced) attempts.push(balanced);
  for (const a of [...new Set(attempts)]) {
    try {
      const parsed = JSON.parse(a) as unknown;
      const repaired = repairNestedJson(parsed);
      // 三顶层键必须齐全才放行：只认 plan 会放过缺失 memory_delta/prose 的输出，
      // 让 normalizeTurn 对 t.memory_delta.state_changes 解引用裸奔（TypeError 整轮 crash）
      if (repaired && typeof repaired === 'object'
        && 'plan' in (repaired as object) && 'memory_delta' in (repaired as object) && 'prose' in (repaired as object)) {
        return repaired as GameTurn;
      }
    } catch { /* 继续下一个尝试 */ }
  }
  return null;
}

/** 平衡括号提取：从第一个 { 到括号归零的 }，正确处理字符串内括号与转义（跳过尾随垃圾） */
function extractBalancedJson(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') inString = !inString;
    if (!inString) {
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 修复嵌套字段为 JSON 字符串的情况（模型偶发把 plan/memory_delta 序列化为字符串） */
function repairNestedJson(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const key of ['plan', 'memory_delta'] as const) {
    const v = out[key];
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try {
        out[key] = JSON.parse(v);
      } catch { /* 保留原样 */ }
    }
  }
  return out;
}

/** 平台归一化（v2"平台做确定性的事"）：越界值自动收敛 + 合同字段同义词归一化，返回警告而非硬失败 */
export function normalizeTurn(turn: GameTurn): { turn: GameTurn; warnings: string[] } {
  const warnings: string[] = [];
  const t = structuredClone(turn);
  // 防御：safeParse 已保证三键存在，但值可能为 null/非对象（如 memory_delta: null、plan: 数组），
  // 可选链兜底，缺失字段按空处理交给后续 zod 校验判契约失败，绝不在此裸奔 TypeError
  for (const sc of (t.memory_delta?.state_changes ?? [])) {
    const raw = (sc as { action?: unknown }).action;
    if (raw == null) continue;
    const norm = ACTION_SYNONYMS[String(raw).toLowerCase()];
    if (norm && norm !== raw) {
      warnings.push(`memory_delta.state_changes.action "${raw}" 归一化 → ${norm}`);
      (sc as { action: 'upsert' | 'delete' }).action = norm;
    } else if (!norm) {
      // 无法识别的 action 几乎都是"想写状态"（删除极少数），默认归入 upsert 保底，避免单字段 KO 整轮
      warnings.push(`memory_delta.state_changes.action "${raw}" 无法识别，归一化 → upsert`);
      (sc as { action: 'upsert' | 'delete' }).action = 'upsert';
    }
  }
  // countdown_min 超 30 → clamp（平行事件 ≤30min 规则；长行为由平台拆分子动作）
  for (const p of (t.plan?.parallel ?? [])) {
    if (p.countdown_min > 30) {
      warnings.push(`parallel.${p.actor}.countdown_min ${p.countdown_min} 超限，平台收敛至 30（长行为应拆分子动作）`);
      p.countdown_min = 30;
    }
  }
  // bars_delta 收敛到 [-100, 100]
  for (const [k, v] of Object.entries(t.plan?.bars_delta ?? {})) {
    if (typeof v === 'number' && (v > 100 || v < -100)) {
      warnings.push(`bars_delta.${k} ${v} 超限，收敛至 ${Math.max(-100, Math.min(100, v))}`);
      (t.plan.bars_delta as Record<string, number>)[k] = Math.max(-100, Math.min(100, v));
    }
  }
  return { turn: t, warnings };
}

/** state_changes.action 同义词映射（大小写不敏感；数据库术语 ↔ 模型口语） */
const ACTION_SYNONYMS: Record<string, 'upsert' | 'delete'> = {
  upsert: 'upsert',
  update: 'upsert', set: 'upsert', add: 'upsert', modify: 'upsert',
  insert: 'upsert', put: 'upsert', write: 'upsert', create: 'upsert',
  delete: 'delete', remove: 'delete', del: 'delete', drop: 'delete', clear: 'delete', erase: 'delete',
};

/**
 * 契约失败诊断：沿 zod issue 的 JSON path 取出实际值（供错误召回带入 + 日志可观测性）。
 * 例：issue `memory_delta.state_changes.0.action: Invalid option...` → `（实际值 "update"）`。
 */
export function diagIssueDetail(issue: string, turn: GameTurn): string {
  const path = issue.split(':')[0].trim();
  const segs = path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s) as string | number);
  let cur: unknown = turn;
  for (const s of segs) {
    if (cur == null) return '';
    cur = (cur as Record<string, unknown>)[s as string];
  }
  if (cur === undefined || cur === null) return '';
  const str = JSON.stringify(cur);
  return str.length > 120 ? `（实际值: ${str.slice(0, 120)}…）` : `（实际值: ${str}）`;
}

/** OpenAI 兼容 tools 定义（用于 API 请求 tools 字段）
 *  注意：工具名用 game_turn（OpenAI 工具名规范 ^[a-zA-Z0-9_-]+$，禁用点号）；文档中的逻辑名 game.turn 与此等价。 */
export function gameTurnTool(): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: 'game_turn',
      description:
        '生成本轮完整回合：剧情编排（plan）+ 记忆增量内容（memory_delta）+ 正文（prose）。' +
        '平台负责检索、写库与校验，本工具只负责涌现内容（规划/正文/风格）。',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            description: '剧情编排（委员会多视角推理产物）',
            properties: {
              thought: { type: 'string', description: '委员会思考摘要' },
              roadmap: {
                type: 'object',
                properties: {
                  current_arc: { type: 'string' },
                  current_stage: { type: 'string' },
                  next_milestone: { type: 'string' },
                  active_foreshadowing: { type: 'array', items: { type: 'object', properties: { clue: { type: 'string' }, status: { type: 'string' } } } },
                },
              },
              key_events: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    character_focus: {
                      type: 'array',
                      items: { type: 'object', properties: { name: { type: 'string' }, knows: { type: 'array', items: { type: 'string' } }, unknowns: { type: 'array', items: { type: 'string' } } } },
                    },
                    reference_source: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              bars_delta: { type: 'object', properties: { personal: { type: 'number' }, accident: { type: 'number' }, main: { type: 'number' }, erotic: { type: 'number' } } },
              parallel: {
                type: 'array',
                items: { type: 'object', properties: { kind: { type: 'string', enum: ['antagonist', 'normal'] }, actor: { type: 'string' }, location: { type: 'string' }, action: { type: 'string' }, countdown_min: { type: 'number' } } },
              },
              next_plan: { type: 'string' },
              event_type: { type: 'string', enum: ['normal', 'fused', 'shadow', 'nsfw'] },
              nsfw_lock: { type: 'object', properties: { locked: { type: 'boolean' }, round: { type: 'number' } } },
            },
            required: ['key_events', 'bars_delta', 'next_plan', 'event_type'],
          },
          memory_delta: {
            type: 'object',
            description: '记忆增量内容（AM 码由平台分配）',
            properties: {
              delta_summary: { type: 'string', description: '本轮增量摘要（≤300字）' },
              state_changes: {
                type: 'array',
                items: { type: 'object', properties: { entity_type: { type: 'string', enum: ['time', 'protagonist', 'npc', 'skill', 'item', 'quest'] }, entity_id: { type: 'string' }, field: { type: 'string' }, value: { type: 'string' }, action: { type: 'string', enum: ['upsert', 'delete'] } } },
              },
              new_events: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, characters: { type: 'string' } } } },
            },
            required: ['delta_summary'],
          },
          prose: { type: 'string', description: '最终正文（纯正文）' },
        },
        required: ['plan', 'memory_delta', 'prose'],
      },
    },
  };
}
