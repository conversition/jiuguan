import { createHash } from 'node:crypto';

export const WORLDBOOK_CONFLICT_EVIDENCE_VERSION = 'worldbook-conflict-evidence-v1' as const;
export const WORLDBOOK_CONFLICT_LIMITS = Object.freeze({ entries: 64, claimsPerSource: 32, totalClaims: 512,
  entryChars: 4_096, userChars: 4_096, proseChars: 8_192, memoryItems: 16, memoryChars: 2_048,
  totalChars: 49_152 });

export type WorldbookConflictType = 'entity-attribute' | 'time-location' | 'rule-mutual-exclusion' | 'unknown';
export type WorldbookConflictConfidence = 'high' | 'medium' | 'low';
export type WorldbookConflictVerdict = 'conflict' | 'none' | 'unknown';
type BaseClaim = { readonly confidence: WorldbookConflictConfidence };
export type PublicWorldbookClaimProjection = BaseClaim & (
  { readonly kind: 'entity-attribute'; readonly entityId: string; readonly attributeId: string; readonly valueDigest: string }
  | { readonly kind: 'time-location'; readonly entityId: string; readonly timeScopeId: string; readonly locationDigest: string }
  | { readonly kind: 'exclusive-rule'; readonly scopeId: string; readonly ruleId: string; readonly polarity: 'allow' | 'deny' }
);
export interface PublicEvidenceSourceProjection {
  readonly publicText?: string;
  readonly textDigest?: string;
  readonly claims?: readonly PublicWorldbookClaimProjection[];
}
export interface ActiveWorldbookEntryProjection extends PublicEvidenceSourceProjection {
  readonly entryId: string;
  readonly activated: true;
  readonly playerVisible: true;
}
export interface WorldbookConflictDetectorInput {
  readonly entries: readonly ActiveWorldbookEntryProjection[];
  readonly userInput: PublicEvidenceSourceProjection;
  readonly finalProse: PublicEvidenceSourceProjection;
  readonly publicMemoryDelta: readonly PublicEvidenceSourceProjection[];
}
export interface WorldbookConflictEvidenceItem {
  readonly entryIds: readonly string[];
  readonly conflictType: WorldbookConflictType;
  readonly summaryDigest: string;
  readonly confidence: WorldbookConflictConfidence;
  readonly evidenceDigest: string;
  readonly noveltyKey: string;
  readonly hardSignal: boolean;
}
export interface WorldbookConflictEvidence {
  readonly evidenceVersion: typeof WORLDBOOK_CONFLICT_EVIDENCE_VERSION;
  readonly verdict: WorldbookConflictVerdict;
  readonly hardSignal: boolean;
  readonly conflictCount: number;
  readonly evidence: readonly WorldbookConflictEvidenceItem[];
  readonly evidenceSetDigest: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HEDGE = /(?:也许|或许|可能|似乎|好像|大概|据说|传闻|猜测|不确定|maybe|perhaps|possibly|seems?|apparently|rumou?red)/iu;
const RANK: Readonly<Record<WorldbookConflictConfidence, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });
const SOURCE_KEYS = ['publicText', 'textDigest', 'claims'] as const;
const CLAIM_KEYS: Readonly<Record<PublicWorldbookClaimProjection['kind'], readonly string[]>> = Object.freeze({
  'entity-attribute': ['kind', 'entityId', 'attributeId', 'valueDigest', 'confidence'],
  'time-location': ['kind', 'entityId', 'timeScopeId', 'locationDigest', 'confidence'],
  'exclusive-rule': ['kind', 'scopeId', 'ruleId', 'polarity', 'confidence'],
});

function hash(value: string): string { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function canon(value: unknown): string {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canon(item)}`).join(',')}}`;
  throw new TypeError('unsupported canonical value');
}
function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object`);
}
function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const bad = Object.keys(value).find((key) => !keys.includes(key));
  if (bad) throw new TypeError(`${label} contains unsupported field: ${bad}`);
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${label} must be a stable opaque ID`);
  return value.normalize('NFC');
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${label} must be a lowercase sha256 digest`);
  return value;
}
function confidence(value: unknown, label: string): WorldbookConflictConfidence {
  if (value !== 'high' && value !== 'medium' && value !== 'low') throw new TypeError(`${label} must be a confidence bucket`);
  return value;
}
function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\r\n?/gu, '\n').replace(/[\t\u00a0 ]+/gu, ' ').trim();
}
export function computePublicEvidenceTextDigest(text: string): string { return hash(normalizeText(text)); }

function parseClaim(value: unknown, label: string): PublicWorldbookClaimProjection {
  record(value, label);
  const kind = value.kind;
  if (kind !== 'entity-attribute' && kind !== 'time-location' && kind !== 'exclusive-rule') throw new TypeError(`${label}.kind is unsupported`);
  only(value, CLAIM_KEYS[kind], label);
  const base = { kind, confidence: confidence(value.confidence, `${label}.confidence`) };
  if (kind === 'entity-attribute') return Object.freeze({ ...base, kind,
    entityId: id(value.entityId, `${label}.entityId`), attributeId: id(value.attributeId, `${label}.attributeId`),
    valueDigest: digest(value.valueDigest, `${label}.valueDigest`) });
  if (kind === 'time-location') return Object.freeze({ ...base, kind,
    entityId: id(value.entityId, `${label}.entityId`), timeScopeId: id(value.timeScopeId, `${label}.timeScopeId`),
    locationDigest: digest(value.locationDigest, `${label}.locationDigest`) });
  if (value.polarity !== 'allow' && value.polarity !== 'deny') throw new TypeError(`${label}.polarity is unsupported`);
  return Object.freeze({ ...base, kind, scopeId: id(value.scopeId, `${label}.scopeId`),
    ruleId: id(value.ruleId, `${label}.ruleId`), polarity: value.polarity });
}

interface Source extends PublicEvidenceSourceProjection { readonly textDigest: string; readonly claims: readonly PublicWorldbookClaimProjection[] }
function parseSource(value: unknown, label: string, maxChars: number, entry = false): Source {
  record(value, label);
  only(value, entry ? ['entryId', 'activated', 'playerVisible', ...SOURCE_KEYS] : SOURCE_KEYS, label);
  if (value.publicText !== undefined && typeof value.publicText !== 'string') throw new TypeError(`${label}.publicText must be a string`);
  const publicText = value.publicText === undefined ? undefined : normalizeText(value.publicText);
  if (publicText !== undefined && (publicText.length === 0 || publicText.length > maxChars)) throw new TypeError(`${label}.publicText exceeds its limit`);
  const providedDigest = value.textDigest === undefined ? undefined : digest(value.textDigest, `${label}.textDigest`);
  const textDigest = publicText === undefined ? providedDigest : computePublicEvidenceTextDigest(publicText);
  if (publicText !== undefined && providedDigest !== undefined && providedDigest !== textDigest) throw new TypeError(`${label}.textDigest mismatches publicText`);
  if (value.claims !== undefined && !Array.isArray(value.claims)) throw new TypeError(`${label}.claims must be an array`);
  const raw = value.claims ?? [];
  if (raw.length > WORLDBOOK_CONFLICT_LIMITS.claimsPerSource) throw new TypeError(`${label}.claims exceeds its limit`);
  const claims = Object.freeze(raw.map((claim, index) => parseClaim(claim, `${label}.claims[${index}]`)));
  if (!textDigest && claims.length === 0) throw new TypeError(`${label} has no public evidence`);
  return Object.freeze({ ...(publicText === undefined ? {} : { publicText }), textDigest: textDigest ?? hash(canon(claims)), claims });
}

function parseInput(value: unknown): WorldbookConflictDetectorInput {
  record(value, 'input');
  only(value, ['entries', 'userInput', 'finalProse', 'publicMemoryDelta'], 'input');
  if (!Array.isArray(value.entries) || value.entries.length > WORLDBOOK_CONFLICT_LIMITS.entries) throw new TypeError('entries exceeds its limit');
  const seen = new Set<string>();
  const entries = value.entries.map((item, index) => {
    record(item, `entries[${index}]`);
    if (item.activated !== true || item.playerVisible !== true) throw new TypeError(`entries[${index}] must be activated and player-visible`);
    const entryId = id(item.entryId, `entries[${index}].entryId`);
    if (seen.has(entryId)) throw new TypeError('entry IDs must be unique');
    seen.add(entryId);
    return Object.freeze({ ...parseSource(item, `entries[${index}]`, WORLDBOOK_CONFLICT_LIMITS.entryChars, true),
      entryId, activated: true as const, playerVisible: true as const });
  }).sort((a, b) => a.entryId.localeCompare(b.entryId));
  const userInput = parseSource(value.userInput, 'userInput', WORLDBOOK_CONFLICT_LIMITS.userChars);
  const finalProse = parseSource(value.finalProse, 'finalProse', WORLDBOOK_CONFLICT_LIMITS.proseChars);
  if (!Array.isArray(value.publicMemoryDelta) || value.publicMemoryDelta.length > WORLDBOOK_CONFLICT_LIMITS.memoryItems) throw new TypeError('publicMemoryDelta exceeds its limit');
  const publicMemoryDelta = value.publicMemoryDelta.map((item, index) => parseSource(item, `publicMemoryDelta[${index}]`, WORLDBOOK_CONFLICT_LIMITS.memoryChars));
  const sources = [...entries, userInput, finalProse, ...publicMemoryDelta];
  if (sources.reduce((sum, source) => sum + (source.publicText?.length ?? 0), 0) > WORLDBOOK_CONFLICT_LIMITS.totalChars) throw new TypeError('total public text exceeds its limit');
  if (sources.reduce((sum, source) => sum + source.claims.length, 0) > WORLDBOOK_CONFLICT_LIMITS.totalClaims) throw new TypeError('total claims exceeds its limit');
  return Object.freeze({ entries: Object.freeze(entries), userInput, finalProse,
    publicMemoryDelta: Object.freeze(publicMemoryDelta) });
}

export const WorldbookConflictDetectorInputSchema = Object.freeze({
  parse: parseInput,
  safeParse(value: unknown) {
    try { return Object.freeze({ success: true as const, data: parseInput(value) }); }
    catch (error) { return Object.freeze({ success: false as const,
      error: error instanceof TypeError ? error : new TypeError('invalid worldbook conflict input') }); }
  },
});

type CandidateType = Exclude<WorldbookConflictType, 'unknown'>;
type SourceKind = 'entry' | 'user-input' | 'final-prose' | 'memory-delta';
interface Claim { type: CandidateType; key: string; value: string; confidence: WorldbookConflictConfidence;
  sourceKind: SourceKind; sourceDigest: string; entryId: string | null }
function token(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim(); }
function floor(a: WorldbookConflictConfidence, b: WorldbookConflictConfidence): WorldbookConflictConfidence { return RANK[a] <= RANK[b] ? a : b; }
function textConfidence(value: string): WorldbookConflictConfidence { return HEDGE.test(value) ? 'low' : 'high'; }

function projected(claim: PublicWorldbookClaimProjection, sourceKind: SourceKind, sourceDigest: string, entryId: string | null): Claim {
  if (claim.kind === 'entity-attribute') return { type: claim.kind, key: canon([claim.entityId, claim.attributeId]),
    value: claim.valueDigest, confidence: claim.confidence, sourceKind, sourceDigest, entryId };
  if (claim.kind === 'time-location') return { type: claim.kind, key: canon([claim.entityId, claim.timeScopeId]),
    value: claim.locationDigest, confidence: claim.confidence, sourceKind, sourceDigest, entryId };
  return { type: 'rule-mutual-exclusion', key: canon([claim.scopeId, claim.ruleId]), value: claim.polarity,
    confidence: claim.confidence, sourceKind, sourceDigest, entryId };
}

function fromText(statement: string, sourceKind: SourceKind, sourceDigest: string, entryId: string | null): Claim | null {
  const location = statement.match(/^(?:(现在|当前|此时|第[\p{N}一二三四五六七八九十百]+(?:天|日|轮|章|幕))\s*[,，:]?\s*)?([\p{L}\p{N}_·.-]{1,40})\s*(?:(当前|现在|此时)\s*)?(?:位于|身处|所在地(?:是|为)|位置(?:是|为))\s*(.{1,64})$/u);
  if (location) {
    const rawTime = token(location[1] ?? location[3] ?? 'unspecified');
    const time = /^(?:现在|当前|此时)$/u.test(rawTime) ? 'current' : rawTime;
    return { type: 'time-location', key: canon([hash(`entity\0${token(location[2]!)}`), hash(`time\0${time}`)]),
      value: hash(`location\0${token(location[4]!)}`), confidence: time === 'unspecified' ? floor(textConfidence(statement), 'medium') : textConfidence(statement),
      sourceKind, sourceDigest, entryId };
  }
  const rule = statement.match(/^(.{1,48}?)(允许|准许|可以|禁止|不得|不可)(.{1,48})$/u);
  if (rule) return { type: 'rule-mutual-exclusion',
    key: canon([hash(`scope\0${token(rule[1]!)}`), hash(`rule\0${token(rule[3]!)}`)]),
    value: /^(?:禁止|不得|不可)$/u.test(rule[2]!) ? 'deny' : 'allow', confidence: textConfidence(statement), sourceKind, sourceDigest, entryId };
  const chineseAttribute = statement.match(/^([\p{L}\p{N}_·.-]{1,40})\s*的\s*([\p{L}\p{N}_-]{1,32}?)(?:(?:也许|或许|可能|似乎|好像|大概)\s*)?(?:是|为|=|:|：)\s*(.{1,64})$/u);
  const attribute = chineseAttribute
    ?? statement.match(/^([A-Za-z][A-Za-z0-9_.-]{0,39})['’]s\s+([A-Za-z][A-Za-z0-9 _-]{0,31})\s+(?:is|=)\s+(.{1,64})$/iu);
  if (!attribute) return null;
  const isLocation = /^(?:位置|所在地|地点|location|whereabouts)$/iu.test(token(attribute[2]!));
  return { type: isLocation ? 'time-location' : 'entity-attribute',
    key: canon([hash(`entity\0${token(attribute[1]!)}`), hash(`${isLocation ? 'time\0unspecified' : `attribute\0${token(attribute[2]!)}`}`)]),
    value: hash(`${isLocation ? 'location' : 'value'}\0${token(attribute[3]!)}`),
    confidence: isLocation ? floor(textConfidence(statement), 'medium') : textConfidence(statement), sourceKind, sourceDigest, entryId };
}

function collect(source: Source, sourceKind: SourceKind, entryId: string | null): Claim[] {
  const out = source.claims.map((claim) => projected(claim, sourceKind, source.textDigest, entryId));
  if (source.publicText) for (const statement of source.publicText.split(/[\n。！？!?;；]+/u).map((item) => item.trim()).filter(Boolean)) {
    const claim = fromText(statement, sourceKind, source.textDigest, entryId);
    if (claim) out.push(claim);
    if (out.length > WORLDBOOK_CONFLICT_LIMITS.claimsPerSource) throw new TypeError('parsed claims exceed their limit');
  }
  const normalized = out.map((claim) => ({ ...claim,
    sourceDigest: hash(canon({ type: claim.type, key: claim.key, value: claim.value,
      confidence: claim.confidence })) }));
  return [...new Map(normalized.map((claim) => [canon(claim), claim])).values()];
}

function item(left: Claim, right: Claim): WorldbookConflictEvidenceItem {
  const confidence = floor(left.confidence, right.confidence);
  const currentTurnPair = (left.entryId === null) !== (right.entryId === null);
  const hardSignal = confidence === 'high' && currentTurnPair;
  const entryIds = Object.freeze([...new Set([left.entryId, right.entryId].filter((value): value is string => value !== null))].sort());
  const keyDigest = hash(left.key);
  const summaryDigest = hash(canon({ version: WORLDBOOK_CONFLICT_EVIDENCE_VERSION, candidateType: left.type, keyDigest }));
  const conflictType = confidence === 'high' ? left.type : 'unknown';
  const evidenceDigest = hash(canon({ version: WORLDBOOK_CONFLICT_EVIDENCE_VERSION, conflictType,
    candidateType: left.type, keyDigest, values: [left.value, right.value].sort(),
    sources: [left.sourceDigest, right.sourceDigest].sort(), entryIds, confidence }));
  return Object.freeze({ entryIds, conflictType, summaryDigest, confidence, evidenceDigest,
    noveltyKey: `worldbook-conflict:${evidenceDigest}`, hardSignal });
}

/** Deterministic zero-token detector. It never resolves or writes worldbook state. */
export function detectWorldbookConflictEvidence(input: unknown): WorldbookConflictEvidence {
  const parsed = parseInput(input);
  const claims: Claim[] = [];
  for (const entry of parsed.entries as readonly (ActiveWorldbookEntryProjection & Source)[]) claims.push(...collect(entry, 'entry', entry.entryId));
  claims.push(...collect(parsed.userInput as Source, 'user-input', null), ...collect(parsed.finalProse as Source, 'final-prose', null));
  for (const delta of parsed.publicMemoryDelta) claims.push(...collect(delta as Source, 'memory-delta', null));
  if (claims.length > WORLDBOOK_CONFLICT_LIMITS.totalClaims) throw new TypeError('normalized claims exceed their limit');
  const found = new Map<string, WorldbookConflictEvidenceItem>();
  let hasComparableEqual = false;
  for (let a = 0; a < claims.length; a += 1) for (let b = a + 1; b < claims.length; b += 1) {
    const left = claims[a]!; const right = claims[b]!;
    const currentTurnPair = (left.entryId === null) !== (right.entryId === null);
    if (currentTurnPair && left.type === right.type && left.key === right.key && left.value === right.value
      && RANK[left.confidence] >= RANK.medium && RANK[right.confidence] >= RANK.medium) hasComparableEqual = true;
    if (left.type === right.type && left.key === right.key && left.value !== right.value
      && (left.entryId !== null || right.entryId !== null)) {
      const evidence = item(left, right); found.set(evidence.evidenceDigest, evidence);
    }
  }
  const evidence = Object.freeze([...found.values()].sort((a, b) => a.evidenceDigest.localeCompare(b.evidenceDigest)));
  const conflictCount = evidence.filter((row) => row.hardSignal).length;
  const verdict: WorldbookConflictVerdict = conflictCount > 0 ? 'conflict'
    : evidence.length > 0 || !hasComparableEqual ? 'unknown' : 'none';
  return Object.freeze({ evidenceVersion: WORLDBOOK_CONFLICT_EVIDENCE_VERSION, verdict,
    hardSignal: conflictCount > 0, conflictCount, evidence,
    evidenceSetDigest: hash(canon({ version: WORLDBOOK_CONFLICT_EVIDENCE_VERSION, verdict,
      evidenceDigests: evidence.map((row) => row.evidenceDigest) })) });
}
