/** @author Codex @date 2026-10-18 @version 1.0
 * HC-2：后台 Skill 服务的失败码处置矩阵（其余领域的第一批分域验收）。
 *
 * 为什么需要它：compile / evaluate / sample / quality / candidate / promotion 六个可选服务
 * 现在都会 `onFailure?.(code)`，但**没有任何地方声明**「这个码谁重试、是否阻塞原回合、
 * 要不要先回读」。于是「单一 retry owner」只是口号。
 *
 * 本矩阵把 11 个已发射的码逐个定性，并锁成闭集：
 * - `retryOwner` 只能是 `host-scheduler`（会话/任务调度层）或 `none`；
 *   **运行时不自己重试**（`autoRetry` 恒 false）——这就是「单一 retry owner」；
 * - 可选服务失败**永不阻塞原回合**（`blocksOriginalTurn` 恒 false）；
 * - 需要先回读权威状态再续跑的码必须 `requiresReadback: true`（提交未知先核对）。
 *
 * 新增一个失败码而不登记 ⇒ 验收测试失败，等于一次显式评审。
 */
export const SKILL_RUNTIME_FAILURE_MATRIX_VERSION = 'skill-runtime-failure-matrix-v1' as const;

export type SkillRuntimeFailureSeverity = 'optional-service' | 'recovery';
export type SkillRuntimeRetryOwner = 'host-scheduler' | 'none';

export interface SkillRuntimeFailureDisposition {
    readonly domain: string;
    readonly severity: SkillRuntimeFailureSeverity;
    /** 恒 false：运行时不自助重试，重试权只属于宿主调度层。 */
    readonly autoRetry: false;
    readonly retryOwner: SkillRuntimeRetryOwner;
    /** 恒 false：可选服务失败不得阻塞原对话回合。 */
    readonly blocksOriginalTurn: false;
    /** 重启/恢复类失败必须先回读权威状态，再决定续跑或放弃。 */
    readonly requiresReadback: boolean;
}

/** 闭集：键必须与 `apps/server/skill-hub/*.ts` 里实际发射的 `onFailure?.('code')` 完全一致。 */
export const SKILL_RUNTIME_FAILURE_MATRIX = Object.freeze({
    'candidate-open-failed': {
        domain: 'candidate', severity: 'optional-service', autoRetry: false,
        retryOwner: 'none', blocksOriginalTurn: false, requiresReadback: false,
    },
    'candidate-validation-pending': {
        domain: 'candidate', severity: 'recovery', autoRetry: false,
        retryOwner: 'host-scheduler', blocksOriginalTurn: false, requiresReadback: true,
    },
    'skill-compile-open-failed': {
        domain: 'compile', severity: 'optional-service', autoRetry: false,
        retryOwner: 'none', blocksOriginalTurn: false, requiresReadback: false,
    },
    'skill-compile-recovery-pending': {
        domain: 'compile', severity: 'recovery', autoRetry: false,
        retryOwner: 'host-scheduler', blocksOriginalTurn: false, requiresReadback: true,
    },
    'skill-evaluate-open-failed': {
        domain: 'evaluate', severity: 'optional-service', autoRetry: false,
        retryOwner: 'none', blocksOriginalTurn: false, requiresReadback: false,
    },
    'skill-evaluate-recovery-pending': {
        domain: 'evaluate', severity: 'recovery', autoRetry: false,
        retryOwner: 'host-scheduler', blocksOriginalTurn: false, requiresReadback: true,
    },
    'skill-promotion-open-failed': {
        domain: 'promotion', severity: 'optional-service', autoRetry: false,
        retryOwner: 'none', blocksOriginalTurn: false, requiresReadback: false,
    },
    'skill-quality-open-failed': {
        domain: 'quality', severity: 'optional-service', autoRetry: false,
        retryOwner: 'none', blocksOriginalTurn: false, requiresReadback: false,
    },
    'skill-quality-recovery-pending': {
        domain: 'quality', severity: 'recovery', autoRetry: false,
        retryOwner: 'host-scheduler', blocksOriginalTurn: false, requiresReadback: true,
    },
    'skill-sample-open-failed': {
        domain: 'sample', severity: 'optional-service', autoRetry: false,
        retryOwner: 'none', blocksOriginalTurn: false, requiresReadback: false,
    },
    'skill-sample-recovery-pending': {
        domain: 'sample', severity: 'recovery', autoRetry: false,
        retryOwner: 'host-scheduler', blocksOriginalTurn: false, requiresReadback: true,
    },
} as const satisfies Record<string, SkillRuntimeFailureDisposition>);

export type SkillRuntimeFailureCode = keyof typeof SKILL_RUNTIME_FAILURE_MATRIX;

export const SKILL_RUNTIME_FAILURE_CODES = Object.freeze(
    Object.keys(SKILL_RUNTIME_FAILURE_MATRIX).sort() as SkillRuntimeFailureCode[],
);

export function classifySkillRuntimeFailure(code: string): SkillRuntimeFailureDisposition | null {
    return (SKILL_RUNTIME_FAILURE_MATRIX as Record<string, SkillRuntimeFailureDisposition>)[code] ?? null;
}

/** 未登记的码一律 fail closed：宁可让测试/调用方炸，也不默认「大概是临时错误」。 */
export function assertSkillRuntimeFailureClassified(code: string): SkillRuntimeFailureDisposition {
    const disposition = classifySkillRuntimeFailure(code);
    if (!disposition) throw new Error('skill-runtime-failure-unclassified');
    return disposition;
}
