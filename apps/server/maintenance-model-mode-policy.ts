/** @author Codex @date 2026-10-14 @version 1.0
 * Model execution must agree with the existing write grant, never manufacture one.
 */
import {
    maintenanceMemorySummaryApplyMode,
    type MaintenanceApplyRuntimeConfig,
} from './maintenance-apply-runtime-config.ts';
import type { PublicMaintenanceJob } from './maintenance-types.ts';

export function maintenanceModelModeAllowed(
    enabled: boolean,
    config: MaintenanceApplyRuntimeConfig,
    job: Pick<PublicMaintenanceJob, 'sessionId' | 'taskKind' | 'mode'>,
): boolean {
    if (!enabled) return false;
    if (job.mode === 'shadow') return true;
    if (job.mode !== 'apply'
        || (job.taskKind !== 'memory_consolidation' && job.taskKind !== 'rolling_summary')) return false;
    return maintenanceMemorySummaryApplyMode(config, job.sessionId, job.taskKind) === 'apply';
}
