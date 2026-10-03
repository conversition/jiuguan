import type { AgentRuntimeLeaseRow } from '../../apps/server/agent-admission-ledger.ts';
import type { ModelUsageRow } from '../../apps/server/model-usage-ledger.ts';

export interface DiagnosticMaintenanceJob {
  readonly taskKind: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly hasProposal: boolean;
  readonly modelCalls: number;
}

function counts(values: readonly string[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function buildP14OperationalDiagnostics(input: {
  readonly sessionId: string;
  readonly usage: readonly ModelUsageRow[];
  readonly leases: readonly AgentRuntimeLeaseRow[];
  readonly maintenanceJobs: readonly DiagnosticMaintenanceJob[];
  readonly generatedAt: string;
  readonly since?: string;
}) {
  const usageLanes = [...new Set(input.usage.map((row) => row.lane))].sort();
  const modelByLane = Object.freeze(Object.fromEntries(usageLanes.map((lane) => {
    const rows = input.usage.filter((row) => row.lane === lane);
    const errors = rows.filter((row) => row.outcome === 'transport_error');
    return [lane, Object.freeze({
      calls: rows.length,
      completed: rows.filter((row) => row.outcome === 'completed').length,
      transportErrors: errors.length,
      cancelled: rows.filter((row) => row.outcome === 'cancelled').length,
      providerUsageKnown: rows.filter((row) => row.usageSource === 'provider').length,
      promptTokens: rows.reduce((sum, row) => sum + (row.usage?.prompt_tokens ?? 0), 0),
      completionTokens: rows.reduce((sum, row) => sum + (row.usage?.completion_tokens ?? 0), 0),
      costMicrousd: rows.reduce((sum, row) => sum + (row.costMicrousd ?? 0), 0),
      p50LatencyMs: percentile(rows.map((row) => row.elapsedMs), 0.5),
      p95LatencyMs: percentile(rows.map((row) => row.elapsedMs), 0.95),
      errorCodes: counts(errors.map((row) => row.errorCode ?? 'unclassified-transport-error')),
    })] as const;
  })));

  const leaseLanes = [...new Set(input.leases.map((row) => row.lane))].sort();
  const leasesByLane = Object.freeze(Object.fromEntries(leaseLanes.map((lane) => {
    const rows = input.leases.filter((row) => row.lane === lane);
    return [lane, Object.freeze({
      leases: rows.length,
      outcomes: counts(rows.map((row) => row.outcome)),
      reasonCodes: counts(rows.flatMap((row) => row.reasonCode ? [row.reasonCode] : [])),
      modelCalls: rows.reduce((sum, row) => sum + row.modelCallsUsed, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokensUsed, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokensUsed, 0),
      costMicrousd: rows.reduce((sum, row) => sum + row.costMicrousdUsed, 0),
    })] as const;
  })));

  const taskKinds = [...new Set(input.maintenanceJobs.map((row) => row.taskKind))].sort();
  const maintenanceByTask = Object.freeze(Object.fromEntries(taskKinds.map((taskKind) => {
    const rows = input.maintenanceJobs.filter((row) => row.taskKind === taskKind);
    const invoked = rows.filter((row) => row.modelCalls > 0);
    return [taskKind, Object.freeze({
      jobs: rows.length,
      statuses: counts(rows.map((row) => row.status)),
      errorCodes: counts(rows.flatMap((row) => row.errorCode ? [row.errorCode] : [])),
      modelCalls: rows.reduce((sum, row) => sum + row.modelCalls, 0),
      modelInvokedJobs: invoked.length,
      proposalJobs: rows.filter((row) => row.hasProposal).length,
      proposalYield: ratio(invoked.filter((row) => row.hasProposal).length, invoked.length),
    })] as const;
  })));

  const riskFlags: string[] = [];
  for (const [lane, row] of Object.entries(modelByLane)) {
    const errorRate = ratio(row.transportErrors, row.calls) ?? 0;
    if (row.calls > 0 && errorRate > 0.10) {
      riskFlags.push(`${lane}:${row.calls >= 20 ? 'provider-error-rate-exceeded' : 'provider-error-rate-watch'}`);
    }
  }
  for (const [lane, row] of Object.entries(leasesByLane)) {
    if ((row.outcomes.provider_error ?? 0) > 0) riskFlags.push(`${lane}:lease-provider-error`);
    if ((row.outcomes.budget_exhausted ?? 0) > 0) riskFlags.push(`${lane}:lease-budget-exhausted`);
    if ((row.outcomes.usage_unavailable ?? 0) > 0) riskFlags.push(`${lane}:lease-usage-unavailable`);
  }
  for (const [taskKind, row] of Object.entries(maintenanceByTask)) {
    if (row.modelInvokedJobs > 0 && row.proposalJobs === 0) {
      riskFlags.push(`maintenance:${taskKind}:zero-proposal-yield`);
    }
  }

  return Object.freeze({
    version: 'p14-operational-diagnostics-v1' as const,
    generatedAt: input.generatedAt,
    window: Object.freeze({ since: input.since ?? null, through: input.generatedAt }),
    sessionId: input.sessionId,
    privacy: Object.freeze({ contentIncluded: false, identifiersIncluded: false }),
    modelCalls: Object.freeze({ total: input.usage.length, byLane: modelByLane }),
    runtimeLeases: Object.freeze({ total: input.leases.length, byLane: leasesByLane }),
    maintenance: Object.freeze({ totalJobs: input.maintenanceJobs.length, byTask: maintenanceByTask }),
    riskFlags: Object.freeze(riskFlags.sort()),
  });
}
