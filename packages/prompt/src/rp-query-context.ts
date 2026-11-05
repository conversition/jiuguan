/** @author Codex @date 2026-10-26 @version 1.0
 * Deterministic RP source compilation over the original planner, scheduler and assembly.
 * Inputs are host-authorized data, not child admission, source authority or execution grants.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
    assembleTurn,
    estimateProtectedSkillsTokens,
    estimateTurnToolSchemaTokens,
    type Message,
    type ProtectedSkillInput,
} from './assembly.ts';
import {
    contextPlanBlockingReasonCodes,
    planTurnContextBudget,
    type ContextModelProfile,
    type ContextPlanBlock,
} from './context-plan.ts';
import { blockTokens, scheduleContext } from './context-scheduler.ts';

export const RP_QUERY_CONTEXT_VERSION = 'rp-query-context-v1' as const;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_TEXT = 65_536;
const MAX_SOURCES = 32;
const MAX_COMPILED_RETRIEVAL_SOURCES = MAX_SOURCES + 16;

export interface RpQueryContextSource {
    readonly sourceRef: string;
    readonly content: string;
    readonly priority?: number;
    readonly required?: boolean;
}

export interface RpQueryContextChildResult {
    readonly artifactRef: string;
    readonly resultDigest: string;
    readonly priority?: number;
    readonly result: {
        readonly version: 'rp-child-analysis-v1';
        readonly templateId: string;
        readonly completeness: 'complete' | 'partial' | 'unknown';
        readonly conclusions: readonly Readonly<{
            claim: string;
            epistemicStatus: 'fact' | 'hypothesis' | 'disputed';
            evidenceRefs: readonly string[];
        }>[];
        readonly sourceWatermarks: readonly Readonly<{ sourceRef: string; revision: string; digest: string }>[];
        readonly truncated: boolean;
    };
}

export interface RpQueryContextInput {
    readonly systemCore: string;
    readonly currentInput: string;
    readonly taskState?: RpQueryContextSource;
    readonly retrieval?: readonly RpQueryContextSource[];
    readonly environment?: readonly RpQueryContextSource[];
    readonly childResults?: readonly RpQueryContextChildResult[];
    readonly modelProfile: ContextModelProfile;
    readonly admittedSkills?: readonly ProtectedSkillInput[];
    readonly useTools?: boolean;
    readonly p2Policy: Readonly<{ targetBasisPoints: number; maxTokens: number }>;
}

export type RpQueryContextHostInput = Omit<RpQueryContextInput, 'taskState' | 'childResults'>;
export type RpQuerySourceLayer = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface RpQueryContextTrace {
    readonly version: typeof RP_QUERY_CONTEXT_VERSION;
    readonly contextDigest: string;
    readonly planDigest: string;
    readonly sourceOrder: readonly Readonly<{
        layer: RpQuerySourceLayer;
        sourceRef: string;
        sourceDigest: string;
        tokens: number;
    }>[];
    readonly promptTokens: number;
    readonly inputBudgetTokens: number;
    readonly p2Tokens: number;
    readonly p2SoftTargetTokens: number;
    readonly p2MaxTokens: number;
    readonly blockingReasonCodes: readonly string[];
    readonly childStatuses: readonly Readonly<{
        artifactRef: string;
        resultDigest: string;
        completeness: 'complete' | 'partial' | 'unknown';
        adoptedConclusions: number;
    }>[];
}

export interface RpQueryContextCompilation {
    readonly status: 'ready' | 'blocked';
    /** Internal materialization only; callers must not copy bodies into public join DTOs. */
    readonly messages: Message[];
    readonly tools?: Record<string, unknown>[];
    readonly trace: RpQueryContextTrace;
}

interface SourceUnit {
    id: string;
    layer: RpQuerySourceLayer;
    sourceRef: string;
    sourceDigest: string;
    content: string;
    tokens: number;
    priority: number;
    required: boolean;
    conclusion: boolean;
}

function invalid(): never {
    throw new TypeError('rp-query-context-input-invalid');
}

function copyData(value: unknown, depth = 0): unknown {
    if (depth > 16) invalid();
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'string' && value.length > MAX_TEXT) invalid();
        if (value !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) invalid();
        return value;
    }
    if (types.isProxy(value)) invalid();
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) invalid();
    if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) invalid();
    if (array) {
        if (value.length > 256 || Object.keys(descriptors).length !== value.length + 1) invalid();
        return Array.from({ length: value.length }, (_, index) =>
            copyData(descriptors[String(index)]?.value, depth + 1),
        );
    }
    if (Object.keys(descriptors).length > 32) invalid();
    return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, copyData(item.value, depth + 1)]));
}

function object(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const result = value as Record<string, unknown>;
    if (required.some((key) => !Object.hasOwn(result, key))) invalid();
    if (Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
    return result;
}

function integer(value: unknown, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
    return value as number;
}

function text(value: unknown, maximum = MAX_TEXT, minimum = 1): string {
    if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid();
    return value;
}

function reference(value: unknown): string {
    const result = text(value, 240);
    if (!REFERENCE.test(result)) invalid();
    return result;
}

function digest(value: unknown): string {
    const result = text(value, 71);
    if (!DIGEST.test(result)) invalid();
    return result;
}

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        return `{${Object.keys(item)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function freezeData<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freezeData(item);
        Object.freeze(value);
    }
    return value;
}

function source(value: unknown): RpQueryContextSource {
    const item = object(value, ['sourceRef', 'content'], ['priority', 'required']);
    if (item.required !== undefined && typeof item.required !== 'boolean') invalid();
    return {
        sourceRef: reference(item.sourceRef),
        content: text(item.content),
        ...(item.priority === undefined ? {} : { priority: integer(item.priority, -10_000, 10_000) }),
        ...(item.required === undefined ? {} : { required: item.required as boolean }),
    };
}

function list<T>(value: unknown, normalize: (item: unknown) => T, maximum = MAX_SOURCES): readonly T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maximum) invalid();
    return value.map(normalize);
}

function skill(value: unknown): ProtectedSkillInput {
    const item = object(value, ['body', 'snapshot']);
    const snapshot = object(item.snapshot, [
        'skillId',
        'name',
        'role',
        'version',
        'sourceHash',
        'bodyHash',
        'exactTokens',
        'selectionReason',
        'explicit',
    ]);
    if (
        snapshot.role !== 'tactical' ||
        typeof snapshot.explicit !== 'boolean' ||
        !['explicit', 'keyword', 'semantic'].includes(text(snapshot.selectionReason, 20))
    )
        invalid();
    return {
        body: text(item.body),
        snapshot: {
            skillId: reference(snapshot.skillId),
            name: text(snapshot.name, 240),
            role: 'tactical',
            version: reference(snapshot.version),
            sourceHash: digest(snapshot.sourceHash),
            bodyHash: digest(snapshot.bodyHash),
            exactTokens: integer(snapshot.exactTokens, 0, 1_048_576),
            selectionReason: snapshot.selectionReason as 'explicit' | 'keyword' | 'semantic',
            explicit: snapshot.explicit,
        },
    };
}

function common(value: Record<string, unknown>, maxRetrievalSources = MAX_SOURCES): RpQueryContextHostInput {
    const model = object(value.modelProfile, ['modelContextTokens', 'outputReserveTokens', 'safetyMarginTokens']);
    const policy = object(value.p2Policy, ['targetBasisPoints', 'maxTokens']);
    if (value.useTools !== undefined && typeof value.useTools !== 'boolean') invalid();
    return {
        systemCore: text(value.systemCore),
        currentInput: text(value.currentInput, MAX_TEXT, 0),
        modelProfile: {
            modelContextTokens: integer(model.modelContextTokens, 2, 16_777_216),
            outputReserveTokens: integer(model.outputReserveTokens, 1, 16_777_216),
            safetyMarginTokens: integer(model.safetyMarginTokens, 0, 16_777_216),
        },
        p2Policy: {
            targetBasisPoints: integer(policy.targetBasisPoints, 1_500, 2_500),
            maxTokens: integer(policy.maxTokens, 0, 32_768),
        },
        retrieval: list(value.retrieval, source, maxRetrievalSources),
        environment: list(value.environment, source),
        admittedSkills: list(value.admittedSkills, skill),
        useTools: value.useTools as boolean | undefined,
    };
}

const COMMON_REQUIRED = ['systemCore', 'currentInput', 'modelProfile', 'p2Policy'] as const;
const COMMON_OPTIONAL = ['retrieval', 'environment', 'admittedSkills', 'useTools'] as const;

/** Freeze caller configuration before any await; parent state and child acceptance are host-only inputs. */
export function normalizeRpQueryContextHostInput(value: unknown): Readonly<RpQueryContextHostInput> {
    return freezeData(common(object(copyData(value), COMMON_REQUIRED, COMMON_OPTIONAL)));
}

function child(value: unknown): RpQueryContextChildResult {
    const item = object(value, ['artifactRef', 'resultDigest', 'result'], ['priority']);
    const result = object(item.result, [
        'version',
        'templateId',
        'completeness',
        'conclusions',
        'sourceWatermarks',
        'truncated',
    ]);
    const resultDigest = digest(item.resultDigest);
    if (`sha256:${createHash('sha256').update(canonicalJson(result), 'utf8').digest('hex')}` !== resultDigest)
        invalid();
    const completeness = text(result.completeness, 16);
    if (
        result.version !== 'rp-child-analysis-v1' ||
        !['complete', 'partial', 'unknown'].includes(completeness) ||
        typeof result.truncated !== 'boolean' ||
        !/^rp\.[a-z][a-z0-9-]{0,95}$/u.test(text(result.templateId, 99))
    )
        invalid();
    const conclusions = list(
        result.conclusions,
        (value) => {
            const conclusion = object(value, ['claim', 'epistemicStatus', 'evidenceRefs']);
            const epistemicStatus = text(conclusion.epistemicStatus, 16);
            const evidenceRefs = list(conclusion.evidenceRefs, reference, 8);
            if (
                !['fact', 'hypothesis', 'disputed'].includes(epistemicStatus) ||
                evidenceRefs.length === 0 ||
                new Set(evidenceRefs).size !== evidenceRefs.length
            )
                invalid();
            return { claim: text(conclusion.claim, 512), epistemicStatus, evidenceRefs };
        },
        8,
    );
    const sourceWatermarks = list(
        result.sourceWatermarks,
        (value) => {
            const watermark = object(value, ['sourceRef', 'revision', 'digest']);
            return {
                sourceRef: reference(watermark.sourceRef),
                revision: reference(watermark.revision),
                digest: digest(watermark.digest),
            };
        },
        8,
    );
    if (sourceWatermarks.length === 0) invalid();
    return {
        artifactRef: reference(item.artifactRef),
        resultDigest,
        ...(item.priority === undefined ? {} : { priority: integer(item.priority, -10_000, 10_000) }),
        result: {
            version: 'rp-child-analysis-v1',
            templateId: result.templateId as string,
            completeness: completeness as 'complete' | 'partial' | 'unknown',
            conclusions: conclusions as RpQueryContextChildResult['result']['conclusions'],
            sourceWatermarks,
            truncated: result.truncated,
        },
    };
}

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function dataContent(layer: RpQuerySourceLayer, value: unknown): string {
    return `<query_context source="${layer}" data-only="true">\n${JSON.stringify(value)}\n</query_context>`;
}

function sourceUnits(input: RpQueryContextInput): SourceUnit[] {
    const units: SourceUnit[] = [];
    const append = (layer: 'P1' | 'P3' | 'P4', values: readonly RpQueryContextSource[]) => {
        const base = layer === 'P1' ? 4_000_000 : layer === 'P3' ? 2_000_000 : 1_000_000;
        const seen = new Set<string>();
        for (const item of [...values].sort(
            (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || compare(a.sourceRef, b.sourceRef),
        )) {
            if (seen.has(item.sourceRef)) invalid();
            seen.add(item.sourceRef);
            const content = dataContent(layer, { sourceRef: item.sourceRef, content: item.content });
            units.push({
                id: `${layer}:${item.sourceRef}`,
                layer,
                sourceRef: item.sourceRef,
                sourceDigest: hash(item.content),
                content,
                tokens: blockTokens(content),
                priority: base + (item.priority ?? 0),
                required: item.required ?? layer === 'P1',
                conclusion: false,
            });
        }
    };
    append('P1', input.taskState ? [input.taskState] : []);
    append('P3', input.retrieval ?? []);
    append('P4', input.environment ?? []);
    return units;
}

function childUnits(children: readonly RpQueryContextChildResult[]): SourceUnit[] {
    const units: SourceUnit[] = [];
    const seen = new Set<string>();
    for (const item of children) {
        if (seen.has(item.artifactRef)) invalid();
        seen.add(item.artifactRef);
        const base = {
            artifactRef: item.artifactRef,
            resultDigest: item.resultDigest,
            completeness: item.result.completeness,
            truncated: item.result.truncated,
        };
        const payloads =
            item.result.completeness === 'complete'
                ? item.result.conclusions.map((conclusion) => ({
                      ...base,
                      templateId: item.result.templateId,
                      conclusion,
                      sourceWatermarks: item.result.sourceWatermarks,
                  }))
                : [base];
        for (const [index, payload] of payloads.entries()) {
            const content = dataContent('P2', payload);
            units.push({
                id: `P2:${item.artifactRef}:${index}`,
                layer: 'P2',
                sourceRef: item.artifactRef,
                sourceDigest: item.resultDigest,
                content,
                tokens: blockTokens(content),
                priority: 3_000_000 + (item.priority ?? 0),
                required: false,
                conclusion: item.result.completeness === 'complete',
            });
        }
    }
    return units;
}

/** This function does not verify source freshness, accepted join state or artifact ownership. */
export function compileRpQueryContext(value: RpQueryContextInput): RpQueryContextCompilation {
    const data = object(copyData(value), COMMON_REQUIRED, [...COMMON_OPTIONAL, 'taskState', 'childResults']);
    const input: RpQueryContextInput = {
        ...common(data, MAX_COMPILED_RETRIEVAL_SOURCES),
        ...(data.taskState === undefined ? {} : { taskState: source(data.taskState) }),
        childResults: list(data.childResults, child),
    };
    const children = [...(input.childResults ?? [])].sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || compare(a.artifactRef, b.artifactRef),
    );
    const ordinary = sourceUnits(input);
    const p2 = childUnits(children);
    const baseline = assembleTurn({
        systemCore: input.systemCore,
        userInput: input.currentInput,
        admittedSkills: input.admittedSkills,
        useTools: input.useTools,
        prefixCacheThreshold: 0,
        maxPromptTokens: 0,
    });
    const skillTokens = estimateProtectedSkillsTokens(input.admittedSkills);
    const toolSchemaTokens = estimateTurnToolSchemaTokens(input.useTools === true);
    const pinnedTokens = baseline.promptTokens - skillTokens - toolSchemaTokens;
    const inputBudget =
        input.modelProfile.modelContextTokens -
        input.modelProfile.outputReserveTokens -
        input.modelProfile.safetyMarginTokens;
    const requiredMinimum = ordinary.reduce((sum, unit) => sum + (unit.required ? unit.tokens : 0), 0);
    const remainder = Math.max(0, inputBudget - baseline.promptTokens - requiredMinimum);
    const softTarget = Math.floor((remainder * input.p2Policy.targetBasisPoints) / 10_000);
    const p2Demand = Math.min(
        input.p2Policy.maxTokens,
        p2.reduce((sum, unit) => sum + unit.tokens, 0),
    );
    const ordinaryBlocks: ContextPlanBlock[] = ordinary.map((unit) => ({
        id: unit.id,
        sourceDigest: unit.sourceDigest,
        budgetClass: unit.required ? 'elastic' : 'droppable',
        tokens: unit.tokens,
        priority: unit.priority,
        required: unit.required,
        minTokens: unit.required ? unit.tokens : 0,
    }));
    const makePlan = (demand: number, preferred: number) =>
        planTurnContextBudget(
            {
                pinnedBlocks: [{ id: 'query-p0-p1', sourceDigest: hash(baseline.messages), tokens: pinnedTokens }],
                toolSchemaTokens,
                blocks: [
                    ...ordinaryBlocks,
                    {
                        id: 'query-p2',
                        sourceDigest: hash(children.map((item) => item.resultDigest)),
                        budgetClass: 'elastic',
                        tokens: demand,
                        priority: 3_000_000,
                        minTokens: 0,
                        preferredTokens: preferred,
                    },
                ],
            },
            input.modelProfile,
            { admitted: skillTokens === 0 ? [] : [{ digest: hash(input.admittedSkills), tokens: skillTokens }] },
        );
    const initial = makePlan(p2Demand, Math.min(p2Demand, softTarget));
    const p2Target = initial.decisions.find((decision) => decision.id === 'query-p2')!.targetTokens;
    let selectedTokens = 0;
    const selectedP2 = p2.filter((unit) => {
        if (selectedTokens + unit.tokens > p2Target) return false;
        selectedTokens += unit.tokens;
        return true;
    });
    // Whole-item reduction can leave slack; return it through the same planner, not a second allocator.
    const plan = selectedTokens === p2Demand ? initial : makePlan(selectedTokens, selectedTokens);
    const selected = [
        ...ordinary.filter(
            (unit) => plan.decisions.find((decision) => decision.id === unit.id)!.targetTokens >= unit.tokens,
        ),
        ...selectedP2,
    ].sort((a, b) => compare(a.layer, b.layer) || b.priority - a.priority || compare(a.id, b.id));
    const scheduled = scheduleContext(
        selected.map((unit) => ({ id: unit.id, fragment: unit.content, cost: unit.tokens, priority: unit.priority })),
        plan.elasticBudgetTokens,
    );
    const blocking: string[] = [...contextPlanBlockingReasonCodes(plan)];
    if (scheduled.dropped.length > 0) blocking.push('query-context-target-unmet');
    const assembled = assembleTurn({
        systemCore: input.systemCore,
        userInput: input.currentInput,
        admittedSkills: input.admittedSkills,
        useTools: input.useTools,
        prefixCacheThreshold: 0,
        queryContextBlocks: selected.map((unit) => ({ id: unit.id, content: unit.content })),
        maxPromptTokens: blocking.length === 0 ? Math.max(1, plan.inputBudgetTokens) : 0,
    });
    if (
        assembled.promptTokens > plan.inputBudgetTokens ||
        assembled.budgetTrace.conflicts.length > 0 ||
        assembled.budgetTrace.dropped.length > 0
    )
        blocking.push('query-context-target-unmet');
    const sourceOrder: RpQueryContextTrace['sourceOrder'][number][] = [
        {
            layer: 'P0',
            sourceRef: 'host:system-core',
            sourceDigest: hash(input.systemCore),
            tokens: blockTokens(input.systemCore),
        },
        {
            layer: 'P1',
            sourceRef: 'host:current-input',
            sourceDigest: hash(input.currentInput),
            tokens: blockTokens(input.currentInput),
        },
    ];
    for (const unit of selected) {
        const previous = sourceOrder.find((entry) => entry.layer === unit.layer && entry.sourceRef === unit.sourceRef);
        if (previous)
            sourceOrder[sourceOrder.indexOf(previous)] = { ...previous, tokens: previous.tokens + unit.tokens };
        else
            sourceOrder.push({
                layer: unit.layer,
                sourceRef: unit.sourceRef,
                sourceDigest: unit.sourceDigest,
                tokens: unit.tokens,
            });
    }
    const stable = {
        version: RP_QUERY_CONTEXT_VERSION,
        planDigest: plan.planDigest,
        sourceOrder,
        promptTokens: assembled.promptTokens,
        inputBudgetTokens: plan.inputBudgetTokens,
        p2Tokens: selectedTokens,
        p2SoftTargetTokens: softTarget,
        p2MaxTokens: input.p2Policy.maxTokens,
        blockingReasonCodes: [...new Set<string>(blocking)].sort(),
        childStatuses: children.map((item) => ({
            artifactRef: item.artifactRef,
            resultDigest: item.resultDigest,
            completeness: item.result.completeness,
            adoptedConclusions: selectedP2.filter((unit) => unit.sourceRef === item.artifactRef && unit.conclusion)
                .length,
        })),
    };
    return {
        status: stable.blockingReasonCodes.length === 0 ? 'ready' : 'blocked',
        messages: stable.blockingReasonCodes.length === 0 ? assembled.messages : [],
        ...(assembled.tools === undefined ? {} : { tools: assembled.tools }),
        trace: freezeData({
            ...stable,
            contextDigest: hash({ ...stable, messages: assembled.messages, tools: assembled.tools }),
        }),
    };
}
