/**
 * core 包 - 预设解析器（启动流程审查 P0：资产选择提升为会话入参）
 * 预设 = 提示词块列表（酒馆 spreset 格式：prompts[{role,name,enabled,content}]）。
 * 产出：
 *  - blocks：按 enabled（块自身开关 ∧ override 覆盖）过滤后的正文，供 <预设> 注入
 *  - vars：全块 {{setvar}} 声明 → VMS 注册（来源注册，不随 enabled 过滤——变量便宜且可能被禁用块引用）
 */
import { z } from 'zod';

const PresetBlockSchema = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  // 与 server /api/preset 语义一致：非布尔/缺失 → 默认启用
  enabled: z.boolean().catch(true).optional(),
  content: z.string().optional(),
}).passthrough();

export const PresetSchema = z.object({
  name: z.string().optional(),
  prompts: z.array(PresetBlockSchema).optional(),
}).passthrough();

export type Preset = z.infer<typeof PresetSchema>;

export interface ParsedPreset {
  name: string;
  /** 生效块正文（enabled ∧ override，按原始顺序） */
  blocks: string[];
  /** 注入用（每块带来源名，便于提示词可读性） */
  blockEntries: { name: string; content: string }[];
  /** {{setvar::name::value}} 声明（全块收集） */
  vars: { scope: string; source: string; name: string; type: 'literal'; value: string }[];
  /** 统计 */
  stats: { total: number; enabled: number; disabled: number; chars: number };
  warnings: string[];
}

const SETVAR_RE = /\{\{setvar::([^:}]+)::([\s\S]*?)\}\}/g;

/** 解析预设 JSON；overrides: {块索引: 是否启用}（UI 勾选覆盖块自身 enabled） */
export function parsePreset(json: string, overrides: Record<string, boolean> = {}): ParsedPreset {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`预设 JSON 解析失败: ${(e as Error).message}`);
  }
  const parsed = PresetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`预设 schema 校验失败: ${issues.join('; ')}`);
  }
  const preset = parsed.data;
  const prompts = preset.prompts ?? [];

  const blockEntries: { name: string; content: string }[] = [];
  const vars: ParsedPreset['vars'] = [];
  let enabled = 0;
  let chars = 0;

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const content = (p.content ?? '').trim();
    if (!content) continue;
    const selfEnabled = p.enabled !== false;
    const finalEnabled = overrides[String(i)] ?? selfEnabled;
    if (finalEnabled) {
      blockEntries.push({ name: p.name || p.role || `块${i + 1}`, content });
      enabled++;
      chars += content.length;
    }
    // setvar 全块收集（禁用块也可能被宏引用）
    for (const m of content.matchAll(SETVAR_RE)) {
      vars.push({ scope: 'preset', source: 'preset', name: m[1], type: 'literal', value: m[2].trim() });
    }
  }

  return {
    name: preset.name ?? '',
    blocks: blockEntries.map((b) => b.content),
    blockEntries,
    vars,
    stats: { total: prompts.length, enabled, disabled: prompts.length - enabled, chars },
    warnings,
  };
}
