import { createHash } from 'node:crypto';
import type { NsfwSceneSelection } from './nsfw-scene-curator.ts';

export const NSFW_AGENT_GENERATOR_VERSION = 'nsfw-agent-generator-v1' as const;

export type NsfwAgentStateSource = 'none' | 'object' | 'json' | 'xml';
export type NsfwAgentVerdict = 'retrieve' | 'skip';
export type NsfwAgentReasonCode =
  | 'content-mode-not-nsfw'
  | 'structured-state-inactive'
  | 'structured-state-active'
  | 'structured-retrieval-requested'
  | 'prior-lock-active'
  | 'prior-event-active'
  | 'scanner-signal-active'
  | 'narrative-signal-active'
  | 'narrative-exit'
  | 'erotic-progress-active'
  | 'insufficient-scene-signal';

export interface NsfwAgentSystemPreset {
  readonly version: typeof NSFW_AGENT_GENERATOR_VERSION;
  readonly name: string;
  readonly role: 'system';
  readonly systemPrompt: string;
  readonly retrievalThreshold: number;
  readonly maxRetrievalQueryChars: number;
  readonly maxQueryHeadChars: number;
}

/**
 * Stable system-role contract for the generator. The current implementation is
 * deterministic and does not spend a Provider call, but the same contract can be
 * handed to a model-backed adapter without changing the preflight/compose API.
 */
export const NSFW_AGENT_SYSTEM_PRESET: NsfwAgentSystemPreset = Object.freeze({
  version: NSFW_AGENT_GENERATOR_VERSION,
  name: 'NSFW 场景检索与组装器',
  role: 'system',
  systemPrompt: [
    '你是主对话之前的 NSFW 场景检索与组装器。',
    '先依据结构化状态、剧情走向与角色状态判断本轮是否属于 NSFW 场景。',
    '非 NSFW 或信号不足时必须输出 skip，且不得请求向量检索、不得生成 query 头。',
    'NSFW 时只生成有界检索查询；召回后仅使用条目标签，不复制素材正文。',
    '角色报表是只读事实；不得改写角色身份、边界、年龄、同意状态或权威变量。',
    '最终只输出简练的场景摘要、角色状态摘要与向量方向，供主对话作为可选写作指导。',
  ].join('\n'),
  retrievalThreshold: 3,
  maxRetrievalQueryChars: 2_000,
  maxQueryHeadChars: 560,
});

export interface ParsedNsfwAgentState {
  readonly source: NsfwAgentStateSource;
  readonly active: boolean | null;
  readonly retrieval: 'required' | 'skip' | 'auto';
  readonly confidence: number | null;
  readonly scene: string;
  readonly phase: string;
  readonly participants: readonly string[];
}

export interface NsfwAgentPreflightInput {
  readonly contentMode: 'nsf' | 'nsfw';
  readonly round?: number;
  readonly currentInput: string;
  readonly currentScene?: string;
  /** JSON/XML text or an already parsed object emitted by the main dialogue. */
  readonly statePayload?: unknown;
  readonly priorNsfwLock?: { readonly locked: boolean; readonly round: number };
  readonly priorEventType?: string;
  /** Read-only reports emitted by character/NPC agents. */
  readonly characterReports?: readonly string[];
  /** Deterministic activation from an already completed ordinary worldbook scan. */
  readonly scannerSignal?: boolean;
  readonly eroticProgress?: number;
}

export interface NsfwAgentPreflight {
  readonly version: typeof NSFW_AGENT_GENERATOR_VERSION;
  readonly presetDigest: string;
  readonly verdict: NsfwAgentVerdict;
  readonly confidence: number;
  readonly reasonCodes: readonly NsfwAgentReasonCode[];
  readonly structuredState: ParsedNsfwAgentState;
  readonly sceneLabel: string;
  readonly characterSummary: string;
  /** Empty on every skip path. Calling an embedding/vector port then is a caller bug. */
  readonly retrievalQuery: string;
}

export interface NsfwAgentGenerator {
  readonly systemPreset: NsfwAgentSystemPreset;
  preflight(input: NsfwAgentPreflightInput): NsfwAgentPreflight;
  renderQueryHead(plan: NsfwAgentPreflight, selected: readonly NsfwSceneSelection[]): string;
}

interface MutableParsedState {
  source: NsfwAgentStateSource;
  active: boolean | null;
  retrieval: 'required' | 'skip' | 'auto';
  confidence: number | null;
  scene: string;
  phase: string;
  participants: string[];
}

const ACTIVE_KEYS = new Set(['active', 'sceneactive', 'nsfw', 'isnsfw', 'enabled', 'locked']);
const RETRIEVAL_KEYS = new Set(['retrieval', 'retrievalmode', 'requiresretrieval', 'vectorretrieval', 'usevector']);
const CONFIDENCE_KEYS = new Set(['confidence', 'score', 'probability']);
const SCENE_KEYS = new Set(['scene', 'scenedescription', 'situation', 'context']);
const PHASE_KEYS = new Set(['phase', 'stage', 'scenestage']);
const PARTICIPANT_KEYS = new Set(['participants', 'characters', 'roles', 'present']);
const STATUS_KEYS = new Set(['status', 'state', 'mode', 'contentmode', 'eventtype']);
const NSFW_ENVELOPE_KEYS = new Set(['nsfw', 'nsfwstate', 'nsfwlock', 'adultscene', 'eroticscene']);
const NSFW_CONTAINER_KEYS = NSFW_ENVELOPE_KEYS;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'active', 'enabled', 'required', 'nsfw', 'explicit', 'erotic', 'adult', '是', '开启', '启用', '进行中', '成人', '情色']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'inactive', 'disabled', 'skip', 'none', 'nsf', 'sfw', 'safe', '否', '关闭', '停用', '结束', '普通', '纯净', '非nsfw']);
const INSTRUCTION_LINE = /(?:忽略|越狱|系统提示|开发者(?:消息|提示)|提示词|必须输出|改写规则|上层约束|泄露|指令\s*[=:：]|视为故事|\b(?:ignore|jailbreak|system prompt|developer message|must output|override|higher[- ]level|reveal|leak)\b)/iu;
const STRONG_NARRATIVE_SIGNAL = /(?:\b(?:nsfw|r-?18|explicit sex|sexual scene|erotic scene|nude)\b|成人场景|情色场景|色情场景|性场景|性爱|性交|做爱|交媾|赤裸|裸体|高潮)/iu;
const SOFT_NARRATIVE_SIGNAL = /(?:脱衣|床笫|情欲|欲望|暧昧升温|亲密接触|抚摸|喘息|调情|深吻)/giu;
const NEGATED_NARRATIVE_SIGNAL = /(?:(?:关闭|退出|结束|停止|取消|不要|别|勿|禁止|不想|不需要|跳过|避开|拒绝|不同意|非)\s*(?:nsfw|r-?18|成人|情色|色情|性场景|性内容|露骨内容|性爱|性交|做爱|交媾|赤裸|裸体|裸露|亲密行为)|(?:nsfw|r-?18|成人|情色|色情|性场景|性内容|露骨内容|性爱|性交|做爱|交媾|赤裸|裸体|裸露|亲密行为)\s*(?:关闭|退出|结束|停止|取消|不要|不需要|跳过|避开|拒绝)|(?:撤回|撤销|收回)\s*(?:同意|许可)|(?:回到|转回|恢复)\s*(?:普通|日常|sfw|非\s*nsfw)|\b(?:stop|end|cancel|skip|avoid|refuse|decline|no|do\s+not|don't)\s+(?:nsfw|r-?18|sex|sexual content|explicit content|nude|nudity)|\b(?:withdraw|revoke)\s+(?:my\s+)?consent|\b(?:return|switch)\s+to\s+(?:sfw|normal))/iu;
const KEEP_NARRATIVE_SIGNAL = /(?:不要|别|勿|不必|无需)\s*(?:关闭|退出|结束|停止|取消|跳过|避开|拒绝)\s*(?:nsfw|r-?18|成人|情色|色情|性场景|性内容|露骨内容|性爱|性交|做爱|交媾|赤裸|裸体|裸露|亲密行为)?/giu;
const KEEP_NARRATIVE_SIGNAL_EN = /\b(?:do\s+not|don't)\s+(?:stop|end|exit|cancel|skip|avoid)\s+(?:nsfw|r-?18|sex|sexual content|explicit content|nude|nudity)/giu;
const DECLINE_NARRATIVE_SIGNAL = /(?:(?:不要|别|不想|停止|取消|跳过|避开|拒绝|不同意)\s*(?:继续|进入|开启|进行)\s*(?:nsfw|r-?18|成人|情色|色情|性场景|性内容|露骨内容|性爱|性交|做爱|交媾|赤裸|裸体|裸露|亲密行为)|\b(?:do\s+not|don't|refuse\s+to|decline\s+to)\s+(?:continue|start|enter)\s+(?:nsfw|r-?18|sex|sexual content|explicit content))/iu;
const TERSE_WITHDRAWAL_SIGNAL = /(?:^|[\s，。！？；,.!?;])(?:停下(?:来)?|住手|不行|不要|够了|我?不同意|我?拒绝|stop|no|i\s+refuse|i\s+do\s+not\s+consent|i\s+don't\s+consent)(?=$|[\s，。！？；,.!?;])/iu;
const META_NARRATIVE_SIGNAL = /(?:(?:如何|怎么|设置|配置|功能|agent|向量|数据库|提示词).{0,24}\bnsfw\b|\bnsfw\b.{0,24}(?:agent|功能|设置|配置|向量|提示词))/iu;
const STATE_XML = /<(nsfw(?:[-_:]?state)?)(?:\s[^>]*)?>[\s\S]{0,8000}?<\/\1>/giu;
const JSON_FENCE = /```(?:json)?\s*([\s\S]{1,8000}?)```/giu;
const STATE_JSON_BODY = /<(?:nsfw[-_:]?state|nsfw)(?:\s[^>]*)?>\s*([\[{][\s\S]{1,8000}?[\]}])\s*<\/(?:nsfw[-_:]?state|nsfw)>/giu;
const MAX_STATE_NODES = 128;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function keyOf(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('und').replace(/[\s_.:-]+/gu, '');
}

function compactText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

function compactStateText(value: unknown, maxChars: number): string {
  const text = compactText(value, maxChars);
  return text && !INSTRUCTION_LINE.test(text) ? text : '';
}

function boolValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value !== 'string') return null;
  const normalized = keyOf(value);
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

function retrievalValue(value: unknown): MutableParsedState['retrieval'] | null {
  if (typeof value === 'boolean') return value ? 'required' : 'skip';
  if (typeof value !== 'string') return null;
  const normalized = keyOf(value);
  if (['required', 'require', 'retrieve', 'vector', 'yes', 'true', '需要', '检索'].includes(normalized)) return 'required';
  if (['skip', 'off', 'none', 'false', 'no', '跳过', '关闭'].includes(normalized)) return 'skip';
  if (['auto', 'automatic', '自动'].includes(normalized)) return 'auto';
  return null;
}

function mergeActive(state: MutableParsedState, active: boolean | null): void {
  if (active === false) state.active = false;
  else if (active === true && state.active !== false) state.active = true;
}

function mergeRetrieval(
  state: MutableParsedState,
  retrieval: MutableParsedState['retrieval'] | null,
): void {
  if (retrieval === 'skip') state.retrieval = 'skip';
  else if (retrieval === 'required' && state.retrieval !== 'skip') state.retrieval = 'required';
}

function addParticipants(target: string[], value: unknown): void {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、|]/u) : [];
  for (const item of raw) {
    const text = compactStateText(item, 80);
    if (text && !target.includes(text)) target.push(text);
    if (target.length >= 12) break;
  }
}

function applyKnownField(state: MutableParsedState, rawKey: string, value: unknown): void {
  const key = keyOf(rawKey);
  if (ACTIVE_KEYS.has(key)) {
    mergeActive(state, boolValue(value));
    return;
  }
  if (STATUS_KEYS.has(key)) {
    mergeActive(state, boolValue(value));
    return;
  }
  if (RETRIEVAL_KEYS.has(key)) {
    mergeRetrieval(state, retrievalValue(value));
    return;
  }
  if (CONFIDENCE_KEYS.has(key)) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) state.confidence = clamp(numeric > 1 ? numeric / 100 : numeric, 0, 1);
    return;
  }
  if (SCENE_KEYS.has(key) && !state.scene) state.scene = compactStateText(value, 240);
  if (PHASE_KEYS.has(key) && !state.phase) state.phase = compactStateText(value, 80);
  if (PARTICIPANT_KEYS.has(key)) addParticipants(state.participants, value);
}

function applyMainDialoguePlan(state: MutableParsedState, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const plan = value as Record<string, unknown>;
  const eventTypeEntry = Object.entries(plan).find(([key]) => keyOf(key) === 'eventtype');
  const lockEntry = Object.entries(plan).find(([key]) => keyOf(key) === 'nsfwlock');
  const eventType = typeof eventTypeEntry?.[1] === 'string' ? keyOf(eventTypeEntry[1]) : '';
  const eventActive = eventType === 'nsfw'
    ? true
    : ['normal', 'fused', 'shadow', 'nsf', 'sfw'].includes(eventType) ? false : null;
  let lockActive: boolean | null = null;
  if (lockEntry?.[1] && typeof lockEntry[1] === 'object' && !Array.isArray(lockEntry[1])) {
    const lockedEntry = Object.entries(lockEntry[1] as Record<string, unknown>)
      .find(([key]) => keyOf(key) === 'locked');
    if (lockedEntry) lockActive = boolValue(lockedEntry[1]);
  }
  // Conflicting producers fail closed: any explicit inactive value wins.
  mergeActive(state, eventActive);
  mergeActive(state, lockActive);
}

function applyObject(state: MutableParsedState, value: unknown, trustedRoot: boolean): void {
  const stack: Array<{ value: unknown; depth: number; nsfwScope: boolean }> = [
    { value, depth: 0, nsfwScope: trustedRoot },
  ];
  const seen = new Set<object>();
  let nodes = 0;
  while (stack.length > 0 && nodes < MAX_STATE_NODES) {
    const current = stack.shift()!;
    if (!current.value || typeof current.value !== 'object' || current.depth > 5) continue;
    if (seen.has(current.value as object)) continue;
    seen.add(current.value as object);
    nodes++;
    if (Array.isArray(current.value)) {
      for (const child of current.value.slice(0, 24)) {
        stack.push({ value: child, depth: current.depth + 1, nsfwScope: current.nsfwScope });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>).slice(0, 48)) {
      const normalizedKey = keyOf(key);
      if (normalizedKey === 'plan') {
        applyMainDialoguePlan(state, child);
        continue;
      }
      const startsEnvelope = NSFW_CONTAINER_KEYS.has(normalizedKey);
      if (current.nsfwScope || startsEnvelope) applyKnownField(state, key, child);
      // A trusted payload may use direct root fields, but unrelated nested task
      // objects do not inherit that trust. Only an explicit NSFW envelope does.
      const nextNsfwScope = startsEnvelope || (current.nsfwScope && current.depth > 0);
      if (child && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1, nsfwScope: nextNsfwScope });
      }
    }
  }
}

function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length <= 8_000 && (/^\{[\s\S]*\}$/u.test(trimmed) || /^\[[\s\S]*\]$/u.test(trimmed))) {
    candidates.push(trimmed);
  }
  for (const match of text.matchAll(JSON_FENCE)) {
    if (match[1]) candidates.push(match[1].trim());
    if (candidates.length >= 4) break;
  }
  for (const match of text.matchAll(STATE_JSON_BODY)) {
    if (match[1]) candidates.push(match[1].trim());
    if (candidates.length >= 6) break;
  }
  return candidates;
}

function xmlDataOnly(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, ' ');
}

function applyXml(state: MutableParsedState, xml: string): void {
  const dataXml = xmlDataOnly(xml);
  const openTag = /^<[^>]+>/u.exec(dataXml)?.[0] ?? '';
  for (const match of openTag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*["']([^"']{0,500})["']/gu)) {
    applyKnownField(state, match[1] ?? '', match[2]);
  }
  const knownTags: ReadonlyArray<readonly [string, string]> = [
    ['active', 'active'], ['scene_active', 'active'], ['scene-active', 'active'], ['is_nsfw', 'nsfw'],
    ['status', 'status'], ['state', 'state'], ['mode', 'mode'], ['content_mode', 'contentmode'],
    ['retrieval', 'retrieval'], ['retrieval_mode', 'retrievalmode'],
    ['requires_retrieval', 'requiresretrieval'], ['vector_retrieval', 'vectorretrieval'],
    ['confidence', 'confidence'], ['score', 'score'], ['probability', 'probability'],
    ['scene', 'scene'], ['scene_description', 'scenedescription'], ['situation', 'situation'],
    ['phase', 'phase'], ['stage', 'stage'], ['scene_stage', 'scenestage'],
    ['participants', 'participants'], ['characters', 'characters'], ['roles', 'roles'], ['present', 'present'],
  ];
  for (const [tag, field] of knownTags) {
    const tagPattern = new RegExp(`<${tag}[^>]*>([\\s\\S]{0,1000}?)<\\/${tag}>`, 'giu');
    for (const match of dataXml.matchAll(tagPattern)) {
      const value = match[1] ?? '';
      if (PARTICIPANT_KEYS.has(keyOf(field)) && /<[^>]+>/u.test(value)) continue;
      applyKnownField(state, field, value);
    }
  }
  for (const match of dataXml.matchAll(/<(?:participant|character|role|人物|角色)[^>]*>([^<]{1,100})<\/(?:participant|character|role|人物|角色)>/giu)) {
    addParticipants(state.participants, match[1]);
  }
}

/** Parse only a bounded, allow-listed NSFW state surface. Arbitrary fields never become instructions. */
export function parseNsfwAgentState(payload: unknown, trustedEnvelope = false): ParsedNsfwAgentState {
  const state: MutableParsedState = {
    source: 'none', active: null, retrieval: 'auto', confidence: null,
    scene: '', phase: '', participants: [],
  };
  if (payload && typeof payload === 'object') {
    state.source = 'object';
    applyObject(state, payload, trustedEnvelope);
  } else if (typeof payload === 'string' && payload.length <= 32_000) {
    for (const candidate of jsonCandidates(payload)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown> : null;
        const plan = root?.plan;
        const hasPlanState = Boolean(plan && typeof plan === 'object' && !Array.isArray(plan)
          && Object.keys(plan as Record<string, unknown>)
            .some((key) => ['eventtype', 'nsfwlock'].includes(keyOf(key))));
        const hasEnvelope = Boolean(root
          && (Object.keys(root).some((key) => NSFW_ENVELOPE_KEYS.has(keyOf(key))) || hasPlanState));
        if (trustedEnvelope || hasEnvelope) {
          applyObject(state, parsed, trustedEnvelope || hasEnvelope);
          state.source = 'json';
          break;
        }
      } catch { /* keep looking for a valid bounded state envelope */ }
    }
    if (state.source !== 'json') {
      const xmlBlocks = [...xmlDataOnly(payload).matchAll(STATE_XML)].slice(0, 3);
      if (state.source === 'none' && xmlBlocks.length > 0) state.source = 'xml';
      for (const match of xmlBlocks) if (match[0]) applyXml(state, match[0]);
    }
  }
  return Object.freeze({
    ...state,
    participants: Object.freeze(state.participants),
  });
}

function identityToken(value: string): string {
  return compactText(value, 100).toLocaleLowerCase('und');
}

function reportIdentityTokens(line: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  const add = (value: string): void => {
    const token = identityToken(value);
    if (token) tokens.add(token);
  };
  const factHeader = /^【([^】]{1,240})】/u.exec(line)?.[1];
  if (factHeader) {
    const [stableId = '', names = ''] = factHeader.split('|', 2);
    add(stableId);
    const mainName = names.replace(/\([^)]*\)$/u, '');
    add(mainName);
    const aliases = /\(([^)]*)\)$/u.exec(names)?.[1] ?? '';
    for (const alias of aliases.split('/')) add(alias);
  }
  const squareId = /\[([A-Za-z0-9][A-Za-z0-9._:/-]{0,120}(?:@v\d+)?)\]/u.exec(line)?.[1];
  if (squareId) {
    add(squareId);
    add(squareId.replace(/@v\d+$/u, ''));
    const prefixName = /^(.{1,100}?)\s+\[/u.exec(line)?.[1] ?? '';
    add(prefixName);
  }
  const labeledName = /^([^=:：【\[\]]{1,80}?)\s*[=:：]/u.exec(line)?.[1];
  if (labeledName) add(labeledName);
  return tokens;
}

function summarizeCharacterReports(reports: readonly string[], participants: readonly string[]): string {
  const lines: string[] = [];
  const participantKeys = participants
    .map(identityToken)
    .filter(Boolean);
  for (const report of reports.slice(0, 8)) {
    if (typeof report !== 'string') continue;
    const withoutTags = report.replace(/<[^>]{1,240}>/gu, ' ');
    for (const rawLine of withoutTags.split(/[\r\n]+/u)) {
      const line = compactText(rawLine.replace(/^[-*•]\s*/u, ''), 140);
      if (!line || INSTRUCTION_LINE.test(line)) continue;
      if (!/[=:：@]/u.test(line)) continue;
      if (participantKeys.length > 0) {
        const identities = reportIdentityTokens(line);
        if (!participantKeys.some((participant) => identities.has(participant))) continue;
      }
      if (!lines.includes(line)) lines.push(line);
      if (lines.length >= 10) break;
    }
    if (lines.length >= 10) break;
  }
  return lines.join('；').slice(0, 720);
}

function stripEmbeddedStateArtifacts(value: string): string {
  let text = value.replace(STATE_XML, ' ').replace(JSON_FENCE, ' ');
  const trimmed = text.trim();
  if (trimmed.length <= 8_000 && (/^\{[\s\S]*\}$/u.test(trimmed) || /^\[[\s\S]*\]$/u.test(trimmed))) {
    try {
      JSON.parse(trimmed);
      text = '';
    } catch { /* ordinary prose that merely resembles JSON remains available */ }
  }
  return text;
}

function composeRetrievalQuery(input: {
  readonly narrative: string;
  readonly scene: string;
  readonly phase: string;
  readonly participants: readonly string[];
  readonly characterSummary: string;
}, maxChars: number): string {
  // Reserve a segment for the latest turn and put it first so secondary state
  // can never crowd the user's current direction out of the embedding query.
  const lines = [
    input.narrative ? `本轮走向：${input.narrative.slice(0, 720)}` : '',
    input.scene ? `场景：${input.scene.slice(0, 240)}` : '',
    input.participants.length > 0 ? `参与者：${input.participants.join('、').slice(0, 240)}` : '',
    input.characterSummary ? `角色状态：${input.characterSummary.slice(0, 520)}` : '',
    input.phase ? `阶段：${input.phase.slice(0, 80)}` : '',
  ].filter(Boolean);
  return (lines.join('\n') || '场景：已确认的成人场景').slice(0, maxChars);
}

function narrativeScore(text: string): { score: number; active: boolean; explicitExit: boolean } {
  const exitText = text.replace(KEEP_NARRATIVE_SIGNAL, ' ').replace(KEEP_NARRATIVE_SIGNAL_EN, ' ');
  const explicitExit = Boolean(text && (
    NEGATED_NARRATIVE_SIGNAL.test(exitText)
    || DECLINE_NARRATIVE_SIGNAL.test(exitText)
    || TERSE_WITHDRAWAL_SIGNAL.test(exitText)
  ));
  if (!text || explicitExit || META_NARRATIVE_SIGNAL.test(text)) {
    return { score: 0, active: false, explicitExit };
  }
  let score = STRONG_NARRATIVE_SIGNAL.test(text) ? 3 : 0;
  const soft = [...text.matchAll(SOFT_NARRATIVE_SIGNAL)].length;
  score += Math.min(2, soft);
  return { score, active: score >= 2, explicitExit: false };
}

function orderedReasons(reasons: Iterable<NsfwAgentReasonCode>): readonly NsfwAgentReasonCode[] {
  const order: readonly NsfwAgentReasonCode[] = [
    'content-mode-not-nsfw', 'structured-state-inactive', 'structured-state-active',
    'structured-retrieval-requested', 'prior-lock-active', 'prior-event-active', 'scanner-signal-active',
    'narrative-signal-active', 'narrative-exit', 'erotic-progress-active', 'insufficient-scene-signal',
  ];
  const present = new Set(reasons);
  return Object.freeze(order.filter((reason) => present.has(reason)));
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function validatePreset(preset: NsfwAgentSystemPreset): void {
  if (preset.version !== NSFW_AGENT_GENERATOR_VERSION || preset.role !== 'system'
    || typeof preset.name !== 'string' || preset.name.length < 1 || preset.name.length > 120
    || typeof preset.systemPrompt !== 'string' || preset.systemPrompt.length < 1 || preset.systemPrompt.length > 8_000
    || !Number.isFinite(preset.retrievalThreshold) || preset.retrievalThreshold < 1 || preset.retrievalThreshold > 20
    || !Number.isSafeInteger(preset.maxRetrievalQueryChars) || preset.maxRetrievalQueryChars < 200 || preset.maxRetrievalQueryChars > 4_000
    || !Number.isSafeInteger(preset.maxQueryHeadChars) || preset.maxQueryHeadChars < 200 || preset.maxQueryHeadChars > 2_000) {
    throw new TypeError('nsfw agent system preset is invalid');
  }
}

export function createNsfwAgentGenerator(
  preset: NsfwAgentSystemPreset = NSFW_AGENT_SYSTEM_PRESET,
): NsfwAgentGenerator {
  validatePreset(preset);
  const frozenPreset = Object.freeze({ ...preset });
  const presetDigest = digest(JSON.stringify(frozenPreset));

  return Object.freeze({
    systemPreset: frozenPreset,
    preflight(input: NsfwAgentPreflightInput): NsfwAgentPreflight {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || (input.contentMode !== 'nsf' && input.contentMode !== 'nsfw')
        || typeof input.currentInput !== 'string' || input.currentInput.length > 100_000
        || (input.currentScene !== undefined && typeof input.currentScene !== 'string')
        || (input.characterReports !== undefined && (!Array.isArray(input.characterReports)
          || input.characterReports.length > 16 || input.characterReports.some((report) => typeof report !== 'string')))) {
        throw new TypeError('nsfw agent preflight input is invalid');
      }
      const structuredState = parseNsfwAgentState(
        input.statePayload,
        input.statePayload !== undefined,
      );
      const reports = input.characterReports ?? [];
      const characterSummary = summarizeCharacterReports(reports, structuredState.participants);
      const sceneLabel = compactStateText(structuredState.scene || input.currentScene || '', 240);
      const reasons: NsfwAgentReasonCode[] = [];
      let score = 0;

      if (input.contentMode !== 'nsfw') reasons.push('content-mode-not-nsfw');
      if (structuredState.active === false || structuredState.retrieval === 'skip') {
        reasons.push('structured-state-inactive');
      }
      if (structuredState.active === true) { score += 5; reasons.push('structured-state-active'); }
      if (structuredState.retrieval === 'required') { score += 5; reasons.push('structured-retrieval-requested'); }
      const lockRound = input.priorNsfwLock?.round;
      const priorLockActive = input.priorNsfwLock?.locked === true
        && Number.isSafeInteger(input.round) && Number(input.round) >= 0
        && Number.isSafeInteger(lockRound) && Number(lockRound) >= 0
        && Number(input.round) - Number(lockRound) >= 0
        && Number(input.round) - Number(lockRound) <= 3;
      if (priorLockActive) { score += 4; reasons.push('prior-lock-active'); }
      if (keyOf(input.priorEventType ?? '') === 'nsfw') { score += 3; reasons.push('prior-event-active'); }
      if (input.scannerSignal === true) { score += 2; reasons.push('scanner-signal-active'); }
      const narrativeSource = stripEmbeddedStateArtifacts(input.currentInput);
      const narrative = narrativeScore(`${sceneLabel}\n${narrativeSource}`);
      if (narrative.active) { score += narrative.score; reasons.push('narrative-signal-active'); }
      if (narrative.explicitExit) reasons.push('narrative-exit');
      const eroticProgress = Number.isFinite(input.eroticProgress) ? clamp(input.eroticProgress as number, 0, 100) : 0;
      if (eroticProgress >= 60) { score += 2; reasons.push('erotic-progress-active'); }
      else if (eroticProgress >= 30) { score += 1; reasons.push('erotic-progress-active'); }

      const hardSkip = input.contentMode !== 'nsfw'
        || structuredState.active === false
        || structuredState.retrieval === 'skip'
        // The current user's explicit stop/withdrawal wins over stale or
        // inconsistent structured activation and prior-turn locks.
        || narrative.explicitExit;
      const verdict: NsfwAgentVerdict = !hardSkip && score >= frozenPreset.retrievalThreshold ? 'retrieve' : 'skip';
      if (verdict === 'skip' && reasons.length === 0) reasons.push('insufficient-scene-signal');
      else if (verdict === 'skip' && !hardSkip && score < frozenPreset.retrievalThreshold) {
        reasons.push('insufficient-scene-signal');
      }
      const confidence = verdict === 'retrieve'
        ? clamp(structuredState.confidence ?? score / 8, 0, 1)
        : clamp(structuredState.confidence ?? 1 - score / 8, 0, 1);
      const narrativeInput = compactText(narrativeSource, 900);
      const retrievalQuery = verdict === 'retrieve' ? composeRetrievalQuery({
        narrative: narrativeInput,
        scene: sceneLabel,
        phase: structuredState.phase,
        participants: structuredState.participants,
        characterSummary,
      }, frozenPreset.maxRetrievalQueryChars) : '';
      return Object.freeze({
        version: NSFW_AGENT_GENERATOR_VERSION,
        presetDigest,
        verdict,
        confidence: Number(confidence.toFixed(4)),
        reasonCodes: orderedReasons(reasons),
        structuredState,
        sceneLabel,
        characterSummary,
        retrievalQuery,
      });
    },
    renderQueryHead(plan: NsfwAgentPreflight, selected: readonly NsfwSceneSelection[]): string {
      if (plan.verdict !== 'retrieve' || selected.length === 0) return '';
      const directions = selected.slice(0, 4).map((entry) => entry.tags.join(' / ')).filter(Boolean).join('；');
      if (!directions) return '';
      const participants = plan.structuredState.participants.slice(0, 4)
        .map((participant) => participant.slice(0, 24)).join('、');
      const sceneParts = [
        plan.sceneLabel.slice(0, 100),
        plan.structuredState.phase ? `阶段=${plan.structuredState.phase.slice(0, 32)}` : '',
        participants ? `参与者=${participants}` : '',
      ].filter(Boolean).join('；').slice(0, 180) || '沿用当前上下文';
      const body = [
        `场景摘要：${escapeXml(sceneParts)}`,
        `向量方向：${escapeXml(directions.slice(0, 120))}`,
        plan.characterSummary ? `角色状态：${escapeXml(plan.characterSummary.slice(0, 100))}` : '',
        '仅作本轮参考；服从角色事实、玩家边界与同意条件。',
      ].filter(Boolean).join('；');
      const open = `<NSFW生成指导 preset="${NSFW_AGENT_GENERATOR_VERSION}">`;
      const close = '</NSFW生成指导>';
      const head = `${open}${body}${close}`;
      if (head.length <= frozenPreset.maxQueryHeadChars) return head;
      const available = frozenPreset.maxQueryHeadChars - open.length - close.length - 1;
      let boundedBody = body.slice(0, Math.max(0, available));
      // Do not cut an escaped entity such as `&amp;` in half.
      if (boundedBody.lastIndexOf('&') > boundedBody.lastIndexOf(';')) {
        boundedBody = boundedBody.slice(0, boundedBody.lastIndexOf('&'));
      }
      return `${open}${boundedBody}…${close}`;
    },
  });
}

export const defaultNsfwAgentGenerator = createNsfwAgentGenerator();
