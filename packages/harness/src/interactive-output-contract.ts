/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Output boundaries shared by the Interactive runner and its Session consumer.
 */
import type { HarnessTool } from './types.ts';
import type { InteractiveVariableSpec, StagedVariablePatch } from './interactive-tools.ts';
import { boundToolResult, type ToolResultContractMetadata } from './tool-result-contract.ts';

export const INTERACTIVE_PRELUDE_OUTPUT_VALIDATOR_VERSION = 'interactive-prelude-output-validator-v3' as const;
export const INTERACTIVE_DIRECTOR_OUTPUT_VALIDATOR_VERSION = 'interactive-director-output-validator-v1' as const;
/** Registry patch parsing and the current-policy/literal recheck before Session commit. */
export const INTERACTIVE_VARIABLE_OUTPUT_VALIDATOR_VERSION = 'interactive-variable-output-validator-v1' as const;

interface ProviderToolCall {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
}

export interface PreparedInteractiveToolCall {
    readonly call: ProviderToolCall;
    readonly tool: HarnessTool<never>;
    readonly value: unknown;
    readonly index: number;
}

function parseInteractiveToolArguments(call: ProviderToolCall): unknown {
    if (!call.arguments || call.arguments.length > 32_768) throw new Error('interactive-tool-args-invalid');
    try {
        return JSON.parse(call.arguments);
    } catch {
        throw new Error('interactive-tool-args-invalid');
    }
}

/** Keep validation and per-item charging in their original order, before any tool executes. */
export function prepareInteractiveToolCalls(
    calls: readonly ProviderToolCall[],
    tools: ReadonlyMap<string, HarnessTool<never>>,
    modelIndex: number,
    maxToolCalls: number,
    consumeTool: () => boolean,
): readonly PreparedInteractiveToolCall[] {
    if (calls.length > maxToolCalls) throw new Error('interactive-tool-limit');
    const ids = new Set<string>();
    return calls.map((call, index) => {
        const id = call.id || `call-${modelIndex}-${index}`;
        if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id) || ids.has(id)) {
            throw new Error('interactive-tool-call-id-invalid');
        }
        ids.add(id);
        const tool = tools.get(call.name);
        if (!tool) throw new Error('interactive-tool-not-allowed');
        const args = parseInteractiveToolArguments(call);
        const validated = tool.validate(args);
        if (!validated.ok) throw new Error('interactive-tool-schema-rejected');
        if (!consumeTool()) throw new Error('interactive-tool-limit');
        return { call: { ...call, id }, tool, value: validated.value, index };
    });
}

export interface DirectorPreludePlan {
    readonly focus: string;
    readonly evidenceGaps: readonly string[];
    readonly constraints: readonly string[];
}

function strictDirectorJson(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith('```')) return trimmed.includes('```') ? null : trimmed;
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
    if (!fenced) return null;
    const payload = fenced[1]?.trim() ?? '';
    return payload && !payload.includes('```') ? payload : null;
}

export function parseDirectorPreludePlan(value: string | null): DirectorPreludePlan | null {
    if (!value || value.length > 4_096) return null;
    const payload = strictDirectorJson(value);
    if (!payload || payload.length > 4_096) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['focus', 'evidenceGaps', 'constraints'].includes(key))
        || typeof row.focus !== 'string' || row.focus.trim().length < 1 || row.focus.length > 240) return null;
    const list = (candidate: unknown): readonly string[] | null => {
        if (!Array.isArray(candidate) || candidate.length > 8
            || candidate.some((entry) => typeof entry !== 'string'
                || entry.trim().length < 1 || entry.length > 240)) return null;
        return Object.freeze(candidate.map((entry) => (entry as string).trim()));
    };
    const evidenceGaps = list(row.evidenceGaps);
    const constraints = list(row.constraints);
    if (!evidenceGaps || !constraints) return null;
    return Object.freeze({ focus: row.focus.trim(), evidenceGaps, constraints });
}

/** A well-formed plan alone cannot supply its own evidence. */
export function acceptDirectorPreludeOutput(
    content: string | null,
    eligible: boolean,
): Readonly<{
    plan?: DirectorPreludePlan;
    reason?: 'interactive-director-plan-missing' | 'interactive-director-plan-invalid';
}> {
    if (!eligible) return {};
    if (!content?.trim()) return { reason: 'interactive-director-plan-missing' };
    const plan = parseDirectorPreludePlan(content);
    return plan ? { plan } : { reason: 'interactive-director-plan-invalid' };
}

export interface InteractiveToolResultMetadata {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly metadata: ToolResultContractMetadata;
}

export interface InteractivePreludeCompleteness {
    readonly state: 'complete' | 'partial';
    readonly toolResults: readonly InteractiveToolResultMetadata[];
    readonly evidenceCarrier: ToolResultContractMetadata;
}

/** Preserve complete evidence bytes; partial carriers and inputs remain explicitly identifiable. */
export function assembleInteractivePreludeOutput(
    evidence: readonly string[],
    staged: StagedVariablePatch | undefined,
    plan: DirectorPreludePlan | undefined,
    toolResults: readonly InteractiveToolResultMetadata[] = [],
): Readonly<{
    evidence: string;
    completeness: InteractivePreludeCompleteness;
    stagedVariablePatch?: StagedVariablePatch;
    directorPlan?: DirectorPreludePlan;
}> {
    const blocks = plan ? [...evidence, `[director_plan]\n${JSON.stringify(plan)}`] : evidence;
    const carrier = boundToolResult(blocks.join('\n\n'), 32_768, 'evidence-carrier');
    const results = Object.freeze(toolResults.map((result) => Object.freeze({
        ...result,
        metadata: Object.freeze({ ...result.metadata }),
    })));
    return {
        evidence: carrier.text,
        completeness: Object.freeze({
            state: carrier.metadata.state === 'partial'
                || results.some((result) => result.metadata.state === 'partial') ? 'partial' : 'complete',
            toolResults: results,
            evidenceCarrier: carrier.metadata,
        }),
        ...(staged ? { stagedVariablePatch: structuredClone(staged) } : {}),
        ...(plan ? { directorPlan: plan } : {}),
    };
}

/** Recheck current policy and variable kind without moving the Session CAS or writes. */
export function validateInteractiveVariablePatchForCommit(
    patch: StagedVariablePatch,
    specs: ReadonlyMap<string, InteractiveVariableSpec>,
    readVariable: (path: string) => { readonly type: string } | undefined,
): void {
    for (const item of patch.patches) {
        const spec = specs.get(item.path);
        const decl = readVariable(item.path);
        if (!spec?.mutable || !decl || decl.type !== 'literal' || typeof item.value !== spec.type) {
            throw new Error('interactive-variable-patch-stale');
        }
        if (spec.type === 'number' && (
            typeof item.value !== 'number' || !Number.isFinite(item.value)
            || !Number.isFinite(spec.min) || !Number.isFinite(spec.max)
            || item.value < spec.min! || item.value > spec.max!
        )) throw new Error('interactive-variable-patch-stale');
        if (spec.type === 'string' && (
            typeof item.value !== 'string'
            || (spec.allowedValues?.length ? !spec.allowedValues.includes(item.value)
                : !Number.isSafeInteger(spec.maxLength) || item.value.length > spec.maxLength!)
        )) throw new Error('interactive-variable-patch-stale');
    }
}
