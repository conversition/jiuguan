/** @author Codex @date 2026-10-18 @version 1.0
 * 真实 Provider 体检的**纯逻辑**部分（可被 CLI 与验收编排共用）。
 * 这里只做「配置枚举 + 两跳探测 + 闭集定性」，不写文件、不启动服务、不退出进程。
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const SKILL_REAL_PREFLIGHT_VERSION = 'skill-real-preflight-v1' as const;

/** 强制工具调用的探针名。与生产 `submit_skill_sample` 同构，但不占用它的名字。 */
export const SKILL_REAL_PROBE_TOOL = 'submit_preflight_text' as const;

const PREFLIGHT_TIMEOUT_MS = 45_000;
/**
 * 探针的 max_tokens。**不能给小**：先思考再发工具调用的模型在 200 时会 `finish_reason=length`
 * 且没有 tool_calls，于是健康的通道被误判成「不支持工具调用」（2026-10-18 实测踩过）。
 * 800 与样本链路的下限同量级，仍然很小。
 */
const PREFLIGHT_MAX_TOKENS = 800;
const MODELS_TIMEOUT_MS = 10_000;

/**
 * 闭集结论。任何未登记的形状都必须落到 `provider-unknown-failure`，
 * 不许因为「看起来像临时错误」就当成可用。
 */
export type SkillRealProbeVerdict =
    | 'ok'
    | 'provider-unreachable'
    | 'provider-requires-session-header'
    | 'provider-key-invalid-or-expired'
    | 'provider-endpoint-not-found'
    | 'provider-http-error'
    | 'provider-model-unknown'
    | 'provider-tool-call-unsupported'
    /** `finish_reason=length` 且没有工具调用：预算给小了，链路本身可能是好的。 */
    | 'provider-output-truncated'
    | 'provider-response-invalid'
    | 'provider-unknown-failure';

export interface SkillRealCandidate {
    readonly source: 'env' | 'provider.json' | 'dotenv';
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
}

export interface SkillRealProbe {
    readonly source: SkillRealCandidate['source'];
    readonly baseUrl: string;
    readonly model: string;
    readonly verdict: SkillRealProbeVerdict;
    readonly httpStatus: number | null;
    /** 上游自己给的稳定错误码（如 `api_key_expired`）；绝不回显完整响应体。 */
    readonly upstreamCode: string | null;
    readonly toolCallName: string | null;
    readonly usage: Readonly<{ prompt: number; completion: number }> | null;
    readonly elapsedMs: number;
    readonly note: string | null;
}

function readDotEnv(name: string, file = '.env.local'): string | null {
    if (!existsSync(file)) return null;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index < 1) continue;
        if (trimmed.slice(0, index) === name) return trimmed.slice(index + 1);
    }
    return null;
}

/** 候选顺序与生产一致：显式 env → `provider.json`（UI 面板唯一权威）→ `.env.local`（兜底）。 */
export function collectSkillRealCandidates(
    options: { readonly providerJsonPath?: string; readonly dotenvPath?: string } = {},
): readonly SkillRealCandidate[] {
    const candidates: SkillRealCandidate[] = [];
    const explicitBase = process.env.JG_REAL_API_BASE ?? null;
    const explicitKey = process.env.JG_REAL_API_KEY ?? null;
    if (explicitBase && explicitKey) {
        candidates.push({
            source: 'env', baseUrl: explicitBase, apiKey: explicitKey,
            model: process.env.JG_REAL_MODEL ?? 'deepseek-v4.1-flash',
        });
    }
    try {
        const path = options.providerJsonPath ?? resolve('data/provider.json');
        const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        if (typeof file.baseUrl === 'string' && typeof file.apiKey === 'string' && file.apiKey) {
            candidates.push({
                source: 'provider.json', baseUrl: file.baseUrl, apiKey: file.apiKey,
                model: typeof file.model === 'string' ? file.model : 'deepseek-v4-flash',
            });
        }
    } catch { /* 缺文件或坏 JSON 只是少一个候选，不阻断其它候选 */ }
    const envBase = readDotEnv('JG_API_BASE', options.dotenvPath);
    const envKey = readDotEnv('JG_API_KEY', options.dotenvPath);
    if (envBase && envKey) {
        candidates.push({
            source: 'dotenv', baseUrl: envBase, apiKey: envKey,
            model: readDotEnv('JG_MODEL', options.dotenvPath) ?? 'deepseek-v4-flash',
        });
    }
    return Object.freeze(candidates);
}

function upstreamCodeOf(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object') {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code) return code.slice(0, 64);
        const type = (error as { type?: unknown }).type;
        if (typeof type === 'string' && type) return type.slice(0, 64);
    }
    if (typeof error === 'string' && error) return error.slice(0, 64);
    const code = (body as { code?: unknown }).code;
    return typeof code === 'string' && code ? code.slice(0, 64) : null;
}

/** 先判「上游要不要会话头」，再判鉴权；顺序写死，避免把缺头报成 key 失效。 */
export function classifySkillRealFailure(input: {
    readonly status: number;
    readonly upstreamCode: string | null;
    readonly bodyText: string;
}): SkillRealProbeVerdict {
    const text = `${input.upstreamCode ?? ''} ${input.bodyText}`.toLowerCase();
    if (input.status === 0) return 'provider-unreachable';
    if (text.includes('x-opencode-session') || text.includes('missingsessionid')) {
        return 'provider-requires-session-header';
    }
    if (input.status === 401 || input.status === 403) return 'provider-key-invalid-or-expired';
    if (input.status === 404) return 'provider-endpoint-not-found';
    if (text.includes('model') && (text.includes('not found') || text.includes('unknown')
        || text.includes('does not exist'))) return 'provider-model-unknown';
    if (input.status >= 400) return 'provider-http-error';
    return 'provider-unknown-failure';
}

/** 两跳探测：先用 models 不花钱地区分「连不上 / 鉴权坏」，再打一次强制工具调用。 */
export async function probeSkillRealCandidate(candidate: SkillRealCandidate): Promise<SkillRealProbe> {
    const started = Date.now();
    const base = candidate.baseUrl.replace(/\/+$/u, '');
    const auth = { authorization: `Bearer ${candidate.apiKey}` };

    let modelsStatus = 0;
    try {
        const response = await fetch(`${base}/v1/models`, {
            headers: auth, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
        modelsStatus = response.status;
        await response.text();
    } catch { modelsStatus = 0; }

    if (modelsStatus === 0) {
        return Object.freeze({
            source: candidate.source, baseUrl: base, model: candidate.model,
            verdict: 'provider-unreachable' as const, httpStatus: null, upstreamCode: null,
            toolCallName: null, usage: null, elapsedMs: Date.now() - started,
            note: '/v1/models 连不上（host 未监听、DNS/TLS 失败或出网被拦）',
        });
    }

    const body = JSON.stringify({
        model: candidate.model,
        messages: [
            { role: 'system', content: 'Return only the required submission tool with exactly one text field.' },
            { role: 'user', content: '用一句中文描述：雨夜的旧书店。' },
        ],
        tools: [{
            type: 'function', function: {
                name: SKILL_REAL_PROBE_TOOL, description: 'Submit one short Chinese sentence.',
                parameters: {
                    type: 'object', additionalProperties: false, required: ['text'],
                    properties: { text: { type: 'string', minLength: 1, maxLength: 200 } },
                },
            },
        }],
        tool_choice: { type: 'function', function: { name: SKILL_REAL_PROBE_TOOL } },
        temperature: 0, max_tokens: PREFLIGHT_MAX_TOKENS,
    });

    let status = 0;
    let text = '';
    try {
        const response = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json', ...auth,
                // 记录型网关会要求会话标识；带上它才能把「缺头」与「真鉴权失败」分开。
                'x-opencode-session': randomUUID(),
            },
            body, signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        });
        status = response.status;
        text = await response.text();
    } catch { status = 0; }

    if (status === 0) {
        return Object.freeze({
            source: candidate.source, baseUrl: base, model: candidate.model,
            verdict: 'provider-unreachable' as const, httpStatus: null, upstreamCode: null,
            toolCallName: null, usage: null, elapsedMs: Date.now() - started,
            note: 'chat/completions 请求失败（超时或连接中断）',
        });
    }

    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const upstreamCode = upstreamCodeOf(parsed);

    if (status < 200 || status >= 300) {
        return Object.freeze({
            source: candidate.source, baseUrl: base, model: candidate.model,
            verdict: classifySkillRealFailure({ status, upstreamCode, bodyText: text.slice(0, 800) }),
            httpStatus: status, upstreamCode, toolCallName: null, usage: null,
            elapsedMs: Date.now() - started, note: null,
        });
    }
    if (!parsed || typeof parsed !== 'object') {
        return Object.freeze({
            source: candidate.source, baseUrl: base, model: candidate.model,
            verdict: 'provider-response-invalid' as const, httpStatus: status, upstreamCode: null,
            toolCallName: null, usage: null, elapsedMs: Date.now() - started,
            note: '200 但响应不是 JSON',
        });
    }
    const record = parsed as {
        choices?: readonly {
            finish_reason?: string;
            message?: { tool_calls?: readonly { function?: { name?: string } }[] };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const finishReason = record.choices?.[0]?.finish_reason ?? null;
    const toolName = record.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? null;
    const usage = record.usage && typeof record.usage.prompt_tokens === 'number'
        && typeof record.usage.completion_tokens === 'number'
        ? Object.freeze({
            prompt: record.usage.prompt_tokens, completion: record.usage.completion_tokens,
        })
        : null;
    const verdict: SkillRealProbeVerdict = toolName === SKILL_REAL_PROBE_TOOL
        ? 'ok'
        : finishReason === 'length' ? 'provider-output-truncated' : 'provider-tool-call-unsupported';
    return Object.freeze({
        source: candidate.source, baseUrl: base, model: candidate.model,
        verdict, httpStatus: status, upstreamCode: null, toolCallName: toolName, usage,
        elapsedMs: Date.now() - started,
        note: verdict === 'ok' ? null
            : verdict === 'provider-output-truncated'
                ? `finish_reason=length（用了 ${PREFLIGHT_MAX_TOKENS} tokens）：模型在输出工具调用前被截断，`
                    + '加大预算后可能可用，不能直接判成不支持'
                : '200 但没有返回约定的强制工具调用；样本/评委链路会全部失败',
    });
}

function probeIdentity(input: Pick<SkillRealCandidate, 'source' | 'baseUrl' | 'model'>): string {
    return `${input.source}\u0000${input.baseUrl.replace(/\/+$/u, '')}\u0000${input.model}`;
}

/**
 * 评委独立性：`resolveSkillQualityAuthority` 要求「生成 + 两个评委」三个 providerId 互不相同。
 * 只统计**已经完成强制工具调用探测**的不同上游主机。配置存在但探测失败的 host
 * 不能成为独立评委，否则一个可用上游加两个失效地址也会被误报为 ready。
 */
export function judgeIndependenceReadiness(
    candidates: readonly SkillRealCandidate[],
    probes: readonly SkillRealProbe[],
): Readonly<{
    distinctProviderHosts: number;
    required: number;
    ready: boolean;
}> {
    const passed = new Set(probes
        .filter((probe) => probe.verdict === 'ok')
        .map((probe) => probeIdentity(probe)));
    const usable = candidates.filter((candidate) => passed.has(probeIdentity(candidate)));
    const hosts = new Set(usable.map((item) => {
        try { return new URL(item.baseUrl).host; } catch { return item.baseUrl; }
    }));
    return Object.freeze({
        distinctProviderHosts: hosts.size,
        required: 3,
        // 同一个 host 上的不同 providerId 只是标签，不算独立来源。
        ready: hosts.size >= 3,
    });
}

export function redactSkillRealKey(key: string): string {
    if (key.length <= 8) return `<${key.length} chars>`;
    return `${key.slice(0, 4)}…${key.slice(-2)} (${key.length} chars)`;
}

/** 依次探测所有候选，返回逐条结论（不短路：坏配置也要留证据）。 */
export async function probeSkillRealCandidates(
    candidates: readonly SkillRealCandidate[],
): Promise<readonly SkillRealProbe[]> {
    const probes: SkillRealProbe[] = [];
    for (const candidate of candidates) probes.push(await probeSkillRealCandidate(candidate));
    return Object.freeze(probes);
}
