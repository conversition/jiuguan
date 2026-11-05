/** @author Codex @date 2026-10-27 @version 1.0
 * Proposal-only variable proposal Skill contract: a deterministic request built from exact session
 * facts, and a patch proposer that can never apply, approve or promote anything.
 */
import { createHash } from 'node:crypto';
import type { ChatRequest } from '../../proxy/public/client.ts';

export const VARIABLE_PROPOSAL_SKILL_SOURCE_VERSION = 'variable-proposal-skill-source-v1' as const;
export const VARIABLE_PROPOSAL_SKILL_POLICY_VERSION = 'p17-variable-proposal-v1' as const;
export const VARIABLE_PROPOSAL_SKILL_MAX_CANDIDATES = 8;
export const VARIABLE_PROPOSAL_SKILL_MAX_OUTPUT_TOKENS = 512;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^(?:sha256:)?[a-f0-9]{64}$/u;
const SESSION_DIGEST = /^session:sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,239}$/u;
const SOURCE_KEYS = ['sourceVersion', 'policyVersion', 'runId', 'parentRunId', 'sessionDigest', 'round',
    'contentMode', 'sourceRevision', 'historyEpoch', 'specDigest', 'valuesDigest', 'userInputDigest',
    'stagedAgainstRevision', 'maxCandidateCount', 'maxOutputTokens', 'sourceDigest'] as const;
const OUTPUT_KEYS = ['patches', 'rationale'] as const;

/** Wire shape of the exact per-session variable declaration the runner exposes. */
export interface VariableProposalSkillSpec {
    readonly path: string;
    readonly type: 'number' | 'string' | 'boolean';
    readonly mutable: boolean;
    readonly min?: number;
    readonly max?: number;
    readonly allowedValues?: readonly string[];
    readonly maxLength?: number;
}

export interface VariableProposalSkillSourceV1 {
    readonly sourceVersion: typeof VARIABLE_PROPOSAL_SKILL_SOURCE_VERSION;
    readonly policyVersion: typeof VARIABLE_PROPOSAL_SKILL_POLICY_VERSION;
    readonly runId: string;
    readonly parentRunId: string;
    readonly sessionDigest: string;
    readonly round: number;
    readonly contentMode: 'nsf' | 'nsfw';
    readonly sourceRevision: string;
    readonly historyEpoch: number;
    readonly specDigest: string;
    readonly valuesDigest: string;
    readonly userInputDigest: string;
    readonly stagedAgainstRevision: string;
    readonly maxCandidateCount: number;
    readonly maxOutputTokens: number;
    readonly sourceDigest: string;
}

export interface VariableProposalSkillCandidate {
    readonly patches: readonly { readonly path: string; readonly value: string | number | boolean }[];
    readonly candidateDigest: string;
}

export function variableProposalSkillDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
export function variableProposalSkillSessionDigest(rawSessionId: string): string {
    if (typeof rawSessionId !== 'string' || !rawSessionId) throw new Error('variable-proposal-session-invalid');
    return `session:${variableProposalSkillDigest(['variable-proposal-skill-session', rawSessionId])}`;
}
export function variableProposalSpecDigest(specs: readonly VariableProposalSkillSpec[]): string {
    return variableProposalSkillDigest(['variable-proposal-specs-v1',
        [...specs].map((spec) => [spec.path, spec.type, spec.mutable, spec.min ?? null, spec.max ?? null,
            spec.allowedValues ? [...spec.allowedValues] : null, spec.maxLength ?? null])
            .sort((left, right) => String(left[0]) < String(right[0]) ? -1 : String(left[0]) > String(right[0]) ? 1 : 0)]);
}
export function variableProposalValuesDigest(values: Readonly<Record<string, string | number | boolean>>): string {
    return variableProposalSkillDigest(['variable-proposal-values-v1',
        Object.keys(values).sort().map((key) => [key, values[key]!])]);
}
export function variableProposalUserInputDigest(userInput: string): string {
    if (typeof userInput !== 'string') throw new Error('variable-proposal-input-invalid');
    return variableProposalSkillDigest(['variable-proposal-user-input-v1', userInput]);
}

function invalid(): never { throw new Error('variable-proposal-skill-source-invalid'); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    return value as Record<string, unknown>;
}
function digest(value: unknown, label: string): string {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`variable-proposal-${label}-invalid`);
    return value;
}
function revision(value: unknown, label: string): string {
    if (typeof value !== 'string' || !REVISION.test(value)) throw new Error(`variable-proposal-${label}-invalid`);
    return value;
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`variable-proposal-${label}-invalid`);
    }
    return value;
}
function token(value: unknown, label: string): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`variable-proposal-${label}-invalid`);
    return value;
}

/**
 * Strict normalization; the digest is always recomputed. `sourceDigest` may be omitted by the
 * builder (it is derived) but, when present, it must match the recomputed value.
 */
export function normalizeVariableProposalSkillSource(value: unknown): VariableProposalSkillSourceV1 {
    const row = record(value);
    const keys = Object.keys(row).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...SOURCE_KEYS].sort())
        && JSON.stringify(keys) !== JSON.stringify(SOURCE_KEYS.filter((key) => key !== 'sourceDigest').sort())) {
        invalid();
    }
    if (row.sourceVersion !== VARIABLE_PROPOSAL_SKILL_SOURCE_VERSION
        || row.policyVersion !== VARIABLE_PROPOSAL_SKILL_POLICY_VERSION) invalid();
    if (typeof row.sessionDigest !== 'string' || !SESSION_DIGEST.test(row.sessionDigest)) invalid();
    if (!['nsf', 'nsfw'].includes(row.contentMode as string)) invalid();
    const base = Object.freeze({
        sourceVersion: VARIABLE_PROPOSAL_SKILL_SOURCE_VERSION,
        policyVersion: VARIABLE_PROPOSAL_SKILL_POLICY_VERSION,
        runId: token(row.runId, 'run'), parentRunId: token(row.parentRunId, 'parent-run'),
        sessionDigest: row.sessionDigest as string,
        round: integer(row.round, 'round', 1, 1_000_000),
        contentMode: row.contentMode as 'nsf' | 'nsfw',
        sourceRevision: revision(row.sourceRevision, 'source-revision'),
        historyEpoch: integer(row.historyEpoch, 'history-epoch', 0, 1_000_000),
        specDigest: digest(row.specDigest, 'spec-digest'),
        valuesDigest: digest(row.valuesDigest, 'values-digest'),
        userInputDigest: digest(row.userInputDigest, 'input-digest'),
        stagedAgainstRevision: revision(row.stagedAgainstRevision, 'staged-revision'),
        maxCandidateCount: integer(row.maxCandidateCount, 'max-candidate-count', 1,
            VARIABLE_PROPOSAL_SKILL_MAX_CANDIDATES),
        maxOutputTokens: integer(row.maxOutputTokens, 'max-output-tokens', 64,
            VARIABLE_PROPOSAL_SKILL_MAX_OUTPUT_TOKENS),
    });
    const expected = variableProposalSkillDigest(base);
    if (Object.hasOwn(row, 'sourceDigest') && row.sourceDigest !== expected) invalid();
    return Object.freeze({ ...base, sourceDigest: expected });
}

function renderSpec(spec: VariableProposalSkillSpec): string {
    const bounds = spec.type === 'number'
        ? `min=${spec.min ?? 0} max=${spec.max ?? 0}`
        : spec.type === 'string'
            ? `values=${JSON.stringify(spec.allowedValues ?? [])} maxLength=${spec.maxLength ?? 0}`
            : 'values=[true,false]';
    return `- ${spec.path} (${spec.type}, ${bounds})`;
}

/**
 * Deterministic single-message request. No tools, no randomness and no timestamps: the same
 * source + values + user input always produce the same bytes, so callers can re-derive it.
 */
export function buildVariableProposalSkillRequest(input: {
    readonly source: VariableProposalSkillSourceV1;
    readonly specs: readonly VariableProposalSkillSpec[];
    readonly values: Readonly<Record<string, string | number | boolean>>;
    readonly userInput: string;
    /** Exact resolved model id; the caller must pass the same one the transport will use. */
    readonly model: string;
}): ChatRequest {
    const source = normalizeVariableProposalSkillSource(input.source);
    if (typeof input.model !== 'string' || !input.model.trim()) {
        throw new Error('variable-proposal-skill-request-model-invalid');
    }
    if (variableProposalSpecDigest(input.specs) !== source.specDigest
        || variableProposalValuesDigest(input.values) !== source.valuesDigest
        || variableProposalUserInputDigest(input.userInput) !== source.userInputDigest) {
        throw new Error('variable-proposal-skill-request-source-drift');
    }
    const writable = input.specs.filter((spec) => spec.mutable);
    if (writable.length === 0) throw new Error('variable-proposal-skill-request-no-writable-spec');
    const current = writable.map((spec) => {
        const value = input.values[spec.path];
        return `- ${spec.path} = ${JSON.stringify(value ?? null)}`;
    });
    const system = [
        '你是变量提案器。只输出 JSON，禁止输出任何其他文字。',
        '格式：{"patches":[{"path":"<下面列出的可写路径>","value":<符合该路径声明类型的值>}],"rationale":"<一句话>"}',
        `patches 数量 1..${source.maxCandidateCount}，路径必须来自可写清单且不得重复。`,
        '可写变量声明：', ...writable.map(renderSpec),
        '当前值：', ...current,
        '这是一份待校验提案；仅在本轮来源、权限和提交检查均通过后由宿主采用。不要臆造清单外的路径。',
    ].join('\n');
    return Object.freeze({
        model: input.model,
        temperature: 0,
        max_tokens: source.maxOutputTokens,
        messages: Object.freeze([
            Object.freeze({ role: 'system' as const, content: system }),
            Object.freeze({ role: 'user' as const, content: input.userInput }),
        ]),
    }) as unknown as ChatRequest;
}

function validValue(spec: VariableProposalSkillSpec, value: unknown): string | number | boolean | null {
    if (spec.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        if (typeof spec.min === 'number' && value < spec.min) return null;
        if (typeof spec.max === 'number' && value > spec.max) return null;
        return value;
    }
    if (spec.type === 'string') {
        if (typeof value !== 'string') return null;
        if (spec.allowedValues && !spec.allowedValues.includes(value)) return null;
        if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) return null;
        return value;
    }
    return typeof value === 'boolean' ? value : null;
}

/**
 * Proposal-only parse. A candidate that fails any declaration check is rejected outright; nothing
 * here can apply the patch, so a bad candidate can never become a write.
 */
export function parseVariableProposalSkillOutput(
    content: string,
    specs: readonly VariableProposalSkillSpec[],
    maxCandidates = VARIABLE_PROPOSAL_SKILL_MAX_CANDIDATES,
): VariableProposalSkillCandidate | null {
    if (typeof content !== 'string' || content.length === 0 || content.length > 8_192) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))) return null;
    const row = parsed as Record<string, unknown>;
    if (Object.keys(row).some((key) => !(OUTPUT_KEYS as readonly string[]).includes(key))) return null;
    if (row.rationale !== undefined && typeof row.rationale !== 'string') return null;
    if (typeof row.rationale === 'string' && row.rationale.length > 512) return null;
    if (!Array.isArray(row.patches) || row.patches.length === 0 || row.patches.length > maxCandidates) return null;
    const byPath = new Map(specs.map((spec) => [spec.path, spec]));
    const seen = new Set<string>();
    const patches: { path: string; value: string | number | boolean }[] = [];
    for (const item of row.patches) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const patch = item as Record<string, unknown>;
        if (Object.keys(patch).sort().join(',') !== 'path,value') return null;
        if (typeof patch.path !== 'string' || seen.has(patch.path)) return null;
        const spec = byPath.get(patch.path);
        if (!spec || !spec.mutable) return null;
        const value = validValue(spec, patch.value);
        if (value === null) return null;
        seen.add(patch.path);
        patches.push({ path: patch.path, value });
    }
    const frozen = Object.freeze(patches.map((patch) => Object.freeze(patch)));
    return Object.freeze({ patches: frozen, candidateDigest: variableProposalSkillDigest(['variable-proposal-candidate-v1', frozen]) });
}
