/** @author Codex @date 2026-10-17 @version 1.0
 * Administrator-only, read-only projection for one authoritative operational replay observation.
 */
import type { SkillOperationalSourceRuntime, SkillOperationalSourcePublicViewV1, SkillOperationalSourceProofV1 }
    from './skill-hub/skill-operational-source.ts';
import type { AgentClosureStore } from './agent-closure-store.ts';
import type { AgentSkillCandidateRuntime } from './skill-hub/candidate-runtime.ts';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@#-]{0,239}$/u;

/** Most recent bounded Closure window; each returned observation is revalidated by the original source authority. */
export function listSkillOperationalSources(
    runtime: SkillOperationalSourceRuntime | null,
    closures: Pick<AgentClosureStore, 'list'> | null,
    candidateId: string,
    candidates: Pick<AgentSkillCandidateRuntime, 'readCandidate'> | null,
) {
    if (!runtime || !closures || !candidates) return { status: 503, body: { code: 'skill-operational-source-unavailable' } };
    if (!DIGEST.test(candidateId)) return { status: 400, body: { code: 'skill-operational-source-reference-invalid' } };
    try {
        const candidate = candidates.readCandidate(candidateId);
        if (!candidate) return { status: 404, body: { code: 'skill-operational-candidate-not-found' } };
        if (candidate.candidate.state !== 'validated' || candidate.candidate.revision !== 1
            || !candidate.validation || candidate.validation.passed !== true)
            return { status: 409, body: { code: 'skill-operational-candidate-not-current' } };
        const candidateSnapshot = JSON.stringify(candidate);
        const records = closures.list({ status: 'closed', limit: 101 });
        const sources: SkillOperationalSourcePublicViewV1[] = [];
        const proofs: SkillOperationalSourceProofV1[] = [];
        for (const closure of records.slice(0, 100)) {
            if (closure.executionClass !== 'operational-replay') continue;
            const proof = runtime.resolve(candidateId, closure.operationId);
            if (!proof) continue;
            const source = runtime.publicView(proof);
            if (!source || source.candidateId !== candidateId || source.operationId !== closure.operationId)
                return { status: 409, body: { code: 'skill-operational-source-stale' } };
            sources.push(source);
            proofs.push(proof);
        }
        if (JSON.stringify(candidates.readCandidate(candidateId)) !== candidateSnapshot
            || proofs.some((proof, index) => runtime.publicView(proof)?.evidenceDigest !== sources[index]!.evidenceDigest))
            return { status: 409, body: { code: 'skill-operational-source-stale' } };
        return { status: 200, body: { sources, scanned: Math.min(records.length, 100), hasMore: records.length > 100 } };
    } catch {
        return { status: 503, body: { code: 'skill-operational-source-read-unavailable' } };
    }
}

export function readSkillOperationalSource(
    runtime: SkillOperationalSourceRuntime | null,
    candidateId: string,
    operationId: string,
) {
    if (!runtime) return { status: 503, body: { code: 'skill-operational-source-unavailable' } };
    if (!DIGEST.test(candidateId) || !TOKEN.test(operationId)) {
        return { status: 400, body: { code: 'skill-operational-source-reference-invalid' } };
    }
    try {
        const proof = runtime.resolve(candidateId, operationId);
        if (!proof) return { status: 404, body: { code: 'skill-operational-source-not-found' } };
        const source = runtime.publicView(proof);
        return source
            ? { status: 200, body: { source } }
            : { status: 409, body: { code: 'skill-operational-source-stale' } };
    } catch {
        return { status: 503, body: { code: 'skill-operational-source-read-unavailable' } };
    }
}
