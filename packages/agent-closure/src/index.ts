import { createHash } from 'node:crypto';

/**
 * Privacy-safe, domain-neutral contract for proving that an Agent result was
 * not merely generated, but validated, committed, consumed and observed.
 *
 * This package deliberately knows nothing about SQLite, HTTP or any concrete
 * Agent implementation. Domain adapters translate their own durable receipts
 * into this small event vocabulary.
 */
export const AGENT_CLOSURE_CONTRACT_VERSION = 'agent-closure-v1' as const;

export const AGENT_CLOSURE_CAPABILITIES = Object.freeze([
  'interactive.prelude',
  'interactive.director',
  'interactive.critic',
  'interactive.aqlReplan',
  'interactive.variableProposal',
  'context.compiler',
  'learning.preference',
  'learning.branchPreference',
  'learning.styleCompile',
  'maintenance.memory',
  'maintenance.branchIndex',
  'maintenance.arc',
  'maintenance.summary',
  'maintenance.npc',
  'maintenance.worldbook',
  'maintenance.nsfwScene',
] as const);
export type AgentClosureCapability = typeof AGENT_CLOSURE_CAPABILITIES[number];

export const AGENT_CLOSURE_LANES = Object.freeze([
  'interactive', 'learning', 'maintenance',
] as const);
export type AgentClosureLane = typeof AGENT_CLOSURE_LANES[number];

/** Advisory artifacts are read directly; proposal artifacts require apply + readback. */
export const AGENT_CLOSURE_KINDS = Object.freeze(['advisory', 'proposal'] as const);
export type AgentClosureKind = typeof AGENT_CLOSURE_KINDS[number];

/**
 * One authoritative capability registry prevents a write-producing Agent from
 * relabelling itself as advisory and skipping apply/readback evidence.  Keep
 * this mapping in the pure contract; adapters may translate names, but may not
 * redefine their lane or closure kind.
 */
export const AGENT_CLOSURE_CAPABILITY_CONTRACTS = Object.freeze({
  'interactive.prelude': Object.freeze({ lane: 'interactive', kind: 'advisory' }),
  'interactive.director': Object.freeze({ lane: 'interactive', kind: 'advisory' }),
  'interactive.critic': Object.freeze({ lane: 'interactive', kind: 'advisory' }),
  'interactive.aqlReplan': Object.freeze({ lane: 'interactive', kind: 'advisory' }),
  'interactive.variableProposal': Object.freeze({ lane: 'interactive', kind: 'proposal' }),
  'context.compiler': Object.freeze({ lane: 'interactive', kind: 'advisory' }),
  'learning.preference': Object.freeze({ lane: 'learning', kind: 'proposal' }),
  'learning.branchPreference': Object.freeze({ lane: 'learning', kind: 'proposal' }),
  'learning.styleCompile': Object.freeze({ lane: 'learning', kind: 'proposal' }),
  'maintenance.memory': Object.freeze({ lane: 'maintenance', kind: 'proposal' }),
  'maintenance.branchIndex': Object.freeze({ lane: 'maintenance', kind: 'proposal' }),
  'maintenance.arc': Object.freeze({ lane: 'maintenance', kind: 'proposal' }),
  'maintenance.summary': Object.freeze({ lane: 'maintenance', kind: 'proposal' }),
  'maintenance.npc': Object.freeze({ lane: 'maintenance', kind: 'proposal' }),
  'maintenance.worldbook': Object.freeze({ lane: 'maintenance', kind: 'proposal' }),
  'maintenance.nsfwScene': Object.freeze({ lane: 'maintenance', kind: 'proposal' }),
} as const satisfies Record<AgentClosureCapability, Readonly<{
  lane: AgentClosureLane;
  kind: AgentClosureKind;
}>>);

export const AGENT_CLOSURE_EXECUTION_CLASSES = Object.freeze([
  'production', 'shadow', 'operational-replay', 'fixture',
] as const);
export type AgentClosureExecutionClass = typeof AGENT_CLOSURE_EXECUTION_CLASSES[number];

/**
 * 写权限 / 审批方式。它与 `executionClass` **正交**（P16 C1）：
 * - `proposalMode=shadow` 只表示"只产出待审批提案、无人自动写入"；
 * - `executionClass` 只表示"证据来自哪里"。
 *
 * 把两者混为一谈曾导致自然生产回合的维护任务因为 `mode=shadow` 被当作阴影证据，
 * 使生产闭环在架构上不可达。
 */
export const AGENT_CLOSURE_PROPOSAL_MODES = Object.freeze(['shadow', 'apply'] as const);
export type AgentClosureProposalMode = typeof AGENT_CLOSURE_PROPOSAL_MODES[number];

/** 维护任务持久化的触发来源，与 `maintenance_jobs.trigger_kind` 同词表。 */
export const MAINTENANCE_TRIGGER_KINDS = Object.freeze(['post-turn', 'idle', 'manual'] as const);
export type MaintenanceTriggerKind = typeof MAINTENANCE_TRIGGER_KINDS[number];

const EXECUTION_CLASS_STRENGTH: Readonly<Record<AgentClosureExecutionClass, number>> = Object.freeze({
  fixture: 0,
  'operational-replay': 1,
  shadow: 2,
  production: 3,
});

/**
 * 证据来源由**权威入口的持久化触发方式**决定，而不是由写权限决定：
 * 自然回合（`post-turn`）与空闲调度（`idle`）都是生产证据；
 * `manual` 目前只被工具 / 离线回放 / 测试使用，在 C4 的 source outbox 能给出可核对
 * 来源之前一律 fail-closed 记 `fixture`，绝不进入生产分母。
 */
export function executionClassForMaintenanceTrigger(
  trigger: unknown,
): AgentClosureExecutionClass {
  const kind = member(trigger, MAINTENANCE_TRIGGER_KINDS, 'maintenance-trigger');
  return kind === 'manual' ? 'fixture' : 'production';
}

/**
 * `learning.*` 的证据来源由**会话种类**决定（P16 C2.3），同样与写权限正交。
 *
 * 维护 lane 有持久化 `trigger` 可作来源依据；learning 提案由会话回合产生、**没有 job**，
 * 因此只能按"产生它的会话种类"判定：
 * - `production`：本机 managed-local 真实用户会话，且学习 lane 当前不处于 `test-session` 灰度；
 * - `replay`：运营 replay / 离线脚本驱动 → `operational-replay`；
 * - 其它（含未知值、无法判定）：fail-closed 记 `fixture`，**绝不**进入生产分母。
 *
 * 这里刻意不用 `member()`：未知值必须静默降级为最弱证据，而不是抛错后被上层吞掉，
 * 否则会重演 C1 "证据静默消失" 的老坑。
 */
export const LEARNING_SESSION_KINDS = Object.freeze(['production', 'replay'] as const);
export type LearningSessionKind = typeof LEARNING_SESSION_KINDS[number];

export function executionClassForLearningSession(
  kind: unknown,
): AgentClosureExecutionClass {
  if (kind === 'production') return 'production';
  if (kind === 'replay') return 'operational-replay';
  return 'fixture';
}

/**
 * 只允许**降级**：高保真来源（production）可被权威入口显式降级为更弱的证据来源
 * （例如用生产路径做离线灰度），但离线证据永远不能被声明升级成 production。
 * 未知声明 fail-closed 回落派生值。
 */
export function weakenExecutionClass(
  derived: unknown,
  declared: unknown,
): AgentClosureExecutionClass {
  const base = member(derived, AGENT_CLOSURE_EXECUTION_CLASSES, 'execution-class');
  if (declared === undefined) return base;
  if (typeof declared !== 'string'
    || !(AGENT_CLOSURE_EXECUTION_CLASSES as readonly string[]).includes(declared)) return base;
  const candidate = declared as AgentClosureExecutionClass;
  return EXECUTION_CLASS_STRENGTH[candidate] <= EXECUTION_CLASS_STRENGTH[base] ? candidate : base;
}

/** 校验并归一化写权限/审批方式。 */
export function agentClosureProposalMode(value: unknown): AgentClosureProposalMode {
  return member(value, AGENT_CLOSURE_PROPOSAL_MODES, 'proposal-mode');
}

/** 写权限只决定审批路径，不改变证据来源。 */
export function maintenanceRequiresApproval(mode: unknown): boolean {
  return agentClosureProposalMode(mode) === 'shadow';
}

/**
 * capability 别名只用于显示与分母去重：一个领域 receipt 只能产生**一条**主 run，
 * 别名绝不允许复制第二条 run 或同时进入分母。
 *
 * 两处已知折叠（都以**操作者可见的控制面**为唯一权威）：
 * - `branch_index` 实际产出 Arc projection ⇒ 归 `maintenance.arc`，`maintenance.branchIndex`
 *   保留为历史别名；
 * - `rolling_summary` 在控制面就归在"记忆/摘要"下（`maintenance.memory`）⇒
 *   账本侧也折进 `maintenance.memory`。此前账本单独记成 `maintenance.summary`，而那个名字
 *   **根本不在控制面注册表里**，于是那部分证据既杀不掉也看不见；
 * - `interactive.director` 与 `interactive.prelude` 由**同一个** `interactive_prelude`
 *   循环承载（控制面早已把三者标为 `shared`）⇒ 它们产出的是**同一份**工件，
 *   只能有一条 run。唯一归属取 `interactive.prelude`。
 *
 * 保留原名在 `AGENT_CLOSURE_CAPABILITIES` 里（而不是删除）是为了让**历史行仍能解析** ——
 * 删名会让 `parseRun` 抛 `capability-invalid`，把旧证据整条变成读不出来的垃圾。
 */
export const AGENT_CLOSURE_CAPABILITY_ALIASES: Readonly<
  Partial<Record<AgentClosureCapability, AgentClosureCapability>>
> = Object.freeze({
  'maintenance.branchIndex': 'maintenance.arc',
  'maintenance.summary': 'maintenance.memory',
  'interactive.director': 'interactive.prelude',
});

/** 把 legacy alias 折算成唯一归属 capability；本函数是分母去重的唯一入口。 */
export function canonicalAgentClosureCapability(capability: unknown): AgentClosureCapability {
  const value = member(capability, AGENT_CLOSURE_CAPABILITIES, 'capability');
  return AGENT_CLOSURE_CAPABILITY_ALIASES[value] ?? value;
}

/**
 * capability 查询的等价集合：按任一别名过滤都必须同时命中其唯一归属，
 * 否则迁移前后的历史行会被拆成两个分母。
 */
export function agentClosureCapabilityFilter(capability: unknown): readonly AgentClosureCapability[] {
  const canonical = canonicalAgentClosureCapability(capability);
  const aliases = (Object.keys(AGENT_CLOSURE_CAPABILITY_ALIASES) as AgentClosureCapability[])
    .filter((alias) => alias !== canonical
      && AGENT_CLOSURE_CAPABILITY_ALIASES[alias] === canonical);
  return Object.freeze([canonical, ...aliases]);
}

export const AGENT_CLOSURE_EVENT_TYPES = Object.freeze([
  'admitted',
  'execution-completed',
  'proposal-persisted',
  'artifact-validated',
  'apply-committed',
  'readback-verified',
  'context-consumed',
  'effect-observed',
  'no-op-completed',
  'failed',
  'cancelled',
  'rejected',
  'stale',
  'rolled-back',
] as const);
export type AgentClosureEventType = typeof AGENT_CLOSURE_EVENT_TYPES[number];

export type AgentClosureStage =
  | 'admitted'
  | 'executed'
  | 'proposed'
  | 'validated'
  | 'applied'
  | 'verified'
  | 'consumed'
  | 'observed';

export type AgentClosureStatus =
  | 'active'
  | 'closed'
  | 'no_op'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'stale'
  | 'rolled_back';

export interface AgentClosureRunInput {
  readonly operationId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly sessionId: string;
  readonly capability: AgentClosureCapability;
  readonly lane: AgentClosureLane;
  readonly kind: AgentClosureKind;
  readonly executionClass: AgentClosureExecutionClass;
  readonly sourceRevision: string;
  readonly policyVersion: string;
  readonly evidenceDigest?: string;
  readonly admittedAt: string;
}

/**
 * Bounded metadata only. Prompt text, proposal payloads, tool arguments,
 * worldbook text, Skill bodies and model reasoning have no field here.
 */
export interface AgentSkillClosureAttributionV1 {
  readonly attributionVersion: 'agent-skill-attribution-v1';
  readonly instructionSetDigest: string;
  readonly selectionReceiptDigest: string;
  readonly compiledArtifactDigest: string;
  readonly compiledInstructionSetDigest: string;
  readonly validatorPlanDigest: string;
  readonly selectedManifestDigests: readonly string[];
  readonly activeCandidateDigests: readonly string[];
  readonly validatorOutcome: 'passed' | 'not-required';
}

export interface AgentClosureEventInput {
  readonly type: Exclude<AgentClosureEventType, 'admitted'>;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly artifactDigest?: string;
  /** Opaque pointer to the authoritative receipt/proposal, never its content. */
  readonly evidenceRef?: string;
  readonly sourceRevision?: string;
  readonly targetRevision?: string;
  readonly consumerRunId?: string;
  readonly contextBlock?: string;
  readonly reasonCode?: string;
  readonly itemCount?: number;
  readonly tokenCount?: number;
  readonly effectOutcome?: 'positive' | 'neutral' | 'negative' | 'inconclusive';
  readonly skillAttribution?: AgentSkillClosureAttributionV1;
}

export function normalizeAgentSkillClosureAttribution(input: unknown): AgentSkillClosureAttributionV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) throw new Error('skill-attribution-invalid');
  const value = input as Record<string, unknown>;
  const fields = ['attributionVersion', 'instructionSetDigest', 'selectionReceiptDigest',
    'compiledArtifactDigest', 'compiledInstructionSetDigest', 'validatorPlanDigest',
    'selectedManifestDigests', 'activeCandidateDigests', 'validatorOutcome'];
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || value.attributionVersion !== 'agent-skill-attribution-v1') throw new Error('skill-attribution-invalid');
  const digests = (items: unknown): readonly string[] => {
    if (!Array.isArray(items) || items.length > 64) throw new Error('skill-attribution-digests-invalid');
    const result: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (!Object.hasOwn(items, index)) throw new Error('skill-attribution-digests-invalid');
      result.push(agentClosureDigest(items[index], 'skill-attribution-digest'));
    }
    if (new Set(result).size !== result.length) throw new Error('skill-attribution-digests-duplicate');
    return Object.freeze(result);
  };
  return Object.freeze({
    attributionVersion: 'agent-skill-attribution-v1',
    instructionSetDigest: agentClosureDigest(value.instructionSetDigest, 'skill-instruction-set'),
    selectionReceiptDigest: agentClosureDigest(value.selectionReceiptDigest, 'skill-selection-receipt'),
    compiledArtifactDigest: agentClosureDigest(value.compiledArtifactDigest, 'skill-compiled-artifact'),
    compiledInstructionSetDigest: agentClosureDigest(value.compiledInstructionSetDigest, 'skill-compiled-instruction-set'),
    validatorPlanDigest: agentClosureDigest(value.validatorPlanDigest, 'skill-validator-plan'),
    selectedManifestDigests: digests(value.selectedManifestDigests),
    activeCandidateDigests: digests(value.activeCandidateDigests),
    validatorOutcome: member(value.validatorOutcome, ['passed', 'not-required'] as const, 'skill-validator-outcome'),
  });
}

export interface AgentClosureEvent extends Omit<AgentClosureEventInput, 'type'> {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: AgentClosureEventType;
}

export interface AgentClosureFold {
  readonly stage: AgentClosureStage;
  readonly status: AgentClosureStatus;
  readonly nextRequiredEvent: AgentClosureEventType | null;
  readonly eventCount: number;
  readonly consumedCount: number;
  /** Fixtures and operational replay can prove mechanics, never production effect. */
  readonly qualifiesAsProductionClosure: boolean;
  readonly latestReasonCode?: string;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u;
const REASON_RE = /^[a-z][a-z0-9-]{0,79}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}-invalid`);
  return value as T;
}

export function agentClosureToken(value: unknown, label: string, max = 240): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || !TOKEN_RE.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

export function agentClosureDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

export function agentClosureTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error(`${label}-invalid`);
  return value;
}

function optionalToken(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : agentClosureToken(value, label);
}

function optionalDigest(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : agentClosureDigest(value, label);
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new Error(`${label}-invalid`);
  }
  return value as number;
}

export function normalizeAgentClosureRun(input: AgentClosureRunInput): AgentClosureRunInput {
  const capability = member(input.capability, AGENT_CLOSURE_CAPABILITIES, 'capability');
  const lane = member(input.lane, AGENT_CLOSURE_LANES, 'lane');
  const kind = member(input.kind, AGENT_CLOSURE_KINDS, 'kind');
  const contract = AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability];
  if (lane !== contract.lane) throw new Error('capability-lane-mismatch');
  if (kind !== contract.kind) throw new Error('capability-kind-mismatch');
  const normalized: AgentClosureRunInput = {
    operationId: agentClosureToken(input.operationId, 'operation-id'),
    runId: agentClosureToken(input.runId, 'run-id'),
    ...(input.parentRunId === undefined ? {} : {
      parentRunId: agentClosureToken(input.parentRunId, 'parent-run-id'),
    }),
    sessionId: agentClosureToken(input.sessionId, 'session-id'),
    capability,
    lane,
    kind,
    executionClass: member(
      input.executionClass,
      AGENT_CLOSURE_EXECUTION_CLASSES,
      'execution-class',
    ),
    sourceRevision: agentClosureToken(input.sourceRevision, 'source-revision'),
    policyVersion: agentClosureToken(input.policyVersion, 'policy-version'),
    ...(input.evidenceDigest === undefined ? {} : {
      evidenceDigest: agentClosureDigest(input.evidenceDigest, 'evidence-digest'),
    }),
    admittedAt: agentClosureTimestamp(input.admittedAt, 'admitted-at'),
  };
  return Object.freeze(normalized);
}

export function normalizeAgentClosureEvent(
  input: AgentClosureEventInput,
): AgentClosureEventInput {
  const type = member(
    input.type,
    AGENT_CLOSURE_EVENT_TYPES.filter((value) => value !== 'admitted'),
    'event-type',
  ) as AgentClosureEventInput['type'];
  const reasonCode = optionalToken(input.reasonCode, 'reason-code');
  if (reasonCode !== undefined && !REASON_RE.test(reasonCode)) throw new Error('reason-code-invalid');
  const normalized: AgentClosureEventInput = {
    type,
    idempotencyKey: agentClosureToken(input.idempotencyKey, 'idempotency-key'),
    occurredAt: agentClosureTimestamp(input.occurredAt, 'occurred-at'),
    ...(input.skillAttribution === undefined ? {} : {
      skillAttribution: normalizeAgentSkillClosureAttribution(input.skillAttribution),
    }),
    ...(input.artifactDigest === undefined ? {} : {
      artifactDigest: optionalDigest(input.artifactDigest, 'artifact-digest'),
    }),
    ...(input.evidenceRef === undefined ? {} : {
      evidenceRef: optionalToken(input.evidenceRef, 'evidence-ref'),
    }),
    ...(input.sourceRevision === undefined ? {} : {
      sourceRevision: optionalToken(input.sourceRevision, 'event-source-revision'),
    }),
    ...(input.targetRevision === undefined ? {} : {
      targetRevision: optionalToken(input.targetRevision, 'event-target-revision'),
    }),
    ...(input.consumerRunId === undefined ? {} : {
      consumerRunId: optionalToken(input.consumerRunId, 'consumer-run-id'),
    }),
    ...(input.contextBlock === undefined ? {} : {
      contextBlock: optionalToken(input.contextBlock, 'context-block'),
    }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(input.itemCount === undefined ? {} : { itemCount: optionalCount(input.itemCount, 'item-count') }),
    ...(input.tokenCount === undefined ? {} : { tokenCount: optionalCount(input.tokenCount, 'token-count') }),
    ...(input.effectOutcome === undefined ? {} : {
      effectOutcome: member(
        input.effectOutcome,
        ['positive', 'neutral', 'negative', 'inconclusive'] as const,
        'effect-outcome',
      ),
    }),
  };
  if (type === 'context-consumed'
    && (!normalized.consumerRunId || !normalized.contextBlock || !normalized.artifactDigest)) {
    throw new Error('context-consumption-binding-required');
  }
  if (normalized.skillAttribution && type !== 'context-consumed') {
    throw new Error('skill-attribution-requires-consumption');
  }
  if (['execution-completed', 'proposal-persisted', 'artifact-validated', 'context-consumed']
    .includes(type) && !normalized.sourceRevision) {
    throw new Error('event-source-revision-required');
  }
  if (['proposal-persisted', 'artifact-validated', 'apply-committed', 'readback-verified', 'rolled-back']
    .includes(type)
    && !normalized.artifactDigest) throw new Error('artifact-digest-required');
  if (type === 'proposal-persisted' && !normalized.evidenceRef) {
    throw new Error('proposal-evidence-ref-required');
  }
  if (['apply-committed', 'readback-verified'].includes(type) && !normalized.evidenceRef) {
    throw new Error('proposal-transition-evidence-ref-required');
  }
  if (['apply-committed', 'readback-verified'].includes(type) && !normalized.targetRevision) {
    throw new Error('proposal-target-revision-required');
  }
  if (type === 'rolled-back' && !normalized.evidenceRef) {
    throw new Error('rollback-evidence-ref-required');
  }
  if (type === 'effect-observed' && (!normalized.artifactDigest
    || !normalized.consumerRunId || !normalized.effectOutcome)) {
    throw new Error('effect-observation-binding-required');
  }
  if (['failed', 'cancelled', 'rejected', 'stale', 'rolled-back'].includes(type)
    && !normalized.reasonCode) throw new Error('terminal-reason-required');
  return Object.freeze(normalized);
}

function requiredEvents(kind: AgentClosureKind): readonly AgentClosureEventType[] {
  return kind === 'proposal'
    ? Object.freeze([
      'admitted', 'execution-completed', 'proposal-persisted', 'artifact-validated', 'apply-committed',
      'readback-verified', 'context-consumed', 'effect-observed',
    ])
    : Object.freeze([
      'admitted', 'execution-completed', 'artifact-validated',
      'context-consumed', 'effect-observed',
    ]);
}

function firstEvent(
  events: readonly AgentClosureEvent[],
  type: AgentClosureEventType,
): AgentClosureEvent | undefined {
  return events.find((event) => event.type === type);
}

/**
 * Event presence alone is not proof that the same artifact travelled through
 * the loop.  Keep these joins in the pure contract so every store/adapter has
 * identical fail-closed semantics.
 */
function assertArtifactLineage(
  kind: AgentClosureKind,
  events: readonly AgentClosureEvent[],
): void {
  const admitted = firstEvent(events, 'admitted');
  const sourceBoundTypes = new Set<AgentClosureEventType>([
    'execution-completed', 'proposal-persisted', 'artifact-validated', 'context-consumed',
  ]);
  for (const event of events) {
    if (sourceBoundTypes.has(event.type)
      && (!event.sourceRevision || event.sourceRevision !== admitted?.sourceRevision)) {
      throw new Error('closure-source-revision-mismatch');
    }
  }
  if (kind !== 'proposal') return;
  const proposal = firstEvent(events, 'proposal-persisted');
  const validated = firstEvent(events, 'artifact-validated');
  const applied = firstEvent(events, 'apply-committed');
  const readback = firstEvent(events, 'readback-verified');
  const rolledBack = firstEvent(events, 'rolled-back');
  const expected = proposal?.artifactDigest;
  if (expected && validated && validated.artifactDigest !== expected) {
    throw new Error('closure-proposal-validation-digest-mismatch');
  }
  if (expected && applied && applied.artifactDigest !== expected) {
    throw new Error('closure-proposal-apply-digest-mismatch');
  }
  if (proposal?.evidenceRef && applied?.evidenceRef !== undefined
    && applied.evidenceRef !== proposal.evidenceRef) {
    throw new Error('closure-proposal-apply-evidence-mismatch');
  }
  if (proposal?.evidenceRef && readback?.evidenceRef !== undefined
    && readback.evidenceRef !== proposal.evidenceRef) {
    throw new Error('closure-proposal-readback-evidence-mismatch');
  }
  if (applied && !applied.targetRevision) {
    throw new Error('closure-proposal-apply-target-revision-required');
  }
  if (readback && !readback.targetRevision) {
    throw new Error('closure-proposal-readback-target-revision-required');
  }
  if (applied?.targetRevision && readback?.targetRevision
    && applied.targetRevision !== readback.targetRevision) {
    throw new Error('closure-proposal-target-revision-mismatch');
  }
  if (proposal?.evidenceRef && rolledBack?.evidenceRef !== undefined
    && rolledBack.evidenceRef !== proposal.evidenceRef) {
    throw new Error('closure-proposal-rollback-evidence-mismatch');
  }
}

function missingLineageEvent(
  kind: AgentClosureKind,
  events: readonly AgentClosureEvent[],
): 'context-consumed' | 'effect-observed' | null {
  const lineageEvent = kind === 'proposal'
    ? firstEvent(events, 'readback-verified')
    : firstEvent(events, 'artifact-validated');
  const lineage = lineageEvent?.artifactDigest;
  if (!lineage || !lineageEvent) return 'context-consumed';
  const lineageAt = Date.parse(agentClosureTimestamp(lineageEvent.occurredAt, 'lineage-occurred-at'));
  const consumed = events.filter((event) => (
    event.type === 'context-consumed' && event.artifactDigest === lineage
      && Date.parse(agentClosureTimestamp(event.occurredAt, 'consumption-occurred-at')) >= lineageAt
  ));
  if (consumed.length === 0) return 'context-consumed';
  const effects = events.filter((event) => event.type === 'effect-observed');
  return effects.some((effect) => consumed.some((receipt) => (
    receipt.artifactDigest === effect.artifactDigest
      && receipt.consumerRunId === effect.consumerRunId
      && Date.parse(agentClosureTimestamp(effect.occurredAt, 'effect-occurred-at'))
        >= Date.parse(agentClosureTimestamp(receipt.occurredAt, 'consumption-occurred-at'))
  ))) ? null : 'effect-observed';
}

function assertCommittedLineageTime(
  kind: AgentClosureKind,
  events: readonly AgentClosureEvent[],
): void {
  if (kind !== 'proposal') return;
  const validated = firstEvent(events, 'artifact-validated');
  const applied = firstEvent(events, 'apply-committed');
  const readback = firstEvent(events, 'readback-verified');
  const time = (event: AgentClosureEvent, label: string): number => (
    Date.parse(agentClosureTimestamp(event.occurredAt, label))
  );
  if (validated && applied
    && time(applied, 'apply-occurred-at') < time(validated, 'validation-occurred-at')) {
    throw new Error('closure-proposal-apply-before-validation');
  }
  if (applied && readback
    && time(readback, 'readback-occurred-at') < time(applied, 'apply-occurred-at')) {
    throw new Error('closure-proposal-readback-before-apply');
  }
}

/**
 * Fold evidence without assuming cross-database atomic ordering. A late repair
 * may append an earlier missing milestone; the stage advances only through the
 * contiguous required evidence set, so out-of-order evidence never fakes a
 * completed loop.
 */
export function foldAgentClosure(
  kind: AgentClosureKind,
  events: readonly AgentClosureEvent[],
  executionClass: AgentClosureExecutionClass = 'fixture',
): AgentClosureFold {
  member(kind, AGENT_CLOSURE_KINDS, 'kind');
  member(executionClass, AGENT_CLOSURE_EXECUTION_CLASSES, 'execution-class');
  if (!Array.isArray(events) || events.length < 1) {
    throw new Error('closure-admission-event-required');
  }
  let consumedCount = 0;
  let latestReasonCode: string | undefined;
  let priorSequence = 0;
  const present = new Set<AgentClosureEventType>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== priorSequence + 1) {
      throw new Error('closure-event-sequence-invalid');
    }
    priorSequence = event.sequence;
    present.add(event.type);
    if (event.reasonCode) latestReasonCode = event.reasonCode;
    if (event.type === 'context-consumed') consumedCount += 1;
  }
  if (!present.has('admitted')) throw new Error('closure-admission-event-required');
  if (kind === 'advisory' && (present.has('apply-committed') || present.has('readback-verified')
    || present.has('rolled-back'))) throw new Error('closure-advisory-write-evidence-invalid');
  assertArtifactLineage(kind, events);
  assertCommittedLineageTime(kind, events);

  const required = requiredEvents(kind);
  const missingByType = required.find((event) => !present.has(event)) ?? null;
  const lineageMissing = missingLineageEvent(kind, events);
  // An unbound consumption/effect may be valid evidence for another artifact
  // or consumer, but cannot close this lineage.
  const firstMissing = missingByType ?? lineageMissing;
  const completedRequired = firstMissing === null;
  const stage: AgentClosureStage = present.has('effect-observed') && completedRequired ? 'observed'
    : present.has('context-consumed') && lineageMissing !== 'context-consumed'
      && required.slice(0, -1).every((event) => present.has(event)) ? 'consumed'
      : kind === 'proposal' && present.has('readback-verified')
        && required.slice(0, 6).every((event) => present.has(event)) ? 'verified'
        : kind === 'proposal' && present.has('apply-committed')
          && required.slice(0, 5).every((event) => present.has(event)) ? 'applied'
          : present.has('artifact-validated')
            && required.slice(0, kind === 'proposal' ? 4 : 3).every((event) => present.has(event)) ? 'validated'
            : kind === 'proposal' && present.has('proposal-persisted')
              && required.slice(0, 3).every((event) => present.has(event)) ? 'proposed'
            : present.has('execution-completed')
              && required.slice(0, 2).every((event) => present.has(event)) ? 'executed'
              : 'admitted';
  const status: AgentClosureStatus = present.has('rolled-back') ? 'rolled_back'
    : present.has('rejected') ? 'rejected'
      : present.has('stale') ? 'stale'
        : present.has('cancelled') ? 'cancelled'
          : present.has('no-op-completed') ? 'no_op'
            : present.has('failed') ? 'failed'
              : completedRequired ? 'closed' : 'active';
  return Object.freeze({
    stage,
    status,
    nextRequiredEvent: ['no_op', 'failed', 'rejected', 'stale', 'cancelled', 'rolled_back'].includes(status)
      ? null : firstMissing,
    eventCount: events.length,
    consumedCount,
    qualifiesAsProductionClosure: status === 'closed' && executionClass === 'production',
    ...(latestReasonCode === undefined ? {} : { latestReasonCode }),
  });
}

/** Stable opaque join key; source ids and evidence text never enter the identifier. */
export function agentClosureOperationId(
  namespace: string,
  runId: string,
  discriminator = '',
): string {
  const safeNamespace = agentClosureToken(namespace, 'operation-namespace', 48);
  const safeRunId = agentClosureToken(runId, 'operation-run-id');
  if (typeof discriminator !== 'string' || discriminator.length > 512
    || /[\u0000-\u001f]/u.test(discriminator)) throw new Error('operation-discriminator-invalid');
  const digest = createHash('sha256')
    .update(`${safeNamespace}\0${safeRunId}\0${discriminator}`, 'utf8')
    .digest('hex').slice(0, 40);
  return `closure_${safeNamespace}_${digest}`;
}
