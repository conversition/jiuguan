/**
 * @author Codex @date 2026-10-15 @version 1.1
 * Side-effect-free identities for the Maintenance model boundary.
 *
 * Runtime modules re-export the corresponding identity beside each implementation;
 * the read-only Agent index imports this file so inspecting contracts never loads a
 * Manager, database adapter or Provider path.
 */
/** Task-specific maintenanceSystemPrompt family. */
export const MAINTENANCE_BASE_SYSTEM_INSTRUCTION_VERSION =
    'maintenance-base-system-instruction-v2' as const;
/** Fixed instruction embedded in every bounded maintenance snapshot. */
export const MAINTENANCE_SNAPSHOT_USER_INSTRUCTION_VERSION =
    'maintenance-snapshot-user-instruction-v1' as const;
/** Bounded protocol correction selected after a rejected proposal. */
export const MAINTENANCE_REPAIR_INSTRUCTION_VERSION =
    'maintenance-repair-instruction-v2' as const;
/**
 * Composite Provider-visible instruction identity. The concrete request is
 * resolved at runtime from the base, snapshot and optional repair components.
 */
export const MAINTENANCE_HOST_INSTRUCTION_VERSION =
    'maintenance-host-instruction-composite-v2' as const;
export const MAINTENANCE_SESSION_INPUT_VERSION = 'maintenance-session-input-v1' as const;
/** Strict proposal dispatch plus the typed NPC no-op terminal parser. */
export const MAINTENANCE_OUTPUT_VALIDATOR_VERSION =
    'maintenance-output-validator-v1' as const;

/** Production native declarations are resolved only against the claimed fixed snapshot. */
export const MAINTENANCE_MODEL_TOOL_SURFACE_VERSION = 'maintenance-native-tool-surface-v1' as const;

export type MaintenanceModelToolTaskKind =
    | 'memory_consolidation'
    | 'branch_index'
    | 'rolling_summary'
    | 'npc_state'
    | 'worldbook_repair';

export type MaintenanceModelToolSelector =
    | 'fixed-snapshot'
    | 'npc-fixed-snapshot'
    | 'npc-fixed-snapshot-noop';

export interface MaintenanceModelToolVariantDescriptor {
    readonly selector: MaintenanceModelToolSelector;
    readonly toolNames: readonly string[];
}

export interface MaintenanceModelToolSurfaceDescriptor {
    readonly taskKind: MaintenanceModelToolTaskKind;
    readonly sourceVersion: typeof MAINTENANCE_MODEL_TOOL_SURFACE_VERSION;
    readonly variants: readonly MaintenanceModelToolVariantDescriptor[];
}


function maintenanceToolVariant(
    taskKind: MaintenanceModelToolTaskKind,
    selector: MaintenanceModelToolSelector,
): MaintenanceModelToolVariantDescriptor {
    return Object.freeze({
        selector,
        toolNames: Object.freeze([
            'query_memory', 'get_worldbook', 'get_variables', `propose_${taskKind}`,
            ...(selector === 'npc-fixed-snapshot-noop' ? ['complete_npc_state_noop'] : []),
        ]),
    });
}


function maintenanceToolDescriptor(
    taskKind: MaintenanceModelToolTaskKind,
): MaintenanceModelToolSurfaceDescriptor {
    return Object.freeze({
        taskKind,
        sourceVersion: MAINTENANCE_MODEL_TOOL_SURFACE_VERSION,
        variants: Object.freeze(taskKind === 'npc_state'
            ? [
                maintenanceToolVariant(taskKind, 'npc-fixed-snapshot'),
                maintenanceToolVariant(taskKind, 'npc-fixed-snapshot-noop'),
            ]
            : [maintenanceToolVariant(taskKind, 'fixed-snapshot')]),
    });
}


/** No snapshots, enum values or digests are retained in this inspection-only catalog. */
export const MAINTENANCE_MODEL_TOOL_SURFACES = Object.freeze([
    maintenanceToolDescriptor('memory_consolidation'),
    maintenanceToolDescriptor('branch_index'),
    maintenanceToolDescriptor('rolling_summary'),
    maintenanceToolDescriptor('npc_state'),
    maintenanceToolDescriptor('worldbook_repair'),
]);


export function maintenanceModelToolSurfaceDescriptor(
    taskKind: MaintenanceModelToolTaskKind,
): MaintenanceModelToolSurfaceDescriptor {
    const descriptor = MAINTENANCE_MODEL_TOOL_SURFACES.find((surface) => surface.taskKind === taskKind);
    if (!descriptor) throw new Error('maintenance-provider-tool-contract-invalid');
    return descriptor;
}
