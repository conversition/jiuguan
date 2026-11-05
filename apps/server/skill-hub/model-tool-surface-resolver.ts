/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Resolve parameterized tool bytes separately from the static inspection-only catalog.
 */
import { resolveMaintenanceModelToolSurface } from '../admitted-maintenance-model.ts';
import type { MaintenanceTaskKind, MaintenanceStrictProposalContext } from '../maintenance-types.ts';
import { modelToolSurfaceFor } from './model-tool-surfaces.ts';

/** A digest describes declaration bytes; it never authorizes a call, a snapshot or a proposal. */
export function resolveMaintenanceToolSurfaceVariant(
    profileId: string,
    taskKind: MaintenanceTaskKind,
    context: MaintenanceStrictProposalContext,
) {
    const surface = modelToolSurfaceFor(profileId, taskKind);
    if (!surface || !surface.variants.some((item) => item.digestResolution === 'runtime')) {
        throw new Error('model-tool-surface-route-unavailable');
    }
    const resolved = resolveMaintenanceModelToolSurface(taskKind, context);
    const variant = surface.variants.find((item) => item.selector === resolved.selector
        && item.digestResolution === 'runtime');
    if (!variant || variant.sourceVersion !== resolved.sourceVersion
        || JSON.stringify(variant.toolNames) !== JSON.stringify(resolved.toolNames)) {
        throw new Error('model-tool-surface-resolution-mismatch');
    }
    return Object.freeze({
        variantReference: variant.reference,
        sourceVersion: resolved.sourceVersion,
        toolNames: resolved.toolNames,
        toolSetDigest: resolved.toolSetDigest,
        authorityEffect: 'none' as const,
    });
}
