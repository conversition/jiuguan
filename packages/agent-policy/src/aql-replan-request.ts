/**
 * @author  : Codex
 * @time    : 2026-10-15
 * @function: Build the deployed managed and legacy text-only AQL requests from one versioned source.
 * @version : v2.0
 */
export const AQL_REPLAN_REQUEST_VERSION = 'aql-replan-request-v2' as const;
export const AQL_REPLAN_TOOL_SURFACE_VERSION = 'aql-replan-native-tools-v1' as const;

export type AqlReplanRequestOptions =
    | { readonly variant: 'managed'; readonly model: string; readonly maxTokens: number }
    | { readonly variant: 'legacy' };

/** Domain-owned request DTO keeps the deterministic policy package independent of the transport client. */
export interface AqlReplanModelRequest {
    model?: string;
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    tools?: Record<string, unknown>[];
    temperature: number;
    max_tokens: number;
}

const LEGACY_SYSTEM_PROMPT = '你是剧本导演。玩家对某一轮回复不满意而重发，请诊断卡点并给出精炼的"重写方向"。'
    + '规则：只给方向（应聚焦的角色/场景细节、卡点原因、下一步推进），不得捏造世界书未记载内容；'
    + '输出 ≤200 字纯文本，不要解释，不用 XML。';
// Preserve the legacy story-fact constraints while retaining the managed
// route's explicit prohibition on tools and database changes.
const MANAGED_SYSTEM_PROMPT = `${LEGACY_SYSTEM_PROMPT}不调用工具、不改数据库。`;
const NO_TOOLS: readonly Readonly<Record<string, unknown>>[] = Object.freeze([]);
const AQL_REPLAN_NATIVE_TOOLS = Object.freeze({ managed: NO_TOOLS, legacy: NO_TOOLS });


/** Preserve both deployed prompts and request property order; this is assembly, not input admission. */
export function buildAqlReplanRequest(prompt: string, options: AqlReplanRequestOptions): AqlReplanModelRequest {
    const tools = aqlReplanNativeTools(options.variant);
    const body: AqlReplanModelRequest = {
        messages: [
            { role: 'system', content: options.variant === 'managed' ? MANAGED_SYSTEM_PROMPT : LEGACY_SYSTEM_PROMPT },
            { role: 'user', content: `=== 当前剧情上下文 ===\n${prompt}` },
        ],
        ...(tools.length > 0 ? { tools: [...tools] } : {}),
        temperature: 0.6,
        max_tokens: options.variant === 'managed' ? options.maxTokens : 300,
    };
    return options.variant === 'managed' ? { model: options.model, ...body } : body;
}


/** Share the exact declaration source used by both builder variants without dispatch or live state. */
export function aqlReplanNativeTools(
    variant: AqlReplanRequestOptions['variant'] = 'managed',
): readonly Readonly<Record<string, unknown>>[] {
    return AQL_REPLAN_NATIVE_TOOLS[variant];
}
