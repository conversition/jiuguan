/** @author Codex @date 2026-10-18 @version 1.0
 * 受控真实验收编排器：preflight 门禁 → 真实 compile → 真实 24 对样本（48 次调用）。
 *
 * 设计取舍：
 * 1. **先过门禁**：复用 `skill-real-preflight-core`，没有一条候选 `ok` 就退出，绝不花钱。
 * 2. **硬上限**：`--max-calls` 是进程级计数闸，到顶直接抛错，而不是事后看账单。
 * 3. **可续跑**：证据落在 `--dir`，`run.json` 记住 compileJobId；重复执行不会重新编译。
 * 4. **只写自己的目录**：不碰 `data/`、不碰玩家会话库、不写 Active。
 * 5. **不冒充真实**：报告的 `providerExecution` 由实际是否发生真实调用决定，不自封。
 *
 * 用法：
 *   pnpm skill:real-acceptance -- --dir .workbuddy/real-run/20261018
 *   pnpm skill:real-acceptance -- --stage sample --max-calls 60
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatCompletionClient, ChatRequest, ChatResponse } from '../../packages/proxy/public/client.ts';
import {
    ProviderRegistry, createOpenAIProviderController, createRegistryProviderClient,
} from '../../packages/proxy/public/provider-runtime.ts';
import { resolveModelRuntimeProfile } from '../../packages/prompt/public/model-runtime-profile.ts';
import { agentBudgetProfileDigest } from '../../packages/agent-policy/public/budget-profile.ts';
import { agentTaskBudgetProfile } from '../../apps/server/agent-task-budget-profiles.ts';
import { AdmissionTicketBroker } from '../../apps/server/agent-admission-broker.ts';
import { AgentSkillCandidateStore } from '../../apps/server/agent-skill-candidate-store.ts';
import { AgentSkillCandidateRuntime } from '../../apps/server/skill-hub/candidate-runtime.ts';
import { SkillCompileStore } from '../../apps/server/skill-compile-store.ts';
import { SkillCompileRuntime } from '../../apps/server/skill-hub/skill-compile-runtime.ts';
import { normalizeSkillCompileSpec } from '../../apps/server/skill-compile-model.ts';
import { createSkillEvaluatePlan } from '../../apps/server/skill-evaluate-registry.ts';
import {
    createSkillSamplePlan, SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS,
} from '../../apps/server/skill-sample-registry.ts';
import { openSkillSampleRuntime } from '../../apps/server/skill-hub/skill-sample-runtime.ts';
import { CandidateEvaluationSampleHost }
    from '../../apps/server/skill-hub/candidate-evaluation-sample-host.ts';
import {
    collectSkillRealCandidates, judgeIndependenceReadiness, probeSkillRealCandidate,
    redactSkillRealKey, type SkillRealCandidate, type SkillRealProbe,
} from './skill-real-preflight-core.ts';

export const SKILL_REAL_ACCEPTANCE_VERSION = 'skill-real-acceptance-v1' as const;

/** 合成作者来源：不是玩家会话。名字刻意写成一眼能看出来的形状，避免被误认成真实存档。 */
const SYNTHETIC_SESSION = 'skill-acceptance-synthetic-author' as const;
const PROVIDER_ID = 'builtin.openai' as const;

function arg(name: string, fallback: string | null = null): string | null {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    return process.argv[index + 1] ?? fallback;
}

function intArg(name: string, fallback: number): number {
    const raw = arg(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        console.error(`${name} 必须是正整数，收到 ${raw}`);
        process.exit(2);
    }
    return value;
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const stage = arg('--stage', 'all')!;
if (!['compile', 'sample', 'all'].includes(stage)) {
    console.error(`--stage 只能是 compile | sample | all，收到 ${stage}`);
    process.exit(2);
}
const maxCalls = intArg('--max-calls', 80);
/**
 * 采样模型可覆盖。**必须避开纯推理模型**：`buildSkillSampleModelRequest` 把每臂上限硬编码为
 * ≤1200 tokens，而先思考的模型会在 1200 内把预算烧在 reasoning 上、始终发不出 tool_calls
 * （2026-10-18 实测 `google/gemini-3.7-flash`：finish_reason=length、content=null）。
 */
const modelOverride = arg('--model');
/** 诊断用：把被 runtime catch 掉的底层异常打到 stderr（只截 200 字符，不上报正文）。 */
const verbose = process.argv.includes('--verbose');
const attempts = intArg('--attempts', 2);
const dir: string = arg('--dir')
    ?? join('.workbuddy', 'real-run', new Date().toISOString().replace(/[:.]/gu, '-'));
mkdirSync(dir, { recursive: true });

// ── 门禁：没有一条真实候选可用就不开工 ──────────────────────────────────────────────
const candidates = collectSkillRealCandidates();
const probes: SkillRealProbe[] = [];
for (const candidate of candidates) probes.push(await probeSkillRealCandidate(candidate));
const usable = probes.find((item) => item.verdict === 'ok');
if (!usable) {
    console.error(JSON.stringify({ stage: 'preflight', verdict: 'blocked', probes }, null, 2));
    console.error('没有可用真实通道：**不启动任何付费调用**。');
    process.exit(1);
}
const base: SkillRealCandidate = candidates.find((item) => (
    item.source === usable.source && item.baseUrl.replace(/\/+$/u, '') === usable.baseUrl
))!;
const chosen: SkillRealCandidate = modelOverride ? { ...base, model: modelOverride } : base;
const independence = judgeIndependenceReadiness(candidates, probes);
console.log(`[gate] ${chosen.source} ${usable.baseUrl} model=${chosen.model} `
    + `key=${redactSkillRealKey(chosen.apiKey)}`);
if (!independence.ready) {
    console.log(`[gate] 通过探测的评委独立来源不足（${independence.distinctProviderHosts}/${independence.required}）：`
        + '本轮只跑编译 + 样本，不跑 judge。');
}

// ── 真实客户端 + 计数闸 ────────────────────────────────────────────────────────
const cfg = {
    providerId: PROVIDER_ID, baseUrl: chosen.baseUrl, apiKey: chosen.apiKey,
    model: chosen.model, kind: 'openai' as const, prefixCacheThreshold: 1024, timeoutMs: 120_000,
};
const registry = new ProviderRegistry({
    onDisposeError: (id: string) => console.warn('[Provider] dispose-failed', id),
    onLateInvocationError: (id: string, error: { readonly code?: string }) => (
        console.warn('[Provider] late-invocation', id, error.code)
    ),
});
const controller = createOpenAIProviderController(cfg);
registry.registerBuiltin(PROVIDER_ID, controller.adapter);
const rawClient = createRegistryProviderClient({
    registry, resolveSelection: () => ({ providerId: PROVIDER_ID, model: chosen.model }),
});
const usage = { calls: 0, prompt: 0, completion: 0 };
const client: ChatCompletionClient = {
    async complete(
        request: ChatRequest,
        signal?: AbortSignal,
        call?: Parameters<ChatCompletionClient['complete']>[2],
    ): Promise<ChatResponse> {
        usage.calls += 1;
        if (usage.calls > maxCalls) {
            // 硬闸：宁可整批失败，也不静默超支。
            throw new Error(`skill-acceptance-call-cap-exceeded(${maxCalls})`);
        }
        let response: ChatResponse;
        try {
            response = await rawClient.complete(request, signal, call);
        } catch (error) {
            if (verbose) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[call-error#${usage.calls}] `
                    + `${error instanceof Error ? error.name : 'Error'}: ${message.slice(0, 200)}`);
            }
            throw error;
        }
        usage.prompt += response.usage?.prompt_tokens ?? 0;
        usage.completion += response.usage?.completion_tokens ?? 0;
        if (verbose) {
            const call0 = (response.toolCalls ?? [])[0];
            let textLength: number | null = null;
            try {
                const args = JSON.parse(call0?.arguments ?? '{}') as { text?: unknown };
                textLength = typeof args.text === 'string' ? [...args.text].length : null;
            } catch { textLength = null; }
            console.error(`[call-ok#${usage.calls}] finish=${String(response.finishReason)} `
                + `tool=${call0?.name ?? 'null'} textLength=${textLength} `
                + `maxTokens=${String((request as { max_tokens?: unknown }).max_tokens)}`);
        }
        return response;
    },
    async stream(...args: Parameters<ChatCompletionClient['stream']>) {
        usage.calls += 1;
        if (usage.calls > maxCalls) throw new Error(`skill-acceptance-call-cap-exceeded(${maxCalls})`);
        return rawClient.stream(...args);
    },
    capabilities: () => rawClient.capabilities?.() ?? { stream: true, tools: true },
};

const descriptor = registry.describe(PROVIDER_ID);
if (!descriptor) {
    console.error('provider descriptor 不可用');
    process.exit(3);
}
const profileFor = (taskKind: 'skill_compile' | 'skill_sample') => {
    const profile = resolveModelRuntimeProfile({
        providerId: PROVIDER_ID, modelId: chosen.model,
        supportsTools: descriptor.capabilities.tools === true,
        supportsStreaming: descriptor.capabilities.stream === true,
    });
    const budget = agentTaskBudgetProfile(taskKind, process.env, {}, profile);
    // 身份摘要刻意**不含凭据**：与 server 的 loadProviderConfig() 摘要做法有意不同，已在此注明。
    const modelBindingDigest = digest({
        providerId: PROVIDER_ID, modelId: chosen.model, profile, budget,
        descriptor, configuration: { baseUrl: chosen.baseUrl, kind: cfg.kind },
    });
    return { profile, budget, modelBindingDigest };
};
const broker = new AdmissionTicketBroker({
    nowMs: () => Date.now(),
    authorizeIssue: (request: { readonly taskKind?: unknown }) => (
        ['skill_compile', 'skill_sample'].includes(String(request.taskKind))
    ),
    authorizeBegin: () => true,
});
const now = () => new Date().toISOString();
const modelContext = (taskKind: 'skill_compile' | 'skill_sample') => {
    const { budget, modelBindingDigest } = profileFor(taskKind);
    return {
        broker, client, modelId: chosen.model, modelBindingDigest, budgetProfile: budget,
        // 与 server 一致的量级：真实花费不在这里结算，调用上限由 --max-calls 守。
        estimateCostMicrousd: () => 1, auditRequired: true,
        onLeaseClosed: () => undefined, now,
    };
};

// ── 编译：真实一次调用 + 静态验证 ─────────────────────────────────────────────────
const candidatesRuntime = new AgentSkillCandidateRuntime(
    new AgentSkillCandidateStore({ dataDir: dir, now }),
    { dataDir: dir, now, submissionEnabled: () => true },
);
const compiler = new SkillCompileRuntime(
    new SkillCompileStore({ dataDir: dir, now }),
    {
        dataDir: dir, now, candidates: candidatesRuntime, enabled: () => true,
        sourceAllowed: (raw: string) => raw === SYNTHETIC_SESSION,
        resolveModel: () => modelContext('skill_compile'),
        onFailure: (code: string) => console.warn('[compile]', code),
    },
);

const runFile = join(dir, 'run.json');
let run: { compileJobId?: string } = {};
if (existsSync(runFile)) {
    try { run = JSON.parse(readFileSync(runFile, 'utf8')) as { compileJobId?: string }; } catch { run = {}; }
}

async function settle(predicate: () => boolean, label: string, schedule: () => void): Promise<void> {
    for (let index = 0; index < 6_000; index += 1) {
        if (predicate()) return;
        schedule();
        await delay(50);
    }
    throw new Error(`skill-acceptance-timeout:${label}`);
}

let compileJobId: string = run.compileJobId ?? '';
if (!compileJobId) {
    const job = compiler.submit({
        rawSessionId: SYNTHETIC_SESSION,
        idempotencyKey: 'acceptance-compile-v1',
        spec: normalizeSkillCompileSpec({
            specVersion: 'agent-skill-compile-spec-v1', intent: 'explicit-author', kind: 'style',
            skillId: 'author.compiled.acceptance-tempo', version: '1.0.0',
            goals: ['brisk-pace', 'preserve-voice'],
        }),
    });
    compileJobId = job.jobId;
    run.compileJobId = job.jobId;
    writeFileSync(runFile, JSON.stringify(run, null, 2), 'utf8');
    await settle(
        () => {
            // 必须等**静态验证落地**（true/false），只看 state=succeeded 会读到静态验证还没写回的中间态。
            const view = compiler.readJob(compileJobId);
            return view?.state === 'failed'
                || (view?.state === 'succeeded'
                    && typeof view.staticValidationPassed === 'boolean');
        },
        'compile', () => compiler.schedule(),
    );
}
const jobId: string = compileJobId;
const compileJob = compiler.readJob(jobId);
console.log(`[compile] job=${compileJobId} state=${compileJob?.state} `
    + `staticValidation=${compileJob?.staticValidationPassed} candidate=${compileJob?.candidateId}`);

if (stage === 'compile') {
    writeFileSync(join(dir, 'report.json'), JSON.stringify({
        acceptanceVersion: SKILL_REAL_ACCEPTANCE_VERSION, stage, dir,
        compileJob, usage, probes, generatedAt: now(),
    }, null, 2), 'utf8');
    console.log(JSON.stringify({ usage, dir }, null, 2));
    await compiler.shutdown();
    process.exit(compileJob?.state === 'succeeded' ? 0 : 1);
}

// ── 样本：真实 24 对 / 48 次调用 ──────────────────────────────────────────────────
const retained = compiler.readEvaluationInput(jobId);
if (!retained) {
    console.error('compile 没有产出可复用的 evaluate 输入（job 未成功？）');
    process.exit(1);
}
const plan = createSkillSamplePlan(createSkillEvaluatePlan(retained));
if (process.argv.includes('--diagnose')) {
    // 只读比对：套件计划里的 per-pair 预算必须与运行时预算**逐字相等**，否则 claim 直接被拒。
    const runtimeBudget = profileFor('skill_sample').budget;
    const planned = (plan as unknown as { suite?: Record<string, unknown> }).suite ?? {};
    console.log('[diagnose] planned=' + JSON.stringify({
        budgetDigest: planned.perPairBudgetDigest,
        inputTokens: planned.perPairInputTokens,
        outputTokens: planned.perPairOutputTokens,
        maxCostMicrousd: planned.perPairMaxCostMicrousd,
    }));
    console.log('[diagnose] runtime=' + JSON.stringify({
        budgetDigest: agentBudgetProfileDigest(runtimeBudget),
        inputTokens: runtimeBudget.agentInputBudgetTokens,
        outputTokens: runtimeBudget.agentOutputBudgetTokens,
        maxCostMicrousd: runtimeBudget.maxCostMicrousd,
        maxModelCalls: runtimeBudget.maxModelCalls,
        maxSteps: runtimeBudget.maxSteps,
        maxToolCalls: runtimeBudget.maxToolCalls,
        maxWrites: runtimeBudget.maxWrites,
        maxWallMs: runtimeBudget.maxWallMs,
    }));
    const plannedTyped = plan as unknown as { suite?: Record<string, unknown> };
    console.log('[diagnose] planIsSuite=' + String(plannedTyped.suite !== undefined));
    const instruction = (plan as unknown as { candidateInstruction?: unknown }).candidateInstruction;
    console.log(`[diagnose] candidateInstructionChars=${typeof instruction === 'string'
        ? [...instruction].length : 'none'}`);
}
const candidateEvidence = new CandidateEvaluationSampleHost({
    dataDir: dir,
    now,
    resolveCurrent: (compileId) => {
        const current = compiler.readEvaluationInput(compileId);
        const model = modelContext('skill_sample');
        return current ? {
            evaluatePlan: createSkillEvaluatePlan(current),
            modelId: model.modelId,
            modelBindingDigest: model.modelBindingDigest,
            budgetProfile: model.budgetProfile,
        } : null;
    },
    isSessionDeleted: () => false,
});
const sample = openSkillSampleRuntime({
    dataDir: dir, now, enabled: () => true, suiteEnabled: () => true,
    sourceAllowed: (raw: string) => raw === SYNTHETIC_SESSION,
    isSessionDeleted: () => false,
    resolvePlan: (id: string) => (id === jobId ? plan : null),
    resolveModel: () => modelContext('skill_sample'),
    resolveDispatchSidecarFactory: (input) => candidateEvidence.resolve(input),
    onFailure: (code: string) => console.warn('[sample]', code),
});
if (!sample) {
    console.error('样本运行时未打开（opt-in 或库损坏）');
    process.exit(3);
}

/**
 * 一次模型失败就会把整个套件关成 incomplete（fail closed 是有意的）。所以这里做**有界**重试：
 * 每轮用一个带序号幂等键的新套件，拿到 complete 就停；重试次数与每轮用量都进报告，不藏。
 */
const attemptLog: Array<{
    suiteId: string; state: string; matrix: string; calls: number;
    candidateBatchId: string | null; candidateBatchState: string | null;
}> = [];
let suiteView = null;
for (let round = 1; round <= attempts; round += 1) {
    const callsBefore = usage.calls;
    const submitted = sample.submitSuite({
        compileJobId: jobId, idempotencyKey: `acceptance-suite:${jobId}:a${round}`,
    });
    const suiteId = submitted.suiteId;
    console.log(`[sample] round=${round} suite=${suiteId} pairs=${SKILL_SAMPLE_SUITE_PAIR_COUNT} `
        + `calls=${SKILL_SAMPLE_SUITE_TOTAL_MODEL_CALLS}`);
    await settle(
        () => {
            const view = sample.readSuite(suiteId);
            return view !== null && ['succeeded', 'failed', 'uncertain'].includes(String(view.state));
        },
        `sample-suite-${round}`, () => sample.schedule(),
    );
    const view = sample.readSuite(suiteId);
    if (!view) {
        console.error('样本套件读不回来');
        process.exit(3);
    }
    suiteView = view;
    const storedSuite = sample.readStoredSuite(suiteId);
    const first = storedSuite?.jobs[0]?.job;
    const model = modelContext('skill_sample');
    const candidateBatchId = first ? candidateEvidence.batchIdFor({
        jobId: first.jobId,
        plan: first.plan,
        modelId: model.modelId,
        modelBindingDigest: model.modelBindingDigest,
    }) : null;
    const candidateBatch = candidateBatchId ? candidateEvidence.readBatch(candidateBatchId) : null;
    attemptLog.push({
        suiteId, state: String(view.state), matrix: String(view.coverage.matrixStatus),
        calls: usage.calls - callsBefore,
        candidateBatchId,
        candidateBatchState: candidateBatch?.state ?? null,
    });
    console.log(`[sample] round=${round} state=${view.state} `
        + `coverage=${JSON.stringify(view.coverage)}`);
    if (String(view.coverage.matrixStatus) === 'complete'
        && candidateBatch?.state === 'complete') break;
}
if (!suiteView) {
    console.error('样本套件没有任何一轮返回');
    process.exit(3);
}

const report = {
    acceptanceVersion: SKILL_REAL_ACCEPTANCE_VERSION,
    stage, dir, provider: {
        source: chosen.source, baseUrl: chosen.baseUrl, model: chosen.model,
        key: redactSkillRealKey(chosen.apiKey),
    },
    // 真实发生了调用才写 real；否则这里就是 false，不允许自封。
    providerExecution: usage.calls > 0 ? 'real' as const : 'none' as const,
    compileJob, suite: suiteView, attempts: attemptLog, usage, probes,
    judgeIndependence: independence,
    generatedAt: now(),
};
writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
    providerExecution: report.providerExecution, usage,
    suiteState: suiteView.state, coverage: suiteView.coverage, attempts: attemptLog, dir,
}, null, 2));

await sample.shutdown();
candidateEvidence.close();
await compiler.shutdown();
const complete = String(suiteView.coverage.matrixStatus) === 'complete'
    && attemptLog.at(-1)?.candidateBatchState === 'complete';
process.exit(complete ? 0 : 1);
