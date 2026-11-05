/** @author Codex @date 2026-10-20 @version 1.0
 * A narrower, explicitly authorized Style acceptance window; never grants Agent authority.
 */
import { createHash } from 'node:crypto';
import { AbortTurnError } from '../../../packages/proxy/public/client.ts';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../../packages/proxy/public/client.ts';
import type { StyleCompilePilotBudgetReservation } from './style-compile-job-store.ts';

export interface StyleCompilePilotPolicy {
    readonly version: 'style-compile-pilot-v1';
    readonly billingContract: 'token-upper-bounds-v1';
    readonly pilotId: string;
    readonly sessionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly maxCalls: number;
    readonly maxCostMicrousd: number;
    readonly inputMicrousdPerMillionTokens: number;
    readonly outputMicrousdPerMillionTokens: number;
    readonly inputTokenOverhead: number;
    readonly expiresAt: string;
    readonly pilotIdDigest: string;
    readonly policyDigest: string;
}

const POLICY_KEYS = Object.freeze([
    'version', 'billingContract', 'pilotId', 'sessionId', 'providerId', 'modelId', 'maxCalls',
    'maxCostMicrousd', 'inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens',
    'inputTokenOverhead', 'expiresAt',
]);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_RATE = 1_000_000_000;
const MAX_INPUT_TOKENS = 1_000_000;
const REQUEST_KEYS = Object.freeze(['model', 'messages', 'tools', 'tool_choice', 'temperature', 'max_tokens', 'stream']);

/** A local refusal is not Provider/model quality evidence and must not trip the shared learning circuit. */
export class StyleCompilePilotRefusal extends AbortTurnError {
    constructor(reasonCode: string) {
        super();
        this.name = 'StyleCompilePilotRefusal';
        this.message = reasonCode;
    }
}

function digest(value: string): string {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}


function timestamp(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}


function integer(value: unknown, minimum: number, maximum: number): value is number {
    return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}


/** Only an explicit complete policy can open a pilot; malformed operator input stays fail closed. */
export function parseStyleCompilePilotPolicy(raw: unknown): StyleCompilePilotPolicy | undefined {
    if (raw === undefined) return undefined;
    const invalid = (): never => { throw new TypeError('style-pilot-policy-invalid'); };
    if (typeof raw !== 'string' || raw.length > 4_096) return invalid();
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw); } catch { return invalid(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== POLICY_KEYS.length
        || POLICY_KEYS.some((key) => !Object.hasOwn(value, key))) return invalid();
    if (value.version !== 'style-compile-pilot-v1' || value.billingContract !== 'token-upper-bounds-v1'
        || typeof value.pilotId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.pilotId)
        || !timestamp(value.expiresAt)) return invalid();
    for (const key of ['sessionId', 'providerId', 'modelId']) {
        if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256
            || /[\s\u0000-\u001f*]/u.test(value[key])) return invalid();
    }
    if (!integer(value.maxCalls, 1, 64) || !integer(value.maxCostMicrousd, 1, MAX_RATE)
        || !integer(value.inputMicrousdPerMillionTokens, 1, MAX_RATE)
        || !integer(value.outputMicrousdPerMillionTokens, 1, MAX_RATE)
        || !integer(value.inputTokenOverhead, 0, 32_768)) return invalid();
    const policy = Object.fromEntries(POLICY_KEYS.map((key) => [key, value[key]]));
    return Object.freeze({ ...policy,
        pilotIdDigest: digest(`style-pilot-id-v1:${value.pilotId}`),
        policyDigest: digest(JSON.stringify(policy)),
    }) as unknown as StyleCompilePilotPolicy;
}


function cost(policy: StyleCompilePilotPolicy, inputTokens: number, outputTokens: number): number {
    const numerator = BigInt(inputTokens) * BigInt(policy.inputMicrousdPerMillionTokens)
        + BigInt(outputTokens) * BigInt(policy.outputMicrousdPerMillionTokens);
    const result = (numerator + 999_999n) / 1_000_000n;
    if (result < 1n || result > BigInt(MAX_RATE)) throw new StyleCompilePilotRefusal('style-pilot-cost-invalid');
    return Number(result);
}


function boundedUsage(usage: ChatResponse['usage'], inputLimit: number, outputLimit: number): boolean {
    // Style always sends a compiler prompt and requires a generated draft; zero counts cannot prove paid usage.
    if (!usage || !integer(usage.prompt_tokens, 1, inputLimit)
        || !integer(usage.completion_tokens, 1, outputLimit)
        || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) return false;
    return [usage.cached_input_tokens, usage.cache_write_tokens].every((value) =>
        value === undefined || integer(value, 0, usage.prompt_tokens))
        && (usage.reasoning_tokens === undefined || integer(usage.reasoning_tokens, 0, usage.completion_tokens));
}


export interface StyleCompilePilotClientOptions {
    readonly client: ChatCompletionClient;
    readonly policy: StyleCompilePilotPolicy;
    readonly rawSessionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly reservationDigest: string;
    readonly maxInputTokens: number;
    isCurrent(): boolean;
    reserve(input: StyleCompilePilotBudgetReservation): void;
    /** Must fence shared future reservations even when the durable halt write throws. */
    halt(pilotIdDigest: string): void;
    readonly now?: () => string;
}


/**
 * Wrap the raw client INSIDE arbitration: queued cancellation cannot consume this window.
 * Declared rates must bound all billable token categories. This is not an upstream billing guarantee.
 */
export function createStyleCompilePilotClient(options: StyleCompilePilotClientOptions): ChatCompletionClient {
    const { client, policy } = options;
    if (!DIGEST_RE.test(options.reservationDigest) || !integer(options.maxInputTokens, 1, MAX_INPUT_TOKENS)) {
        throw new TypeError('style-pilot-client-invalid');
    }
    const now = options.now ?? (() => new Date().toISOString());
    const current = (request: ChatRequest, signal?: AbortSignal): string => {
        const time = now();
        if (!timestamp(time) || time >= policy.expiresAt || signal?.aborted || !options.isCurrent()
            || options.rawSessionId !== policy.sessionId || options.providerId !== policy.providerId
            || options.modelId !== policy.modelId || request.model !== policy.modelId) {
            throw new StyleCompilePilotRefusal('style-pilot-authority-closed');
        }
        return time;
    };
    return Object.freeze({
        async complete(request, signal, call) {
            const time = current(request, signal);
            const outputTokens = request.max_tokens;
            if (Object.keys(request).some((key) => !REQUEST_KEYS.includes(key)) || request.stream === true
                || !Array.isArray(request.messages) || request.messages.some((message) =>
                    message.content !== null && typeof message.content !== 'string')
                || !integer(outputTokens, 1, MAX_INPUT_TOKENS)
                || Buffer.byteLength(JSON.stringify(request), 'utf8') + policy.inputTokenOverhead
                    > options.maxInputTokens) throw new StyleCompilePilotRefusal('style-pilot-request-bound-invalid');
            const reservedCostMicrousd = cost(policy, options.maxInputTokens, outputTokens);
            try {
                options.reserve({ pilotIdDigest: policy.pilotIdDigest, policyDigest: policy.policyDigest,
                    reservationDigest: options.reservationDigest, maxCalls: policy.maxCalls,
                    maxCostMicrousd: policy.maxCostMicrousd, reservedCostMicrousd,
                    expiresAt: policy.expiresAt, now: time });
            } catch (error) {
                const reason = error instanceof Error && /^style-pilot-[a-z-]+$/u.test(error.message)
                    ? error.message : 'style-pilot-budget-refused';
                throw new StyleCompilePilotRefusal(reason);
            }
            try {
                // No await between the durable reservation and the only physical transport attempt.
                const response = await client.complete(request, signal, { ...call, maxTransportAttempts: 1 });
                current(request, signal);
                if (!boundedUsage(response.usage, options.maxInputTokens, outputTokens)) {
                    throw new Error('style-pilot-provider-usage-unbounded');
                }
                // No refund: late failures, process death and stale results retain the entire reservation.
                return response;
            } catch (error) {
                try { options.halt(policy.pilotIdDigest); }
                catch { /* The shared Store is fault-closed; preserve the original Provider/cancellation evidence. */ }
                throw error;
            }
        },
        async stream() { throw new Error('style-pilot-stream-denied'); },
        ...(client.capabilities ? { capabilities: () => client.capabilities!() } : {}),
        ...(client.modelName ? { modelName: () => client.modelName!() } : {}),
        ...(client.listModels ? { listModels: (signal?: AbortSignal) => client.listModels!(signal) } : {}),
    } satisfies ChatCompletionClient);
}
