/** @author Codex @date 2026-10-18 @version 1.0
 * 管理员侧的 Channel 发布边界。所有写操作都要 opt-in；读操作只回摘要，不回证据正文。
 *
 * 返回形状沿用其它 skills API：`{ status, body }`，错误只给闭集 `code`（blocked 附带闭集阻断码）。
 */
export interface SkillPromotionApiRuntime {
    readonly writesEnabled: boolean;
    readOverview(input?: { readonly limit?: number; readonly cursor?: number }): unknown;
    reconcileRetirements(): unknown;
    readCandidateDiff(leftId: string, rightId: string): unknown;
    readActiveDiff?(candidateId: string): Promise<unknown>;
    listEvidence?(candidateId: string, batchCursor: string, qualityCursor: string, expectedBatchId: string): unknown;
    readPreflight(input: unknown): unknown;
    readPointer(channelId: string): unknown | null;
    readChannelEvidence?(channelId: string): unknown | null;
    readHistory(channelId: string): readonly unknown[];
    adopt?(input: unknown): unknown;
    promote(input: unknown): unknown;
    retire(input: unknown): unknown;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const CANDIDATE_ID = /^sha256:[a-f0-9]{64}$/u;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/u;

function field(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('invalid');
    return value;
}

function channelField(input: Record<string, unknown>): string {
    const value = input.channelId;
    if (typeof value !== 'string' || !CHANNEL.test(value)) throw new Error('invalid');
    return value;
}

function timeField(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) throw new Error('invalid');
    return value;
}

function revisionField(input: Record<string, unknown>): number {
    const value = input.expectedChannelRevision;
    if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid');
    return Number(value);
}

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        throw new Error('invalid');
    }
    const actual = Reflect.ownKeys(input);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
        throw new Error('invalid');
    }
    return input as Record<string, unknown>;
}

/** 服务层错误码 → HTTP 状态。未登记的一律按 503（存储不可用），不猜测。 */
const PASSTHROUGH = new Set([
    'skill-promotion-evidence-unavailable', 'skill-promotion-service-input-invalid',
    'skill-promotion-promote-failed', 'skill-promotion-quality-suite-unavailable',
    'skill-retire-input-invalid', 'skill-retire-no-fallback', 'skill-retire-stale',
    'skill-retire-candidate-invalid', 'skill-retire-kill-failed', 'skill-retire-rollback-failed',
    'skill-retire-candidate-in-use', 'skill-retire-target-unavailable',
    'skill-adoption-request-invalid', 'skill-adoption-candidate-invalid', 'skill-adoption-evidence-unavailable',
    'skill-promotion-disabled',
]);
function failure(error: unknown, fallback: string) {
    const code = error instanceof Error ? error.message : '';
    const blockers = (error as { blockers?: readonly unknown[] } | null)?.blockers;
    if (code === 'skill-promotion-preflight-channel-unavailable' || code === 'skill-retire-lock-unavailable'
        || code === 'skill-adoption-consume-failed') {
        return { status: 503, body: { code } };
    }
    if (code === 'skill-promotion-blocked') {
        return {
            status: 409,
            body: {
                code,
                blockers: Array.isArray(blockers)
                    ? blockers.filter((item): item is string => typeof item === 'string')
                    : [],
            },
        };
    }
    if (PASSTHROUGH.has(code)) return { status: 409, body: { code } };
    return { status: 503, body: { code: fallback } };
}

/** Adopt only a current, server-reconstructed evidence join; request carries no evidence body. */
export function adoptSkillCandidateApi(runtime: SkillPromotionApiRuntime | null, input: unknown) {
    return guard(runtime, (current) => {
        let body: Record<string, unknown>;
        try {
            body = exact(input, ['candidateId', 'expectedRevision', 'sampleSuiteId', 'batchId', 'qualitySuiteId']);
            if (!CANDIDATE_ID.test(field(body, 'candidateId')) || body.expectedRevision !== 1) throw new Error('invalid');
            body = { candidateId: field(body, 'candidateId'), expectedRevision: 1,
                sampleSuiteId: field(body, 'sampleSuiteId'), batchId: field(body, 'batchId'),
                qualitySuiteId: field(body, 'qualitySuiteId') };
        } catch { return { status: 400, body: { code: 'skill-adoption-request-invalid' } }; }
        if (!current.adopt) return { status: 503, body: { code: 'skill-promotion-unavailable' } };
        return { status: 200, body: { adoption: current.adopt(body) } };
    });
}

function guard<T>(runtime: SkillPromotionApiRuntime | null, work: (runtime: SkillPromotionApiRuntime) => T) {
    if (!runtime) return { status: 503, body: { code: 'skill-promotion-unavailable' } };
    try { return work(runtime); }
    catch (error) { return failure(error, 'skill-promotion-storage-unavailable'); }
}

const PROMOTE_KEYS = ['candidateId', 'channelId', 'expectedChannelRevision', 'sampleSuiteId',
    'batchId', 'qualitySuiteId', 'decidedAt', 'checkedAt'] as const;

export function readSkillPromotionPreflightApi(
    runtime: SkillPromotionApiRuntime | null, input: unknown,
) {
    return guard(runtime, (current) => {
        let body: Record<string, unknown>;
        try {
            body = exact(input, ['candidateId', 'channelId', 'sampleSuiteId', 'batchId',
                'qualitySuiteId', 'decidedAt', 'checkedAt']);
            body = {
                candidateId: field(body, 'candidateId'),
                channelId: channelField(body),
                sampleSuiteId: field(body, 'sampleSuiteId'),
                batchId: field(body, 'batchId'),
                qualitySuiteId: field(body, 'qualitySuiteId'),
                decidedAt: timeField(body, 'decidedAt'),
                checkedAt: timeField(body, 'checkedAt'),
            };
        } catch { return { status: 400, body: { code: 'skill-promotion-request-invalid' } }; }
        return { status: 200, body: { preflight: current.readPreflight(body) } };
    });
}

export function promoteSkillCandidateApi(runtime: SkillPromotionApiRuntime | null, input: unknown) {
    return guard(runtime, (current) => {
        let body: Record<string, unknown>;
        try {
            body = exact(input, PROMOTE_KEYS);
            body = {
                candidateId: field(body, 'candidateId'),
                channelId: channelField(body),
                expectedChannelRevision: revisionField(body),
                sampleSuiteId: field(body, 'sampleSuiteId'),
                batchId: field(body, 'batchId'),
                qualitySuiteId: field(body, 'qualitySuiteId'),
                decidedAt: timeField(body, 'decidedAt'),
                checkedAt: timeField(body, 'checkedAt'),
            };
        } catch { return { status: 400, body: { code: 'skill-promotion-request-invalid' } }; }
        const outcome = current.promote(body) as { pointer: unknown };
        return { status: 200, body: { pointer: outcome.pointer } };
    });
}

export function retireSkillCandidateApi(runtime: SkillPromotionApiRuntime | null, input: unknown) {
    return guard(runtime, (current) => {
        let body: Record<string, unknown>;
        try {
            body = exact(input, ['candidateId', 'channelId', 'expectedChannelRevision', 'reasonCode']);
            body = {
                candidateId: field(body, 'candidateId'),
                channelId: channelField(body),
                expectedChannelRevision: revisionField(body),
                reasonCode: field(body, 'reasonCode'),
            };
        } catch { return { status: 400, body: { code: 'skill-promotion-request-invalid' } }; }
        const outcome = current.retire(body) as {
            killedNow: boolean; retiredRevision: number; pointer: unknown;
        };
        return {
            status: 200,
            body: {
                killedNow: outcome.killedNow,
                retiredRevision: outcome.retiredRevision,
                pointer: outcome.pointer,
            },
        };
    });
}

/** 只读发布总览：limit/cursor 只接受十进制整数，其它一律 400。 */
export function readSkillPromotionOverviewApi(
    runtime: SkillPromotionApiRuntime | null,
    query: Readonly<{ limit?: string; cursor?: string }> = {},
) {
    return guard(runtime, (current) => {
        const input: { limit?: number; cursor?: number } = {};
        try {
            for (const [key, raw] of [['limit', query.limit], ['cursor', query.cursor]] as const) {
                if (raw === undefined) continue;
                if (typeof raw !== 'string' || !/^[0-9]{1,6}$/u.test(raw)) throw new Error('invalid');
                input[key] = Number(raw);
            }
        } catch { return { status: 400, body: { code: 'skill-promotion-request-invalid' } }; }
        return { status: 200, body: { overview: current.readOverview(input) } };
    });
}

/** 退役和解：只补「候选已死、指针未退」的半途状态；无入参、无副作用之外的推断。 */
export function reconcileSkillRetirementsApi(runtime: SkillPromotionApiRuntime | null) {
    return guard(runtime, (current) => ({
        status: 200,
        body: { entries: current.reconcileRetirements() },
    }));
}

/** Candidate 结构化 Diff（只读，需两个精确 candidateId）。 */
export function readSkillCandidateDiffApi(
    runtime: SkillPromotionApiRuntime | null, candidateId: string, against: string | undefined,
) {
    if (!CANDIDATE_ID.test(candidateId) || against === undefined || !CANDIDATE_ID.test(against)) {
        return { status: 400, body: { code: 'skill-candidate-diff-request-invalid' } };
    }
    if (!runtime) return { status: 503, body: { code: 'skill-promotion-unavailable' } };
    try {
        return { status: 200, body: { diff: runtime.readCandidateDiff(candidateId, against) } };
    } catch (error) {
        if (error instanceof Error && error.message === 'candidate-not-found') {
            return { status: 404, body: { code: 'skill-candidate-not-found' } };
        }
        return { status: 503, body: { code: 'skill-promotion-storage-unavailable' } };
    }
}

/** Discovery supplies identifiers for the form only; adoption revalidates the full evidence join. */
export function listSkillPromotionEvidenceApi(runtime: SkillPromotionApiRuntime | null, candidateId: string,
    batchCursor = '', qualityCursor = '', expectedBatchId = '') {
    if (!CANDIDATE_ID.test(candidateId) || (batchCursor && !CANDIDATE_ID.test(batchCursor))
        || (qualityCursor && !CANDIDATE_ID.test(qualityCursor)) || (expectedBatchId && !CANDIDATE_ID.test(expectedBatchId))
        || Boolean(qualityCursor) !== Boolean(expectedBatchId)) {
        return { status: 400, body: { code: 'skill-evidence-reference-invalid' } };
    }
    if (!runtime?.listEvidence) return { status: 503, body: { code: 'skill-evidence-discovery-unavailable' } };
    try { return { status: 200, body: { evidence: runtime.listEvidence(candidateId, batchCursor, qualityCursor, expectedBatchId) } }; }
    catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'candidate-not-found') return { status: 404, body: { code: 'skill-candidate-not-found' } };
        if (code === 'skill-evidence-candidate-invalid' || code === 'skill-evidence-discovery-stale') {
            return { status: 409, body: { code } };
        }
        return { status: 503, body: { code: 'skill-evidence-discovery-unavailable' } };
    }
}

export function readSkillChannelApi(runtime: SkillPromotionApiRuntime | null, channelId: string) {
    if (!CHANNEL.test(channelId)) {
        return { status: 400, body: { code: 'skill-channel-invalid' } };
    }
    return guard(runtime, (current) => {
        const pointer = current.readPointer(channelId);
        if (!pointer) return { status: 404, body: { code: 'skill-channel-not-found' } };
        return {
            status: 200,
            body: { pointer, history: current.readHistory(channelId), writesEnabled: current.writesEnabled },
        };
    });
}

/** Reconstructs original evidence for the current Channel; this does not assert live activation. */
export function readSkillChannelEvidenceApi(runtime: SkillPromotionApiRuntime | null, channelId: string) {
    if (!CHANNEL.test(channelId)) return { status: 400, body: { code: 'skill-channel-invalid' } };
    if (!runtime?.readChannelEvidence) return { status: 503, body: { code: 'skill-channel-evidence-unavailable' } };
    try {
        const current = runtime.readChannelEvidence(channelId);
        return current ? { status: 200, body: { current } } : { status: 404, body: { code: 'skill-channel-not-found' } };
    } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'skill-channel-evidence-unavailable' || code === 'skill-channel-evidence-stale'
            || code === 'skill-channel-evidence-chain-limit') {
            return { status: 409, body: { code } };
        }
        return { status: 503, body: { code: 'skill-channel-evidence-unavailable' } };
    }
}

export const SKILL_PROMOTION_ROUTE_TEMPLATES = Object.freeze({
    activeDiff: '/api/skills/candidates/:candidateId/active-diff',
    overview: '/api/skills/promotion/overview',
    reconcile: '/api/skills/promotion/reconcile',
    candidateDiff: '/api/skills/candidates/:candidateId/diff',
    evidence: '/api/skills/candidates/:candidateId/promotion-evidence',
    adopt: '/api/skills/promotion/adopt',
    preflight: '/api/skills/promotion/preflight',
    promote: '/api/skills/promotion/promote',
    retire: '/api/skills/promotion/retire',
    channel: '/api/skills/channels/:channelId',
    channelEvidence: '/api/skills/channels/:channelId/evidence',
});

/** 供路由清单校验用的闭集：新增路由必须同步 `route-access.ts`。 */
export const SKILL_PROMOTION_ROUTES = Object.freeze([
    ['GET', '/api/skills/candidates/:candidateId/active-diff'],
    ['GET', '/api/skills/promotion/overview'],
    ['POST', '/api/skills/promotion/adopt'],
    ['POST', '/api/skills/promotion/preflight'],
    ['POST', '/api/skills/promotion/promote'],
    ['POST', '/api/skills/promotion/retire'],
    ['POST', '/api/skills/promotion/reconcile'],
    ['GET', '/api/skills/channels/:channelId'],
    ['GET', '/api/skills/channels/:channelId/evidence'],
    ['GET', '/api/skills/candidates/:candidateId/diff'],
    ['GET', '/api/skills/candidates/:candidateId/promotion-evidence'],
] as const);

export async function readSkillActiveDiffApi(runtime: SkillPromotionApiRuntime | null, candidateId: string) {
    if (!CANDIDATE_ID.test(candidateId)) return { status: 400, body: { code: 'skill-candidate-diff-request-invalid' } };
    if (!runtime?.readActiveDiff) return { status: 503, body: { code: 'skill-active-baseline-unavailable' } };
    try { return { status: 200, body: { comparison: await runtime.readActiveDiff(candidateId) } }; }
    catch (error) {
        if (error instanceof Error && error.message === 'candidate-not-found') return { status: 404, body: { code: 'skill-candidate-not-found' } };
        if (error instanceof Error && error.message === 'skill-active-baseline-stale') return { status: 409, body: { code: error.message } };
        return { status: 503, body: { code: 'skill-active-baseline-unavailable' } };
    }
}
