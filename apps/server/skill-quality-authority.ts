/** @author Codex @date 2026-10-17 @version 1.0
 * Host-owned, stateless authority for two pinned Skill Quality judges.
 * It never reads credentials, endpoints, fixture bodies, or mutable Provider internals.
 */
import { createHash } from 'node:crypto';
import {
    agentBudgetProfileDigest, type AgentBudgetProfileV2,
} from '../../packages/agent-policy/public/budget-profile.ts';
import type { ChatCompletionClient } from '../../packages/proxy/public/client.ts';
import { arbitratedAgentClient } from './agent-arbitrated-client.ts';
import type { ProviderDescriptor } from '../../packages/proxy/public/provider-protocol.ts';
import {
    MODEL_RUNTIME_PROFILE_VERSION, type ModelRuntimeProfile,
} from '../../packages/prompt/public/model-runtime-profile.ts';
import type { AdmissionTicketBroker } from './agent-admission-broker.ts';
import { agentTaskBudgetProfile } from './agent-task-budget-profiles.ts';
import type { RunSkillQualityModelInput } from './skill-quality-model.ts';
import type { SkillQualityModelBinding, SkillQualityJudgeSlot }
    from './skill-quality-registry.ts';

export const SKILL_QUALITY_AUTHORITY_VERSION = 'skill-quality-authority-v1' as const;
export const SKILL_QUALITY_JUDGE_BINDING_VERSION = 'skill-quality-judge-binding-v1' as const;

export const SKILL_QUALITY_JUDGE_ENV = Object.freeze({
    judgeAProviderId: 'JG_AGENT_SKILL_QUALITY_JUDGE_A_PROVIDER_ID',
    judgeAModel: 'JG_AGENT_SKILL_QUALITY_JUDGE_A_MODEL',
    judgeBProviderId: 'JG_AGENT_SKILL_QUALITY_JUDGE_B_PROVIDER_ID',
    judgeBModel: 'JG_AGENT_SKILL_QUALITY_JUDGE_B_MODEL',
} as const);

const JUDGE_ENV_PREFIX = 'JG_AGENT_SKILL_QUALITY_JUDGE_';
const PROVIDER_ID = /^[a-z][a-z0-9.-]{0,63}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const KNOWN_JUDGE_ENV = new Set<string>(Object.values(SKILL_QUALITY_JUDGE_ENV));

export interface SkillQualityJudgeSelection {
    readonly judgeSlot: SkillQualityJudgeSlot;
    readonly providerId: string;
    readonly modelId: string;
}

export interface SkillQualityGenerationAuthority {
    readonly providerId: string;
    readonly modelId: string;
    readonly modelBindingDigest: string;
}

type QualityModelBase = Omit<RunSkillQualityModelInput,
    'claim' | 'allowed' | 'signal' | 'modelId' | 'modelBindingDigest' | 'budgetProfile'>;

export interface SkillQualityJudgeModelContext extends QualityModelBase, SkillQualityModelBinding {
    readonly judgeSlot: SkillQualityJudgeSlot;
    readonly providerId: string;
    readonly budgetProfile: AgentBudgetProfileV2;
    readonly auditRequired: true;
    readonly onLeaseClosed: NonNullable<RunSkillQualityModelInput['onLeaseClosed']>;
}

export interface SkillQualityAuthoritySnapshot {
    readonly authorityVersion: typeof SKILL_QUALITY_AUTHORITY_VERSION;
    readonly generation: SkillQualityModelBinding;
    readonly judges: readonly [SkillQualityJudgeModelContext, SkillQualityJudgeModelContext];
    readonly perJudgeBudget: AgentBudgetProfileV2;
    readonly perJudgeBudgetDigest: string;
}

export interface SkillQualityAuthorityHost {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly generation: SkillQualityGenerationAuthority;
    readonly broker: AdmissionTicketBroker;
    readonly estimateCostMicrousd: RunSkillQualityModelInput['estimateCostMicrousd'];
    readonly onLeaseClosed: NonNullable<RunSkillQualityModelInput['onLeaseClosed']>;
    readonly now?: RunSkillQualityModelInput['now'];
    describeProvider(providerId: string): ProviderDescriptor | undefined;
    createClient(selection: Readonly<{ providerId: string; model: string }>): ChatCompletionClient;
    resolveModelProfile(
        selection: Readonly<{ providerId: string; model: string }>,
        client: ChatCompletionClient,
    ): ModelRuntimeProfile;
}

function sha256(input: string): string {
    return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

function canonicalDigest(input: unknown): string {
    return sha256(JSON.stringify(input));
}

function providerId(input: unknown): string {
    if (typeof input !== 'string' || !PROVIDER_ID.test(input)) {
        throw new Error('skill-quality-judge-provider-invalid');
    }
    return input;
}

function modelId(input: unknown): string {
    if (typeof input !== 'string') throw new Error('skill-quality-judge-model-invalid');
    const normalized = input.trim();
    if (normalized !== input || !MODEL_ID.test(normalized)) {
        throw new Error('skill-quality-judge-model-invalid');
    }
    return normalized;
}

function hash(input: unknown, code: string): string {
    if (typeof input !== 'string' || !HASH.test(input)) throw new Error(code);
    return input;
}

/** Missing and every value other than the exact string `1` remain disabled. */
export function skillQualityEnabled(
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    return env.JG_AGENT_SKILL_QUALITY === '1';
}

/** Provider identity is the current host-owned independence boundary. */
export function skillQualityProviderIndependenceDigest(input: string): string {
    return sha256(providerId(input));
}

/**
 * Parse the only four supported judge-routing scalars. Unknown prefixed keys and partial
 * configurations are rejected instead of inheriting the dialogue or generation model.
 */
export function parseSkillQualityJudgeEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
): readonly [SkillQualityJudgeSelection, SkillQualityJudgeSelection] | null {
    const unknown = Object.keys(env).find((key) => (
        key.startsWith(JUDGE_ENV_PREFIX) && !KNOWN_JUDGE_ENV.has(key)
    ));
    if (unknown) throw new Error('skill-quality-judge-env-unknown');
    const raw = [
        env[SKILL_QUALITY_JUDGE_ENV.judgeAProviderId],
        env[SKILL_QUALITY_JUDGE_ENV.judgeAModel],
        env[SKILL_QUALITY_JUDGE_ENV.judgeBProviderId],
        env[SKILL_QUALITY_JUDGE_ENV.judgeBModel],
    ] as const;
    if (raw.every((value) => value === undefined)) return null;
    if (raw.some((value) => value === undefined)) {
        throw new Error('skill-quality-judge-env-incomplete');
    }
    const selections = Object.freeze([
        Object.freeze({ judgeSlot: 'judge-a' as const, providerId: providerId(raw[0]), modelId: modelId(raw[1]) }),
        Object.freeze({ judgeSlot: 'judge-b' as const, providerId: providerId(raw[2]), modelId: modelId(raw[3]) }),
    ]) as readonly [SkillQualityJudgeSelection, SkillQualityJudgeSelection];
    if (selections[0].providerId === selections[1].providerId) {
        throw new Error('skill-quality-judge-independence-invalid');
    }
    return selections;
}

function publicDescriptor(input: ProviderDescriptor | undefined, expectedProviderId: string) {
    if (!input || input.id !== expectedProviderId || input.configured !== true
        || input.protocolVersion !== 1 || typeof input.adapterVersion !== 'string'
        || input.adapterVersion.length < 1 || input.adapterVersion.length > 128
        || !input.capabilities || input.capabilities.tools !== true
        || input.capabilities.chatCompletions !== true) {
        throw new Error('skill-quality-judge-provider-unavailable');
    }
    // Explicitly copy public fields. Extra adapter properties can neither leak nor influence a binding.
    return Object.freeze({
        id: expectedProviderId,
        adapterVersion: input.adapterVersion,
        protocolVersion: 1 as const,
        configured: true as const,
        capabilities: Object.freeze({
            listModels: input.capabilities.listModels === true,
            stream: input.capabilities.stream === true,
            tools: true as const,
            vision: input.capabilities.vision === true,
            chatCompletions: true as const,
            responses: input.capabilities.responses === true,
            messages: input.capabilities.messages === true,
        }),
    });
}

function positiveInteger(input: unknown, code: string): number {
    if (!Number.isSafeInteger(input) || Number(input) < 1) throw new Error(code);
    return Number(input);
}

function normalizeProfile(
    input: ModelRuntimeProfile,
    selection: SkillQualityJudgeSelection,
): ModelRuntimeProfile {
    const independence = skillQualityProviderIndependenceDigest(selection.providerId);
    if (!input || input.version !== MODEL_RUNTIME_PROFILE_VERSION
        || input.providerIdDigest !== independence || input.modelId !== selection.modelId
        || input.supportsTools !== true
        || !['provider-exact', 'local-exact', 'conservative-estimate'].includes(input.tokenizer)
        || !['static-declaration', 'provider-verified'].includes(input.source)
        || typeof input.supportsStreaming !== 'boolean'
        || typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))
        || new Date(input.updatedAt).toISOString() !== input.updatedAt) {
        throw new Error('skill-quality-judge-profile-invalid');
    }
    const contextWindowTokens = positiveInteger(
        input.contextWindowTokens, 'skill-quality-judge-profile-invalid',
    );
    const maxOutputTokens = positiveInteger(
        input.maxOutputTokens, 'skill-quality-judge-profile-invalid',
    );
    if (maxOutputTokens >= contextWindowTokens) throw new Error('skill-quality-judge-profile-invalid');
    const inputRate = input.inputMicrousdPerMillionTokens;
    const outputRate = input.outputMicrousdPerMillionTokens;
    if ((inputRate === undefined) !== (outputRate === undefined)
        || inputRate !== undefined && (!Number.isSafeInteger(inputRate) || inputRate < 1)
        || outputRate !== undefined && (!Number.isSafeInteger(outputRate) || outputRate < 1)) {
        throw new Error('skill-quality-judge-profile-invalid');
    }
    return Object.freeze({
        version: MODEL_RUNTIME_PROFILE_VERSION,
        providerIdDigest: independence,
        modelId: selection.modelId,
        contextWindowTokens,
        maxOutputTokens,
        tokenizer: input.tokenizer,
        supportsTools: true,
        supportsStreaming: input.supportsStreaming,
        ...(inputRate === undefined ? {} : {
            inputMicrousdPerMillionTokens: inputRate,
            outputMicrousdPerMillionTokens: outputRate,
        }),
        source: input.source,
        updatedAt: input.updatedAt,
    });
}

function sharedBudgetProfile(
    profiles: readonly [ModelRuntimeProfile, ModelRuntimeProfile],
    env: Readonly<Record<string, string | undefined>>,
): AgentBudgetProfileV2 {
    const tokenizer: ModelRuntimeProfile['tokenizer'] = profiles.some(
        (profile) => profile.tokenizer === 'conservative-estimate',
    ) ? 'conservative-estimate' : profiles.some(
        (profile) => profile.tokenizer === 'local-exact',
    ) ? 'local-exact' : 'provider-exact';
    const common: ModelRuntimeProfile = Object.freeze({
        version: MODEL_RUNTIME_PROFILE_VERSION,
        providerIdDigest: canonicalDigest(profiles.map((profile) => profile.providerIdDigest).sort()),
        modelId: 'skill-quality-shared-budget',
        contextWindowTokens: Math.min(...profiles.map((profile) => profile.contextWindowTokens)),
        maxOutputTokens: Math.min(...profiles.map((profile) => profile.maxOutputTokens)),
        tokenizer,
        supportsTools: true,
        supportsStreaming: profiles.every((profile) => profile.supportsStreaming),
        source: profiles.every((profile) => profile.source === 'provider-verified')
            ? 'provider-verified' : 'static-declaration',
        updatedAt: profiles.map((profile) => profile.updatedAt).sort()[0]!,
    });
    const budget = agentTaskBudgetProfile('skill_quality', env, {}, common);
    if (profiles.some((profile) => (
        budget.agentInputBudgetTokens + budget.agentOutputBudgetTokens > profile.contextWindowTokens
        || budget.agentOutputBudgetTokens > profile.maxOutputTokens
    ))) throw new Error('skill-quality-judge-budget-unavailable');
    return budget;
}

function validClient(input: ChatCompletionClient): ChatCompletionClient {
    if (!input || typeof input.complete !== 'function' || typeof input.stream !== 'function') {
        throw new Error('skill-quality-judge-client-invalid');
    }
    let capabilities: ReturnType<NonNullable<ChatCompletionClient['capabilities']>> | undefined;
    try { capabilities = input.capabilities?.(); } catch {
        throw new Error('skill-quality-judge-client-invalid');
    }
    if (capabilities?.tools !== true) throw new Error('skill-quality-judge-client-invalid');
    return input;
}

function judgeBindingDigest(input: {
    readonly selection: SkillQualityJudgeSelection;
    readonly descriptor: ReturnType<typeof publicDescriptor>;
    readonly profile: ModelRuntimeProfile;
    readonly budget: AgentBudgetProfileV2;
    readonly independenceGroupDigest: string;
}): string {
    return canonicalDigest({
        bindingVersion: SKILL_QUALITY_JUDGE_BINDING_VERSION,
        judgeSlot: input.selection.judgeSlot,
        selection: { providerId: input.selection.providerId, modelId: input.selection.modelId },
        descriptor: input.descriptor,
        profile: input.profile,
        budget: input.budget,
        independenceGroupDigest: input.independenceGroupDigest,
    });
}

/**
 * Build two pinned contexts from public host ports. Every failure returns null and no fallback
 * is attempted. In particular, one valid judge can never stand in for the other.
 */
export function resolveSkillQualityAuthority(
    input: SkillQualityAuthorityHost,
): SkillQualityAuthoritySnapshot | null {
    const env = input.env ?? process.env;
    if (!skillQualityEnabled(env)) return null;
    try {
        const selections = parseSkillQualityJudgeEnvironment(env);
        if (!selections || typeof input.estimateCostMicrousd !== 'function'
            || typeof input.onLeaseClosed !== 'function') return null;
        const generationProviderId = providerId(input.generation.providerId);
        const generationModelId = modelId(input.generation.modelId);
        const generationModelBindingDigest = hash(
            input.generation.modelBindingDigest, 'skill-quality-generation-binding-invalid',
        );
        if (selections.some((selection) => selection.providerId === generationProviderId)) return null;

        // Resolve both public descriptors before creating either client.
        const descriptors = selections.map((selection) => publicDescriptor(
            input.describeProvider(selection.providerId), selection.providerId,
        )) as [ReturnType<typeof publicDescriptor>, ReturnType<typeof publicDescriptor>];
        // P17-01.3：裁判/生成 client 全部走全局仲裁（quality-judge = background）。
        // 这一层同时知道 providerId 与 model，是唯一能诚实组键的地方。
        // 独立性检查必须作用在**原始** client 上：包装会生成新对象，会让
        // 「两个裁判槽不得共用同一个 client」的检查失效。
        const rawClients = selections.map((selection) => input.createClient({
            providerId: selection.providerId, model: selection.modelId,
        })) as [ChatCompletionClient, ChatCompletionClient];
        if (rawClients[0] === rawClients[1]) return null;
        const clients = rawClients.map((raw, index) => validClient(arbitratedAgentClient(
            raw, { providerId: selections[index]!.providerId, model: selections[index]!.modelId },
            'quality-judge',
        ))) as [ChatCompletionClient, ChatCompletionClient];
        const profiles = selections.map((selection, index) => normalizeProfile(
            input.resolveModelProfile({ providerId: selection.providerId, model: selection.modelId }, clients[index]!),
            selection,
        )) as [ModelRuntimeProfile, ModelRuntimeProfile];
        const budget = sharedBudgetProfile(profiles, env);
        const budgetDigest = agentBudgetProfileDigest(budget);
        const generation: SkillQualityModelBinding = Object.freeze({
            modelId: generationModelId,
            modelBindingDigest: generationModelBindingDigest,
            independenceGroupDigest: skillQualityProviderIndependenceDigest(generationProviderId),
        });
        const judges = selections.map((selection, index) => {
            const independenceGroupDigest = skillQualityProviderIndependenceDigest(selection.providerId);
            const modelBindingDigest = judgeBindingDigest({
                selection, descriptor: descriptors[index]!, profile: profiles[index]!, budget,
                independenceGroupDigest,
            });
            return Object.freeze({
                judgeSlot: selection.judgeSlot,
                providerId: selection.providerId,
                modelId: selection.modelId,
                modelBindingDigest,
                independenceGroupDigest,
                broker: input.broker,
                client: clients[index]!,
                budgetProfile: budget,
                estimateCostMicrousd: input.estimateCostMicrousd,
                auditRequired: true as const,
                onLeaseClosed: input.onLeaseClosed,
                ...(input.now ? { now: input.now } : {}),
            });
        }) as unknown as readonly [SkillQualityJudgeModelContext, SkillQualityJudgeModelContext];
        const groups = [generation.independenceGroupDigest,
            judges[0].independenceGroupDigest, judges[1].independenceGroupDigest];
        const bindings = [generation.modelBindingDigest,
            judges[0].modelBindingDigest, judges[1].modelBindingDigest];
        if (new Set(groups).size !== 3 || new Set(bindings).size !== 3
            || judges[0].budgetProfile !== judges[1].budgetProfile
            || agentBudgetProfileDigest(judges[0].budgetProfile) !== budgetDigest
            || agentBudgetProfileDigest(judges[1].budgetProfile) !== budgetDigest) return null;
        return Object.freeze({
            authorityVersion: SKILL_QUALITY_AUTHORITY_VERSION,
            generation,
            judges: Object.freeze(judges),
            perJudgeBudget: budget,
            perJudgeBudgetDigest: budgetDigest,
        });
    } catch { return null; }
}
