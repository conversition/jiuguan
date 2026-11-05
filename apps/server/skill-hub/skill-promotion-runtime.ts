/** @author Codex @date 2026-10-18 @version 1.0
 * D-Q3a2c 组合根：把 adoption / channel / candidate 三个 Store 与发布服务装到一起。
 *
 * 边界：
 * 1) **默认不建库**：未 opt-in 且三个库都不存在 ⇒ 返回 null（路由 503）；
 * 2) 已存在库但未 opt-in ⇒ 只读可用（指针/历史/体检），`promote` / `retire` 一律 `disabled`；
 * 3) 汇合 resolver 缺端口（candidate batch store 尚未接线）⇒ `promote` 报
 *    `skill-promotion-evidence-unavailable`，绝不降级成「大概能用」；
 * 4) 不激活 live、不写 Active；本模块只动 Channel 指针与候选记录。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
    AgentSkillCandidateStore, AGENT_SKILL_CANDIDATE_DB_FILE,
} from '../agent-skill-candidate-store.ts';
import {
    SkillCandidateAdoptionStore, SKILL_CANDIDATE_ADOPTION_DB_FILE,
} from '../skill-candidate-adoption-store.ts';
import {
    SkillChannelStore, SKILL_CHANNEL_DB_FILE,
    type SkillChannelPointer,
    type SkillChannelEvidenceRef,
} from '../skill-candidate-promotion-store.ts';
import {
    SkillPromotionService, type SkillPromotionInspectInput, type SkillPromotionApplyInput,
    type SkillPromotionOutcome, type SkillRetireInput, type SkillRetireOutcome,
    type SkillPromotionEvidenceRef, type SkillPromotionResolvedJoin,
} from '../skill-promotion-service.ts';
import { readSkillQualityEvidenceJoin, type SkillEvidenceJoin } from '../skill-evidence-join.ts';
import {
    decideSkillQualityVerdict, verdictInputFromOfflineReceipt,
    type SkillQualityVerdict, type SkillQualityVerdictInput,
} from '../skill-quality-verdict.ts';
import type { SkillPromotionPreflight } from '../skill-promotion-preflight.ts';
import {
    buildSkillPromotionOverview, type SkillPromotionOverview,
} from '../skill-promotion-overview.ts';
import { diffSkillCandidates, type SkillCandidateDiff } from '../skill-candidate-diff.ts';
import {
    buildSkillQualityEvidenceJoin,
} from '../skill-evidence-join-host.ts';
import type { SkillSampleStoredSuite } from '../skill-sample-store.ts';
import type { SkillQualityStoredSuite } from '../skill-quality-store.ts';
import {
    currentCompleteCandidateEvaluationBatch, type CandidateEvaluationStoredBatch,
} from '../candidate-evaluation-batch-store.ts';
import type { SkillQualityOfflineReceipt } from '../skill-quality-offline.ts';
import { readSkillActiveDiff } from './skill-active-diff.ts';

export const SKILL_PROMOTION_DISABLED = 'skill-promotion-disabled' as const;

export interface SkillPromotionRuntimeOptions {
    readonly dataDir: string;
    /** opt-in：允许写（promote / retire）并在库不存在时建库。 */
    readonly enabled: () => boolean;
    readonly styleCompileLiveEnabled?: () => boolean;
    readonly now?: () => string;
    /** 只读：按 quality suite 读离线回执，用来重算裁决。缺端口 ⇒ promote 不可用。 */
    readonly readQualityReceipt?: (suiteId: string) => SkillQualityOfflineReceipt | null;
    /** 只读：三源汇合。缺端口 ⇒ promote 不可用（retire / 读路由不受影响）。 */
    readonly resolveJoin?: (ref: SkillPromotionEvidenceRef) => SkillPromotionResolvedJoin;
    /**
     * 汇合的三个读端口（组合根负责接真 Store）。三者齐备时才启用 `resolveJoin` 的默认实现；
     * 任何一个缺失都按「没有端口」处理，报 `skill-evidence-join-host-source-missing`。
     */
    readonly joinPorts?: {
        readonly readSampleSuite: (suiteId: string) => SkillSampleStoredSuite | null;
        readonly readQualitySuite: (suiteId: string) => SkillQualityStoredSuite | null;
        readonly readBatch: (batchId: string) => CandidateEvaluationStoredBatch | null;
        readonly readBatchReadOnly?: (batchId: string) => CandidateEvaluationStoredBatch | null;
        readonly listBatches?: (candidateId: string, cursor: string) => Readonly<{
            batches: readonly Readonly<{ batchId: string; sampleSuiteId: string }>[];
            hasMore: boolean; nextCursor: string | null; unavailable: boolean;
        }>;
        readonly listQualities?: (sampleSuiteId: string, cursor: string) => Readonly<{
            suiteIds: readonly string[]; hasMore: boolean; nextCursor: string | null; unavailable: boolean;
        }>;
    };
    readonly onFailure?: (code: string) => void;
}

/** 和解结果的一行：只描述**已经发生的**动作，不做推断。 */
export interface SkillRetirementReconcileEntry {
    readonly channelId: string;
    readonly outcome: 'rolled-back' | 'no-fallback' | 'skipped' | 'failed';
    readonly pointerRevision: number;
    readonly candidateState: string | null;
}

export interface SkillPromotionRuntime {
    readonly writesEnabled: boolean;
    readActiveDiff(candidateId: string): ReturnType<typeof readSkillActiveDiff>;
    readPreflight(input: SkillPromotionInspectInput): SkillPromotionPreflight;
    readPointer(channelId: string): SkillChannelPointer | null;
    readChannelEvidence(channelId: string): Readonly<{ pointer: SkillChannelPointer; evidence: SkillChannelEvidenceRef }> | null;
    readHistory(channelId: string): readonly Readonly<Record<string, unknown>>[];
    readOverview(input?: { readonly limit?: number; readonly cursor?: number }): SkillPromotionOverview;
    /**
     * 退役和解：只处理「指针所指候选已经是 killed、但指针还没退回上一格」的半途状态
     * （`retire` 在 kill 成功、rollback 失败时会留下它）。**不会**杀任何活着的候选，
     * 也不会碰 healthy 指针；rev1 无父版本时只报 `no-fallback`，不改状态。
     */
    reconcileRetirements(): readonly SkillRetirementReconcileEntry[];
    /** 两个候选的不可变 bundle 结构化 Diff；任一记录不存在 ⇒ `candidate-not-found`。 */
    readCandidateDiff(leftId: string, rightId: string): SkillCandidateDiff;
    listEvidence(candidateId: string, batchCursor: string, qualityCursor: string, expectedBatchId: string): Readonly<{
        entries: readonly Readonly<{ sampleSuiteId: string; batchId: string; qualitySuiteId: string }>[];
        hasMoreBatches: boolean; nextBatchCursor: string | null;
        hasMoreQualities: boolean; nextQualityCursor: string | null; currentBatchId: string | null; unavailable: boolean;
    }>;
    adopt(input: SkillCandidateAdoptInput): SkillCandidateAdoptOutcome;
    promote(input: SkillPromotionApplyInput): SkillPromotionOutcome;
    retire(input: SkillRetireInput): SkillRetireOutcome;
    close(): void;
}

export interface SkillCandidateAdoptInput extends SkillPromotionEvidenceRef {
    readonly candidateId: string;
    readonly expectedRevision: 1;
}

export interface SkillCandidateAdoptOutcome {
    readonly candidateId: string;
    readonly candidateRevision: 2;
    readonly adoptionDigest: string;
    readonly joinDigest: string;
}

/** 裁决生成时间由调用方给出（可复算）；这里只做回执 → 输入 → 裁决的确定性映射。 */
function verdictFromReceipt(
    receipt: SkillQualityOfflineReceipt,
    qualitySuiteId: string,
    decidedAt: string,
): SkillQualityVerdict {
    if (receipt.qualitySuiteId !== qualitySuiteId) {
        throw new Error('skill-promotion-quality-suite-unavailable');
    }
    return decideSkillQualityVerdict(verdictInputFromOfflineReceipt(receipt), decidedAt);
}

export function openSkillPromotionRuntime(options: SkillPromotionRuntimeOptions): SkillPromotionRuntime | null {
    const writeEnabled = options.enabled();
    const files = [AGENT_SKILL_CANDIDATE_DB_FILE, SKILL_CANDIDATE_ADOPTION_DB_FILE, SKILL_CHANNEL_DB_FILE];
    const anyExists = files.some((file) => existsSync(join(options.dataDir, file)));
    // 未 opt-in 且从未建过库 ⇒ 不创建任何文件，直接视为未启用。
    if (!writeEnabled && !anyExists) return null;

    let candidates: AgentSkillCandidateStore | null = null;
    let adoptions: SkillCandidateAdoptionStore | null = null;
    let channels: SkillChannelStore | null = null;
    try {
        candidates = new AgentSkillCandidateStore({ dataDir: options.dataDir, now: options.now });
        const candidatePort = {
            readCandidate: (candidateId: string) => {
                const stored = candidates!.readCandidate(candidateId);
                return stored
                    ? {
                        state: stored.candidate.state,
                        revision: stored.candidate.revision,
                        validationEvidenceDigest: stored.candidate.validationEvidenceDigest,
                    }
                    : null;
            },
        };
        adoptions = new SkillCandidateAdoptionStore({
            dataDir: options.dataDir, now: options.now, candidate: candidatePort,
            batch: options.joinPorts ? {
                readBatchCandidateId: (batchId) => currentCompleteCandidateEvaluationBatch(
                    options.joinPorts!.readBatch(batchId),
                )?.source.candidateId ?? null,
            } : undefined,
        });
        channels = new SkillChannelStore({
            dataDir: options.dataDir, now: options.now, candidate: candidatePort,
        });
    } catch {
        try { candidates?.close(); } catch { /* 保持可选服务的关闭态 */ }
        try { adoptions?.close(); } catch { /* 同上 */ }
        try { channels?.close(); } catch { /* 同上 */ }
        try { options.onFailure?.('skill-promotion-open-failed'); } catch { /* 可选服务不阻断启动 */ }
        return null;
    }

    const candidateStore = candidates;
    const adoptionStore = adoptions;
    const channelStore = channels;
    const requireWrites = (): void => {
        if (!writeEnabled) throw new Error(SKILL_PROMOTION_DISABLED);
    };
    const resolveVerdict = (input: { qualitySuiteId: string; decidedAt: string }): SkillQualityVerdict => {
        const read = options.readQualityReceipt;
        if (!read) throw new Error('skill-promotion-quality-suite-unavailable');
        const receipt = read(input.qualitySuiteId);
        if (!receipt) throw new Error('skill-promotion-quality-suite-unavailable');
        return verdictFromReceipt(receipt, input.qualitySuiteId, input.decidedAt);
    };
    const resolveAdoptionJoin = (ref: SkillPromotionEvidenceRef, joinedAt: string, readOnly = false): SkillPromotionResolvedJoin => {
        if (options.resolveJoin) return options.resolveJoin(ref);
        const ports = options.joinPorts;
        if (!ports) throw new Error('skill-evidence-join-host-source-missing');
        if (readOnly && !ports.readBatchReadOnly) throw new Error('skill-evidence-join-host-source-missing');
        const readBatch = readOnly ? ports.readBatchReadOnly! : ports.readBatch;
        const batch = currentCompleteCandidateEvaluationBatch(readBatch(ref.batchId));
        if (!batch) throw new Error('skill-evidence-join-host-source-missing');
        const join = buildSkillQualityEvidenceJoin({
            sampleStore: { readSuite: (suiteId) => ports.readSampleSuite(suiteId) },
            candidateStore: { readBatch: (batchId) => readBatch(batchId) },
            qualityStore: { readSuite: (suiteId) => ports.readQualitySuite(suiteId) },
            sampleSuiteId: ref.sampleSuiteId, batchId: ref.batchId,
            qualitySuiteId: ref.qualitySuiteId, joinedAt,
        });
        return Object.freeze({ candidateId: batch.source.candidateId, join });
    };
    const service = new SkillPromotionService({
        readCurrentCompleteBatchCandidateId: (batchId) => {
            const ports = options.joinPorts;
            if (!ports) return null;
            return currentCompleteCandidateEvaluationBatch(
                ports.readBatch(batchId),
            )?.source.candidateId ?? null;
        },
        adoption: { read: (candidateId: string) => adoptionStore.read(candidateId) },
        candidate: {
            readCandidate: (candidateId: string) => {
                const stored = candidateStore.readCandidate(candidateId);
                return stored
                    ? { state: stored.candidate.state, revision: stored.candidate.revision }
                    : null;
            },
            kill: (candidateId: string, input: unknown) => candidateStore.kill(candidateId, input),
        },
        channel: {
            readPointer: (channelId: string) => channelStore.readPointer(channelId),
            promote: (input: unknown) => channelStore.promote(input),
            rollback: (input: unknown) => channelStore.rollback(input),
            assertRetirementReady: (channelId: string, revision: number, candidateId: string) =>
                channelStore.assertRetirementReady(channelId, revision, candidateId),
            withRetirementLock: <T>(work: () => T) => channelStore.withRetirementLock(work),
        },
        resolveJoin: (ref) => {
            if (options.resolveJoin) return options.resolveJoin(ref);
            const ports = options.joinPorts;
            if (!ports) throw new Error('skill-evidence-join-host-source-missing');
            const batch = currentCompleteCandidateEvaluationBatch(ports.readBatch(ref.batchId));
            if (!batch) throw new Error('skill-evidence-join-host-source-missing');
            const adoption = adoptionStore.read(batch.source.candidateId)?.adoption;
            const joinedAt = adoptionStore.readJoinedAt(batch.source.candidateId);
            if (!adoption || !joinedAt) throw new Error('skill-evidence-join-adoption-source-missing');
            const join = buildSkillQualityEvidenceJoin({
                sampleStore: { readSuite: (suiteId) => ports.readSampleSuite(suiteId) },
                candidateStore: { readBatch: (batchId) => ports.readBatch(batchId) },
                qualityStore: { readSuite: (suiteId) => ports.readQualitySuite(suiteId) },
                sampleSuiteId: ref.sampleSuiteId,
                batchId: ref.batchId,
                qualitySuiteId: ref.qualitySuiteId,
                joinedAt,
            });
            if (join.joinDigest !== adoption.joinDigest) throw new Error('skill-evidence-join-adoption-source-mismatch');
            return Object.freeze({ candidateId: batch.source.candidateId, join });
        },
        resolveVerdict,
    });

    return Object.freeze({
        writesEnabled: writeEnabled,
        readActiveDiff: (candidateId: string) => readSkillActiveDiff({ candidateId,
            readCandidate: id => candidateStore.readCandidate(id), enabled: () => options.styleCompileLiveEnabled?.() === true }),
        readPreflight: (input: SkillPromotionInspectInput) => service.inspect(input),
        readPointer: (channelId: string) => channelStore.readPointer(channelId),
        readChannelEvidence: (channelId: string) => {
            const retained = channelStore.readCurrentEvidence(channelId);
            if (!retained) return null;
            const { pointer, evidence } = retained;
            const candidate = candidateStore.readCandidate(pointer.candidateId);
            const adoption = adoptionStore.read(pointer.candidateId)?.adoption;
            if (!candidate || candidate.candidate.state !== 'validated' || candidate.candidate.revision !== 2
                || !candidate.validation?.passed || !adoption || adoption.adoptionDigest !== pointer.adoptionDigest
                || candidateStore.readAdoptionReceipt(pointer.candidateId)?.adoptionDigest !== adoption.adoptionDigest
                || adoption.joinDigest !== evidence.joinDigest || adoption.evidenceDigest !== evidence.joinDigest
                || adoption.candidateValidationEvidenceDigest !== candidate.candidate.validationEvidenceDigest
                || adoptionStore.readJoinedAt(pointer.candidateId) !== evidence.joinedAt) {
                throw new Error('skill-channel-evidence-stale');
            }
            const ref = { sampleSuiteId: evidence.sampleSuiteId, batchId: evidence.batchId, qualitySuiteId: evidence.qualitySuiteId };
            const verify = () => {
                const resolved = resolveAdoptionJoin(ref, evidence.joinedAt, true);
                const join = readSkillQualityEvidenceJoin(resolved.join);
                const verdict = resolveVerdict({ qualitySuiteId: evidence.qualitySuiteId, decidedAt: evidence.decidedAt });
                if (resolved.candidateId !== pointer.candidateId || join.sampleSuiteId !== evidence.sampleSuiteId
                    || join.candidateBatchId !== evidence.batchId || join.qualitySuiteId !== evidence.qualitySuiteId
                    || join.joinedAt !== evidence.joinedAt || join.joinDigest !== evidence.joinDigest
                    || verdict.verdictDigest !== pointer.verdictDigest || verdict.verdict !== 'candidate-better') {
                    throw new Error('skill-channel-evidence-stale');
                }
            };
            verify();
            if (JSON.stringify(channelStore.readCurrentEvidence(channelId)) !== JSON.stringify(retained)
                || JSON.stringify(candidateStore.readCandidate(pointer.candidateId)) !== JSON.stringify(candidate)
                || JSON.stringify(adoptionStore.read(pointer.candidateId)?.adoption) !== JSON.stringify(adoption)) {
                throw new Error('skill-channel-evidence-stale');
            }
            verify();
            return retained;
        },
        readHistory: (channelId: string) => channelStore.history(channelId),
        readCandidateDiff: (leftId: string, rightId: string) => {
            const left = candidateStore.readCandidate(leftId);
            const right = candidateStore.readCandidate(rightId);
            if (!left || !right) throw new Error('candidate-not-found');
            return diffSkillCandidates({
                left: {
                    candidateId: leftId, state: left.candidate.state,
                    revision: left.candidate.revision, bundle: left.bundle,
                },
                right: {
                    candidateId: rightId, state: right.candidate.state,
                    revision: right.candidate.revision, bundle: right.bundle,
                },
            });
        },
        listEvidence: (candidateId: string, batchCursor: string, qualityCursor: string, expectedBatchId: string) => {
            if (!/^sha256:[a-f0-9]{64}$/u.test(candidateId)) throw new Error('skill-evidence-reference-invalid');
            if ((batchCursor && !/^sha256:[a-f0-9]{64}$/u.test(batchCursor))
                || (qualityCursor && !/^sha256:[a-f0-9]{64}$/u.test(qualityCursor))
                || (expectedBatchId && !/^sha256:[a-f0-9]{64}$/u.test(expectedBatchId))
                || Boolean(qualityCursor) !== Boolean(expectedBatchId)) {
                throw new Error('skill-evidence-reference-invalid');
            }
            const ports = options.joinPorts;
            if (!ports?.listBatches || !ports.listQualities) throw new Error('skill-evidence-discovery-unavailable');
            const source = candidateStore.readCandidate(candidateId);
            if (!source) throw new Error('candidate-not-found');
            if (source.candidate.state !== 'validated' || ![1, 2].includes(source.candidate.revision)) {
                throw new Error('skill-evidence-candidate-invalid');
            }
            const snapshot = JSON.stringify(source);
            const page = ports.listBatches(candidateId, batchCursor);
            const currentBatchId = page.batches[0]?.batchId ?? null;
            if (expectedBatchId && currentBatchId !== expectedBatchId) throw new Error('skill-evidence-discovery-stale');
            const entries: Array<Readonly<{ sampleSuiteId: string; batchId: string; qualitySuiteId: string }>> = [];
            let hasMoreQualities = false, nextQualityCursor: string | null = null, unavailable = page.unavailable;
            for (const item of page.batches) {
                const qualities = ports.listQualities(item.sampleSuiteId, qualityCursor);
                hasMoreQualities = qualities.hasMore; nextQualityCursor = qualities.nextCursor;
                unavailable ||= qualities.unavailable;
                for (const qualitySuiteId of qualities.suiteIds) {
                    const quality = ports.readQualitySuite(qualitySuiteId);
                    if (!quality || quality.state !== 'succeeded' || quality.sourceCurrent !== true
                        || quality.plans[0]?.source.sampleSuiteId !== item.sampleSuiteId) {
                        throw new Error('skill-evidence-discovery-stale');
                    }
                    entries.push(Object.freeze({ sampleSuiteId: item.sampleSuiteId, batchId: item.batchId, qualitySuiteId }));
                }
            }
            if (JSON.stringify(candidateStore.readCandidate(candidateId)) !== snapshot) {
                throw new Error('skill-evidence-discovery-stale');
            }
            if (JSON.stringify(ports.listBatches(candidateId, batchCursor)) !== JSON.stringify(page)) {
                throw new Error('skill-evidence-discovery-stale');
            }
            return Object.freeze({ entries: Object.freeze(entries), hasMoreBatches: page.hasMore,
                nextBatchCursor: page.nextCursor, hasMoreQualities, nextQualityCursor, currentBatchId, unavailable });
        },
        adopt: (input: SkillCandidateAdoptInput) => {
            requireWrites();
            if (!input || input.expectedRevision !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(input.candidateId)) {
                throw new Error('skill-adoption-request-invalid');
            }
            const ref = { sampleSuiteId: input.sampleSuiteId, batchId: input.batchId, qualitySuiteId: input.qualitySuiteId };
            const ports = options.joinPorts;
            if (!ports) throw new Error('skill-adoption-evidence-unavailable');
            const batch = currentCompleteCandidateEvaluationBatch(ports.readBatch(ref.batchId));
            if (!batch || batch.source.candidateId !== input.candidateId) throw new Error('skill-adoption-evidence-unavailable');
            const source = candidateStore.readCandidate(input.candidateId);
            if (!source || source.candidate.state !== 'validated'
                || (source.candidate.revision !== 1 && source.candidate.revision !== 2)
                || !source.validation?.passed || !source.candidate.validationEvidenceDigest) {
                throw new Error('skill-adoption-candidate-invalid');
            }
            const previous = adoptionStore.read(input.candidateId)?.adoption ?? null;
            const joinedAt = previous ? adoptionStore.readJoinedAt(input.candidateId) : (options.now ?? (() => new Date().toISOString()))();
            if (!joinedAt) throw new Error('skill-adoption-evidence-unavailable');
            const resolved = resolveAdoptionJoin(ref, joinedAt);
            const join = readSkillQualityEvidenceJoin(resolved.join);
            if (resolved.candidateId !== input.candidateId || join.sampleSuiteId !== ref.sampleSuiteId
                || join.candidateBatchId !== ref.batchId || join.qualitySuiteId !== ref.qualitySuiteId
                || (previous && (join.joinedAt !== joinedAt || join.joinDigest !== previous.joinDigest
                    || previous.evidenceDigest !== join.joinDigest
                    || previous.candidateValidationEvidenceDigest !== source.candidate.validationEvidenceDigest))) {
                throw new Error('skill-adoption-evidence-unavailable');
            }
            if (!previous && source.candidate.revision !== 1) throw new Error('skill-adoption-candidate-invalid');
            const receipt = previous ?? adoptionStore.adopt({ candidateId: input.candidateId, expectedRevision: 1,
                join, evidenceDigest: join.joinDigest,
                candidateValidationEvidenceDigest: source.candidate.validationEvidenceDigest });
            // A retained ledger receipt alone is not authority to finish a prior partial write.
            // Re-read the batch and all three sources after the ledger write, before consumption.
            const currentBatch = currentCompleteCandidateEvaluationBatch(ports.readBatch(ref.batchId));
            const rechecked = resolveAdoptionJoin(ref, join.joinedAt);
            const currentJoin = readSkillQualityEvidenceJoin(rechecked.join);
            if (!currentBatch || currentBatch.source.candidateId !== input.candidateId
                || rechecked.candidateId !== input.candidateId || currentJoin.joinDigest !== receipt.joinDigest
                || currentJoin.joinedAt !== join.joinedAt) {
                throw new Error('skill-adoption-evidence-unavailable');
            }
            try { candidateStore.consumeAdoptionReceipt(receipt); }
            catch { throw new Error('skill-adoption-consume-failed'); }
            return Object.freeze({ candidateId: input.candidateId, candidateRevision: 2 as const,
                adoptionDigest: receipt.adoptionDigest, joinDigest: receipt.joinDigest });
        },
        reconcileRetirements: () => {
            requireWrites();
            const entries: SkillRetirementReconcileEntry[] = [];
            for (const pointer of channelStore.listPointers()) {
                let state: string | null = null;
                try {
                    state = candidateStore.readCandidate(pointer.candidateId)?.candidate.state ?? null;
                } catch {
                    entries.push(Object.freeze({
                        channelId: pointer.channelId, outcome: 'failed' as const,
                        pointerRevision: pointer.revision, candidateState: null,
                    }));
                    continue;
                }
                if (state !== 'killed') {
                    entries.push(Object.freeze({
                        channelId: pointer.channelId, outcome: 'skipped' as const,
                        pointerRevision: pointer.revision, candidateState: state,
                    }));
                    continue;
                }
                if (pointer.revision < 2) {
                    entries.push(Object.freeze({
                        channelId: pointer.channelId, outcome: 'no-fallback' as const,
                        pointerRevision: pointer.revision, candidateState: state,
                    }));
                    continue;
                }
                try {
                    service.retire({
                        channelId: pointer.channelId,
                        expectedChannelRevision: pointer.revision,
                        candidateId: pointer.candidateId,
                        reasonCode: 'reconcile-killed-candidate',
                    });
                    entries.push(Object.freeze({
                        channelId: pointer.channelId, outcome: 'rolled-back' as const,
                        pointerRevision: pointer.revision, candidateState: state,
                    }));
                } catch {
                    entries.push(Object.freeze({
                        channelId: pointer.channelId, outcome: 'failed' as const,
                        pointerRevision: pointer.revision, candidateState: state,
                    }));
                }
            }
            return Object.freeze(entries);
        },
        readOverview: (input: { readonly limit?: number; readonly cursor?: number } = {}) =>
            buildSkillPromotionOverview({
                listCandidates: (page) => candidateStore.list(page),
                readAdoption: (candidateId: string) => adoptionStore.read(candidateId),
                listPointers: () => channelStore.listPointers(),
                writesEnabled: writeEnabled,
                now: options.now ?? (() => new Date().toISOString()),
            }, input),
        promote: (input: SkillPromotionApplyInput) => { requireWrites(); return service.apply(input); },
        retire: (input: SkillRetireInput) => { requireWrites(); return service.retire(input); },
        close: () => {
            try { channelStore.close(); } catch { /* ignore */ }
            try { adoptionStore.close(); } catch { /* ignore */ }
            try { candidateStore.close(); } catch { /* ignore */ }
        },
    });
}
