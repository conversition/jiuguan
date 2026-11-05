/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Preserve the foreground text-only summary request independently of background proposal tools.
 */
import type { ChatRequest } from '../../proxy/public/client.ts';

export const FOREGROUND_SUMMARY_MODEL_CONTRACT_VERSION = 'foreground-summary-model-contract-v1' as const;
const FOREGROUND_SUMMARY_NATIVE_TOOLS: readonly Readonly<Record<string, unknown>>[] = Object.freeze([]);

export function foregroundSummaryNativeTools(): typeof FOREGROUND_SUMMARY_NATIVE_TOOLS {
    return FOREGROUND_SUMMARY_NATIVE_TOOLS;
}

/** No new validation or normalization: the existing host owns prompt planning and budget admission. */
export function buildForegroundSummaryModelRequest(input: {
    readonly model: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
}): ChatRequest {
    const tools = foregroundSummaryNativeTools();
    return {
        model: input.model,
        messages: [
            { role: 'system', content: '你是剧情记忆压缩器，只输出摘要正文，禁止解释、禁止输出对话。' },
            { role: 'user', content: input.prompt },
        ],
        ...(tools.length > 0 ? { tools: [...tools] } : {}),
        temperature: 0.3,
        max_tokens: input.maxOutputTokens,
    };
}
