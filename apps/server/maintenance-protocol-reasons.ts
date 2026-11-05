/**
 * Stable, content-free control-plane reason codes shared by the Maintenance
 * circuit breaker and evidence-bound recovery. This module must stay free of
 * store/runtime imports so either side can depend on it without a cycle.
 */
export const MAINTENANCE_CAPABILITY_PROTOCOL_KILL_REASON =
  'maintenance-protocol-invalid' as const;

export const MAINTENANCE_MULTI_TASK_PROTOCOL_KILL_REASON =
  'maintenance-multi-task-protocol-invalid' as const;
