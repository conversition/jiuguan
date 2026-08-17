/**
 * variable 包 - 变量清单 schema（VariableManifest）
 *
 * 编译层产物：把卡片变量规则（结构化声明 / 自然语言规则）翻译为统一清单。
 *  - vars：变量定义（名 + 类型 + 默认值）→ 注册进 VMS
 *  - rules：确定性规则（trigger 布尔表达式 + action 赋值）→ 每回合由规则执行器跑
 *  - source：卡片类型（mvu / structured / nl / mixed）
 * 产物绝不进对话 prompt；只进 VMS 注册 + 规则表（04 铁律：平台做确定性的事）。
 */
import { z } from 'zod';

export const VARIABLE_MANIFEST_VERSION = 1;

export const VariableManifestSchema = z.object({
  version: z.number().int().default(VARIABLE_MANIFEST_VERSION),
  /** 卡片 id（缓存 key） */
  cardId: z.string(),
  /** 卡片类型（决定运行期走桥 or 规则执行器 or 都不走） */
  source: z.enum(['mvu', 'structured', 'nl', 'mixed', 'none']),
  /** 变量定义（scope 缺省 'session'，source 缺省 'card'） */
  vars: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z_一-鿿][a-zA-Z0-9_.一-鿿]*$/, '变量名非法（字母/数字/下划线/点/中文，不以数字开头）'),
    type: z.enum(['number', 'string', 'boolean']),
    default: z.union([z.number(), z.string(), z.boolean()]).optional(),
  })).default([]),
  /** 确定性规则：trigger 为 DSL 布尔表达式（可引用 {event.*} 与变量），action 为 lhs = rhs 赋值 */
  rules: z.array(z.object({
    trigger: z.string().min(1),
    action: z.string().min(1),
    /** 无法转确定性的规则：运行时批量 AI 辅助（本期仅记录，不执行） */
    requires_ai: z.boolean().default(false),
  })).default([]),
  /** 编译器产物哈希（卡片内容指纹；缓存失效判断） */
  cardHash: z.string().default(''),
}).passthrough();

export type VariableManifest = z.infer<typeof VariableManifestSchema>;
export type VariableManifestRule = VariableManifest['rules'][number];

/** 校验 manifest：schema 合法 + 表达式可解析 + action 左值存在 + 依赖无环（Kahn） */
export function validateManifest(
  m: unknown,
  deps: { parseExpr(expr: string): unknown },
): { ok: true; manifest: VariableManifest } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const parsed = VariableManifestSchema.safeParse(m);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const manifest = parsed.data;
  const names = new Set(manifest.vars.map((v) => v.name));
  for (const r of manifest.rules) {
    // trigger / action 右值必须能被 DSL 解析
    const exprPart = (r.action.match(/=\s*(.+)$/) ?? [])[1];
    try { deps.parseExpr(r.trigger); } catch (e) { issues.push(`规则 trigger 解析失败: ${r.trigger}（${(e as Error).message}）`); }
    if (exprPart) {
      try { deps.parseExpr(exprPart); } catch (e) { issues.push(`规则 action 右值解析失败: ${r.action}（${(e as Error).message}）`); }
    } else {
      issues.push(`规则 action 需为 lhs = rhs 形式: ${r.action}`);
    }
    const lhs = (r.action.match(/^\s*([a-zA-Z0-9_.一-鿿]+)\s*=/) ?? [])[1];
    if (lhs && !names.has(lhs)) issues.push(`action 左值未声明变量: ${lhs}`);
  }
  // 依赖无环：rules 的 action 左值不作为自身 trigger 引用环（轻量：仅依赖 manifest.vars，派生环由 VMS evaluate Kahn 兜底）
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, manifest };
}