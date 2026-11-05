import {
  AGENT_TASK_KINDS,
  type AdmissionRequest,
  type AgentTaskKind,
} from '../../packages/agent-policy/src/admission.ts';
import {
  AGENT_SUBCAPABILITY_IDS,
  type AgentSubcapabilityId,
} from '../../packages/mobile-contracts/src/agent-control.ts';
import {
  AGENT_CLOSURE_CAPABILITIES,
  AGENT_CLOSURE_CAPABILITY_ALIASES,
  AGENT_CLOSURE_CAPABILITY_CONTRACTS,
  type AgentClosureCapability,
  type AgentClosureKind,
} from '../../packages/agent-closure/index.ts';
import type { AgentControlStore } from './agent-control-store.ts';

const capabilities = (...ids: AgentSubcapabilityId[]): readonly AgentSubcapabilityId[] => Object.freeze(ids);

const TASK_CAPABILITIES: Readonly<Record<AgentTaskKind, readonly AgentSubcapabilityId[]>> = Object.freeze({
  // One shared interactive loop currently serves all three logical roles.
  interactive_prelude: capabilities(
    'interactive.prelude', 'interactive.director', 'interactive.variableProposal',
  ),
  context_compiler: capabilities('context.compiler'),
  memory_consolidation: capabilities('maintenance.memory'),
  // The persisted compatibility task executes both the branch-index and Arc
  // projections in one shared loop, so either control must stop that loop.
  branch_index: capabilities('maintenance.branchIndex', 'maintenance.arc'),
  rolling_summary: capabilities('maintenance.memory'),
  npc_state: capabilities('maintenance.npc'),
  worldbook_repair: capabilities('maintenance.worldbook'),
  preference_extract: capabilities('learning.preference'),
  style_compile: capabilities('learning.styleCompile'),
  skill_compile: capabilities('learning.styleCompile'),
  skill_evaluate: capabilities('learning.styleCompile'),
  skill_sample: capabilities('learning.styleCompile'),
  skill_quality: capabilities('learning.styleCompile'),
  arc_maintenance: capabilities('maintenance.arc'),
  npc_maintenance: capabilities('maintenance.npc'),
  critic_revision: capabilities('interactive.critic'),
  aql_replan: capabilities('interactive.aqlReplan'),
  // No existing control-plane toggle grants the new, explicitly hosted RP leaf.
  rp_child_analysis: capabilities(),
});

/**
 * Maps a Ticket to the logical capability controls that must all remain un-killed.
 * Shared execution is explicit: killing director/prelude/variableProposal stops their
 * one shared interactive Ticket rather than pretending those calls are separable.
 */
export function agentCapabilitiesForAdmission(
  request: Pick<AdmissionRequest, 'taskKind' | 'policyVersion'>,
): readonly AgentSubcapabilityId[] {
  if (request.taskKind === 'preference_extract' && request.policyVersion.includes('branch-semantic')) {
    return capabilities('learning.branchPreference');
  }
  return TASK_CAPABILITIES[request.taskKind];
}

export function agentCapabilityTicketAllowed(
  store: AgentControlStore,
  request: Pick<AdmissionRequest, 'taskKind' | 'policyVersion'>,
): boolean {
  if (request.taskKind === 'rp_child_analysis') return false;
  return agentCapabilitiesForAdmission(request).every(
    (capabilityId) => store.capabilityControl(capabilityId).killedReason === null,
  );
}

/** 控制面能力注册表（供形态守卫对账，避免它自己再跨包引一次）。 */
export { AGENT_TASK_KINDS, AGENT_SUBCAPABILITY_IDS };

export interface AgentCapabilityShapeReport {
  readonly capabilities: readonly AgentSubcapabilityId[];
  readonly closureCapabilities: readonly AgentClosureCapability[];
  /** 闭环合同里有、控制面注册表里没有：操作者**看不见也 kill 不掉**。 */
  readonly contractOnlyCapabilities: readonly AgentClosureCapability[];
  /** 控制面有、闭环合同里没有：会被账本静默丢弃。目前为空。 */
  readonly controlOnlyCapabilities: readonly string[];
  /**
   * 一个 admitted taskKind 承载了**不同 `kind`** 的能力。
   *
   * 一个 closure run 只带一个 `kind`（`begin()` 时定死、不可变），所以这类 taskKind 接线时
   * 必须**拆成两条 run**（advisory 一条、proposal 一条）。退化成一条就会让其中一方在架构上
   * 永远不可达 —— 与 C1 修掉的维护 P0 同形（证据看起来都在，但那一方永远不可能成立）。
   */
  readonly mixedKindTaskKinds: readonly AgentTaskKind[];
  /** 有合同、有名字，却没有任何 taskKind 映射 ⇒ 没有任何生产者。 */
  readonly unreachableCapabilities: readonly AgentClosureCapability[];
  /** 一个 taskKind 的能力跨了多个 lane：预算与灰度会对错的对象计数。 */
  readonly crossLaneTaskKinds: readonly AgentTaskKind[];
}

/**
 * P16 · 能力形态守卫的**唯一数据源**。
 *
 * 把两类结构性缺陷变成可断言的数据，而不是留在注释里。放在这里是因为本模块已经同时拥有
 * `AGENT_TASK_KINDS`、`AGENT_SUBCAPABILITY_IDS` 与闭环合同三条边，无需再新增跨包依赖。
 */
export function agentCapabilityShapeReport(): AgentCapabilityShapeReport {
  // `preference_extract` 按 policyVersion 分流到 preference / branchPreference，两条都要看。
  const policyVariants = ['preference-v1', 'branch-semantic'] as const;
  const reachable = new Set<AgentClosureCapability>();
  const mixedKindTaskKinds: AgentTaskKind[] = [];
  const crossLaneTaskKinds: AgentTaskKind[] = [];
  for (const taskKind of AGENT_TASK_KINDS) {
    const kinds = new Set<AgentClosureKind>();
    const lanes = new Set<string>();
    for (const policyVersion of policyVariants) {
      for (const id of agentCapabilitiesForAdmission({ taskKind, policyVersion })) {
        const capability = id as AgentClosureCapability;
        reachable.add(capability);
        kinds.add(AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability].kind);
        lanes.add(AGENT_CLOSURE_CAPABILITY_CONTRACTS[capability].lane);
      }
    }
    if (kinds.size > 1) mixedKindTaskKinds.push(taskKind);
    if (lanes.size > 1) crossLaneTaskKinds.push(taskKind);
  }
  const controlPlane = new Set<string>(AGENT_SUBCAPABILITY_IDS);
  const closure = new Set<string>(AGENT_CLOSURE_CAPABILITIES);
  // 历史别名不是独立能力：它们已折算进唯一归属，因此不需要控制面的独立行，
  // 也不用在报表里单独占行。把它们算进来只会制造假缺口。
  const canonicalClosure = AGENT_CLOSURE_CAPABILITIES
    .filter((capability) => !(capability in AGENT_CLOSURE_CAPABILITY_ALIASES));
  return Object.freeze({
    capabilities: AGENT_SUBCAPABILITY_IDS,
    closureCapabilities: AGENT_CLOSURE_CAPABILITIES,
    contractOnlyCapabilities: Object.freeze(
      canonicalClosure.filter((capability) => !controlPlane.has(capability)),
    ),
    controlOnlyCapabilities: Object.freeze(
      [...AGENT_SUBCAPABILITY_IDS].filter((capability) => !closure.has(capability)),
    ),
    mixedKindTaskKinds: Object.freeze(mixedKindTaskKinds.sort()),
    unreachableCapabilities: Object.freeze(
      canonicalClosure.filter((capability) => !reachable.has(capability)),
    ),
    crossLaneTaskKinds: Object.freeze(crossLaneTaskKinds.sort()),
  });
}
