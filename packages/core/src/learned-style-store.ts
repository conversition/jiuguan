import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  STYLE_COMPILER_POLICY_VERSION,
  normalizeLearnedStyleDraft,
  type LearnedStyleDraft,
} from '../../agent-policy/src/style-compiler.ts';
import {
  assertStyleProposalEvaluation,
  type StyleProposalEvaluation,
} from '../../agent-policy/src/style-evaluator.ts';
import { addSkill, findSkill, listSkills, setSkillEnabled } from './skills.ts';

export type { StyleProposalEvaluation } from '../../agent-policy/src/style-evaluator.ts';

export interface StyleProposalVersion {
  readonly version: number;
  readonly sourceDigest: string;
  readonly profileVersion: string;
  readonly model: string;
  readonly policyVersion: string;
  readonly evaluation: StyleProposalEvaluation;
  readonly draft: LearnedStyleDraft;
  readonly createdAt: string;
}

/** Content-free owner boundary for a learned Style proposal. */
export interface LearnedStyleProposalScope {
  readonly sessionId: string;
  readonly cardId: string;
  readonly contentMode: 'nsf' | 'nsfw';
  readonly baseStyleSkillId: string;
}

export interface StyleProposal {
  readonly id: string;
  /** Missing only on pre-scope legacy records. Legacy records never bind to a session. */
  readonly scope?: LearnedStyleProposalScope;
  readonly status: 'disabled' | 'enabled';
  readonly activeVersion: number | null;
  /** Opaque CAS token; contains no prompt, prose or Skill body. */
  readonly revision: string;
  readonly versions: readonly StyleProposalVersion[];
}

export interface ResolvedLearnedStyle {
  readonly proposalId: string;
  /** Exact activation generation; changes even when the same version is re-enabled. */
  readonly proposalRevision: string;
  readonly version: number;
  readonly name: string;
  readonly body: string;
  readonly bodyDigest: string;
}

export const LEARNED_STYLE_READBACK_VERSION = 'learned-style-readback-v1' as const;

/**
 * P16 C2.3 · Style 写后回读回执。
 *
 * 权威真值是 **proposal 记录**（见 `resolveActive`：派生 SKILL.md 是用户可管理的副本，
 * 从不用于绑定）。因此回读**重新从磁盘读取 `proposal.json`**，并额外核对派生 Skill 是否
 * 仍与提案绑定（`source` / `styleId` / `sourceHash` 三者同时一致）。副本不一致只降级为
 * `skillBound: false`，**不**改写真值、不修 Skill。
 *
 * 回执**内容无关**：只有标识、版本边界、绑定状态与摘要；Skill 正文与名称一律不出结构。
 */
export interface LearnedStyleReadbackReceipt {
  readonly version: typeof LEARNED_STYLE_READBACK_VERSION;
  readonly proposalId: string;
  readonly activeVersion: number;
  readonly status: 'enabled' | 'disabled';
  readonly proposalRevision: string;
  readonly skillBound: boolean;
  readonly sourceHash: string | null;
  readonly readbackDigest: string;
}

function readbackDigest(value: Omit<LearnedStyleReadbackReceipt, 'readbackDigest'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([
    value.version, value.proposalId, value.activeVersion, value.status,
    value.proposalRevision, value.skillBound, value.sourceHash,
  ]), 'utf8').digest('hex')}`;
}

export interface LearnedStyleSessionDeleteResult {
  readonly sessionId: string;
  readonly deletedProposalIds: readonly string[];
  readonly deletedDerivedSkillNames: readonly string[];
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;

function normalizeScope(value: unknown): LearnedStyleProposalScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('style proposal scope invalid');
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'baseStyleSkillId,cardId,contentMode,sessionId'
    || typeof row.sessionId !== 'string' || !TOKEN.test(row.sessionId)
    || typeof row.cardId !== 'string' || !TOKEN.test(row.cardId)
    || (row.contentMode !== 'nsf' && row.contentMode !== 'nsfw')
    || typeof row.baseStyleSkillId !== 'string' || !TOKEN.test(row.baseStyleSkillId)) {
    throw new TypeError('style proposal scope invalid');
  }
  return Object.freeze({
    sessionId: row.sessionId,
    cardId: row.cardId,
    contentMode: row.contentMode,
    baseStyleSkillId: row.baseStyleSkillId,
  });
}

function sameScope(left: LearnedStyleProposalScope | undefined, right: LearnedStyleProposalScope): boolean {
  return left !== undefined
    && left.sessionId === right.sessionId
    && left.cardId === right.cardId
    && left.contentMode === right.contentMode
    && left.baseStyleSkillId === right.baseStyleSkillId;
}

function normalizeDraft(value: unknown): LearnedStyleDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['name', 'description', 'keywords', 'body', 'bodyDigest'].includes(key))) {
    return null;
  }
  const normalized = normalizeLearnedStyleDraft({
    name: row.name, description: row.description, keywords: row.keywords, body: row.body,
  });
  if (!normalized) return null;
  return row.bodyDigest === undefined || row.bodyDigest === normalized.bodyDigest ? normalized : null;
}

function proposalId(sourceDigest: string, profileVersion: string): string {
  return `style-${createHash('sha256').update(`${sourceDigest}\0${profileVersion}\0${randomUUID()}`).digest('hex').slice(0, 20)}`;
}

export class LearnedStyleProposalStore {
  constructor(
    private readonly proposalDir = join('data', 'style-proposals'),
    private readonly skillsDir = join('data', 'skills'),
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): readonly StyleProposal[] {
    if (!existsSync(this.proposalDir)) return Object.freeze([]);
    return Object.freeze(readdirSync(this.proposalDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^style-[a-f0-9]{20}$/u.test(entry.name))
      .map((entry) => this.read(entry.name))
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  /** Legacy unscoped proposals deliberately fail closed at this boundary. */
  listForScope(scopeValue: LearnedStyleProposalScope): readonly StyleProposal[] {
    const scope = normalizeScope(scopeValue);
    return Object.freeze(this.list().filter((proposal) => sameScope(proposal.scope, scope)));
  }

  read(id: string): StyleProposal {
    if (!/^style-[a-f0-9]{20}$/u.test(id)) throw new TypeError('style proposal id invalid');
    const value = JSON.parse(readFileSync(join(this.proposalDir, id, 'proposal.json'), 'utf8')) as StyleProposal;
    if (value.id !== id || !Array.isArray(value.versions) || value.versions.length < 1) {
      throw new Error('style proposal record invalid');
    }
    const legacyRevision = value.versions.at(-1)!.createdAt;
    const revision = this.revision(value.revision ?? legacyRevision);
    const scope = value.scope === undefined ? undefined : normalizeScope(value.scope);
    return Object.freeze({ ...value, ...(scope ? { scope } : {}), revision });
  }

  create(input: {
    draft: unknown;
    sourceDigest: string;
    profileVersion: string;
    model: string;
    policyVersion?: string;
    evaluation: StyleProposalEvaluation;
    scope: LearnedStyleProposalScope;
    createdAt?: string;
  }): StyleProposal {
    const draft = normalizeDraft(input.draft);
    if (!draft) throw new TypeError('complete learned style draft required');
    if (!DIGEST.test(input.sourceDigest) || !TOKEN.test(input.profileVersion)
      || !TOKEN.test(input.model) || !TOKEN.test(input.policyVersion ?? STYLE_COMPILER_POLICY_VERSION)) {
      throw new TypeError('style proposal provenance invalid');
    }
    const scope = normalizeScope(input.scope);
    const existing = this.list().find((proposal) => sameScope(proposal.scope, scope)
      && proposal.versions.some((version) => (
      version.sourceDigest === input.sourceDigest
      && version.profileVersion === input.profileVersion
      && version.model === input.model
      && version.policyVersion === (input.policyVersion ?? STYLE_COMPILER_POLICY_VERSION)
    )));
    if (existing) return existing;
    const id = proposalId(input.sourceDigest, input.profileVersion);
    const createdAt = input.createdAt ?? this.now().toISOString();
    const record: StyleProposal = {
      id,
      scope,
      status: 'disabled',
      activeVersion: null,
      revision: this.revision(createdAt),
      versions: [{
        version: 1,
        sourceDigest: input.sourceDigest,
        profileVersion: input.profileVersion,
        model: input.model,
        policyVersion: input.policyVersion ?? STYLE_COMPILER_POLICY_VERSION,
        evaluation: assertStyleProposalEvaluation(input.evaluation, draft.bodyDigest),
        draft,
        createdAt,
      }],
    };
    this.write(record);
    return record;
  }

  revise(id: string, input: {
    draft: unknown;
    sourceDigest: string;
    profileVersion: string;
    model: string;
    policyVersion?: string;
    evaluation: StyleProposalEvaluation;
    createdAt?: string;
  }): StyleProposal {
    const current = this.read(id);
    const draft = normalizeDraft(input.draft);
    if (!draft) throw new TypeError('complete learned style draft required');
    if (!DIGEST.test(input.sourceDigest) || !TOKEN.test(input.profileVersion)
      || !TOKEN.test(input.model) || !TOKEN.test(input.policyVersion ?? STYLE_COMPILER_POLICY_VERSION)) {
      throw new TypeError('style proposal provenance invalid');
    }
    const nextVersion = current.versions.at(-1)!.version + 1;
    const next: StyleProposal = {
      ...current,
      status: 'disabled',
      activeVersion: current.activeVersion,
      revision: this.nextRevision(current.revision),
      versions: [...current.versions, {
        version: nextVersion,
        sourceDigest: input.sourceDigest,
        profileVersion: input.profileVersion,
        model: input.model,
        policyVersion: input.policyVersion ?? STYLE_COMPILER_POLICY_VERSION,
        evaluation: assertStyleProposalEvaluation(input.evaluation, draft.bodyDigest),
        draft,
        createdAt: input.createdAt ?? this.now().toISOString(),
      }],
    };
    this.write(next);
    return next;
  }

  activate(id: string, version?: number): StyleProposal {
    const current = this.read(id);
    return this.activateCurrent(current, version);
  }

  activateCas(id: string, version: number | undefined, expectedRevision: string): StyleProposal {
    const current = this.read(id);
    this.assertExpectedRevision(current, expectedRevision);
    return this.activateCurrent(current, version);
  }

  approveCas(id: string, version: number, expectedRevision: string): StyleProposal {
    const current = this.read(id);
    this.assertExpectedRevision(current, expectedRevision);
    if (current.status !== 'disabled') throw new Error('style-proposal-already-enabled');
    return this.activateCurrent(current, version);
  }

  private activateCurrent(current: StyleProposal, version?: number): StyleProposal {
    const id = current.id;
    const selected = current.versions.find((entry) => entry.version === (version ?? current.versions.at(-1)!.version));
    if (!selected) throw new Error('style proposal version not found');
    let evaluation: StyleProposalEvaluation;
    try {
      evaluation = assertStyleProposalEvaluation(selected.evaluation, selected.draft.bodyDigest);
    } catch {
      throw new Error('style proposal has not passed the current evaluator');
    }
    if (!evaluation.passed) throw new Error('style proposal evaluation did not pass');
    const existing = findSkill(selected.draft.name, this.skillsDir);
    if (existing && existing.source !== `learned-style:${id}`) {
      throw new Error('refusing to overwrite a hand-authored or imported Skill');
    }
    // One active proposal per exact owner scope. Siblings are disabled first so
    // a crash can at worst fail closed; it cannot expose a foreign/older Style.
    if (current.scope) {
      for (const sibling of this.listForScope(current.scope)) {
        if (sibling.id === current.id || sibling.status !== 'enabled') continue;
        this.disableDerivedSkill(sibling);
        this.write({
          ...sibling,
          status: 'disabled',
          activeVersion: null,
          revision: this.nextRevision(sibling.revision),
        });
      }
    }
    addSkill({
      name: selected.draft.name,
      description: selected.draft.description,
      content: selected.draft.body,
      keywords: [...selected.draft.keywords],
      version: String(selected.version),
      enabled: true,
      role: 'style',
      source: `learned-style:${id}`,
      sourceHash: selected.draft.bodyDigest,
      styleId: id,
    }, this.skillsDir);
    const next: StyleProposal = {
      ...current,
      status: 'enabled',
      activeVersion: selected.version,
      revision: this.nextRevision(current.revision),
    };
    this.write(next);
    return next;
  }

  rollback(id: string, version: number): StyleProposal {
    return this.activate(id, version);
  }

  rollbackCas(id: string, version: number, expectedRevision: string): StyleProposal {
    const current = this.read(id);
    this.assertExpectedRevision(current, expectedRevision);
    if (current.status !== 'enabled' || current.activeVersion === null) {
      throw new Error('style-proposal-not-enabled');
    }
    if (version >= current.activeVersion) throw new Error('style-proposal-rollback-version-invalid');
    return this.activateCurrent(current, version);
  }

  disableCas(id: string, expectedRevision: string): StyleProposal {
    const current = this.read(id);
    this.assertExpectedRevision(current, expectedRevision);
    if (current.status === 'disabled') throw new Error('style-proposal-already-disabled');
    this.disableDerivedSkill(current);
    const next: StyleProposal = {
      ...current,
      status: 'disabled',
      activeVersion: null,
      revision: this.nextRevision(current.revision),
    };
    this.write(next);
    return next;
  }

  /**
   * Resolve the proposal record itself as the sole runtime truth. The generated
   * SKILL.md is a user-manageable derivative and is never trusted for binding.
   */
  resolveActive(scopeValue: LearnedStyleProposalScope): ResolvedLearnedStyle | null {
    const scope = normalizeScope(scopeValue);
    const proposals = this.listForScope(scope);
    if (proposals.some((proposal) => proposal.status !== 'enabled' && proposal.status !== 'disabled')) {
      throw new Error('style-proposal-active-status-invalid');
    }
    const candidates = proposals
      .filter((candidate) => candidate.status === 'enabled')
      .sort((left, right) => right.revision.localeCompare(left.revision) || right.id.localeCompare(left.id));
    const active = candidates[0];
    if (!active) return null;
    // Select exactly once. A broken active version must not silently revive an older sibling.
    if (typeof active.activeVersion !== 'number' || !Number.isSafeInteger(active.activeVersion)
      || active.activeVersion < 1) {
      throw new Error('style-proposal-active-version-invalid');
    }
    const selectedVersions = active.versions.filter((version) => version?.version === active.activeVersion);
    if (selectedVersions.length !== 1) throw new Error('style-proposal-active-version-invalid');
    const selected = selectedVersions[0]!;
    const normalized = normalizeDraft(selected.draft);
    if (!normalized || normalized.bodyDigest !== selected.draft.bodyDigest) {
      throw new Error('style-proposal-active-draft-invalid');
    }
    let evaluation: StyleProposalEvaluation;
    try { evaluation = assertStyleProposalEvaluation(selected.evaluation, normalized.bodyDigest); }
    catch { throw new Error('style-proposal-active-evaluation-invalid'); }
    if (!evaluation.passed) throw new Error('style-proposal-active-evaluation-invalid');
    return Object.freeze({
      proposalId: active.id,
      proposalRevision: active.revision,
      version: selected.version,
      name: normalized.name,
      body: normalized.body,
      bodyDigest: normalized.bodyDigest,
    });
  }

  /**
   * 提交**之后**重新读回权威提案记录，并核对派生 Skill 的绑定。
   *
   * 只读：不写盘、不改 revision、不修 Skill，也不触发任何 Provider 调用。
   * 尚未激活（`activeVersion === null`）时抛 `learned-style-readback-not-active`；
   * 调用方据此判定"本次转换不产生读回证据"，绝不合成一个。
   */
  readback(id: string): LearnedStyleReadbackReceipt {
    const current = this.read(id); // 重新从磁盘读 proposal.json，不复用调用方手里的对象
    if (current.activeVersion === null) throw new Error('learned-style-readback-not-active');
    const selected = current.versions.find((entry) => entry.version === current.activeVersion);
    if (!selected) throw new Error('learned-style-readback-version-missing');
    // 副本只是"绑定核对"，不是真值来源：找不到或不匹配都只降级 skillBound。
    let installed: ReturnType<typeof findSkill> = null;
    try { installed = findSkill(selected.draft.name, this.skillsDir); } catch { installed = null; }
    const bound = installed !== null
      && installed.source === `learned-style:${current.id}`
      && installed.styleId === current.id
      && installed.sourceHash === selected.draft.bodyDigest;
    const base = Object.freeze({
      version: LEARNED_STYLE_READBACK_VERSION,
      proposalId: current.id,
      activeVersion: current.activeVersion,
      status: current.status,
      proposalRevision: current.revision,
      skillBound: bound,
      sourceHash: installed?.sourceHash ?? null,
    });
    return Object.freeze({ ...base, readbackDigest: readbackDigest(base) });
  }

  /**
   * Privacy cleanup for one opaque story session.
   *
   * Derived Skills are removed before their proposal provenance. A crash between
   * those steps therefore leaves enough proposal state for an idempotent retry.
   * User-authored/imported Skills are never selected: both source and styleId
   * must bind the artifact to the exact proposal being deleted.
   */
  deleteSessionScope(sessionIdValue: string): LearnedStyleSessionDeleteResult {
    if (!TOKEN.test(sessionIdValue)) throw new TypeError('style proposal session id invalid');
    const proposals = this.list().filter((proposal) => proposal.scope?.sessionId === sessionIdValue);
    const deletedProposalIds: string[] = [];
    const deletedDerivedSkillNames: string[] = [];
    for (const proposal of proposals) {
      const source = `learned-style:${proposal.id}`;
      for (const skill of listSkills(this.skillsDir)) {
        if (skill.source !== source || skill.styleId !== proposal.id) continue;
        rmSync(dirname(skill.path), { recursive: true, force: true });
        deletedDerivedSkillNames.push(skill.name);
      }
      rmSync(join(this.proposalDir, proposal.id), { recursive: true, force: true });
      deletedProposalIds.push(proposal.id);
    }
    return Object.freeze({
      sessionId: sessionIdValue,
      deletedProposalIds: Object.freeze(deletedProposalIds.sort()),
      deletedDerivedSkillNames: Object.freeze(deletedDerivedSkillNames.sort((left, right) => (
        left.localeCompare(right, 'zh')
      ))),
    });
  }

  diff(id: string, leftVersion: number, rightVersion: number): {
    readonly removed: readonly string[]; readonly added: readonly string[];
  } {
    const current = this.read(id);
    const left = current.versions.find((entry) => entry.version === leftVersion);
    const right = current.versions.find((entry) => entry.version === rightVersion);
    if (!left || !right) throw new Error('style proposal version not found');
    const leftLines = new Set(left.draft.body.split('\n'));
    const rightLines = new Set(right.draft.body.split('\n'));
    return Object.freeze({
      removed: Object.freeze([...leftLines].filter((line) => !rightLines.has(line))),
      added: Object.freeze([...rightLines].filter((line) => !leftLines.has(line))),
    });
  }

  private write(record: StyleProposal): void {
    const dir = join(this.proposalDir, record.id);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'proposal.json');
    const temp = join(dir, `proposal.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    renameSync(temp, target);
  }

  private disableDerivedSkill(proposal: StyleProposal): void {
    const active = proposal.versions.find((entry) => entry.version === proposal.activeVersion);
    if (!active) throw new Error('style-proposal-active-version-invalid');
    const installed = findSkill(active.draft.name, this.skillsDir);
    if (!installed) return;
    if (installed.source !== `learned-style:${proposal.id}` || installed.styleId !== proposal.id) {
      throw new Error('style-proposal-skill-source-mismatch');
    }
    setSkillEnabled(installed.name, false, this.skillsDir);
  }

  private revision(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) throw new Error('style proposal revision invalid');
    return value;
  }

  private nextRevision(current: string): string {
    const expected = this.revision(current);
    return new Date(Math.max(this.now().getTime(), Date.parse(expected) + 1)).toISOString();
  }

  private assertExpectedRevision(current: StyleProposal, expectedRevision: string): void {
    if (current.revision !== this.revision(expectedRevision)) {
      throw new Error('style-proposal-revision-conflict');
    }
  }
}
