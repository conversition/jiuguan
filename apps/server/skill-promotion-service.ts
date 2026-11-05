/** @author Codex @date 2026-10-18 @version 1.0
 * D-Q3a2c 收口：体检门控的发布服务。
 *
 * 为什么需要它：`checkSkillPromotionPreflight` 与 `SkillChannelStore.promote` 各自都能读证据，
 * 如果调用方先体检、再另拿一份证据去 promote，就存在「体检看的 A、提交的 B」的窗口。
 * 本服务把**解析证据**和**用同一份证据提交**放进同一次调用：
 *   1) resolve join（三源汇合）与 verdict（质量裁决）各一次；
 *   2) 用这两个对象跑体检；不是 `ready` 就直接拒，不做任何写；
 *   3) 仍用**同两个对象**调 promote（内部再做 joinDigest / qualitySuiteId 双绑定）。
 *
 * 边界：
 * 1) 不自己读盘、不自己拼摘要：证据必须由宿主注入的 resolver 产出（组合根负责接真 Store）；
 * 2) 不做时间旅行：`decidedAt` 由调用方显式给出，服务只用它生成裁决，不改证据内容；
 * 3) 体检 blocked 一律 fail closed，错误码不带自然语言；
 * 4) 本服务仍**不激活 live**：它只把 Channel 指针推进一格。
 */
import {
    checkSkillPromotionPreflight, type SkillPromotionPreflight,
    type SkillPromotionPreflightPorts,
} from './skill-promotion-preflight.ts';
import type { SkillEvidenceJoin } from './skill-evidence-join.ts';
import type { SkillQualityVerdict } from './skill-quality-verdict.ts';
import type { SkillChannelPointer } from './skill-candidate-promotion-store.ts';

export const SKILL_PROMOTION_SERVICE_ERROR_CODES = Object.freeze([
    'skill-promotion-service-input-invalid',
    'skill-promotion-evidence-unavailable',
    'skill-promotion-blocked',
    'skill-promotion-promote-failed',
    'skill-retire-input-invalid',
    'skill-retire-no-fallback',
    'skill-retire-stale',
    'skill-retire-candidate-invalid',
    'skill-retire-candidate-in-use',
    'skill-retire-target-unavailable',
    'skill-retire-lock-unavailable',
    'skill-retire-kill-failed',
    'skill-retire-rollback-failed',
] as const);
export type SkillPromotionServiceErrorCode = typeof SKILL_PROMOTION_SERVICE_ERROR_CODES[number];

export class SkillPromotionServiceError extends Error {
    readonly code: SkillPromotionServiceErrorCode;
    constructor(code: SkillPromotionServiceErrorCode, readonly blockers: readonly string[] = []) {
        if (!(SKILL_PROMOTION_SERVICE_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-promotion-service-error-code-invalid');
        }
        super(code);
        this.name = 'SkillPromotionServiceError';
        this.code = code;
    }
}

/** 三源坐标：汇合证据的身份来自这三个 id，不来自任何调用方自报摘要。 */
export interface SkillPromotionEvidenceRef {
    readonly sampleSuiteId: string;
    readonly batchId: string;
    readonly qualitySuiteId: string;
}

/** Host read-back binding; `candidateId` comes from the same immutable Batch source as `join`. */
export interface SkillPromotionResolvedJoin {
    readonly candidateId: string;
    readonly join: SkillEvidenceJoin;
}

export interface SkillPromotionServicePorts extends SkillPromotionPreflightPorts {
    /**
     * 从持久 Batch Store 经 complete/current 统一 guard 后读取候选身份。
     * inspect/apply 必须独立复核，不能只信 resolveJoin 自报。
     */
    readonly readCurrentCompleteBatchCandidateId: (batchId: string) => string | null;
    /** 从三个真实 Store 汇合；失败必须抛错，不允许返回 null 冒充「大概没问题」。 */
    readonly resolveJoin: (ref: SkillPromotionEvidenceRef) => SkillPromotionResolvedJoin;
    /** 从 Quality 离线回执生成裁决；`decidedAt` 由调用方给出以保证可复算。 */
    readonly resolveVerdict: (input: Readonly<{
        qualitySuiteId: string;
        decidedAt: string;
    }>) => SkillQualityVerdict;
    readonly candidate: SkillPromotionPreflightPorts['candidate'] & {
        /** 可选：`retire` 需要它把指针所指候选真正杀掉（validated/rev2 → killed）。 */
        kill?(candidateId: string, input: unknown): unknown;
    };
    readonly channel: SkillPromotionPreflightPorts['channel'] & {
        promote(input: unknown): SkillChannelPointer;
        /** 可选：`retire` 用来把指针退回上一格。 */
        rollback?(input: unknown): SkillChannelPointer;
        assertRetirementReady?(channelId: string, revision: number, candidateId: string): void;
        withRetirementLock?<T>(work: () => T): T;
    };
}

export interface SkillPromotionInspectInput extends SkillPromotionEvidenceRef {
    readonly candidateId: string;
    readonly channelId: string;
    /** 裁决生成时间（canonical ISO）；同一次发布必须复用同一个值，保证可复算。 */
    readonly decidedAt: string;
    /** 体检时刻（canonical ISO）；只用于报告时间戳，不参与证据。 */
    readonly checkedAt: string;
}

export interface SkillPromotionApplyInput extends SkillPromotionInspectInput {
    readonly expectedChannelRevision: number;
}

export interface SkillPromotionOutcome {
    readonly preflight: SkillPromotionPreflight;
    readonly pointer: SkillChannelPointer;
}

export interface SkillRetireInput {
    readonly channelId: string;
    /** 当前指针 revision（CAS 键）；退役成功后指针会前进一格（指向上一格内容）。 */
    readonly expectedChannelRevision: number;
    readonly candidateId: string;
    readonly reasonCode: string;
}

export interface SkillRetireOutcome {
    /** false = 重入：候选此前已被同一次退役杀掉，本次只补回滚。 */
    readonly killedNow: boolean;
    readonly retiredRevision: number;
    readonly pointer: SkillChannelPointer;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,119}$/u;

function fail(code: SkillPromotionServiceErrorCode, blockers: readonly string[] = []): never {
    throw new SkillPromotionServiceError(code, blockers);
}

function token(value: unknown): string {
    if (typeof value !== 'string' || !TOKEN.test(value)) fail('skill-promotion-service-input-invalid');
    return value;
}

function channelId(value: unknown): string {
    if (typeof value !== 'string' || !CHANNEL.test(value)) fail('skill-promotion-service-input-invalid');
    return value;
}

function time(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) {
        fail('skill-promotion-service-input-invalid');
    }
    return value;
}

function evidenceRef(input: SkillPromotionEvidenceRef): SkillPromotionEvidenceRef {
    return Object.freeze({
        sampleSuiteId: token(input?.sampleSuiteId),
        batchId: token(input?.batchId),
        qualitySuiteId: token(input?.qualitySuiteId),
    });
}

export class SkillPromotionService {
    readonly #ports: SkillPromotionServicePorts;

    constructor(ports: SkillPromotionServicePorts) {
        if (!ports || typeof ports.resolveJoin !== 'function'
            || typeof ports.readCurrentCompleteBatchCandidateId !== 'function'
            || typeof ports.resolveVerdict !== 'function'
            || typeof ports.channel?.promote !== 'function') {
            fail('skill-promotion-service-input-invalid');
        }
        this.#ports = ports;
    }

    /** 解析一次证据并体检；不写状态。体检失败不抛错，返回 blocked 报告。 */
    inspect(input: SkillPromotionInspectInput): SkillPromotionPreflight {
        const resolved = this.#resolve(input);
        return checkSkillPromotionPreflight({
            candidateId: resolved.candidateId,
            channelId: resolved.channelId,
            join: resolved.join,
            verdict: resolved.verdict,
            ports: this.#ports,
            checkedAt: time(input.checkedAt),
        });
    }

    /**
     * 体检必须 `ready` 才推进指针；提交用的就是体检时那一份 join/verdict。
     * `expectedChannelRevision` 必须与体检报告一致（新通道 0），否则视为调用方自相矛盾。
     */
    apply(input: SkillPromotionApplyInput): SkillPromotionOutcome {
        const resolved = this.#resolve(input);
        if (!Number.isSafeInteger(input?.expectedChannelRevision) || input.expectedChannelRevision < 0) {
            fail('skill-promotion-service-input-invalid');
        }
        const checkedAt = time(input.checkedAt);
        const preflight = checkSkillPromotionPreflight({
            candidateId: resolved.candidateId,
            channelId: resolved.channelId,
            join: resolved.join,
            verdict: resolved.verdict,
            ports: this.#ports,
            checkedAt,
        });
        if (preflight.state !== 'ready') fail('skill-promotion-blocked', preflight.blockers);
        if (preflight.expectedChannelRevision !== input.expectedChannelRevision) {
            fail('skill-promotion-service-input-invalid');
        }
        let pointer: SkillChannelPointer;
        try {
            pointer = this.#ports.channel.promote({
                channelId: preflight.channelId,
                expectedChannelRevision: preflight.expectedChannelRevision,
                candidateId: preflight.candidateId,
                adoptionReceipt: this.#ports.adoption.read(preflight.candidateId)?.adoption,
                join: resolved.join,
                verdict: resolved.verdict,
            });
        } catch {
            fail('skill-promotion-promote-failed');
        }
        return Object.freeze({ preflight, pointer });
    }

    /**
     * 退役当前指针所指候选：**先杀、再退回上一格**。
     *
     * 两个 Store 没有共享事务，所以顺序与可重入性是合同的一部分：
     * 1) 指针必须真的指向该候选、revision 与调用方声明一致（否则 `stale`），且存在上一格
     *    （rev1 无父版本 ⇒ `no-fallback`，先拒，免得留下指向死者的指针）；
     * 2) 候选必须是 `validated/rev2`；**已经是 killed 视为重入**（上次 kill 成功、rollback 失败），
     *    不再要求它仍 validated，直接继续回滚；
     * 3) 回滚的目标是 `expected - 1`，由 Channel 侧再校验目标候选仍可用；
     * 4) kill 失败 ⇒ `kill-failed` 且指针原样；rollback 失败 ⇒ `rollback-failed`，此时候选已死、
     *    指针未动，重试会走重入分支。
     */
    retire(input: SkillRetireInput): SkillRetireOutcome {
        const lock = this.#ports.channel.withRetirementLock;
        if (typeof lock !== 'function') fail('skill-retire-lock-unavailable');
        let completed = false;
        try {
            return lock(() => {
                const outcome = this.#retireLocked(input);
                completed = true;
                return outcome;
            });
        }
        catch (error) {
            if (error instanceof SkillPromotionServiceError) throw error;
            // Candidate kill commits in a separate database; an outer Channel commit failure
            // after the callback ran is a recoverable half-retirement, not a lock failure.
            if (completed) return fail('skill-retire-rollback-failed');
            return fail('skill-retire-lock-unavailable');
        }
    }

    #retireLocked(input: SkillRetireInput): SkillRetireOutcome {
        if (!input || typeof input !== 'object') fail('skill-retire-input-invalid');
        const id = channelId(input.channelId);
        if (!Number.isSafeInteger(input.expectedChannelRevision) || input.expectedChannelRevision < 1) {
            fail('skill-retire-input-invalid');
        }
        const expected = Number(input.expectedChannelRevision);
        const candidateId = token(input.candidateId);
        const reasonCode = token(input.reasonCode);
        if ([...reasonCode].length > 64) fail('skill-retire-input-invalid');
        const kill = this.#ports.candidate.kill;
        const rollback = this.#ports.channel.rollback;
        if (typeof kill !== 'function' || typeof rollback !== 'function') fail('skill-retire-input-invalid');

        const pointer = this.#ports.channel.readPointer(id);
        if (!pointer) fail('skill-retire-no-fallback');
        if (pointer.revision !== expected) fail('skill-retire-stale');
        if (pointer.candidateId !== candidateId) fail('skill-retire-input-invalid');
        if (expected < 2) fail('skill-retire-no-fallback');

        let record: ReturnType<SkillPromotionPreflightPorts['candidate']['readCandidate']> = null;
        try { record = this.#ports.candidate.readCandidate(candidateId); }
        catch { return fail('skill-retire-candidate-invalid'); }
        if (!record) fail('skill-retire-candidate-invalid');
        let killedNow = true;
        if (record.state === 'killed') {
            killedNow = false;
        } else {
            if (record.state !== 'validated' || record.revision !== 2) {
                fail('skill-retire-candidate-invalid');
            }
            if (typeof this.#ports.channel.assertRetirementReady !== 'function') {
                fail('skill-retire-target-unavailable');
            }
            try { this.#ports.channel.assertRetirementReady(id, expected, candidateId); }
            catch (error) {
                if (error instanceof Error && error.message === 'skill-channel-candidate-in-use') {
                    return fail('skill-retire-candidate-in-use');
                }
                if (error instanceof Error && error.message === 'skill-channel-revision-conflict') {
                    return fail('skill-retire-stale');
                }
                return fail('skill-retire-target-unavailable');
            }
            try { kill(candidateId, { expectedRevision: 2, reasonCode }); }
            catch { return fail('skill-retire-kill-failed'); }
        }
        let rolled: SkillChannelPointer;
        try {
            rolled = rollback({
                channelId: id, expectedChannelRevision: expected, targetRevision: expected - 1,
                reasonCode,
            });
        } catch { return fail('skill-retire-rollback-failed'); }
        return Object.freeze({ killedNow, retiredRevision: expected, pointer: rolled });
    }

    #resolve(input: SkillPromotionInspectInput): Readonly<{
        candidateId: string;
        channelId: string;
        join: SkillEvidenceJoin;
        verdict: SkillQualityVerdict;
        decidedAt: string;
    }> {
        if (!input || typeof input !== 'object') fail('skill-promotion-service-input-invalid');
        const ref = evidenceRef(input);
        const candidateId = token(input.candidateId);
        const channel = channelId(input.channelId);
        const decidedAt = time(input.decidedAt);
        let resolvedJoin: SkillPromotionResolvedJoin;
        let batchCandidateId: string | null;
        let verdict: SkillQualityVerdict;
        try {
            batchCandidateId = this.#ports.readCurrentCompleteBatchCandidateId(ref.batchId);
        } catch { return fail('skill-promotion-evidence-unavailable'); }
        try {
            resolvedJoin = this.#ports.resolveJoin(ref);
        } catch { return fail('skill-promotion-evidence-unavailable'); }
        try {
            verdict = this.#ports.resolveVerdict({ qualitySuiteId: ref.qualitySuiteId, decidedAt });
        } catch { return fail('skill-promotion-evidence-unavailable'); }
        // resolver 说这是 ref 的证据，就必须真是：否则等于给了个可以随便换证据的口子。
        const join = resolvedJoin.join;
        if (batchCandidateId !== candidateId
            || token(resolvedJoin.candidateId) !== candidateId
            || join.sampleSuiteId !== ref.sampleSuiteId
            || join.candidateBatchId !== ref.batchId
            || join.qualitySuiteId !== ref.qualitySuiteId
            || verdict.qualitySuiteId !== ref.qualitySuiteId) {
            return fail('skill-promotion-evidence-unavailable');
        }
        return Object.freeze({ candidateId, channelId: channel, join, verdict, decidedAt });
    }
}
