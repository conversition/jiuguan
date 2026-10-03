/**
 * AM-01 / AM-02：人物身份、来源与角色投影
 *
 * ── 为什么单独成模块 ────────────────────────────────────────────────
 * 旧链路上，「关键人物事实」只有两条来源：
 *   ① 角色档案块 —— 必须在本轮线索里命中实体名才注入；
 *   ② 记忆召回块 —— RAG 命中才进 prompt。
 * 两者都不是「权威状态」，于是滑窗把早期介绍剔掉后，人物事实就查不到了。
 *
 * 本模块把「人物」变成可恢复的**合法头投影**：
 *   - 人物身份：稳定 characterId（代码分配）+ 别名候选（会话命名空间隔离）
 *   - 事实准入：字段级候选 + 证据 + 事实类别（事实/回忆/计划/假设/转述/纠正）
 *   - 投影：固定 schema 的只读 JSON，走既有 StateStore（复用幂等/乐观锁/代际/前驱）
 *   - 变更记录：character_fact_log（有来源、可回放、可回滚重建）
 *
 * **不新建第二套权威记忆库**：当前投影仍存在 state_snapshot（scope='character'），
 * 提交仍走 StateStore.commit（operationId 幂等 + expectedVersion 乐观锁 + historyEpoch
 * + predecessor），提交记录仍写 state_commit。JSON 默认作为 API 返回形状，不强制落物理文件。
 *
 * 与既有身份的边界（不得互相替代）：
 *   AM 码       → 定位记忆事件（memory_arc/event/summary）
 *   MemoryRef   → 定位某来源的物理记录（source + recordId）
 *   characterId → 定位人物
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import type { CommitResult, PredecessorRef, SnapshotSource } from './state-store.ts';
import { StateStore, StateVersionConflictError } from './state-store.ts';

export type { PredecessorRef };

// ────────────────────────── 公开类型（固定 schema） ──────────────────────────

/** 事实类别：区分已发生 / 计划 / 假设 / 回忆 / 转述 / 明确纠正（§3.2-5） */
export type FactKind = 'fact' | 'recall' | 'plan' | 'hypothesis' | 'quoted' | 'correction';
/** 事实状态：确认 / 待核对 / 未消歧 / 最后已知 / 未知（省略字段 ≠ 清空） */
export type FactStatus = 'confirmed' | 'pending' | 'unresolved' | 'last-known' | 'unknown';
/** 内容分层：相对稳定档案 / 当前单局状态 / 关系 */
export type FactScope = 'profile' | 'fact' | 'relationship';

/** 来源引用：支持该事实的**证据**，不是最后一次读取或导出它的时间 */
export interface SourceRef {
  source: 'message' | 'am' | 'lore' | 'card' | 'user';
  recordId: string;
  recordVersion?: number;
}

/** 生效位置：事实在剧情中的位置（不是模型完成时间，也不是文件修改时间） */
export interface EffectiveAt {
  round?: number;
  /** 源消息的稳定内部身份（chat_log.id） */
  messageId?: number;
  eventIndex?: number;
}

export interface CharacterFact {
  value: unknown;
  status: FactStatus;
  factKind: FactKind;
  sceneId?: string;
  effectiveAt: EffectiveAt;
  sourceRefs: SourceRef[];
}

export interface CharacterRelationship {
  relationshipId: string;
  fromCharacterId: string;
  toCharacterId: string;
  type: string;
  /** objective = 客观事实；subjective = 某人的主观认知（不冒充客观） */
  perspective: 'objective' | 'subjective';
  status: FactStatus;
  factKind: FactKind;
  sceneId?: string;
  effectiveAt: EffectiveAt;
  sourceRefs: SourceRef[];
  /** 对称关系的反向边由代码派生（避免两份可漂移的真值） */
  derived?: boolean;
}

/** 历史事实与主观认知：保留历史/视角，不直接冒充当前客观事实 */
export interface HistoricalFact {
  field: string;
  value: unknown;
  factKind: FactKind;
  status: FactStatus;
  effectiveAt: EffectiveAt;
  sourceRefs: SourceRef[];
  reason: string;
}

export interface CharacterProjection {
  schemaVersion: 1;
  scope: { sessionId: string; stateInstanceId: string; historyEpoch: number };
  /** head = 这份投影的**合法读取边界**（与 entityVersion 不是同一件事） */
  head: { snapshotId: string; headRevision: number; asOfMessageId?: string };
  characterId: string;
  /** 人物对象自身的版本 */
  entityVersion: number;
  identity: { name: string; aliases: string[] };
  profile: Record<string, CharacterFact>;
  facts: Record<string, CharacterFact>;
  relationships: CharacterRelationship[];
  history: HistoricalFact[];
  unresolved: string[];
}

/**
 * Proposal-specific rollback anchor for maintenance writes. It deliberately
 * stores no prose or fact values: the append-only fact log is the before-image,
 * while this anchor binds the exact operation and semantic projection head.
 */
export interface CharacterMaintenanceRollbackAnchor {
  readonly characterId: string;
  readonly operationId: string;
  readonly beforeEntityVersion: number;
  readonly appliedEntityVersion: number;
  readonly beforeFactLogCount: number;
  readonly beforeProjectionDigest: string;
}

export interface CharacterMaintenanceRollbackResult {
  readonly deduped: boolean;
  readonly removedFactRows: number;
  readonly characters: readonly {
    readonly characterId: string;
    readonly entityVersion: number;
    readonly projectionDigest: string;
  }[];
}

// ────────────────────────── 候选（子 Agent 只产候选） ──────────────────────────

export interface CharacterChangeCandidate {
  field: string;
  scope?: FactScope;
  value: unknown;
  factKind?: FactKind;
  status?: FactStatus;
  sceneId?: string;
  effectiveAt?: EffectiveAt;
  sourceRefs?: SourceRef[];
}

export interface CharacterRelationshipCandidate {
  relationshipId?: string;
  fromCharacterId: string;
  toCharacterId: string;
  type: string;
  perspective?: 'objective' | 'subjective';
  status?: FactStatus;
  factKind?: FactKind;
  sceneId?: string;
  effectiveAt?: EffectiveAt;
  sourceRefs?: SourceRef[];
}

export interface CharacterCandidate {
  /** 已消歧的人物 ID（子 Agent 不得自行发明 ID） */
  characterId?: string;
  /** 待消歧的称呼（无法唯一确定时留空并给出 unresolved） */
  mention?: string;
  name?: string;
  aliases?: string[];
  /** 子 Agent 声明这是新人物候选（ID 由代码分配） */
  newEntity?: boolean;
  changes?: CharacterChangeCandidate[];
  relationships?: CharacterRelationshipCandidate[];
  /** 未消歧项：不静默写入任意人物 */
  unresolved?: string[];
}

/** 提交上下文：由**运行时**绑定，模型不得自行决定（§1.4） */
export interface AdmitContext {
  operationId: string;
  instanceId: string;
  /** 写入方已知的历史代际；低于当前代际 → 拒绝 */
  historyEpoch: number;
  predecessor?: PredecessorRef;
  /** 允许的人物集合（不提供 = 不限制，仅用于批处理隔离） */
  allowedCharacterIds?: string[];
  round?: number;
  sceneId?: string;
  /** 来源类型（用户明确修正 vs 剧情推断） */
  sourceKind?: 'story' | 'user-correction' | 'migration';
  sourceRefs?: SourceRef[];
  /** 基准版本（不提供 = 读取当前头作为基准） */
  expectedVersion?: number;
}

export interface AdmitResult {
  ok: boolean;
  characterId?: string;
  created?: boolean;
  entityVersion?: number;
  applied: string[];
  /** 只进历史、未晋升当前状态的字段 */
  recordedHistory: string[];
  unresolved: string[];
  rejected: { field: string; reason: string }[];
  receipt: { operationId: string; entityVersion?: number; deduped?: boolean };
  error?: { name: string; message: string };
}

export interface MentionResolution {
  resolved: { mention: string; characterId: string; name: string; via: 'name' | 'alias' }[];
  unresolved: string[];
}

// ────────────────────────── AM-07 临时层类型 ──────────────────────────

/** 入池输入：只带**本轮的证据**，不含任何派生 ID */
export interface StageMentionInput {
  /** 卡引擎实体键或模型给的称呼。**只作累计键，绝不当人物名** */
  mentionKey: string;
  entityType?: string;
  /** 模型显式给的可读名（newEntity.name），优先级最高 */
  name?: string;
  /** 模型给的待消歧称呼（mention） */
  mention?: string;
  round?: number;
  messageId?: number;
  /** 本轮携带的字段候选 */
  fields?: { field: string; value: unknown }[];
}

export interface StageMentionResult {
  /** 归一后的累计键（`npc_entity_alpha` → `entity_alpha`）；调用方记账/打日志应使用它 */
  key: string;
  /** 本轮是否计入（同一轮重复写同一键 → false，避免一轮写 5 条就触发阈值） */
  counted: boolean;
  /** 已累计的**轮数**（= rounds_json.length） */
  hits: number;
  threshold: number;
  displayName?: string;
  /**
   * 有值 → 调用方按该 characterId 走常规 admit（人物已存在，本轮的字段还没写）。
   * 注意：本次**刚促升**时字段已被促升一并写入，调用方**不应**再写一次。
   */
  routedCharacterId?: string;
  /** 本次刚促升的结果 */
  promoted?: { characterId: string; name: string; created: boolean; applied: string[]; error?: string };
  /** 未入池/未促升的原因（诊断用，不是错误） */
  skipped?: string;
}

/** 池子里的候选行（诊断/面板用） */
export interface PoolEntry {
  mentionKey: string;
  entityType: string;
  displayName?: string;
  nameCandidates: string[];
  rounds: number[];
  /** 暂存的字段 → 最后写入轮次 */
  pending: { field: string; round?: number; messageId?: number; value: unknown }[];
  firstRound?: number;
  lastRound?: number;
  promotedCharacterId?: string;
}

/** `character_mention_pool` 的内部行形状（JSON 列保持字符串，避免无谓的解析往返） */
interface PoolRow {
  mention_key: string;
  entity_type: string;
  display_name: string | null;
  name_candidates: string;
  rounds_json: string;
  pending_json: string;
  first_round: number | null;
  last_round: number | null;
  first_message_id: number | null;
  last_message_id: number | null;
  promoted_character_id: string | null;
  promoted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 角色事实注入块（供最终 prompt 保护槽使用） */
export interface FactBlock {
  blockId: string;
  text: string;
  tokens: number;
  /** 入选原因 / 裁剪原因（§5.4 需要按块身份判断重复） */
  includedReasons: { characterId: string; head: string; reason: string }[];
  dropped: { characterId: string; reason: string }[];
  headVersions: { characterId: string; entityVersion: number; headRevision: number }[];
}

// ────────────────────────── 规则常量 ──────────────────────────

/** 对称关系类型：反向边由代码派生，不分别存储两份可漂移的真值 */
export const SYMMETRIC_RELATION_TYPES = new Set(['companion', 'sibling', 'spouse', 'friend', 'ally', '同伴', '兄妹', '夫妻', '朋友']);
/** 指代/称谓类称呼：必须结合场景与证据，默认不消歧 */
const AMBIGUOUS_MENTION_RE = /^(他|她|它|祂|你|您|我|俺|咱|老师|先生|小姐|大人|阁下|哥哥|姐姐|妹妹|弟弟|老大|老板|医生|教授|会长|社长|同学|对方|那个人|这个人)$/;
/** 字段名白名单形态（防原型污染与超长字段） */
const FIELD_RE = /^[\w.\u4e00-\u9fff-]{1,64}$/;
const MAX_CHANGES = 64;
const MAX_VALUE_BYTES = 4096;

// ── AM-07 临时层规则常量 ──

/** 促升阈值：同一 mention_key 需在**至少这么多轮**出现（`JG_CHARACTER_PROMOTE_HITS` 覆盖） */
export const DEFAULT_PROMOTE_HITS = 3;
const POOL_MAX_FIELDS = 16;
const POOL_MAX_NAME_CANDIDATES = 6;
const POOL_MAX_ROUNDS = 24;
const POOL_MAX_ROWS = 200;

/**
 * 促升阈值。用**轮数**而不是条数：一轮里模型写 5 条 state_changes 只说明"这一轮提到了它"，
 * 不说明它是个持续存在的人物。
 */
export function promoteHits(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.JG_CHARACTER_PROMOTE_HITS ?? '');
  if (!Number.isFinite(raw) || raw < 2) return DEFAULT_PROMOTE_HITS;
  return Math.min(20, Math.floor(raw));
}

/**
 * 字段/子实体后缀：`<已注册人物名> + 后缀` **不是人物**，是那个人的属性或所在位置。
 * 实测污染源：`主角所在地点`、`祥子外观` 被当成人物建进注册表。
 * 注意这只用于**报告与促升前置检查**，不是靠它区分人与非人的主判据——
 * 主判据是「持续性」（见 CHARACTER_POOL_SQL 注释）。
 */
const FIELD_SUFFIXES = [
  '所在地点', '所在地', '所在位置', '当前状态', '心理状态', '外观', '外貌', '长相', '穿着',
  '服装', '装备', '属性', '技能', '能力', '身份', '设定', '档案', '状态', '位置',
];

/** 机构/地点尾词（同名实体被当成人物的实证：`示例学园`） */
const PLACE_SUFFIXES = ['学园', '学院', '学校', '大学', '会社', '公司', '商会', '教会', '公会'];

/**
 * 内部标识形态（**绝不能**当人物名）：
 *  - `char_003` 这类本模块自己分配的 ID
 *  - 卡引擎的复合实体键（`char_001|角色甲`、`char_001:角色甲`）
 *  - 纯 ASCII/下划线/连字符键（`entity_alpha`、`example-name`）
 *  - 纯数字 / UUID
 *
 * 旧链路把 `state_changes.entity_id` 直接当人物名用，于是注册表里出现了一批
 * "名字叫 char_001 的人物" —— 它们既不是人，还会与真正的 characterId 撞名。
 */
const INTERNAL_ID_RE = /^(char_\d+|\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COMPOSITE_KEY_RE = /[|:]/;
const ASCII_KEY_RE = /^[A-Za-z0-9_.\- ]+$/;

/** 名字是否像**人类可读**的人物名（用于拒绝把内部标识写成人物） */
export function isPlausibleCharacterName(raw: string): boolean {
  const name = String(raw ?? '').trim();
  if (!name) return false;
  if (INTERNAL_ID_RE.test(name)) return false;
  if (COMPOSITE_KEY_RE.test(name)) return false;
  if (ASCII_KEY_RE.test(name)) return false; // 纯 ASCII 键（拼音/变量名）不是显示名
  return true;
}

/**
 * 从卡引擎实体键里取**可读名**：`char_001|角色甲` → 角色甲，`char_001:角色甲` → 角色甲。
 * 这是零成本的名字来源 —— 复合键本身就把显示名带上了，只是以前没人去拆。
 */
function readableNameFromKey(key: string): string | undefined {
  for (const seg of String(key ?? '').split(/[|:]/).reverse()) {
    const s = seg.trim();
    if (s && isPlausibleCharacterName(s)) return s;
  }
  return undefined;
}

/**
 * 把卡引擎实体键归一成**同一个累计键**（AM-07 第二轮修复）。
 *
 * 为什么必须做：池子按 `mention_key` 唯一，计数按"同一键在几个不同轮次出现"。
 * 若模型对同一实体换键写法，计数就被拆散、永远攒不满阈值 ——
 * 匿名回归样本中，同一个「角色乙」被写成 `npc_entity_alpha`
 * 与 `char_entity_alpha` 两个键，池子里成了两行（1/3 与 0/3），谁都到不了 3。
 *
 * 规则（**只剥 `npc_` / `char_` 前缀，且右段不能是纯数字**）：
 *  - `npc_entity_alpha` / `char_entity_alpha` → `entity_alpha`（同一行）
 *  - `npc_角色甲` → `角色甲`（顺带让已注册人物能按名字命中）
 *  - `char_001` → **原样不动**。它是本模块自己分配的 characterId，回挂路径依赖它；
 *    剥成 `001` 会同时废掉匹配与"内部标识不得当人名"的判据。
 *  - 复合键（`char_001|角色甲`）不动，它有自己的右段解析。
 */
export function canonicalMentionKey(raw: string): string {
  const key = String(raw ?? '').trim();
  if (!key || COMPOSITE_KEY_RE.test(key)) return key;
  const m = /^(?:npc|char)_(.+)$/i.exec(key);
  if (!m) return key;
  const rest = m[1].trim();
  if (!rest || /^\d+$/.test(rest)) return key;
  return rest;
}

/**
 * A（AM-07 二轮）：**在场角色补计数**的判据。
 *
 * 为什么需要：计数源原本只有 `state_changes`，而模型对**非焦点角色**极少结构化上报 ——
 * 实测某常驻角色正文出现 5 轮、`state_changes` 只上报 1 次 ⇒ 池子永远停在 1/3，人建不出来。
 * 但模型**每轮还有另一个结构化字段**：`new_events[].characters`（本轮出场角色名单，
 * 落库在 `memory_event.characters`）。它逐轮声明、用**完整可读名**、零额外成本 ——
 * 只是以前没人拿它计数：实测该档 round 19/20/26/27/28 的 `characters` 都写着同一个全名，
 * 而 `state_changes` 只在 round 19 出现过它。
 *
 * 白名单是安全阀，三条缺一不可：
 *  · 行有可读名 —— `char_001` / `npc_xxx` / `char_xxx` 这类内部键永不符合
 *  · 未促升 —— 已建人的人不需要再攒轮次
 *  · **声明名与可读名/别名逐字相等**（**不做子串匹配**）—— 子串匹配会让「桐月」挂在
 *    「示例学园」上，把 R4 那类地点/字段重新推进注册表
 */
export function shouldCountByDeclaredPresence(
  entry: Pick<PoolEntry, 'displayName' | 'nameCandidates' | 'promotedCharacterId'>,
  declaredNames: string[],
): boolean {
  if (entry.promotedCharacterId) return false;
  const names = [entry.displayName, ...(entry.nameCandidates ?? [])]
    .map((n) => String(n ?? '').trim()).filter((n) => n.length >= 2);
  if (names.length === 0) return false;
  return declaredNames.some((d) => names.includes(String(d ?? '').trim()));
}

/** 拆 `new_events[].characters`：模型混用顿号/逗号/分号/斜杠分隔（如「角色甲、角色乙, 角色丙」） */
export function splitDeclaredCharacters(raw: string | undefined): string[] {
  return String(raw ?? '').split(/[、,，;；/|]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 挑可读名，优先级：显式 `newEntity.name` → 模型给的 `mention` → 复合键右段。
 * 指代/称谓（她/老师/会长）与内部标识（char_001）一律不作为名字。
 */
function pickReadableName(hints: (string | undefined)[], key: string): string | undefined {
  for (const h of hints) {
    const s = String(h ?? '').trim();
    if (!s || AMBIGUOUS_MENTION_RE.test(s)) continue;
    if (!isPlausibleCharacterName(s)) continue;
    return s;
  }
  return readableNameFromKey(key);
}

/** 只有这些事实类别可以晋升为「当前状态」 */
function mayPromoteCurrent(kind: FactKind): boolean {
  return kind === 'fact' || kind === 'correction';
}

function jsonSize(v: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(v ?? null), 'utf8'); } catch { return Number.MAX_SAFE_INTEGER; }
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { const v = JSON.parse(text); return (v ?? fallback) as T; } catch { return fallback; }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).filter((key) => row[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(row[key])).join(',') + '}';
}

function maintenanceProjectionDigest(projection: CharacterProjection): string {
  return 'sha256:' + sha256Hex(stableJson({
    characterId: projection.characterId,
    profile: projection.profile,
    facts: projection.facts,
    relationships: projection.relationships,
    history: projection.history,
    unresolved: projection.unresolved,
  }));
}

function emptyProjection(sessionKey: string, characterId: string, name: string, epoch: number): CharacterProjection {
  return {
    schemaVersion: 1,
    scope: { sessionId: sessionKey, stateInstanceId: '', historyEpoch: epoch },
    head: { snapshotId: '', headRevision: 0 },
    characterId,
    entityVersion: 0,
    identity: { name, aliases: [] },
    profile: {},
    facts: {},
    relationships: [],
    history: [],
    unresolved: [],
  };
}

interface CharacterFactProjectionRow {
  readonly field: string;
  readonly scope_kind: string;
  readonly fact_kind: string;
  readonly status: string;
  readonly value_json: string;
  readonly scene_id: string | null;
  readonly effective_round: number | null;
  readonly effective_message_id: number | null;
  readonly source_refs: string;
  readonly history_epoch: number;
  readonly entity_version: number;
}

/** Pure log replay. It never writes SQLite and is shared by rebuild and rollback before-image checks. */
function projectionFromFactRows(input: {
  readonly sessionKey: string;
  readonly characterId: string;
  readonly name: string;
  readonly epoch: number;
  readonly rows: readonly CharacterFactProjectionRow[];
}): CharacterProjection {
  const p = emptyProjection(input.sessionKey, input.characterId, input.name, input.epoch);
  for (const r of input.rows) {
    const factKind = r.fact_kind as FactKind;
    const status = r.status as FactStatus;
    const effectiveAt: EffectiveAt = {
      round: r.effective_round ?? undefined,
      messageId: r.effective_message_id ?? undefined,
    };
    const sourceRefs = parseJson<SourceRef[]>(r.source_refs, []);
    const value = parseJson<unknown>(r.value_json, null);
    const field = r.field;
    if (field.startsWith('rel:')) {
      const relationValue = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
      const seg = field.split(':');
      const from = typeof relationValue.from === 'string' ? relationValue.from : seg[1];
      const to = typeof relationValue.to === 'string' ? relationValue.to : seg[2];
      const type = typeof relationValue.type === 'string' ? relationValue.type : seg[3];
      if (!from || !to || !type) continue;
      const perspective = relationValue.perspective === 'subjective' ? 'subjective' : 'objective';
      const fallbackId = `rel_${from}_${to}_${type}`;
      const relationshipId = typeof relationValue.relationshipId === 'string'
        && relationValue.relationshipId.length > 0 && relationValue.relationshipId.length <= 240
        ? relationValue.relationshipId
        : perspective === 'objective' ? fallbackId : `${fallbackId}_subj_${from}`;
      if (!mayPromoteCurrent(factKind)) {
        p.history.push({
          field: `rel.${relationshipId}`,
          value: { type, from, to },
          factKind,
          status,
          effectiveAt,
          sourceRefs,
          reason: `关系候选类别为 ${factKind}（计划/单方情绪），不得写成已发生的客观关系`,
        });
        continue;
      }
      const entry: CharacterRelationship = {
        relationshipId,
        fromCharacterId: from,
        toCharacterId: to,
        type,
        perspective,
        status,
        factKind,
        sceneId: r.scene_id ?? undefined,
        effectiveAt,
        sourceRefs,
      };
      const existing = p.relationships.findIndex((relationship) => (
        relationship.relationshipId === relationshipId
      ));
      if (existing >= 0) p.relationships[existing] = entry;
      else p.relationships.push(entry);
      if (entry.perspective === 'objective' && SYMMETRIC_RELATION_TYPES.has(entry.type)) {
        const reverseId = `${entry.relationshipId}_rev`;
        const reverse: CharacterRelationship = {
          ...entry,
          relationshipId: reverseId,
          fromCharacterId: entry.toCharacterId,
          toCharacterId: entry.fromCharacterId,
          derived: true,
        };
        const reverseIndex = p.relationships.findIndex((relationship) => (
          relationship.relationshipId === reverseId
        ));
        if (reverseIndex >= 0) p.relationships[reverseIndex] = reverse;
        else p.relationships.push(reverse);
      }
      continue;
    }
    const dot = field.indexOf('.');
    const scope = (dot > 0 ? field.slice(0, dot) : 'fact') as FactScope;
    const bare = dot > 0 ? field.slice(dot + 1) : field;
    if (!mayPromoteCurrent(factKind)) {
      p.history.push({
        field, value, factKind, status, effectiveAt, sourceRefs,
        reason: `事实类别为 ${factKind}，不得写成既成事实`,
      });
      continue;
    }
    const target = scope === 'profile' ? p.profile : p.facts;
    const prev = target[bare];
    if (prev?.effectiveAt?.round !== undefined && effectiveAt.round !== undefined
      && effectiveAt.round < prev.effectiveAt.round) {
      p.history.push({
        field, value, factKind, status, effectiveAt, sourceRefs,
        reason: `生效轮次 ${effectiveAt.round} 早于当前值生效轮次 ${prev.effectiveAt.round}（历史事实不晋升当前状态）`,
      });
      continue;
    }
    target[bare] = {
      value,
      status,
      factKind,
      sceneId: r.scene_id ?? undefined,
      effectiveAt,
      sourceRefs,
    };
  }
  const version = input.rows.length > 0
    ? Math.max(...input.rows.map((row) => row.entity_version)) : 0;
  p.head = {
    snapshotId: version > 0 ? `commit_${String(version).padStart(3, '0')}` : '',
    headRevision: version,
  };
  p.scope = {
    sessionId: input.sessionKey,
    stateInstanceId: '',
    historyEpoch: input.epoch,
  };
  p.entityVersion = version;
  return p;
}

// ────────────────────────── CharacterStore ──────────────────────────

export class CharacterStore {
  constructor(private db: DatabaseSync, private store: StateStore) {}

  // ── 注册表 ──

  /** 会话内人物清单（含别名） */
  list(sessionKey: string): { characterId: string; name: string; kind: string; aliases: string[] }[] {
    const rows = this.db.prepare('SELECT character_id, name, kind FROM character_registry WHERE session_key = ? ORDER BY character_id')
      .all(sessionKey) as { character_id: string; name: string; kind: string }[];
    const aliasRows = this.db.prepare('SELECT character_id, alias FROM character_alias WHERE session_key = ? ORDER BY id')
      .all(sessionKey) as { character_id: string; alias: string }[];
    const byId = new Map<string, string[]>();
    for (const a of aliasRows) {
      const list = byId.get(a.character_id) ?? [];
      list.push(a.alias);
      byId.set(a.character_id, list);
    }
    return rows.map((r) => ({ characterId: r.character_id, name: r.name, kind: r.kind, aliases: byId.get(r.character_id) ?? [] }));
  }

  /** 代码分配稳定 ID（`char_001`…）：名称只是属性，不是主键或文件名 */
  private allocateId(sessionKey: string): string {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(character_id, 6) AS INTEGER)), 0) AS n
       FROM character_registry WHERE session_key = ? AND character_id LIKE 'char_%'`,
    ).get(sessionKey) as { n: number };
    return `char_${String((row?.n ?? 0) + 1).padStart(3, '0')}`;
  }

  /**
   * 注册人物（幂等）：同一 create operationId 重试取得**同一创建结果**。
   * 同名人物在同一会话内复用同一 ID；不同会话同名人物各自独立（不共享单局状态）。
   */
  ensureCharacter(
    sessionKey: string,
    input: { name: string; aliases?: string[]; kind?: 'protagonist' | 'npc'; operationId?: string; reuseByName?: boolean },
  ): { characterId: string; created: boolean; deduped: boolean } {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('人物名不能为空');
    // 内部标识（char_003 / char_001|角色甲 / entity_alpha / 纯数字）不是人物名：
    // 旧链路把卡引擎的 entity_id 直接当名字建过人物，会与真正的 characterId 撞名。
    if (!isPlausibleCharacterName(name)) {
      throw new Error(`拒绝把内部标识注册为人物：${JSON.stringify(name)}（需要人类可读的人物名）`);
    }
    const op = input.operationId ?? '';
    if (op) {
      const prev = this.db.prepare('SELECT character_id FROM character_registry WHERE create_operation_id = ?').get(op) as { character_id: string } | undefined;
      if (prev) return { characterId: prev.character_id, created: false, deduped: true };
    }
    // 同名复用**仅在唯一命中时**成立；多命中说明存在同名人物 → 必须按 characterId 定位，
    // 不把新候选挂到"最近出现"或"第一个"同名人物上。
    const sameName = this.db.prepare('SELECT character_id, kind FROM character_registry WHERE session_key = ? AND name = ? ORDER BY character_id')
      .all(sessionKey, name) as { character_id: string; kind: string }[];
    if (input.reuseByName !== false && sameName.length === 1) {
      const existing = sameName[0];
      this.addAliases(sessionKey, existing.character_id, input.aliases ?? []);
      // 主角身份由会话配置提供：已存在的 npc 被显式认定为 protagonist 时升级（不硬编码角色名）
      if (input.kind === 'protagonist' && existing.kind !== 'protagonist') {
        this.db.prepare('UPDATE character_registry SET kind = ? WHERE session_key = ? AND character_id = ?')
          .run('protagonist', sessionKey, existing.character_id);
      }
      return { characterId: existing.character_id, created: false, deduped: false };
    }
    const characterId = this.allocateId(sessionKey);
    this.db.prepare(
      'INSERT INTO character_registry (session_key, character_id, name, kind, create_operation_id, created_at) VALUES (?,?,?,?,?,?)',
    ).run(sessionKey, characterId, name, input.kind ?? 'npc', op || null, new Date().toISOString());
    this.addAliases(sessionKey, characterId, input.aliases ?? []);
    return { characterId, created: true, deduped: false };
  }

  addAliases(sessionKey: string, characterId: string, aliases: string[], explicit = true): string[] {
    const added: string[] = [];
    for (const raw of aliases ?? []) {
      const alias = String(raw ?? '').trim();
      if (!alias || alias === characterId) continue;
      // 同一别名在同会话内已归属另一人物 → 视为歧义，不覆盖（跨批次重复发现先消歧）
      const owner = this.db.prepare('SELECT DISTINCT character_id FROM character_alias WHERE session_key = ? AND alias = ?')
        .all(sessionKey, alias) as { character_id: string }[];
      if (owner.some((o) => o.character_id !== characterId)) continue;
      const r = this.db.prepare('INSERT OR IGNORE INTO character_alias (session_key, alias, character_id, explicit, created_at) VALUES (?,?,?,?,?)')
        .run(sessionKey, alias, characterId, explicit ? 1 : 0, new Date().toISOString());
      if (Number(r.changes) > 0) added.push(alias);
    }
    return added;
  }

  aliasesOf(sessionKey: string, characterId: string): string[] {
    const rows = this.db.prepare('SELECT alias FROM character_alias WHERE session_key = ? AND character_id = ? ORDER BY id')
      .all(sessionKey, characterId) as { alias: string }[];
    return rows.map((r) => r.alias);
  }

  /**
   * 待人消歧（§2.1）：名称/显式别名可唯一确定 → resolved；
   * 指代与称谓（她/老师/会长…）默认 unresolved；多候选 → unresolved。
   * **不把变化写到最近出现或相似度最高的人物上。**
   */
  resolveMentions(sessionKey: string, mentions: string[]): MentionResolution {
    const resolved: MentionResolution['resolved'] = [];
    const unresolved: string[] = [];
    for (const raw of mentions) {
      const m = String(raw ?? '').trim();
      if (!m) continue;
      if (AMBIGUOUS_MENTION_RE.test(m)) { unresolved.push(m); continue; }
      const hits = new Map<string, { name: string; via: 'name' | 'alias' }>();
      const nameRows = this.db.prepare('SELECT character_id, name FROM character_registry WHERE session_key = ? AND name = ?')
        .all(sessionKey, m) as { character_id: string; name: string }[];
      for (const r of nameRows) hits.set(r.character_id, { name: r.name, via: 'name' });
      const aliasRows = this.db.prepare(
        `SELECT a.character_id AS character_id, r.name AS name FROM character_alias a
         JOIN character_registry r ON r.session_key = a.session_key AND r.character_id = a.character_id
         WHERE a.session_key = ? AND a.alias = ?`,
      ).all(sessionKey, m) as { character_id: string; name: string }[];
      for (const r of aliasRows) if (!hits.has(r.character_id)) hits.set(r.character_id, { name: r.name, via: 'alias' });
      if (hits.size === 1) {
        const [characterId, info] = [...hits.entries()][0];
        resolved.push({ mention: m, characterId, name: info.name, via: info.via });
      } else {
        // 0 候选（未知人物）或 ≥2 候选（同名/歧义）→ 一律 unresolved
        unresolved.push(m);
      }
    }
    return { resolved, unresolved };
  }

  // ── AM-07 候选临时层（**不参与读路径**：factBlock / resolveMentions / list 都不查它） ──

  /**
   * 按**稳定身份**匹配已注册人物：`characterId` / `name` / `alias` 三者都算。
   *
   * 旧链路只比 name/alias，于是卡引擎实体键恰好等于我们分配的 characterId 时会报「未注册」——
   * 实测 `state_changes.entity_id = 'char_001'`，而注册表里 `char_001` 正是角色甲，
   * 日志却写「char_001（未注册 NPC）」，自相矛盾，该实体的字段被永久丢弃。
   */
  matchRegistered(
    sessionKey: string,
    rawId: string,
  ): { characterId: string; name: string; via: 'id' | 'name' | 'alias' }[] {
    const v = String(rawId ?? '').trim();
    if (!v) return [];
    const hits = new Map<string, { characterId: string; name: string; via: 'id' | 'name' | 'alias' }>();
    for (const c of this.list(sessionKey)) {
      if (c.characterId === v) { hits.set(c.characterId, { characterId: c.characterId, name: c.name, via: 'id' }); continue; }
      if (c.name === v) { hits.set(c.characterId, { characterId: c.characterId, name: c.name, via: 'name' }); continue; }
      if (c.aliases.includes(v)) hits.set(c.characterId, { characterId: c.characterId, name: c.name, via: 'alias' });
    }
    return [...hits.values()];
  }

  /** 读一行池子记录（内部形状；JSON 列保持字符串，避免无谓的解析往返） */
  private poolRow(sessionKey: string, key: string): PoolRow | undefined {
    return this.db.prepare(
      `SELECT mention_key, entity_type, display_name, name_candidates, rounds_json, pending_json,
              first_round, last_round, first_message_id, last_message_id,
              promoted_character_id, promoted_at, created_at, updated_at
       FROM character_mention_pool WHERE session_key = ? AND mention_key = ?`,
    ).get(sessionKey, key) as PoolRow | undefined;
  }

  private upsertPoolRow(sessionKey: string, r: PoolRow): void {
    this.db.prepare(
      `INSERT INTO character_mention_pool
         (session_key, mention_key, entity_type, display_name, name_candidates, rounds_json, pending_json,
          first_round, last_round, first_message_id, last_message_id,
          promoted_character_id, promoted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_key, mention_key) DO UPDATE SET
         entity_type = excluded.entity_type, display_name = excluded.display_name,
         name_candidates = excluded.name_candidates, rounds_json = excluded.rounds_json,
         pending_json = excluded.pending_json, first_round = excluded.first_round,
         last_round = excluded.last_round, first_message_id = excluded.first_message_id,
         last_message_id = excluded.last_message_id,
         promoted_character_id = excluded.promoted_character_id, promoted_at = excluded.promoted_at,
         updated_at = excluded.updated_at`,
    ).run(
      sessionKey, r.mention_key, r.entity_type, r.display_name, r.name_candidates, r.rounds_json, r.pending_json,
      r.first_round, r.last_round, r.first_message_id, r.last_message_id,
      r.promoted_character_id, r.promoted_at, r.created_at, r.updated_at,
    );
  }

  /** 单会池子上限：淘汰「未促升 + 最早出现」的行（已促升的行不再淘汰，它们是身份映射） */
  private trimPool(sessionKey: string): void {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM character_mention_pool WHERE session_key = ?')
      .get(sessionKey) as { n: number };
    if ((n?.n ?? 0) <= POOL_MAX_ROWS) return;
    this.db.prepare(
      `DELETE FROM character_mention_pool WHERE id IN (
         SELECT id FROM character_mention_pool
         WHERE session_key = ? AND promoted_character_id IS NULL
         ORDER BY COALESCE(last_round, 0) ASC, id ASC
         LIMIT ?)`,
    ).run(sessionKey, (n?.n ?? 0) - POOL_MAX_ROWS);
  }

  /**
   * 把暂存字段转入权威投影（成功才清空暂存 —— **失败保留，绝不丢中间信息**）。
   * operationId 带内容指纹：同内容重跑幂等，内容变了是新操作（不会撞成「操作身份冲突」）。
   */
  private flushPoolPending(
    sessionKey: string,
    key: string,
    characterId: string,
    round?: number,
    messageId?: number,
  ): { applied: string[]; error?: string; note?: string } {
    const row = this.poolRow(sessionKey, key);
    if (!row) return { applied: [], note: '池子行已不存在' };
    const pending = parseJson<Record<string, { v: unknown; r?: number; m?: number }>>(row.pending_json, {});
    const entries = Object.entries(pending);
    if (entries.length === 0) return { applied: [], note: '无可转字段' };
    const changes: CharacterChangeCandidate[] = entries.map(([field, p]) => ({
      field,
      value: p.v,
      scope: 'fact' as const,
      factKind: 'fact' as const,
      // 池子里攒的是**还没被显式确认**的当前事实 → 与旧档迁移同口径，不把推断升级为确认
      status: 'pending' as const,
      effectiveAt: { round: p.r, messageId: p.m },
    }));
    const fp = sha256Hex(JSON.stringify(changes.map((c) => [c.field, c.value ?? null, c.effectiveAt?.round ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).slice(0, 16);
    const res = this.admit(sessionKey, { characterId, changes, relationships: [] }, {
      operationId: `promote:${sessionKey}:${key}:apply:r${round ?? 0}:${fp}`,
      instanceId: `character-pool:${sessionKey}`,
      historyEpoch: this.store.historyEpoch(sessionKey),
      round,
      sourceRefs: messageId !== undefined ? [{ source: 'message', recordId: String(messageId) }] : [],
    });
    if (res.ok) {
      this.db.prepare('UPDATE character_mention_pool SET pending_json = ?, updated_at = ? WHERE session_key = ? AND mention_key = ?')
        .run('{}', new Date().toISOString(), sessionKey, key);
      return { applied: res.applied.map((f) => `${res.characterId}.${f}`) };
    }
    if (res.error?.name === 'EmptyCandidate') return { applied: [] };
    return { applied: [], error: `${res.error?.name ?? 'error'}: ${res.error?.message ?? ''}` };
  }

  /**
   * 把一个**未注册**的人物候选收进临时层（AM-07）。调用方按返回值分流，不要自己猜：
   *  · `routedCharacterId` —— 人物已存在（此前促升过 / 本轮刚促升）→ 走常规 admit
   *  · 入池累计、未到阈值 → **本轮不再报 unresolved**（它已被受理，不是"没处理"）
   *  · `skipped` —— 缺累计键 / 同名多人歧义 / 无可读名（诊断理由，不是错误）
   *
   * 促升判据 = 「出现 ≥ 阈值轮」**且**「拿到可读名」。前者排除单轮客串的地点/字段
   * （`主角所在地点`、`示例学园`），后者保证永远不会造出"名字叫 char_001 的人物"。
   */
  stageMention(sessionKey: string, input: StageMentionInput): StageMentionResult {
    const threshold = promoteHits();
    // 归一：同一实体的多种键写法（npc_x / char_x）必须落到同一行，否则各算各的轮次、永远攒不满
    const key = canonicalMentionKey(String(input.mentionKey ?? '').trim());
    const base: StageMentionResult = { key, counted: false, hits: 0, threshold };
    if (!key) return { ...base, skipped: '候选缺少累计键' };

    const existing = this.poolRow(sessionKey, key);
    // 已促升：本轮字段还没写 → 交给调用方走常规入口；同时把此前**未能转入**的暂存补一次
    if (existing?.promoted_character_id) {
      const flushed = this.flushPoolPending(sessionKey, key, existing.promoted_character_id, input.round, input.messageId);
      return {
        ...base,
        displayName: existing.display_name ?? undefined,
        routedCharacterId: existing.promoted_character_id,
        hits: parseJson<number[]>(existing.rounds_json, []).length,
        skipped: flushed.error ? `暂存补写失败：${flushed.error}` : undefined,
      };
    }

    const round = input.round;
    const rounds = parseJson<number[]>(existing?.rounds_json ?? null, []).filter((r) => typeof r === 'number');
    const counted = round !== undefined && !rounds.includes(round);
    if (counted) rounds.push(round as number);
    rounds.sort((a, b) => a - b);
    const cappedRounds = rounds.slice(-POOL_MAX_ROUNDS);

    const names = new Set<string>(parseJson<string[]>(existing?.name_candidates ?? null, []));
    const picked = pickReadableName([input.name, input.mention], key);
    if (picked) names.add(picked);
    const nameCandidates = [...names].slice(-POOL_MAX_NAME_CANDIDATES);
    const displayName = existing?.display_name ?? picked ?? nameCandidates[0];

    // 字段暂存：字段级带**各自的轮次** —— 中间事实不丢，不是只留最后一次
    const pending = parseJson<Record<string, { v: unknown; r?: number; m?: number }>>(existing?.pending_json ?? null, {});
    for (const f of input.fields ?? []) {
      const field = String(f.field ?? '').trim();
      if (!field) continue;
      pending[field] = { v: f.value ?? null, r: round, m: input.messageId };
    }
    const pendingCapped = Object.fromEntries(
      Object.entries(pending).sort((a, b) => (a[1].r ?? 0) - (b[1].r ?? 0)).slice(-POOL_MAX_FIELDS),
    );

    const now = new Date().toISOString();
    const hits = cappedRounds.length;
    const rowBase: PoolRow = {
      mention_key: key,
      entity_type: existing?.entity_type ?? input.entityType ?? 'npc',
      display_name: displayName ?? null,
      name_candidates: JSON.stringify(nameCandidates),
      rounds_json: JSON.stringify(cappedRounds),
      pending_json: JSON.stringify(pendingCapped),
      first_round: existing?.first_round ?? round ?? null,
      last_round: round ?? existing?.last_round ?? null,
      first_message_id: existing?.first_message_id ?? input.messageId ?? null,
      last_message_id: input.messageId ?? existing?.last_message_id ?? null,
      promoted_character_id: null,
      promoted_at: null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    if (hits < threshold || !displayName) {
      this.upsertPoolRow(sessionKey, rowBase);
      this.trimPool(sessionKey);
      return {
        ...base, counted, hits, displayName,
        skipped: displayName
          ? `已累计 ${hits}/${threshold} 轮`
          : `已累计 ${hits}/${threshold} 轮，但无可读名（不建人）`,
      };
    }

    // ── 促升 ──
    // 唯一命中已有同名人物 → **回挂，不建新 ID**。这同时挡住模型把主角又标成 npc 时
    // 造出第二个「角色甲」（实测 session-example-b 里 ('npc','角色甲') 与 ('protagonist','角色甲') 并存）
    const sameName = this.matchRegistered(sessionKey, displayName);
    if (sameName.length > 1) {
      this.upsertPoolRow(sessionKey, rowBase);
      return { ...base, counted, hits, displayName, skipped: `已累计 ${hits} 轮，但「${displayName}」同名 ${sameName.length} 人，需显式 characterId` };
    }
    let characterId: string;
    let created = false;
    if (sameName.length === 1) {
      characterId = sameName[0].characterId;
      this.addAliases(sessionKey, characterId, nameCandidates.filter((n) => n !== sameName[0].name));
    } else {
      // 到这一步说明没有唯一同名命中。`reuseByName:false` 是刻意的：同名不等于同一人，
      // 幂等由 create_operation_id 锁住（同一键重跑取得同一人物，不会造出第二个）。
      const c = this.ensureCharacter(sessionKey, {
        name: displayName,
        aliases: nameCandidates.filter((n) => n !== displayName),
        kind: rowBase.entity_type === 'protagonist' ? 'protagonist' : 'npc',
        operationId: `promote:${sessionKey}:${key}`,
        reuseByName: false,
      });
      characterId = c.characterId;
      created = c.created;
    }
    this.upsertPoolRow(sessionKey, { ...rowBase, promoted_character_id: characterId, promoted_at: now });
    const flushed = this.flushPoolPending(sessionKey, key, characterId, round, input.messageId);
    return {
      ...base, counted, hits, displayName, routedCharacterId: characterId,
      promoted: { characterId, name: displayName, created, applied: flushed.applied, error: flushed.error },
    };
  }

  /**
   * 门 B 补名（**不计数**）：`presentEntities()` 是按标点分词的产物，会把「你来了」这类
   * 非人名片段一起送进来，让它参与计数会污染阈值。所以这里只做一件事：某个在场称呼能匹配到
   * **已在池子里**的候选行时，把该称呼补进它的可读名候选（如 `char_001|角色甲` 因玩家
   * 输入里的「角色甲」而补上别名）。**不为不存在的键建行** —— 池子只由门 A 驱动。
   */
  annexNameHints(sessionKey: string, mentions: string[]): string[] {
    const annexed: string[] = [];
    const rows = this.db.prepare(
      'SELECT mention_key, name_candidates, display_name FROM character_mention_pool WHERE session_key = ? AND promoted_character_id IS NULL',
    ).all(sessionKey) as { mention_key: string; name_candidates: string; display_name: string | null }[];
    if (rows.length === 0) return annexed;
    for (const raw of mentions) {
      const m = String(raw ?? '').trim();
      if (!m || AMBIGUOUS_MENTION_RE.test(m) || !isPlausibleCharacterName(m)) continue;
      if (this.matchRegistered(sessionKey, m).length > 0) continue; // 已注册 → 交给 resolveMentions
      const hit = rows.find((r) => r.mention_key.includes(m)
        || r.display_name === m
        || parseJson<string[]>(r.name_candidates, []).includes(m));
      if (!hit) continue;
      const names = new Set<string>(parseJson<string[]>(hit.name_candidates, []));
      const needName = !hit.display_name;
      if (!names.has(m)) names.add(m);
      else if (!needName) continue;
      this.db.prepare(
        'UPDATE character_mention_pool SET name_candidates = ?, display_name = COALESCE(display_name, ?), updated_at = ? WHERE session_key = ? AND mention_key = ?',
      ).run(JSON.stringify([...names].slice(-POOL_MAX_NAME_CANDIDATES)), needName ? m : null,
        new Date().toISOString(), sessionKey, hit.mention_key);
      annexed.push(`${m}→${hit.mention_key}`);
    }
    return annexed;
  }

  /** 池子只读视图（诊断/面板用；不参与 prompt 装配） */
  poolList(sessionKey: string): PoolEntry[] {
    const rows = this.db.prepare(
      `SELECT mention_key, entity_type, display_name, name_candidates, rounds_json, pending_json,
              first_round, last_round, promoted_character_id
       FROM character_mention_pool WHERE session_key = ? ORDER BY COALESCE(first_round,0), id`,
    ).all(sessionKey) as (Pick<PoolRow, 'mention_key' | 'entity_type' | 'display_name' | 'name_candidates' | 'rounds_json' | 'pending_json' | 'first_round' | 'last_round' | 'promoted_character_id'>)[];
    return rows.map((r) => ({
      mentionKey: r.mention_key,
      entityType: r.entity_type,
      displayName: r.display_name ?? undefined,
      nameCandidates: parseJson<string[]>(r.name_candidates, []),
      rounds: parseJson<number[]>(r.rounds_json, []),
      pending: Object.entries(parseJson<Record<string, { v: unknown; r?: number; m?: number }>>(r.pending_json, {}))
        .map(([field, p]) => ({ field, round: p.r, messageId: p.m, value: p.v })),
      firstRound: r.first_round ?? undefined,
      lastRound: r.last_round ?? undefined,
      promotedCharacterId: r.promoted_character_id ?? undefined,
    }));
  }

  /**
   * 回滚池子的**未促升**行：丢掉 round 及之后的轮次证据并重算计数。
   * 已促升的行**不动** —— 已建人物的回滚由 `rollbackTo`（character_fact_log + rebuildProjection）
   * 负责，两侧各管一段，不重复回滚同一件事。
   */
  poolRollbackTo(sessionKey: string, round: number): { rebuilt: number; unbound: number } {
    let rebuilt = 0;
    for (const row of this.db.prepare(
      'SELECT mention_key, rounds_json, promoted_character_id FROM character_mention_pool WHERE session_key = ?',
    ).all(sessionKey) as { mention_key: string; rounds_json: string; promoted_character_id: string | null }[]) {
      if (row.promoted_character_id) continue;
      const kept = parseJson<number[]>(row.rounds_json, []).filter((r) => r < round).sort((a, b) => a - b);
      this.db.prepare('UPDATE character_mention_pool SET rounds_json = ?, last_round = ?, updated_at = ? WHERE session_key = ? AND mention_key = ?')
        .run(JSON.stringify(kept), kept.length > 0 ? kept[kept.length - 1] : null, new Date().toISOString(), sessionKey, row.mention_key);
      rebuilt++;
    }
    return { rebuilt, unbound: 0 };
  }

  // ── 投影读取（只读） ──

  /**
   * 读取投影。**版本以权威 `state_snapshot.state_version` 为准**，不是 JSON 里的
   * `entityVersion` 字段 —— 两者一旦不一致（例如回滚重建后），用 JSON 字段做 CAS 基线
   * 就会永久性地把版本比较算错（线上实际出现过 `期望 5，实际 14` 的死循环拒绝）。
   * 这里在读路径上做权威归一，历史库无需迁移即可自愈。
   */
  readProjection(sessionKey: string, characterId: string): CharacterProjection | null {
    const snap = this.store.read({ kind: 'character', key: characterId, sessionKey });
    if (!snap.exists) return null;
    const p = snap.state as unknown as CharacterProjection;
    if (!p || p.characterId !== characterId) return null;
    return p.entityVersion === snap.stateVersion ? p : { ...p, entityVersion: snap.stateVersion };
  }

  /** 权威实体版本（= state_snapshot.state_version；未初始化 → 0） */
  versionOf(sessionKey: string, characterId: string): number {
    return this.store.read({ kind: 'character', key: characterId, sessionKey }).stateVersion;
  }

  /** 投影（未初始化 → 透明空投影，但 exists=false 不冒充"已加载"） */
  project(sessionKey: string, characterId: string): CharacterProjection {
    const reg = this.db.prepare('SELECT name FROM character_registry WHERE session_key = ? AND character_id = ?')
      .get(sessionKey, characterId) as { name: string } | undefined;
    const epoch = this.store.historyEpoch(sessionKey);
    const p = this.readProjection(sessionKey, characterId);
    if (p) return { ...p, identity: { ...p.identity, aliases: this.aliasesOf(sessionKey, characterId) }, scope: { ...p.scope, historyEpoch: epoch } };
    return emptyProjection(sessionKey, characterId, reg?.name ?? characterId, epoch);
  }

  projectAll(sessionKey: string): CharacterProjection[] {
    return this.list(sessionKey).map((c) => this.project(sessionKey, c.characterId));
  }

  /** Read-only proof that this exact maintenance operation and candidate already committed. */
  maintenanceAppliedOperationVersion(
    sessionKey: string,
    characterId: string,
    operationId: string,
    candidate: CharacterCandidate,
  ): number | null {
    const rows = this.db.prepare(
      `SELECT candidate_fingerprint, entity_version
       FROM character_fact_log
       WHERE session_key=? AND character_id=? AND operation_id=?
       ORDER BY id`,
    ).all(sessionKey, characterId, operationId) as Array<{
      candidate_fingerprint: string | null;
      entity_version: number;
    }>;
    if (rows.length === 0) return null;
    const expectedFingerprint = this.fingerprint(candidate);
    if (rows.some((row) => row.candidate_fingerprint !== expectedFingerprint)) {
      throw new Error('character-maintenance-operation-intent-conflict');
    }
    const versions = new Set(rows.map((row) => Number(row.entity_version)));
    if (versions.size !== 1) throw new Error('character-maintenance-operation-version-conflict');
    const appliedEntityVersion = [...versions][0]!;
    if (!Number.isSafeInteger(appliedEntityVersion) || appliedEntityVersion < 1) {
      throw new Error('character-maintenance-operation-version-invalid');
    }
    return appliedEntityVersion;
  }

  /** Semantic digest of the live authoritative projection, excluding mutable head metadata. */
  maintenanceCurrentProjectionDigest(sessionKey: string, characterId: string): string {
    return maintenanceProjectionDigest(this.project(sessionKey, characterId));
  }

  /**
   * Reconstruct the exact pre-proposal semantic image after an idempotent
   * CharacterStore admit. This is a pure, read-only replay of fact-log rows at
   * or before the bound version; it never mutates the live projection. This
   * closes the business-DB/control-DB crash window without storing private NPC
   * values in the control DB.
   */
  maintenanceRollbackAnchorForAppliedOperation(
    sessionKey: string,
    characterId: string,
    operationId: string,
    beforeEntityVersion: number,
    appliedEntityVersion: number,
    expectedBeforeProjectionDigest?: string,
  ): CharacterMaintenanceRollbackAnchor {
    if (!Number.isSafeInteger(beforeEntityVersion) || beforeEntityVersion < 0
      || !Number.isSafeInteger(appliedEntityVersion)
      || appliedEntityVersion !== beforeEntityVersion + 1) {
      throw new Error('character-maintenance-rollback-version-binding-invalid');
    }
    const currentVersion = this.versionOf(sessionKey, characterId);
    if (currentVersion < appliedEntityVersion) {
      throw new StateVersionConflictError(appliedEntityVersion, currentVersion);
    }
    const operationRow = this.db.prepare(
      `SELECT COUNT(*) AS n, MIN(entity_version) AS min_version, MAX(entity_version) AS max_version
       FROM character_fact_log WHERE session_key=? AND character_id=? AND operation_id=?`,
    ).get(sessionKey, characterId, operationId) as {
      n: number;
      min_version: number | null;
      max_version: number | null;
    };
    if (Number(operationRow?.n ?? 0) < 1
      || operationRow.min_version !== appliedEntityVersion
      || operationRow.max_version !== appliedEntityVersion) {
      throw new Error('character-maintenance-rollback-operation-missing');
    }
    const reg = this.db.prepare(
      'SELECT name FROM character_registry WHERE session_key=? AND character_id=?',
    ).get(sessionKey, characterId) as { name: string } | undefined;
    if (!reg) throw new Error('character-maintenance-rollback-character-missing');
    const beforeRows = this.db.prepare(
      `SELECT field, scope_kind, fact_kind, status, value_json, scene_id, effective_round,
              effective_message_id, source_refs, history_epoch, entity_version
       FROM character_fact_log
       WHERE session_key=? AND character_id=? AND entity_version<=?
       ORDER BY id`,
    ).all(sessionKey, characterId, beforeEntityVersion) as unknown as CharacterFactProjectionRow[];
    const before = projectionFromFactRows({
      sessionKey,
      characterId,
      name: reg.name,
      epoch: this.store.historyEpoch(sessionKey),
      rows: beforeRows,
    });
    const beforeProjectionDigest = maintenanceProjectionDigest(before);
    if (expectedBeforeProjectionDigest !== undefined
      && (!/^sha256:[a-f0-9]{64}$/u.test(expectedBeforeProjectionDigest)
        || beforeProjectionDigest !== expectedBeforeProjectionDigest)) {
      throw new Error('character-maintenance-before-image-replay-mismatch');
    }
    return Object.freeze({
      characterId,
      operationId,
      beforeEntityVersion,
      appliedEntityVersion,
      beforeFactLogCount: beforeRows.length,
      beforeProjectionDigest,
    });
  }

  /**
   * Remove only the fact-log rows written by one maintenance proposal and
   * rebuild from the remaining log. The caller must wrap this method in the
   * same BEGIN IMMEDIATE transaction used for all characters in the proposal.
   */
  rollbackMaintenanceOperations(
    sessionKey: string,
    anchors: readonly CharacterMaintenanceRollbackAnchor[],
  ): CharacterMaintenanceRollbackResult {
    const ordered = [...anchors].sort((left, right) => left.characterId.localeCompare(right.characterId));
    if (new Set(ordered.map((item) => item.characterId)).size !== ordered.length
      || new Set(ordered.map((item) => item.operationId)).size !== ordered.length) {
      throw new Error('character-maintenance-rollback-anchor-duplicate');
    }
    const rows = ordered.map((anchor) => {
      if (!Number.isSafeInteger(anchor.beforeEntityVersion) || anchor.beforeEntityVersion < 0
        || !Number.isSafeInteger(anchor.appliedEntityVersion) || anchor.appliedEntityVersion < 1
        || anchor.appliedEntityVersion !== anchor.beforeEntityVersion + 1
        || !Number.isSafeInteger(anchor.beforeFactLogCount) || anchor.beforeFactLogCount < 0
        || !/^sha256:[a-f0-9]{64}$/u.test(anchor.beforeProjectionDigest)
        || !anchor.operationId.startsWith('maintenance:')) {
        throw new Error('character-maintenance-rollback-anchor-invalid');
      }
      const count = this.db.prepare(
        'SELECT COUNT(*) AS n FROM character_fact_log WHERE session_key=? AND character_id=? AND operation_id=?',
      ).get(sessionKey, anchor.characterId, anchor.operationId) as { n: number };
      return { anchor, operationRows: Number(count?.n ?? 0) };
    });
    if (rows.every((row) => row.operationRows === 0)) {
      return Object.freeze({ deduped: true, removedFactRows: 0, characters: Object.freeze([]) });
    }
    if (rows.some((row) => row.operationRows === 0)) {
      throw new Error('character-maintenance-rollback-anchor-partial');
    }
    for (const { anchor } of rows) {
      const actualVersion = this.versionOf(sessionKey, anchor.characterId);
      if (actualVersion !== anchor.appliedEntityVersion) {
        throw new StateVersionConflictError(anchor.appliedEntityVersion, actualVersion);
      }
    }

    let removedFactRows = 0;
    const characters: Array<{ characterId: string; entityVersion: number; projectionDigest: string }> = [];
    for (const { anchor } of rows) {
      const removed = this.db.prepare(
        'DELETE FROM character_fact_log WHERE session_key=? AND character_id=? AND operation_id=?',
      ).run(sessionKey, anchor.characterId, anchor.operationId);
      removedFactRows += Number(removed.changes);
      const count = this.db.prepare(
        'SELECT COUNT(*) AS n FROM character_fact_log WHERE session_key=? AND character_id=?',
      ).get(sessionKey, anchor.characterId) as { n: number };
      if (Number(count?.n ?? 0) !== anchor.beforeFactLogCount) {
        throw new Error('character-maintenance-rollback-before-image-mismatch');
      }
      const rebuilt = this.rebuildProjection(sessionKey, anchor.characterId);
      const projectionDigest = maintenanceProjectionDigest(rebuilt);
      if (projectionDigest !== anchor.beforeProjectionDigest) {
        throw new Error('character-maintenance-rollback-projection-mismatch');
      }
      characters.push({
        characterId: anchor.characterId,
        entityVersion: rebuilt.entityVersion,
        projectionDigest,
      });
    }
    return Object.freeze({
      deduped: false,
      removedFactRows,
      characters: Object.freeze(characters.map((item) => Object.freeze(item))),
    });
  }

  // ── 事实日志（有来源的字段/关系变更记录） ──

  /** 规范化业务指纹：同一 operationId 只有指纹相同才算"同一业务意图" */
  private fingerprint(candidate: CharacterCandidate): string {
    const norm = JSON.stringify({
      characterId: candidate.characterId ?? '',
      mention: candidate.mention ?? '',
      newEntity: !!candidate.newEntity,
      changes: (candidate.changes ?? []).map((c) => ({ field: c.field, scope: c.scope ?? 'fact', value: c.value ?? null }))
        .sort((a, b) => a.field.localeCompare(b.field)),
      relationships: (candidate.relationships ?? []).map((r) => ({
        from: r.fromCharacterId, to: r.toCharacterId, type: r.type, perspective: r.perspective ?? 'objective',
      })).sort((a, b) => `${a.from}|${a.type}|${a.to}`.localeCompare(`${b.from}|${b.type}|${b.to}`)),
    });
    return sha256Hex(norm);
  }

  private appendFactLog(
    sessionKey: string, characterId: string, row: {
      field: string; scopeKind: FactScope; factKind: FactKind; status: FactStatus; value: unknown;
      sceneId?: string; effectiveAt: EffectiveAt; sourceRefs: SourceRef[]; historyEpoch: number;
      entityVersion: number; operationId: string; fingerprint?: string;
    },
  ): void {
    this.db.prepare(
      `INSERT INTO character_fact_log
        (session_key, character_id, field, scope_kind, fact_kind, status, value_json, scene_id,
         effective_round, effective_message_id, source_refs, history_epoch, entity_version, operation_id, candidate_fingerprint, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sessionKey, characterId, row.field, row.scopeKind, row.factKind, row.status, JSON.stringify(row.value ?? null),
      row.sceneId ?? null, row.effectiveAt.round ?? null, row.effectiveAt.messageId ?? null,
      JSON.stringify(row.sourceRefs ?? []), row.historyEpoch, row.entityVersion, row.operationId,
      row.fingerprint ?? null, new Date().toISOString(),
    );
  }

  /** 该人物已有的字段变更证据（供诊断/冲突报告） */
  factLog(sessionKey: string, characterId: string, limit = 200): unknown[] {
    return this.db.prepare(
      'SELECT field, scope_kind, fact_kind, status, value_json, scene_id, effective_round, effective_message_id, source_refs, history_epoch, entity_version, operation_id, created_at FROM character_fact_log WHERE session_key = ? AND character_id = ? ORDER BY id DESC LIMIT ?',
    ).all(sessionKey, characterId, limit);
  }

  // ── 准入与提交（MEM-02） ──

  /**
   * 候选准入（§3.2 顺序）：
   *  1. schema/字段/资源限制  2. operationId + 业务指纹（在 StateStore）  3. 人物 ID 属于允许集合
   *  4. 源记录存在与版本      5. 事实类别区分  6. 权威性与时间/场景语义
   *  7. 短事务内复核代际/前驱/版本 → 原子提交  8. 保存回执并镜像只读状态表
   *
   * 任何拒绝都返回**真实冲突**，不自动换最新版本覆盖，也不假成功。
   */
  admit(sessionKey: string, candidate: CharacterCandidate, ctx: AdmitContext): AdmitResult {
    const base: AdmitResult = {
      ok: false, applied: [], recordedHistory: [], unresolved: [...(candidate.unresolved ?? [])],
      rejected: [], receipt: { operationId: ctx.operationId },
    };
    // 1. 目标人物
    let characterId = candidate.characterId ?? '';
    if (!characterId && candidate.newEntity) {
      if (!candidate.name) return { ...base, error: { name: 'InvalidCandidate', message: 'newEntity 候选必须提供 name' } };
      // ID 由代码分配；创建操作幂等（同一 operationId 重试取得同一结果）
      const c = this.ensureCharacter(sessionKey, {
        name: candidate.name, aliases: candidate.aliases, kind: 'npc',
        operationId: `create:${sessionKey}:${ctx.operationId}`,
        // 显式 newEntity：即便已有同名人物也创建**独立 ID**（同名不等于同一人）
        reuseByName: false,
      });
      characterId = c.characterId;
      base.created = c.created;
    }
    if (!characterId) {
      const r = this.resolveMentions(sessionKey, [candidate.mention ?? candidate.name ?? '']);
      if (r.resolved.length === 1) characterId = r.resolved[0].characterId;
      else {
        base.unresolved.push(candidate.mention ?? candidate.name ?? '(空)');
        return { ...base, error: { name: 'UnresolvedCharacter', message: '无法唯一确定人物（不静默写入任意人物）' } };
      }
    }
    base.characterId = characterId;
    const reg = this.db.prepare('SELECT character_id, name FROM character_registry WHERE session_key = ? AND character_id = ?')
      .get(sessionKey, characterId) as { character_id: string; name: string } | undefined;
    if (!reg) return { ...base, error: { name: 'UnknownCharacter', message: `人物 ${characterId} 不在本会话注册表中` } };

    // 3. 允许集合
    if (ctx.allowedCharacterIds && !ctx.allowedCharacterIds.includes(characterId)) {
      return { ...base, error: { name: 'CharacterNotAllowed', message: `人物 ${characterId} 不在本任务允许集合内` } };
    }
    if (candidate.aliases?.length) this.addAliases(sessionKey, characterId, candidate.aliases);

    // 2. 幂等 / 业务指纹：
    //   同 ID 同意图且已提交 → 返回原回执（历史回执可读，但不重新应用）
    //   同 ID 不同意图 → 明确拒绝（不因"ID 撞了"就把新意图写成既成事实）
    const fp = this.fingerprint(candidate);
    const prior = this.db.prepare(
      'SELECT candidate_fingerprint, entity_version FROM character_fact_log WHERE operation_id = ? ORDER BY id DESC LIMIT 1',
    ).get(ctx.operationId) as { candidate_fingerprint: string | null; entity_version: number } | undefined;
    if (prior) {
      if (prior.candidate_fingerprint && prior.candidate_fingerprint !== fp) {
        return {
          ...base,
          error: { name: 'StateOperationIntentConflictError', message: `操作身份冲突：${ctx.operationId} 已绑定到另一项业务意图` },
          receipt: { operationId: ctx.operationId },
        };
      }
      const applied = (this.db.prepare('SELECT DISTINCT field FROM character_fact_log WHERE operation_id = ?')
        .all(ctx.operationId) as { field: string }[]).map((r) => r.field);
      return {
        ...base, ok: true, entityVersion: prior.entity_version, applied,
        receipt: { operationId: ctx.operationId, entityVersion: prior.entity_version, deduped: true },
      };
    }

    // 2 & 4：幂等 + 前驱 + 代际由 StateStore 承担（先做一次廉价预检以返回真实冲突）
    const epochNow = this.store.historyEpoch(sessionKey);
    if (ctx.historyEpoch < epochNow) {
      return { ...base, error: { name: 'StateEpochStaleError', message: `候选基于代际 ${ctx.historyEpoch}，当前代际 ${epochNow}（回滚后旧写入被拒绝）` } };
    }

    // 1. 字段级 schema 校验
    const changes = (candidate.changes ?? []).slice(0, MAX_CHANGES);
    if ((candidate.changes?.length ?? 0) > MAX_CHANGES) {
      base.rejected.push({ field: '*', reason: `候选字段数超过上限 ${MAX_CHANGES}` });
    }
    const clean: CharacterChangeCandidate[] = [];
    for (const ch of changes) {
      const field = String(ch.field ?? '').trim();
      if (!FIELD_RE.test(field) || field.includes('__proto__') || field.includes('constructor') || field.includes('prototype')) {
        base.rejected.push({ field, reason: '非法字段名' });
        continue;
      }
      if (jsonSize(ch.value) > MAX_VALUE_BYTES) {
        base.rejected.push({ field, reason: `字段值超过 ${MAX_VALUE_BYTES} 字节上限` });
        continue;
      }
      clean.push({ ...ch, field });
    }

    // 5/6：字段级事实类别 + 时间/场景语义
    const cur = this.project(sessionKey, characterId);
    const next: CharacterProjection = JSON.parse(JSON.stringify(cur)) as CharacterProjection;
    const userCorrection = ctx.sourceKind === 'user-correction';
    const relationshipLogRows: CharacterRelationship[] = [];
    for (const ch of clean) {
      const kind: FactKind = userCorrection ? 'correction' : (ch.factKind ?? 'fact');
      const status: FactStatus = ch.status ?? (kind === 'fact' || kind === 'correction' ? 'confirmed' : 'pending');
      const scope: FactScope = ch.scope ?? 'fact';
      const effectiveAt: EffectiveAt = ch.effectiveAt ?? { round: ctx.round };
      const sourceRefs = ch.sourceRefs?.length ? ch.sourceRefs : (ctx.sourceRefs ?? []);
      const target = scope === 'profile' ? next.profile : next.facts;
      const prev = target[ch.field];

      // 计划/假设/回忆/转述 永不冒充当前客观事实 → 只进历史
      if (!mayPromoteCurrent(kind)) {
        next.history.push({
          field: `${scope}.${ch.field}`, value: ch.value, factKind: kind, status, effectiveAt, sourceRefs,
          reason: `事实类别为 ${kind}，不得写成既成事实`,
        });
        base.recordedHistory.push(`${scope}.${ch.field}`);
        continue;
      }
      // 晚提及的历史事实（生效轮次早于当前值）→ 记历史，不覆盖当前值（T07）
      const prevRound = prev?.effectiveAt?.round;
      if (prev && prevRound !== undefined && effectiveAt.round !== undefined && effectiveAt.round < prevRound) {
        next.history.push({
          field: `${scope}.${ch.field}`, value: ch.value, factKind: kind, status, effectiveAt, sourceRefs,
          reason: `生效轮次 ${effectiveAt.round} 早于当前值生效轮次 ${prevRound}（历史事实不晋升当前状态）`,
        });
        base.recordedHistory.push(`${scope}.${ch.field}`);
        continue;
      }
      // 场景不一致且无新证据 → last-known，不无条件宣称仍是当前（§2.2）
      let finalStatus = status;
      let sceneId = ch.sceneId ?? ctx.sceneId;
      if (prev?.sceneId && sceneId && prev.sceneId !== sceneId && kind === 'fact') {
        finalStatus = 'last-known';
      }
      if (prev?.sceneId && !sceneId) { sceneId = prev.sceneId; finalStatus = prev.status === 'confirmed' ? 'last-known' : prev.status; }
      target[ch.field] = { value: ch.value, status: finalStatus, factKind: kind, sceneId, effectiveAt, sourceRefs };
      base.applied.push(`${scope}.${ch.field}`);
    }

    // 关系端点与方向（§2.3）。
    // 模型可以只给**称呼**：由代码把它解析成稳定 characterId（身份由运行时/代码决定，模型不发明 ID）。
    const knownIds = new Set(this.list(sessionKey).map((c) => c.characterId));
    const resolveEndpoint = (raw: string): { id?: string; error?: string } => {
      const v = String(raw ?? '').trim();
      if (!v) return { error: '关系端点为空' };
      if (knownIds.has(v)) return { id: v };
      const r = this.resolveMentions(sessionKey, [v]);
      if (r.resolved.length === 1) return { id: r.resolved[0].characterId };
      const hits = this.list(sessionKey).filter((c) => c.name === v).length;
      return { error: hits > 1 ? `关系端点「${v}」同名 ${hits} 人，需按 characterId 消歧` : `关系端点「${v}」不在本会话注册表` };
    };
    for (const rel of candidate.relationships ?? []) {
      const kind: FactKind = userCorrection ? 'correction' : (rel.factKind ?? 'fact');
      const status: FactStatus = rel.status ?? (mayPromoteCurrent(kind) ? 'confirmed' : 'pending');
      const fromRes = resolveEndpoint(rel.fromCharacterId || characterId);
      const toRes = resolveEndpoint(rel.toCharacterId ?? '');
      if (!fromRes.id || !toRes.id) {
        base.rejected.push({ field: `rel.${rel.type}`, reason: fromRes.error ?? toRes.error ?? '关系端点无法解析' });
        continue;
      }
      const from = fromRes.id;
      const to = toRes.id;
      const perspective = rel.perspective ?? 'objective';
      const baseId = rel.relationshipId ?? `rel_${from}_${to}_${rel.type}`;
      const entry: CharacterRelationship = {
        relationshipId: perspective === 'objective' ? baseId : `${baseId}_subj_${from}`,
        fromCharacterId: from, toCharacterId: to, type: rel.type, perspective, status, factKind: kind,
        sceneId: rel.sceneId ?? ctx.sceneId,
        effectiveAt: rel.effectiveAt ?? { round: ctx.round },
        sourceRefs: rel.sourceRefs?.length ? rel.sourceRefs : (ctx.sourceRefs ?? []),
      };
      // Preserve the exact normalized endpoints, identity and perspective used by
      // the live projection. Rebuild must not guess them again from raw input.
      relationshipLogRows.push(entry);
      if (!mayPromoteCurrent(kind)) {
        next.history.push({
          field: `rel.${entry.relationshipId}`, value: { type: rel.type, from, to }, factKind: kind, status,
          effectiveAt: entry.effectiveAt, sourceRefs: entry.sourceRefs,
          reason: `关系候选类别为 ${kind}（计划/单方情绪），不得写成已发生的客观关系`,
        });
        base.recordedHistory.push(`rel.${entry.relationshipId}`);
        continue;
      }
      const idx = next.relationships.findIndex((r) => r.relationshipId === entry.relationshipId);
      if (idx >= 0) next.relationships[idx] = entry;
      else next.relationships.push(entry);
      base.applied.push(`rel.${entry.relationshipId}`);
      // 对称关系：反向边由代码派生（单一真源，不产生两份可漂移的值）
      if (perspective === 'objective' && SYMMETRIC_RELATION_TYPES.has(rel.type)) {
        const revId = `${entry.relationshipId}_rev`;
        const rev: CharacterRelationship = {
          ...entry, relationshipId: revId, fromCharacterId: to, toCharacterId: from, derived: true,
        };
        const ri = next.relationships.findIndex((r) => r.relationshipId === revId);
        if (ri >= 0) next.relationships[ri] = rev;
        else next.relationships.push(rev);
      }
    }

    if (base.applied.length === 0 && base.recordedHistory.length === 0) {
      return { ...base, error: { name: 'EmptyCandidate', message: '候选没有任何可准入的字段或关系变更' } };
    }

    // 7/8：短事务内复核 + 原子提交（复用 StateStore：幂等 / 乐观锁 / 代际 / 前驱）
    // **CAS 基线必须用权威 state_version**，不能再用投影 JSON 里的 entityVersion：
    // 回滚重建会推进 state_version 而 JSON 字段不跟随，两者一旦错位就会永久拒绝所有写入。
    const baseVersion = this.versionOf(sessionKey, characterId);
    const entityVersion = baseVersion + 1;
    next.entityVersion = entityVersion;
    next.head = {
      snapshotId: `commit_${String(entityVersion).padStart(3, '0')}`,
      headRevision: entityVersion,
      asOfMessageId: ctx.predecessor?.messageId !== undefined ? `msg_${ctx.predecessor.messageId}` : undefined,
    };
    next.scope = { sessionId: sessionKey, stateInstanceId: ctx.instanceId, historyEpoch: ctx.historyEpoch };
    next.unresolved = [...new Set([...next.unresolved, ...base.unresolved])];

    let res: CommitResult;
    try {
      res = this.store.commit({
        scope: { kind: 'character', key: characterId, sessionKey },
        state: next as unknown as Record<string, unknown>,
        round: ctx.round,
        instanceId: ctx.instanceId,
        operationId: ctx.operationId,
        expectedVersion: ctx.expectedVersion ?? (baseVersion > 0 ? baseVersion : undefined),
        historyEpoch: ctx.historyEpoch,
        predecessor: ctx.predecessor,
        sessionKey,
        source: (ctx.sourceKind === 'migration' ? 'seed' : 'card-write') as SnapshotSource,
        note: `人物 ${reg.name} 字段级候选准入`,
      });
    } catch (e) {
      const err = e as Error;
      return { ...base, ok: false, error: { name: err.name, message: err.message } };
    }

    // 变更记录（有来源、可回放）
    for (const ch of clean) {
      const scope: FactScope = ch.scope ?? 'fact';
      const target = scope === 'profile' ? next.profile : next.facts;
      const fact = target[ch.field];
      const wentHistory = !fact || JSON.stringify(fact.value) !== JSON.stringify(ch.value);
      const hist = wentHistory ? next.history.filter((h) => h.field === `${scope}.${ch.field}`).pop() : undefined;
      this.appendFactLog(sessionKey, characterId, {
        field: `${scope}.${ch.field}`,
        scopeKind: scope,
        factKind: hist?.factKind ?? fact?.factKind ?? 'fact',
        status: hist?.status ?? fact?.status ?? 'pending',
        value: hist ? hist.value : (fact?.value ?? ch.value),
        sceneId: fact?.sceneId,
        effectiveAt: hist?.effectiveAt ?? fact?.effectiveAt ?? {},
        sourceRefs: hist?.sourceRefs ?? fact?.sourceRefs ?? [],
        historyEpoch: ctx.historyEpoch,
        entityVersion: res.stateVersion,
        operationId: ctx.operationId,
        fingerprint: fp,
      });
    }
    for (const rel of relationshipLogRows) {
      this.appendFactLog(sessionKey, characterId, {
        field: `rel:${rel.fromCharacterId}:${rel.toCharacterId}:${rel.type}`,
        scopeKind: 'relationship',
        factKind: rel.factKind,
        status: rel.status,
        value: {
          relationshipId: rel.relationshipId,
          from: rel.fromCharacterId,
          to: rel.toCharacterId,
          type: rel.type,
          perspective: rel.perspective,
        },
        sceneId: rel.sceneId,
        effectiveAt: rel.effectiveAt,
        sourceRefs: rel.sourceRefs,
        historyEpoch: ctx.historyEpoch,
        entityVersion: res.stateVersion,
        operationId: ctx.operationId,
        fingerprint: fp,
      });
    }

    // 镜像只读状态表（复用既有 memory_state，供记忆面板「状态表」直接显示；不是第二套权威库）
    this.mirrorToStateTable(sessionKey, next, ctx.round ?? 0);

    return {
      ...base, ok: true, entityVersion: res.stateVersion,
      receipt: { operationId: ctx.operationId, entityVersion: res.stateVersion, deduped: res.deduped },
    };
  }

  /** 只读镜像：memory_state（表0-5）按人物输出当前字段值 */
  private mirrorToStateTable(sessionKey: string, p: CharacterProjection, round: number): void {
    const kind = this.db.prepare('SELECT kind FROM character_registry WHERE session_key = ? AND character_id = ?')
      .get(sessionKey, p.characterId) as { kind: string } | undefined;
    const entityType = kind?.kind === 'protagonist' ? 'protagonist' : 'npc';
    const payload: Record<string, unknown> = {};
    for (const [f, v] of Object.entries(p.facts)) payload[f] = v.value;
    for (const [f, v] of Object.entries(p.profile)) payload[f] = v.value;
    if (p.relationships.length) {
      payload['关系'] = p.relationships.filter((r) => !r.derived).map((r) => `${r.fromCharacterId}→${r.toCharacterId}:${r.type}(${r.status})`);
    }
    const existing = this.db.prepare('SELECT id FROM memory_state WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, p.characterId) as { id: number } | undefined;
    const name = p.identity.name || p.characterId;
    if (existing) {
      this.db.prepare('UPDATE memory_state SET name = ?, state_json = ?, updated_round = ?, last_access_ms = ? WHERE id = ?')
        .run(name, JSON.stringify(payload), round, Date.now(), existing.id);
    } else {
      this.db.prepare(
        'INSERT INTO memory_state (entity_type, entity_id, name, state_json, updated_round, last_access_ms) VALUES (?,?,?,?,?,?)',
      ).run(entityType, p.characterId, name, JSON.stringify(payload), round, Date.now());
    }
    this.db.prepare('INSERT OR REPLACE INTO idx_entity (entity, category, row_id, weight) VALUES (?,?,?,?)')
      .run(p.characterId, 'state', existing?.id ?? 0, 1.0);
  }

  // ── 投影重建 / 回滚（确定路径，不靠"取全库最新一条"） ──

  /**
   * 回滚到第 round 轮之前：删除本轮及之后的事实证据并**从日志重放**重建投影。
   * 合法回滚不受版本比较误拦（重建后写入方读到的是新头）。
   */
  rollbackTo(sessionKey: string, round: number): { rebuilt: number; removed: number } {
    const del = this.db.prepare('DELETE FROM character_fact_log WHERE session_key = ? AND COALESCE(effective_round, 0) >= ?')
      .run(sessionKey, round);
    let rebuilt = 0;
    for (const c of this.list(sessionKey)) {
      this.rebuildProjection(sessionKey, c.characterId);
      rebuilt++;
    }
    return { rebuilt, removed: Number(del.changes) };
  }

  /** 从事实日志重放重建单个投影（幂等；同一批日志重复重放得到同一结果） */
  rebuildProjection(sessionKey: string, characterId: string): CharacterProjection {
    const reg = this.db.prepare('SELECT name FROM character_registry WHERE session_key = ? AND character_id = ?')
      .get(sessionKey, characterId) as { name: string } | undefined;
    if (!reg) throw new Error(`人物 ${characterId} 不在本会话注册表中`);
    const rows = this.db.prepare(
      `SELECT field, scope_kind, fact_kind, status, value_json, scene_id, effective_round, effective_message_id,
              source_refs, history_epoch, entity_version
       FROM character_fact_log WHERE session_key = ? AND character_id = ? ORDER BY id ASC`,
    ).all(sessionKey, characterId) as unknown as CharacterFactProjectionRow[];
    const epoch = this.store.historyEpoch(sessionKey);
    const p = projectionFromFactRows({
      sessionKey,
      characterId,
      name: reg.name,
      epoch,
      rows,
    });
    // 重建也走权威提交入口，并把 entityVersion 对齐到**提交后的 state_version**：
    // 旧实现让 JSON 版本停在日志最大值、而 state_version 每次重建 +1，
    // 两者错位后 CAS 基线永远是旧的（线上表现为永久 `期望 5，实际 14`）。
    const rebuilt = this.store.commit({
      scope: { kind: 'character', key: characterId, sessionKey },
      state: p as unknown as Record<string, unknown>,
      instanceId: undefined,
      historyEpoch: epoch,
      sessionKey,
      source: 'seed',
      note: `投影重建（从事实日志重放，epoch=${epoch}）`,
    });
    p.entityVersion = rebuilt.stateVersion;
    this.mirrorToStateTable(sessionKey, p, 0);
    return p;
  }

  /**
   * 只读诊断：列出注册表里**不像人物**的条目（历史链路把 `state_changes.entity_id`
   * 当人物名写入造成的污染）。默认只报告，不删除——删数据必须由调用方显式决定。
   *
   * 两类判据：
   *  ① 形态判据（旧）：内部 ID / 复合键 / 纯 ASCII 键。
   *  ② **纯汉字也可能不是人**（新增）：`<已注册人物名>+字段后缀`（实测 `主角所在地点`、`祥子外观`）、
   *     `主角…` 前缀、机构/地点尾词（实测 `示例学园`）。这一类的根因是**单轮建人无阈值**，
   *     新写入路径已由临时层挡住（`stageMention`）；本函数只负责把存量列出来。
   */
  suspiciousCharacters(sessionKey: string): { characterId: string; name: string; reason: string; factCount: number }[] {
    const out: { characterId: string; name: string; reason: string; factCount: number }[] = [];
    const roster = this.list(sessionKey);
    const allNames = roster.map((c) => c.name);
    for (const c of roster) {
      let reason: string;
      if (!isPlausibleCharacterName(c.name)) {
        reason = INTERNAL_ID_RE.test(c.name) ? '名字是内部 ID 形态'
          : COMPOSITE_KEY_RE.test(c.name) ? '名字是复合实体键（含 | 或 :）'
            : '名字是纯 ASCII 键（拼音/变量名），不是显示名';
      } else {
        const suffix = FIELD_SUFFIXES.find((s) => c.name.endsWith(s) && c.name.length > s.length);
        const owner = suffix
          ? allNames.find((n) => n !== c.name && n.length >= 2 && c.name.startsWith(n))
          : undefined;
        const place = PLACE_SUFFIXES.find((s) => c.name.endsWith(s) && c.name.length > s.length);
        if (suffix && owner) reason = `名字是「${owner}+${suffix}」形态，像属性/位置而非人物`;
        else if (c.name.startsWith('主角') && c.name.length > 2) reason = '名字是「主角+…」形态，像字段而非人物';
        else if (place) reason = `名字以「${place}」结尾，像机构/地点而非人物`;
        else continue;
      }
      const log = this.db.prepare('SELECT COUNT(*) AS n FROM character_fact_log WHERE session_key = ? AND character_id = ?')
        .get(sessionKey, c.characterId) as { n: number };
      out.push({ characterId: c.characterId, name: c.name, factCount: log?.n ?? 0, reason });
    }
    return out;
  }

  /**
   * 清理被污染的人物条目（**默认干跑**）：只删注册表/别名/事实日志 + 对应 memory_state 镜像，
   * 不碰其它业务数据。请先看 dry-run 报告再决定是否 apply。
   */
  pruneSuspicious(sessionKey: string, opts: { apply?: boolean } = {}): {
    dryRun: boolean; removed: { characterId: string; name: string; reason: string; facts: number }[];
  } {
    const targets = this.suspiciousCharacters(sessionKey);
    const removed = targets.map((t) => ({ characterId: t.characterId, name: t.name, reason: t.reason, facts: t.factCount }));
    if (!opts.apply) return { dryRun: true, removed };
    for (const t of targets) {
      this.db.prepare('DELETE FROM character_alias WHERE session_key = ? AND character_id = ?').run(sessionKey, t.characterId);
      this.db.prepare('DELETE FROM character_fact_log WHERE session_key = ? AND character_id = ?').run(sessionKey, t.characterId);
      this.db.prepare('DELETE FROM character_registry WHERE session_key = ? AND character_id = ?').run(sessionKey, t.characterId);
      this.db.prepare('DELETE FROM memory_state WHERE entity_id = ?').run(t.characterId);
    }
    return { dryRun: false, removed };
  }

  // ── 最小注入（MEM-03 数据源） ──

  /**
   * 本轮最小人物事实块（§5.2 三层）：
   *  - 必须保留：涉及人物 ID/称谓、关键身份、与主角相关关系、当前动作需要的事实
   *  - 按需加入：关系与服饰细节（精确查取）
   *  - 默认不加入：全量档案、过时穿着
   *
   * 返回结构化 trace（blockId / 来源版本 / 入选与裁剪原因 / token），供真实出站请求核查。
   */
  factBlock(sessionKey: string, characterIds: string[], opts: { protagonistId?: string; sceneId?: string; budgetTokens?: number } = {}): FactBlock {
    const budget = opts.budgetTokens ?? 900;
    const lines: string[] = [];
    const includedReasons: FactBlock['includedReasons'] = [];
    const dropped: FactBlock['dropped'] = [];
    const heads: FactBlock['headVersions'] = [];
    let used = 0;
    for (const id of [...new Set(characterIds)].slice(0, 8)) {
      const p = this.readProjection(sessionKey, id);
      if (!p) { dropped.push({ characterId: id, reason: '无已提交投影（未准入过任何事实）' }); continue; }
      const ids = `${p.characterId}|${p.identity.name}${p.identity.aliases.length ? `(${p.identity.aliases.slice(0, 3).join('/')})` : ''}`;
      const parts: string[] = [`【${ids}】v${p.entityVersion}`];
      // 必须保留：关键身份（档案优先取少量稳定字段）
      for (const f of Object.keys(p.profile).slice(0, 3)) parts.push(`档案.${f}=${fmt(p.profile[f].value)}(${p.profile[f].status})`);
      // 与主角相关关系（不含派生副本）
      for (const r of p.relationships.filter((x) => !x.derived)) {
        parts.push(`关系 ${r.fromCharacterId}→${r.toCharacterId}:${r.type}(${r.perspective}/${r.status})`);
      }
      // 当前动作需要的事实：场景匹配优先，其次确认态；last-known 显式标注
      const factEntries = Object.entries(p.facts);
      const sceneHit = opts.sceneId ? factEntries.filter(([, v]) => v.sceneId === opts.sceneId) : [];
      const confirmed = factEntries.filter(([, v]) => v.status === 'confirmed');
      const pickedMap = new Map<string, CharacterFact>();
      for (const [f, v] of [...sceneHit, ...confirmed]) if (!pickedMap.has(f)) pickedMap.set(f, v);
      for (const [f, v] of factEntries) if (!pickedMap.has(f) && pickedMap.size < 6) pickedMap.set(f, v);
      const picked = [...pickedMap.entries()].slice(0, 6);
      for (const [f, v] of picked) {
        const mark = v.status === 'last-known' ? '[last-known，非当前确认]' : '';
        parts.push(`${f}=${fmt(v.value)}${mark}`);
      }
      if (p.history.length > 0) {
        parts.push(`历史(不冒充当前): ${p.history.slice(-2).map((h) => `${h.field}=${fmt(h.value)}(${h.factKind})`).join('; ')}`);
      }
      const line = parts.join(' ');
      const t = estimateTokens(line);
      if (used + t > budget) { dropped.push({ characterId: id, reason: `超出人物块预算 ${budget}` }); continue; }
      used += t;
      lines.push(line);
      heads.push({ characterId: p.characterId, entityVersion: p.entityVersion, headRevision: p.head.headRevision });
      includedReasons.push({
        characterId: p.characterId,
        head: `v${p.entityVersion}/rev${p.head.headRevision}`,
        reason: picked.length > 0 ? `本轮相关事实 ${picked.length} 项（场景${opts.sceneId ?? '未定'}）` : '仅关系/档案',
      });
    }
    const text = lines.length > 0
      ? `<人物事实 block="character-facts">\n${lines.join('\n')}\n</人物事实>`
      : '';
    return { blockId: 'character-facts', text, tokens: used, includedReasons, dropped, headVersions: heads };
  }

  /** 会话内全部已注册人物 ID（供本轮人物集合计算） */
  characterIds(sessionKey: string): string[] {
    return this.list(sessionKey).map((c) => c.characterId);
  }

  /** 主角 ID（由会话配置提供，不硬编码某个角色名字） */
  protagonistId(sessionKey: string): string | undefined {
    const row = this.db.prepare("SELECT character_id FROM character_registry WHERE session_key = ? AND kind = 'protagonist' ORDER BY character_id LIMIT 1")
      .get(sessionKey) as { character_id: string } | undefined;
    return row?.character_id;
  }

  // ── 老存档迁移（MEM-06 / T26） ──

  /**
   * 老存档 → 人物投影的**显式迁移步骤**。
   *
   * 纪律：
   *  · 只在此显式步骤写入；**打开面板/普通读取绝不迁移**
   *  · 旧摘要有明确来源才作为候选；无来源的字段不猜内容，记为待核对（不强行填满角色表）
   *  · 迁入的字段状态为 `pending`（待核对），**不把推测升级为确认**
   *  · 迁移重跑幂等（operationId 绑定来源身份；同 op 重试返回原回执）
   *
   * @returns 每次都返回同一形状，供"重跑两次结果一致"的断言使用
   */
  migrateFromLegacy(
    sessionKey: string,
    rows: { entity_type: string; entity_id: string; name?: string; state_json: string; updated_round?: number }[],
    opts: {
      /** 来源证据（会话绑定的版本化设定或合法历史）；缺省 → 全部字段记为待核对 */
      sourceRefs?: SourceRef[];
      /** 迁移批身份（同一批重跑 = 同一 operationId 前缀 → 幂等） */
      batchId: string;
      instanceId?: string;
      historyEpoch?: number;
    },
  ): {
    createdCharacters: number; importedFields: number; pendingFields: number; dedupedFields: number; skipped: { entityId: string; reason: string }[];
  } {
    const epoch = opts.historyEpoch ?? this.store.historyEpoch(sessionKey);
    const out = { createdCharacters: 0, importedFields: 0, pendingFields: 0, dedupedFields: 0, skipped: [] as { entityId: string; reason: string }[] };
    const hasSource = (opts.sourceRefs?.length ?? 0) > 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const name = String(row.name ?? row.entity_id ?? '').trim();
      const entityId = String(row.entity_id ?? '').trim();
      const key = `${row.entity_type}:${entityId}`;
      if (!name || !entityId) { out.skipped.push({ entityId: entityId || '(空)', reason: '实体名或 ID 为空' }); continue; }
      if (seen.has(key)) { out.skipped.push({ entityId, reason: '同批次重复出现（跳过，不重复写关系）' }); continue; }
      seen.add(key);

      // 幂等：本批次已为该实体建过人 → 复用同一角色（重跑走原回执，不重复建人）
      const createOp = `migrate:${sessionKey}:${opts.batchId}:${key}`;
      const mapped = this.db.prepare('SELECT character_id FROM character_registry WHERE create_operation_id = ?')
        .get(createOp) as { character_id: string } | undefined;
      if (!mapped) {
        // 旧行之间的**同名歧义**：无法确认是否同一人 → 保持待核对，不强行合并也不重复建人
        const sameName = this.list(sessionKey).filter((c) => c.name === name);
        if (sameName.length > 0) {
          out.skipped.push({ entityId, reason: `「${name}」已有人物注册（同名，无法确认是否同一人），保持待核对` });
          continue;
        }
      }

      const before = this.list(sessionKey).length;
      const reg = this.ensureCharacter(sessionKey, {
        name, kind: row.entity_type === 'protagonist' ? 'protagonist' : 'npc',
        operationId: createOp,
      });
      if (this.list(sessionKey).length > before) out.createdCharacters++;

      let payload: Record<string, unknown> = {};
      try {
        const v = JSON.parse(row.state_json ?? '{}') as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) payload = v as Record<string, unknown>;
      } catch { /* 坏行不猜内容 */ }
      const fields = Object.entries(payload).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'object' && Object.keys(v as object).length === 0));
      if (fields.length === 0) { out.skipped.push({ entityId, reason: '旧行无可迁移字段' }); continue; }

      const res = this.admit(sessionKey, {
        characterId: reg.characterId,
        changes: fields.map(([field, value]) => ({
          field, value, scope: 'fact' as const, factKind: 'fact' as const,
          // 无来源 → 待核对（不把推测升级为确认）
          status: 'pending' as const,
          effectiveAt: { round: row.updated_round },
          sourceRefs: opts.sourceRefs,
        })),
      }, {
        operationId: `migrate:${sessionKey}:${opts.batchId}:${key}:apply`,
        instanceId: opts.instanceId ?? `migrate:${sessionKey}`,
        historyEpoch: epoch,
        round: row.updated_round,
        sourceKind: 'migration',
        sourceRefs: opts.sourceRefs,
      });
      if (!res.ok) {
        out.skipped.push({ entityId, reason: `${res.error?.name ?? 'error'}: ${res.error?.message ?? ''}` });
        continue;
      }
      if (res.receipt.deduped) {
        // 重跑：原回执可读，但**不重复生效**（不得计入本次迁入）
        out.dedupedFields += res.applied.length;
        continue;
      }
      out.importedFields += res.applied.length;
      out.pendingFields += res.applied.length; // 迁入字段一律 pending，等待真实剧情证据确认
    }
    void hasSource;
    return out;
  }

  // ── 可选导出（§1.3 / T25） ──
  /**
   * 按 session + character 命名空间**只读导出**：写临时文件后原子替换。
   *
   * 三条硬约束（T25）：
   *  1. 导出失败**不能使权威状态回退** —— 本函数只读快照，任何异常都不改数据库；
   *  2. 导出文件**不得自动写回覆盖数据库** —— 本模块**不提供**从文件导入的入口；
   *  3. 导出内容记录所对应的数据库头与实体版本，陈旧文件无法冒充最新状态。
   */
  exportProjection(sessionKey: string, characterId: string, targetPath: string): {
    ok: boolean; path?: string; headRevision?: number; entityVersion?: number; historyEpoch?: number; error?: string;
  } {
    try {
      const p = this.readProjection(sessionKey, characterId);
      if (!p) return { ok: false, error: `人物 ${characterId} 无已提交投影（不导出空投影冒充已加载）` };
      const payload = {
        exportedAt: new Date().toISOString(),
        namespace: { sessionId: sessionKey, characterId },
        head: p.head,
        entityVersion: p.entityVersion,
        historyEpoch: p.scope.historyEpoch,
        projection: p,
      };
      const tmp = `${targetPath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, targetPath);
      return { ok: true, path: targetPath, headRevision: p.head.headRevision, entityVersion: p.entityVersion, historyEpoch: p.scope.historyEpoch };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '(空)';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  } catch { return String(v); }
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest * 0.4);
}

export { StateVersionConflictError };
