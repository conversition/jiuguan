export type OperationalReplayLane = 'interactive' | 'learning' | 'maintenance';

export const OPERATIONAL_REPLAY_BRIDGE_VERSION = 2 as const;
export const OPERATIONAL_REPLAY_CAPABILITY_FILE = 'operational-replay-bridge.v2.json';
export const OPERATIONAL_REPLAY_ACKS: Readonly<Record<OperationalReplayLane, string>> = Object.freeze({
  interactive: 'p14-q9-interactive-operational-replay-v2',
  learning: 'p14-q9-learning-operational-replay-v1',
  maintenance: 'p14-q9-maintenance-operational-replay-v2',
});

export const P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID =
  'p14-q9-maintenance-operational-suite-v2' as const;
export const P14_MAINTENANCE_OPERATIONAL_BUDGET_ID =
  'p14-maintenance-operational-budget-v2' as const;
export const P14_MAINTENANCE_OPERATIONAL_MAX_COST_MICROUSD = 2_500_000 as const;
export const P14_MAINTENANCE_OPERATIONAL_ACCOUNTING_VERSION =
  'p14-maintenance-operational-accounting-v3' as const;

export interface OperationalReplayCapability {
  readonly version: typeof OPERATIONAL_REPLAY_BRIDGE_VERSION;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly pid: number;
  readonly serverInstanceId: string;
  readonly token: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface OperationalReplaySelection {
  readonly providerId: string;
  readonly model: string;
}

/**
 * Bridge-owned conservative accounting for the physical Provider window.
 * Cost may include failed or timed-out calls whose reservation is deliberately
 * not refunded, so it can be greater than accounting derived from responses.
 */
export interface OperationalReplayAccounting {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrousd: number;
}

/** The exact session accepted by /begin, echoed by /finish with its accounting. */
export interface OperationalReplayFinish {
  readonly sessionId: string;
  readonly accounting: OperationalReplayAccounting;
}

/** Maintenance v2 persists the bridge-owned session inside its digest-bound evidence. */
export interface MaintenanceOperationalReplayBridgeAccounting
  extends OperationalReplayAccounting {
  readonly sessionId: string;
}

export interface MaintenanceOperationalReplaySourceManifestEntry {
  readonly scenarioId: string;
  readonly sourceDigest: string;
}

export interface MaintenanceOperationalReplayToolSetManifestEntry {
  readonly scenarioId: string;
  readonly taskKind: 'npc_state' | 'branch_index';
  readonly proposalContextDigest: string;
  readonly toolSetDigest: string;
}

export interface MaintenanceOperationalReplayAccountingSummary extends OperationalReplayAccounting {
  readonly providerErrors: number;
  readonly invalidCalls: number;
}

export interface MaintenanceOperationalReplayAccountingEvidence {
  readonly version: typeof P14_MAINTENANCE_OPERATIONAL_ACCOUNTING_VERSION;
  readonly lane: 'maintenance';
  readonly suiteId: typeof P14_MAINTENANCE_OPERATIONAL_REPLAY_SUITE_ID;
  readonly sessionId: string;
  readonly suiteDigest: string;
  readonly runDigest: string;
  readonly sourceArtifactDigest: string;
  readonly toolSetDigest: string;
  readonly sourceManifest: readonly MaintenanceOperationalReplaySourceManifestEntry[];
  readonly toolSetManifest: readonly MaintenanceOperationalReplayToolSetManifestEntry[];
  readonly replayAccounting: MaintenanceOperationalReplayAccountingSummary;
  readonly bridgeAccounting: MaintenanceOperationalReplayBridgeAccounting;
  readonly accountingDigest: string;
}

export interface OperationalReplayFinishResponse extends OperationalReplayFinish {
  readonly ok: true;
}

export interface OperationalReplayResponse {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
  raw: unknown;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_input_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
  } | null;
}

export interface OperationalReplayTransportClient {
  complete(request: unknown, signal?: AbortSignal, call?: unknown): Promise<OperationalReplayResponse>;
  stream(
    request: unknown,
    onDelta: (delta: string) => void,
    onToolArg?: (name: string, argsDelta: string, delta?: {
      index: number;
      id?: string;
      nameDelta?: string;
    }) => void,
    signal?: AbortSignal,
    call?: unknown,
  ): Promise<OperationalReplayResponse>;
  modelName(): string;
  capabilities(): { readonly stream: boolean; readonly tools: boolean };
}
