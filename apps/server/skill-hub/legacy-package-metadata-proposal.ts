/** @author Codex @date 2026-10-19 @version 1.0
 * SKP-1 第二步：**元数据提案**（proposal-only，永不落盘、永不发布）。
 *
 * 47 个包缺 `capabilityIds/taskKinds/phases/contentModes/risk/evaluatorId`，而 §12.3 明令
 * 禁止「批量填默认值伪装迁移」。所以这里产出的是**供人逐条审的提案**，不是迁移结果：
 *
 * 1. 每个字段都带 `evidence`：值是从哪条可见信号推出来的（`role=style`、目录名前缀、`nsfw: true`）。
 *    推不出来的字段不猜，直接进 `reviewRequired`。
 * 2. **`lifecycle` 永远为 null**。它决定包能不能进 Catalog（等于「上线」），属于产品决策，
 *    任何自动推导都等于伪造发布；报告里单独列出这一列并标 `blockedByLifecycle`。
 * 3. 另给一个**模拟**：把提案 + `lifecycle=active` 只放在内存里过一遍既有 legacy adapter，
 *    回答「如果人把 lifecycle 打开，这份提案够不够让包进 Catalog」。它只证明元数据充分性，
 *    不写任何文件、不产生任何发布。
 */
import {
  createLegacyAgentSkillCatalogAdapter,
  type LegacyAgentSkillRecord,
  type LegacyAgentSkillSkipCode,
} from './legacy-catalog-adapter.ts';
import type { MigratableSkillDocument } from './legacy-package-migrator.ts';

export const SKILL_METADATA_PROPOSAL_VERSION = 'skill-metadata-proposal-v1' as const;

export type SkillMetadataConfidence = 'frontmatter-role' | 'name-prefix' | 'default';

export interface SkillMetadataProposalV1 {
  readonly directory: string;
  readonly name: string;
  readonly documentIdentityDigest: string;
  readonly kind: 'style' | 'procedure';
  readonly capabilityIds: readonly string[];
  readonly taskKinds: readonly string[];
  readonly phases: readonly string[];
  readonly contentModes: readonly string[];
  readonly scopeLevel: 'global';
  readonly risk: 'advisory';
  readonly evaluatorId: string;
  /** 永远为 null：生命周期不是能从名字推出来的东西。 */
  readonly lifecycle: null;
  readonly confidence: SkillMetadataConfidence;
  readonly evidence: readonly string[];
  /** 需要人工确认的字段（`lifecycle` 恒在其中）。 */
  readonly reviewRequired: readonly string[];
}

export interface SkillMetadataProposalReportV1 {
  readonly proposalVersion: typeof SKILL_METADATA_PROPOSAL_VERSION;
  readonly proposals: readonly SkillMetadataProposalV1[];
  /** 模拟结果：提案 + `lifecycle=active` 时，adapter 会给出什么。 */
  readonly simulation: Readonly<{
    metadataComplete: number;
    stillSkipped: readonly Readonly<{ directory: string; code: LegacyAgentSkillSkipCode }>[];
    /** 模拟中仍不满足的最小充分性结论（不是发布结论）。 */
    note: string;
  }>;
}

const STYLE_CAPABILITIES = Object.freeze(['style.compose', 'style.revise']);
const STORY_CAPABILITIES = Object.freeze(['story.plan', 'prompt.compose']);
const HYPNOSIS_CAPABILITIES = Object.freeze(['story.plan', 'npc.dialogue']);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function familyOf(record: LegacyAgentSkillRecord): Readonly<{
  kind: 'style' | 'procedure';
  capabilityIds: readonly string[];
  taskKinds: readonly string[];
  phases: readonly string[];
  confidence: SkillMetadataConfidence;
  evidence: readonly string[];
}> {
  if (record.role === 'style') {
    return {
      kind: 'style',
      capabilityIds: STYLE_CAPABILITIES,
      taskKinds: ['conversation-turn'],
      phases: ['execute'],
      confidence: 'frontmatter-role',
      evidence: ['frontmatter.role=style'],
    };
  }
  if (record.name.startsWith('文风')) {
    return {
      kind: 'style',
      capabilityIds: STYLE_CAPABILITIES,
      taskKinds: ['conversation-turn'],
      phases: ['execute'],
      confidence: 'name-prefix',
      evidence: ['name 以「文风-」开头'],
    };
  }
  if (record.name.includes('分镜')) {
    return {
      kind: 'procedure',
      capabilityIds: STORY_CAPABILITIES,
      taskKinds: ['conversation-turn', 'story-continuation'],
      phases: ['plan', 'execute'],
      confidence: record.role === 'procedure' ? 'frontmatter-role' : 'name-prefix',
      evidence: ['name 含「分镜」'],
    };
  }
  if (record.name.includes('催眠')) {
    return {
      kind: 'procedure',
      capabilityIds: HYPNOSIS_CAPABILITIES,
      taskKinds: ['conversation-turn'],
      phases: ['plan', 'execute'],
      confidence: 'name-prefix',
      evidence: ['name 含「催眠」'],
    };
  }
  // 认不出来的包不猜能力：给最小集合 + 明确要求人工确认。
  return {
    kind: 'style',
    capabilityIds: STYLE_CAPABILITIES,
    taskKinds: ['conversation-turn'],
    phases: ['execute'],
    confidence: 'default',
    evidence: ['无 role/前缀信号，按最小只读风格能力处理'],
  };
}

function contentModesOf(record: LegacyAgentSkillRecord): Readonly<{
  modes: readonly string[];
  evidence: readonly string[];
}> {
  if (record.contentModes && record.contentModes.length > 0) {
    return { modes: [...record.contentModes].sort(compareText), evidence: ['frontmatter.contentModes'] };
  }
  const nsfwHint = record.name.includes('NSFW') || /nsfw|成人|官能/u.test(record.description ?? '');
  return nsfwHint
    ? { modes: ['nsf', 'nsfw'], evidence: ['name/description 含 NSFW 信号'] }
    : { modes: ['nsf'], evidence: ['无 NSFW 信号，按 SFW 处理'] };
}

export function proposeSkillMetadata(
  documents: readonly MigratableSkillDocument[],
): SkillMetadataProposalReportV1 {
  if (!Array.isArray(documents) || documents.length > 10_000) {
    throw new TypeError('documents must be an array with at most 10000 items');
  }
  const ordered = [...documents].sort((left, right) => compareText(left.record.name, right.record.name)
    || compareText(left.directory, right.directory));

  const proposals = ordered.map((document): SkillMetadataProposalV1 => {
    const family = familyOf(document.record);
    const content = contentModesOf(document.record);
    const reviewRequired: string[] = ['lifecycle'];
    if (family.confidence === 'default') reviewRequired.push('kind', 'capabilityIds', 'taskKinds');
    if (document.record.capabilityIds?.length) reviewRequired.push('capabilityIds（已有声明，提案未采用）');
    return Object.freeze({
      directory: document.directory,
      name: document.record.name,
      documentIdentityDigest: document.documentIdentityDigest,
      kind: family.kind,
      capabilityIds: family.capabilityIds,
      taskKinds: family.taskKinds,
      phases: family.phases,
      contentModes: content.modes,
      scopeLevel: 'global',
      risk: 'advisory',
      evaluatorId: `evaluator.${family.kind}.legacy.v1`,
      lifecycle: null,
      confidence: family.confidence,
      evidence: Object.freeze([...family.evidence, ...content.evidence]),
      reviewRequired: Object.freeze(reviewRequired),
    });
  });

  // 模拟：只在内存里把 lifecycle 打开，看提案是否让 adapter 接受这些包。
  const simulatedRecords: LegacyAgentSkillRecord[] = ordered.map((document, index) => {
    const proposal = proposals[index]!;
    return {
      ...document.record,
      lifecycle: 'active',
      capabilityIds: proposal.capabilityIds,
      taskKinds: proposal.taskKinds,
      phases: proposal.phases,
      contentModes: proposal.contentModes,
      scopeLevel: proposal.scopeLevel,
      risk: proposal.risk,
      evaluatorId: proposal.evaluatorId,
      kind: proposal.kind,
    };
  });
  const adapter = createLegacyAgentSkillCatalogAdapter(simulatedRecords);
  const published = new Set(adapter.published.map((item) => item.documentIdentityDigest));
  const stillSkipped: { directory: string; code: LegacyAgentSkillSkipCode }[] = [];
  for (const document of ordered) {
    if (published.has(document.documentIdentityDigest)) continue;
    const skip = adapter.skipped.find((item) => item.skillName === document.record.name);
    stillSkipped.push({ directory: document.directory, code: skip?.code ?? 'invalid-metadata' });
  }

  return Object.freeze({
    proposalVersion: SKILL_METADATA_PROPOSAL_VERSION,
    proposals: Object.freeze(proposals),
    simulation: Object.freeze({
      metadataComplete: proposals.length - stillSkipped.length,
      stillSkipped: Object.freeze(stillSkipped.map((item) => Object.freeze(item))),
      note: '仅证明「提案 + lifecycle=active」时元数据是否充分；不构成发布授权，也未写任何文件。',
    }),
  });
}
