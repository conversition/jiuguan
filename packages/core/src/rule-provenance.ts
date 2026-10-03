/**
 * FE-06.0 有效规则来源（rule provenance）——**纯逻辑**，可 node 直测
 *
 * 问题：规则库只有一个 `enabled` 布尔值。旧缓存与原卡冲突（作者标禁用、库里却是启用）时，
 * 无从判断"这是用户有意开的，还是陈旧数据"，于是只能靠猜或靠名字特判。
 *
 * 本模块让每条**实际执行**的规则都能回答：
 *   来自哪张卡 / 哪个全局源？原始版本与内容是什么？作者默认启用状态？是否存在用户显式覆盖？
 *   当前为什么选择它（生效 / 待确认 / 已按覆盖生效 / 作者禁用 / 无来源）？
 *
 * 四条纪律：
 *  1. **零名字特判**：不因规则名含"测试""非作者别开"等字样做判断；只看
 *     `id`（内容派生身份）、`source`、`authorEnabled`、`override`（显式记录）。
 *  2. **冲突不自动运行**：库中 `enabled` 与作者默认不一致、又**没有显式覆盖记录** →
 *     `pending-confirmation`（标记待确认，不进入有效集）。
 *  3. **有覆盖按授权生效**：显式覆盖记录存在 → 生效并**显示覆盖来源**。
 *  4. **互斥不给默认裁决**：同一协议区段有多条候选且无裁决依据 → 报告歧义，**不无条件取第一条**；
 *     多条**不互斥**的规则按既有顺序合法串联，不因"数量 > 1"就全部拦截。
 *
 * 不新建规则库：本模块只读现有规则（`RegexLibrary.list()`）与卡片导入结果（作者真值来源）。
 */
import type { RegexRule } from './regex.ts';

/** 规则来源状态 */
export type RuleProvenanceStatus =
  /** 库中启用状态与作者默认一致（或内置规则）→ 可直接生效 */
  | 'effective'
  /** 用户显式覆盖（有覆盖记录）→ 按授权生效，展示覆盖来源 */
  | 'user-override'
  /** 库中与作者默认冲突、且无覆盖记录 → **待确认**，不自动运行 */
  | 'pending-confirmation'
  /** 作者默认禁用且库中也禁用 → 明确不生效（不是缺项） */
  | 'author-disabled'
  /** 带来源标记，但当前版本卡已无此规则（旧缓存）→ 明确不进入执行序 */
  | 'source-missing'
  /** 带来源标记，但属于**其它卡**（会话限定下）→ 本会话不生效 */
  | 'other-card'
  /**
   * 无来源标记的**历史数据**（FE-06.0 之前导入）。
   * 无法归属 → **不作冲突判定、不阻断**（避免把旧数据一律停掉），但必须**报告**为诊断缺口。
   */
  | 'legacy-unattributed';

export interface RuleProvenanceEntry {
  ruleId: string;
  name: string;
  status: RuleProvenanceStatus;
  /** 规则库中的来源标记 */
  declaredSource: RegexRule['source'];
  /** 归属来源：内置 / 某张卡 / 用户自建 / 未知 */
  origin: { kind: 'builtin' | 'card' | 'user' | 'unknown'; card?: string; version?: string };
  /** 作者默认启用状态（来自当前卡版本的重算；无法判定时为 undefined） */
  authorEnabled?: boolean;
  /** 规则库中当前的启用状态 */
  currentEnabled: boolean;
  /** 用户显式覆盖记录（存在才算"已授权"） */
  override?: RegexRule['override'];
  /** 为什么是当前状态（可解释；报告/诊断直接展示） */
  reason: string;
  /** 协议区段（用于互斥判定；不是业务分类） */
  section: string;
}

/**
 * 协议区段键 —— **只按协议形状判定**，不按规则名。
 *  - `frontend:gal-external`：命中 `<gal_inface>` 且替换里带外链引擎页（互斥：一个场景只能用一个前端页）
 *  - `frontend:doc-inject` ：整文档前端注入（互斥：同一正文只应被一个注入规则替换）
 *  - `hidden:strip`        ：隐藏/剥离类（可叠加，不互斥）
 *  - `text:transform`      ：文本变换类（可叠加，不互斥）
 */
export function ruleSection(rule: Pick<RegexRule, 'findRegex' | 'replaceString' | 'inject' | 'galExternalUrl' | 'scope'>): string {
  if (rule.galExternalUrl) return 'frontend:gal-external';
  if (rule.inject) return 'frontend:doc-inject';
  if (rule.replaceString === '') return 'hidden:strip';
  return 'text:transform';
}

/** 互斥区段（同一区段只允许一条生效；>1 且无裁决依据 → 报告歧义） */
export const EXCLUSIVE_SECTIONS = new Set(['frontend:gal-external', 'frontend:doc-inject']);

export interface ProvenanceInput {
  /** 规则库合并视图（RegexLibrary.list()） */
  stored: RegexRule[];
  /** **作者真值**：按 id 索引的"当前卡版本重算结果"（来源一致性判定的依据） */
  authorTruthById: Map<string, RegexRule>;
  /** 当前会话所用卡（用于把来源限定到该卡；空 = 不作会话限定） */
  sessionCard?: string;
}

/**
 * 构造来源诊断。**默认拒绝语义**：无法判定为"与作者一致"的 card 规则一律不给 effective。
 */
export function buildRuleProvenance(input: ProvenanceInput): {
  entries: RuleProvenanceEntry[];
  /** 可直接进入执行序的规则（保持原顺序） */
  effective: RegexRule[];
  /** 需要用户确认的冲突规则 */
  pending: { rule: RegexRule; reason: string }[];
  /** 互斥区段歧义（无裁决依据，**不自动选第一条**） */
  ambiguities: { section: string; candidates: { ruleId: string; name: string; origin: string }[]; reason: string }[];
} {
  const entries: RuleProvenanceEntry[] = [];
  const effective: RegexRule[] = [];
  const pending: { rule: RegexRule; reason: string }[] = [];

  for (const rule of input.stored) {
    const truth = input.authorTruthById.get(rule.id);
    const section = ruleSection(rule);
    let status: RuleProvenanceStatus;
    let reason: string;
    let authorEnabled: boolean | undefined;
    let origin: RuleProvenanceEntry['origin'];

    if (rule.source === 'builtin') {
      status = 'effective';
      origin = { kind: 'builtin' };
      reason = '内置规则：启用状态即自身声明';
    } else if (rule.source === 'user') {
      authorEnabled = truth ? truth.enabled : undefined;
      origin = truth
        ? { kind: 'card', card: truth.sourceCard ?? rule.sourceCard, version: truth.sourceVersion ?? rule.sourceVersion }
        : { kind: 'user' };
      status = 'user-override';
      reason = truth
        ? '用户显式保存过该规则（source=user），按授权生效；已记录覆盖来源'
        : '用户自建规则（无对应卡片来源），按用户声明生效';
    } else {
      // source === 'card'：来源一致性判定
      const declaredCard = rule.sourceCard;
      origin = {
        kind: truth ? 'card' : 'unknown',
        card: truth?.sourceCard ?? declaredCard,
        version: truth?.sourceVersion ?? rule.sourceVersion,
      };
      if (declaredCard && input.sessionCard && declaredCard !== input.sessionCard) {
        // 明确属于别的卡 → 本会话不生效（按卡限定的正确结果）
        status = 'other-card';
        reason = `来源为卡片「${declaredCard}」，与当前会话卡「${input.sessionCard}」不符 → 本会话不生效`;
      } else if (!truth) {
        status = declaredCard ? 'source-missing' : 'legacy-unattributed';
        reason = declaredCard
          ? `来源卡片「${declaredCard}」当前版本已无此规则（旧缓存）→ 不进入执行序；请重新导入该卡或删除此规则`
          : '无来源标记的**历史数据**（FE-06.0 之前的导入）：无法归属 → 不作冲突判定、不阻断，'
            + '但列为诊断缺口（重新导入卡片规则可补全来源）';
      } else {
        authorEnabled = truth.enabled;
        if (rule.enabled === truth.enabled) {
          status = 'effective';
          reason = `与作者默认一致（${truth.enabled ? '启用' : '禁用'}）`;
        } else if (rule.override?.kind === 'user-explicit') {
          status = 'user-override';
          reason = `与作者默认（${truth.enabled ? '启用' : '禁用'}）不同，但有用户显式覆盖记录 → 按授权生效`;
        } else {
          status = 'pending-confirmation';
          reason = `库中为${rule.enabled ? '启用' : '禁用'}、作者默认为${truth.enabled ? '启用' : '禁用'}，`
            + '且**没有用户覆盖记录** → 冲突待确认，不自动运行（不猜、不按名字特判）';
        }
      }
    }

    // 禁用的规则即便"与作者一致"也不进入有效集：状态如实记为 author-disabled（不是缺项）
    if (rule.enabled === false && status === 'effective') {
      status = 'author-disabled';
      reason = '作者默认与库中一致为**禁用** → 明确不生效（不是缺项，也未参与冲突判定）';
    }
    entries.push({
      ruleId: rule.id, name: rule.name, status, declaredSource: rule.source, origin,
      authorEnabled, currentEnabled: rule.enabled, override: rule.override, reason, section,
    });
    // 可进入执行序：**必须是启用状态**，且为"与作者一致 / 已授权覆盖 / 历史未标记（不阻断但已报告）"
    const runnable = rule.enabled === true;
    if (runnable && (status === 'effective' || status === 'user-override' || status === 'legacy-unattributed')) {
      effective.push(rule);
    }
    if (status === 'pending-confirmation') pending.push({ rule, reason });
  }

  // 互斥区段歧义：只在**同一会话可见**且**可归属**（与作者一致 / 有用户授权）的有效规则之间判定。
  // 历史未标记数据（legacy-unattributed）不参与互斥选择 —— 无法归属就没有裁决依据，
  // 拿它参与"取第一条"等于把不可解释的数据当成决议。
  const scoped = effective.filter((r) => {
    if (input.sessionCard && r.source === 'card' && r.sourceCard && r.sourceCard !== input.sessionCard) return false;
    const st = entries.find((e) => e.ruleId === r.id)?.status;
    return st === 'effective' || st === 'user-override';
  });
  const ambiguities: { section: string; candidates: { ruleId: string; name: string; origin: string }[]; reason: string }[] = [];
  for (const section of EXCLUSIVE_SECTIONS) {
    const group = scoped.filter((r) => ruleSection(r) === section);
    if (group.length <= 1) continue;
    // 裁决依据：同一组里存在"用户显式覆盖"的规则 → 视为用户已选（不报歧义）
    const decided = group.filter((r) => entries.find((e) => e.ruleId === r.id)?.status === 'user-override');
    if (decided.length === 1) continue;
    ambiguities.push({
      section,
      candidates: group.map((r) => {
        const e = entries.find((x) => x.ruleId === r.id);
        return { ruleId: r.id, name: r.name, origin: e?.origin.card ?? e?.origin.kind ?? 'unknown' };
      }),
      reason: `区段 ${section} 有 ${group.length} 条**可归属**的有效候选且无裁决依据 → 报告歧义，**不无条件取第一条**；`
        + '请由用户显式指定（或按来源/版本治理）后再执行',
    });
  }

  return { entries, effective, pending, ambiguities };
}

/** 报告/诊断用：来源摘要（按状态分组计数） */
export function summarizeProvenance(entries: RuleProvenanceEntry[]): Record<RuleProvenanceStatus, number> {
  const out: Record<RuleProvenanceStatus, number> = {
    effective: 0, 'user-override': 0, 'pending-confirmation': 0, 'author-disabled': 0,
    'source-missing': 0, 'other-card': 0, 'legacy-unattributed': 0,
  };
  for (const e of entries) out[e.status] += 1;
  return out;
}
