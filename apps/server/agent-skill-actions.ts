import {
  DEFAULT_SKILLS_DIR,
  SkillDocumentRevisionConflictError,
  deleteSkillFromSnapshot,
  listSkillDocuments,
  setSkillEnabledFromSnapshot,
} from '../../packages/core/public/skills.ts';
import type { PublicAgentSkillSummary } from '@jiuguan/mobile-contracts';
import {
  agentSkillMutationPermissions,
  buildAgentSkillCatalog,
} from './agent-skill-read-model.ts';

export const AGENT_SKILL_ACTIONS = Object.freeze(['enable', 'disable', 'delete'] as const);
export type AgentSkillAction = typeof AGENT_SKILL_ACTIONS[number];

export type AgentSkillActionErrorCode =
  | 'agent-skill-action-invalid'
  | 'agent-skill-action-forbidden'
  | 'agent-skill-name-ambiguous'
  | 'agent-skill-not-found'
  | 'agent-skill-revision-stale';

export class AgentSkillActionError extends Error {
  constructor(
    readonly code: AgentSkillActionErrorCode,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSkillActionError';
  }
}

export type AgentSkillActionResult = Readonly<
  | { ok: true; action: 'delete' }
  | { ok: true; action: 'enable' | 'disable'; skill: PublicAgentSkillSummary }
>;

function parseAction(action: string): AgentSkillAction {
  if ((AGENT_SKILL_ACTIONS as readonly string[]).includes(action)) return action as AgentSkillAction;
  throw new AgentSkillActionError(
    'agent-skill-action-invalid',
    400,
    '不支持的 Agent Skill 操作',
  );
}

/**
 * Apply a Skill action under the same provenance policy exposed by GET /api/skills.
 * Permission and mutation are bound to one complete-document digest; revision drift fails closed.
 */
export function executeAgentSkillAction(input: {
  readonly name: string;
  readonly action: string;
  readonly skillsDir?: string;
}): AgentSkillActionResult {
  const action = parseAction(input.action);
  const skillsDir = input.skillsDir ?? DEFAULT_SKILLS_DIR;
  const matching = listSkillDocuments(skillsDir)
    .filter((snapshot) => snapshot.skill.name === input.name);
  if (matching.length < 1) {
    throw new AgentSkillActionError('agent-skill-not-found', 404, 'Agent Skill 不存在');
  }
  if (matching.length > 1) {
    throw new AgentSkillActionError(
      'agent-skill-name-ambiguous',
      409,
      'Agent Skill 名称不唯一，已拒绝变更',
    );
  }

  const snapshot = matching[0]!;
  const permissions = agentSkillMutationPermissions(snapshot.skill);
  const allowed = action === 'delete' ? permissions.deletable : permissions.toggleable;
  if (!allowed) {
    throw new AgentSkillActionError(
      'agent-skill-action-forbidden',
      403,
      action === 'delete'
        ? '该 Agent Skill 由系统或学习流程管理，不允许删除'
        : '该 Agent Skill 不允许启停',
    );
  }

  try {
    if (action === 'delete') {
      deleteSkillFromSnapshot(snapshot, skillsDir);
      return Object.freeze({ ok: true, action });
    }
    const updated = setSkillEnabledFromSnapshot(snapshot, action === 'enable', skillsDir);
    const skill = buildAgentSkillCatalog([updated]).skills[0];
    if (!skill) throw new TypeError('Updated Agent Skill was not projectable');
    return Object.freeze({ ok: true, action, skill });
  } catch (error) {
    if (error instanceof SkillDocumentRevisionConflictError) {
      throw new AgentSkillActionError(
        'agent-skill-revision-stale',
        409,
        'Agent Skill 已更新，请刷新后重试',
      );
    }
    throw error;
  }
}
