/** @author Codex @date 2026-10-15 @version 1.0 Read-only, versioned Provider tool projections. */
import { agentToolSetDigest } from '../../../packages/agent-policy/public/admission.ts';
import {
    AQL_REPLAN_TOOL_SURFACE_VERSION, aqlReplanNativeTools,
} from '../../../packages/agent-policy/public/aql-replan-request.ts';
import {
    FOREGROUND_SUMMARY_MODEL_CONTRACT_VERSION, foregroundSummaryNativeTools,
} from '../../../packages/harness/public/foreground-summary-model.ts';
import {
    MAINTENANCE_MODEL_TOOL_SURFACES,
    type MaintenanceModelToolSelector,
} from '../maintenance-model-contract.ts';
import {
    CONTEXT_COMPILER_MODEL_CONTRACT_VERSION,
    LEARNING_MODEL_CONTRACT_VERSION,
    PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION,
} from '../../../packages/harness/public/agent-model-contracts.ts';
import {
    INTERACTIVE_TOOL_CONTRACT_CATALOG_VERSION,
} from '../../../packages/harness/public/interactive-tool-contracts.ts';
import {
    effectiveInteractiveNativeTools,
    styleCompilationNativeTools,
    STYLE_COMPILATION_TOOL_SURFACE_VERSION,
} from '../../../packages/harness/public/model-tool-surfaces.ts';

export const SERVER_MODEL_TOOL_SURFACE_CATALOG_VERSION = 'server-model-tool-surface-catalog-v2' as const;
const SUMMARY_MODEL_TOOL_SURFACE_VERSION = 'summary-model-tool-surface-composite-v1';

export interface ModelToolSurfaceVariant {
    readonly reference: string;
    readonly sourceVersion: string;
    readonly selector: 'empty-variable-policy' | 'nonempty-variable-policy' | 'fixed'
    | 'aql-managed' | 'aql-legacy' | 'foreground-summary-text' | MaintenanceModelToolSelector;
    readonly transport: 'native-function' | 'no-tools';
    readonly role: 'host-execution' | 'output-submission' | 'none';
    readonly toolChoice: 'auto' | 'named-submission' | 'none';
    readonly toolNames: readonly string[];
    readonly toolSetDigest: string | null;
    readonly digestResolution: 'static' | 'runtime';
    readonly resolverReference: 'maintenance-model-tool-surface:resolveMaintenanceModelToolSurface' | null;
}

export interface ModelToolSurface {
    readonly reference: string;
    readonly sourceVersion: string;
    readonly resolution: 'static' | 'runtime';
    readonly variants: readonly ModelToolSurfaceVariant[];
    readonly authorityEffect: 'none';
    readonly runtimeStateIncluded: false;
}

function variant(
    key: string,
    version: string,
    selector: ModelToolSurfaceVariant['selector'],
    role: ModelToolSurfaceVariant['role'],
    toolChoice: ModelToolSurfaceVariant['toolChoice'],
    tools: readonly Readonly<Record<string, unknown>>[],
): ModelToolSurfaceVariant {
    const toolNames = tools.map((tool) => {
        const fn = tool.function as { name?: unknown } | undefined;
        if (typeof fn?.name !== 'string') throw new TypeError('model-tool-surface invalid native declaration');
        return fn.name;
    });
    return Object.freeze({
        reference: `ref.environment.tool-variant.${key}.${selector}.${version}`,
        sourceVersion: version,
        selector,
        transport: tools.length === 0 ? 'no-tools' : 'native-function',
        role,
        toolChoice,
        toolNames: Object.freeze(toolNames),
        toolSetDigest: agentToolSetDigest(tools),
        digestResolution: 'static',
        resolverReference: null,
    });
}

function surface(
    key: string,
    sourceVersion: string,
    resolution: ModelToolSurface['resolution'],
    variants: readonly ModelToolSurfaceVariant[],
): ModelToolSurface {
    return Object.freeze({
        reference: `ref.environment.model-tool-surface.${key}.${sourceVersion}`,
        sourceVersion,
        resolution,
        variants: Object.freeze([...variants]),
        authorityEffect: 'none',
        runtimeStateIncluded: false,
    });
}

function emptySurface(key: string, version: string): ModelToolSurface {
    return surface(key, version, 'static', [variant(key, version, 'fixed', 'none', 'none', [])]);
}

const INTERACTIVE_VERSION = INTERACTIVE_TOOL_CONTRACT_CATALOG_VERSION;
const INTERACTIVE_SURFACE = surface('interactive-prelude', INTERACTIVE_VERSION, 'runtime', [
    variant('interactive-prelude', INTERACTIVE_VERSION, 'empty-variable-policy', 'host-execution', 'auto',
        effectiveInteractiveNativeTools([])),
    // Only array emptiness selects the declaration variant; this is not a live variable grant.
    variant('interactive-prelude', INTERACTIVE_VERSION, 'nonempty-variable-policy', 'host-execution', 'auto',
        effectiveInteractiveNativeTools([{ path: 'contract:selector', type: 'boolean', mutable: true }])),
]);
const CRITIC_SURFACE = emptySurface('critic-revision', PRECOMMIT_CRITIC_MODEL_CONTRACT_VERSION);
const CONTEXT_SURFACE = emptySurface('context-compiler', CONTEXT_COMPILER_MODEL_CONTRACT_VERSION);
const PREFERENCE_SURFACE = emptySurface('learning-preference', LEARNING_MODEL_CONTRACT_VERSION);
const BRANCH_SURFACE = emptySurface('learning-branch-preference', LEARNING_MODEL_CONTRACT_VERSION);
const STYLE_SURFACE = surface('learning-style', STYLE_COMPILATION_TOOL_SURFACE_VERSION, 'static', [
    variant('learning-style', STYLE_COMPILATION_TOOL_SURFACE_VERSION, 'fixed', 'output-submission',
        'named-submission', styleCompilationNativeTools()),
]);
const AQL_SURFACE = surface('aql-replan', AQL_REPLAN_TOOL_SURFACE_VERSION, 'static', [
    variant('aql-replan', AQL_REPLAN_TOOL_SURFACE_VERSION, 'aql-managed', 'none', 'none',
        aqlReplanNativeTools('managed')),
    variant('aql-replan', AQL_REPLAN_TOOL_SURFACE_VERSION, 'aql-legacy', 'none', 'none',
        aqlReplanNativeTools('legacy')),
]);

/** Parameterized declarations have no universal digest; only the real snapshot resolver can supply it. */
const MAINTENANCE_SURFACES = MAINTENANCE_MODEL_TOOL_SURFACES.map((descriptor) => {
    const key = `maintenance-${descriptor.taskKind}`;
    const variants: ModelToolSurfaceVariant[] = descriptor.variants.map((item) => Object.freeze({
        reference: `ref.environment.tool-variant.${key}.${item.selector}.${descriptor.sourceVersion}`,
        sourceVersion: descriptor.sourceVersion,
        selector: item.selector,
        transport: 'native-function', role: 'host-execution', toolChoice: 'auto',
        toolNames: item.toolNames,
        toolSetDigest: null, digestResolution: 'runtime',
        resolverReference: 'maintenance-model-tool-surface:resolveMaintenanceModelToolSurface',
    } as const));
    if (descriptor.taskKind === 'rolling_summary') variants.push(variant(key,
        FOREGROUND_SUMMARY_MODEL_CONTRACT_VERSION, 'foreground-summary-text', 'none', 'none',
        foregroundSummaryNativeTools()));
    return surface(key, descriptor.taskKind === 'rolling_summary'
        ? SUMMARY_MODEL_TOOL_SURFACE_VERSION : descriptor.sourceVersion, 'runtime', variants);
});
const MAINTENANCE_BY_TASK = new Map(MAINTENANCE_MODEL_TOOL_SURFACES.map((item, index) =>
    [item.taskKind, MAINTENANCE_SURFACES[index]!] as const));

export const SERVER_MODEL_TOOL_SURFACES = Object.freeze([
    INTERACTIVE_SURFACE, CRITIC_SURFACE, CONTEXT_SURFACE, PREFERENCE_SURFACE, BRANCH_SURFACE, STYLE_SURFACE,
    AQL_SURFACE, ...MAINTENANCE_SURFACES,
]);

/** Missing routes remain unindexed; a shared task name cannot inherit a neighbouring tool grant. */
export function modelToolSurfaceFor(profileId: string, taskKind: string): ModelToolSurface | null {
    if (taskKind === 'interactive_prelude' && [
        'interactive.prelude', 'interactive.director', 'interactive.variableProposal',
    ].includes(profileId)) return INTERACTIVE_SURFACE;
    if (profileId === 'interactive.critic' && taskKind === 'critic_revision') return CRITIC_SURFACE;
    if (profileId === 'context.compiler' && taskKind === 'context_compiler') return CONTEXT_SURFACE;
    if (profileId === 'learning.preference' && taskKind === 'preference_extract') return PREFERENCE_SURFACE;
    if (profileId === 'learning.branchPreference' && taskKind === 'preference_extract') return BRANCH_SURFACE;
    if (profileId === 'learning.styleCompile' && taskKind === 'style_compile') return STYLE_SURFACE;
    if (profileId === 'interactive.aqlReplan' && taskKind === 'aql_replan') return AQL_SURFACE;
    if (profileId === 'maintenance.memory' && taskKind === 'memory_consolidation') {
        return MAINTENANCE_BY_TASK.get('memory_consolidation')!;
    }
    if (profileId === 'maintenance.memory' && taskKind === 'rolling_summary') {
        return MAINTENANCE_BY_TASK.get('rolling_summary')!;
    }
    if (['maintenance.branchIndex', 'maintenance.arc'].includes(profileId) && taskKind === 'branch_index') {
        return MAINTENANCE_BY_TASK.get('branch_index')!;
    }
    if (profileId === 'maintenance.npc' && taskKind === 'npc_state') return MAINTENANCE_BY_TASK.get('npc_state')!;
    if (profileId === 'maintenance.worldbook' && taskKind === 'worldbook_repair') {
        return MAINTENANCE_BY_TASK.get('worldbook_repair')!;
    }
    return null;
}
