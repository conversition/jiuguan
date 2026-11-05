/** @author Codex @date 2026-10-17 @version 1.0
 * D-Q3a2b2c 宿主适配器：从三个真实 Store 读取 24/48/48，映射成显式坐标后调用纯汇合。
 * 只读、无 Provider 调用；任一 Store 缺记录或跨源绑定不一致即 fail closed。
 */
import {
    currentCompleteCandidateEvaluationBatch, type CandidateEvaluationStoredBatch,
} from './candidate-evaluation-batch-store.ts';
import type { SkillQualityStoredSuite } from './skill-quality-store.ts';
import {
    SKILL_SAMPLE_SUITE_PAIR_COUNT, SKILL_SAMPLE_SUITE_PLAN_VERSION,
    type SkillSampleSuitePlan,
} from './skill-sample-registry.ts';
import type { SkillSampleStoredSuite } from './skill-sample-store.ts';
import { SKILL_QUALITY_PLAN_COUNT } from './skill-quality-registry.ts';
import {
    joinSkillQualityEvidence, type SkillEvidenceArm, type SkillEvidenceJoin,
} from './skill-evidence-join.ts';

export const SKILL_EVIDENCE_JOIN_HOST_ERROR_CODES = Object.freeze([
    'skill-evidence-join-host-source-missing',
    'skill-evidence-join-host-incomplete',
    'skill-evidence-join-host-binding-mismatch',
] as const);
export type SkillEvidenceJoinHostErrorCode = typeof SKILL_EVIDENCE_JOIN_HOST_ERROR_CODES[number];

export class SkillEvidenceJoinHostError extends Error {
    constructor(readonly code: SkillEvidenceJoinHostErrorCode) {
        if (!(SKILL_EVIDENCE_JOIN_HOST_ERROR_CODES as readonly unknown[]).includes(code)) {
            throw new Error('skill-evidence-join-host-error-code-invalid');
        }
        super(code);
        this.name = 'SkillEvidenceJoinHostError';
    }
}

export interface SkillEvidenceJoinHostInput {
    readonly sampleStore: { readSuite(suiteId: string): SkillSampleStoredSuite | null };
    readonly candidateStore: { readBatch(batchId: string): CandidateEvaluationStoredBatch | null };
    readonly qualityStore: { readSuite(suiteId: string): SkillQualityStoredSuite | null };
    readonly sampleSuiteId: string;
    readonly batchId: string;
    readonly qualitySuiteId: string;
    readonly joinedAt: string;
}

function reject(code: SkillEvidenceJoinHostErrorCode): never {
    throw new SkillEvidenceJoinHostError(code);
}

function suiteCoordinates(plan: SkillSampleSuitePlan): { scenarioOrdinal: number; repeatIndex: number } {
    if (plan.planVersion !== SKILL_SAMPLE_SUITE_PLAN_VERSION) reject('skill-evidence-join-host-binding-mismatch');
    return {
        scenarioOrdinal: plan.suite.scenarioOrdinal,
        repeatIndex: plan.suite.repeatIndex,
    };
}

/**
 * 读三个 Store 并汇合。所有坐标从记录本身的 `suite` / `source` 字段取，
 * 不依赖数组顺序；数组件数不对、terminal 缺坐标、跨源摘要不一致都拒绝。
 */
export function buildSkillQualityEvidenceJoin(input: SkillEvidenceJoinHostInput): SkillEvidenceJoin {
    const sampleSuite = input.sampleStore.readSuite(input.sampleSuiteId);
    if (!sampleSuite) reject('skill-evidence-join-host-source-missing');
    const batch = currentCompleteCandidateEvaluationBatch(
        input.candidateStore.readBatch(input.batchId),
    );
    if (!batch) reject('skill-evidence-join-host-incomplete');
    if (batch.batch.batchId !== input.batchId) reject('skill-evidence-join-host-binding-mismatch');
    const qualitySuite = input.qualityStore.readSuite(input.qualitySuiteId);
    if (!qualitySuite) reject('skill-evidence-join-host-source-missing');
    if (sampleSuite.state !== 'succeeded' || !sampleSuite.evaluation
        || sampleSuite.plans.length !== SKILL_SAMPLE_SUITE_PAIR_COUNT
        || sampleSuite.jobs.length !== SKILL_SAMPLE_SUITE_PAIR_COUNT
        || sampleSuite.jobs.some((stored) =>
            stored.job.state !== 'succeeded' || !stored.packet || !stored.execution)) {
        reject('skill-evidence-join-host-incomplete');
    }
    if (qualitySuite.state !== 'succeeded' || qualitySuite.sourceCurrent !== true
        || !qualitySuite.evaluation || qualitySuite.jobs.length !== SKILL_QUALITY_PLAN_COUNT
        || qualitySuite.execution.expectedJobCount !== SKILL_QUALITY_PLAN_COUNT
        || qualitySuite.execution.completedJobCount !== SKILL_QUALITY_PLAN_COUNT
        || qualitySuite.execution.gatewayProofStatus !== 'complete'
        || qualitySuite.jobs.some((stored) =>
            stored.job.state !== 'succeeded' || !stored.packet || !stored.execution)) {
        reject('skill-evidence-join-host-incomplete');
    }

    // 跨源身份：Sample 的 suite manifest / Candidate 的 sampleSuiteDigest / Quality 的 source 必须一致。
    const manifestDigest = sampleSuite.plans[0]?.suite.manifestDigest;
    if (!manifestDigest || batch.source.sampleSuiteDigest !== manifestDigest) {
        reject('skill-evidence-join-host-binding-mismatch');
    }
    const sampleByJobId = new Map(sampleSuite.jobs.map((stored) => [stored.job.jobId, stored]));

    const samples = sampleSuite.jobs.map((stored) => {
        const coordinates = suiteCoordinates(stored.job.plan as SkillSampleSuitePlan);
        const packet = stored.packet;
        const execution = stored.execution;
        if (!packet || !execution) reject('skill-evidence-join-host-incomplete');
        if (execution.jobId !== stored.job.jobId
            || execution.scenarioOrdinal !== coordinates.scenarioOrdinal
            || execution.repeatIndex !== coordinates.repeatIndex) {
            reject('skill-evidence-join-host-binding-mismatch');
        }
        return {
            sampleJobId: stored.job.jobId,
            scenarioOrdinal: coordinates.scenarioOrdinal,
            repeatIndex: coordinates.repeatIndex,
            planDigest: packet.planDigest,
            samplePacketDigest: packet.packetDigest,
            executionDigest: execution.executionDigest,
            arms: execution.arms.map((arm) => ({
                variant: arm.variant as SkillEvidenceArm,
                sampleResponseDigest: arm.sampleResponseDigest,
                candidateReceiptDigest: arm.candidateReceiptDigest,
                candidateResponseDigest: arm.candidateResponseDigest,
                commonResponseBinding: arm.commonResponseBinding,
            })),
        };
    });

    const terminalByCoordinate = new Map(batch.terminals.map((terminal) => [terminal.coordinateId, terminal]));
    if (terminalByCoordinate.size !== batch.coordinates.length) reject('skill-evidence-join-host-incomplete');
    const arms = batch.coordinates.map((coordinate) => {
        const terminal = terminalByCoordinate.get(coordinate.coordinateId);
        if (!terminal) reject('skill-evidence-join-host-incomplete');
        // restart-recovery terminal 没有 receipt 身份 ⇒ 不能进入汇合证据。
        const receipt = terminal.candidateReceipt;
        if (!receipt) reject('skill-evidence-join-host-incomplete');
        if (receipt.sampleKey !== coordinate.sampleKey
            || receipt.arm !== coordinate.arm) {
            reject('skill-evidence-join-host-binding-mismatch');
        }
        return {
            sampleKey: coordinate.sampleKey,
            scenarioOrdinal: coordinate.scenarioOrdinal,
            repeatIndex: coordinate.repeatIndex,
            arm: coordinate.arm,
            planDigest: coordinate.planDigest,
            outcome: terminal.outcome,
            receiptDigest: terminal.candidateReceiptDigest,
            responseDigest: terminal.responseDigest,
        };
    });

    const judges = qualitySuite.jobs.map((stored) => {
        const job = stored.job;
        const sample = sampleByJobId.get(job.plan.source.sampleJobId);
        if (!sample) reject('skill-evidence-join-host-binding-mismatch');
        if (job.plan.source.sampleSuiteId !== sampleSuite.suiteId
            || job.plan.source.samplePacketDigest !== sample.packet!.packetDigest
            || job.plan.source.scenarioOrdinal !== suiteCoordinates(sample.job.plan as SkillSampleSuitePlan).scenarioOrdinal
            || job.plan.source.repeatIndex !== suiteCoordinates(sample.job.plan as SkillSampleSuitePlan).repeatIndex) {
            reject('skill-evidence-join-host-binding-mismatch');
        }
        if (!stored.packet || !job.receiptDigest) reject('skill-evidence-join-host-incomplete');
        if (stored.packet.packetDigest !== job.receiptDigest) reject('skill-evidence-join-host-binding-mismatch');
        return {
            jobId: job.jobId,
            sampleJobId: job.plan.source.sampleJobId,
            scenarioOrdinal: job.plan.source.scenarioOrdinal,
            repeatIndex: job.plan.source.repeatIndex,
            judgeSlot: job.plan.suite.judgeSlot,
            judgeOrdinal: job.plan.suite.judgeOrdinal,
            outcome: 'passed' as const,
            packetDigest: stored.packet.packetDigest,
            receiptDigest: job.receiptDigest,
        };
    });

    return joinSkillQualityEvidence({
        sampleSuiteId: sampleSuite.suiteId,
        candidateBatchId: batch.batch.batchId,
        qualitySuiteId: qualitySuite.suiteId,
        samples,
        arms,
        judges,
        joinedAt: input.joinedAt,
    });
}
