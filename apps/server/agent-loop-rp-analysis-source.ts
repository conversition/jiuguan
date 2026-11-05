/** @author Codex @date 2026-10-26 @version 1.0
 * Trusted RP Character/result adapter. Not a Runner, Gateway dispatch grant, verifier receipt or parent join.
 */
import {
    isRpAnalysisSessionPort,
    type RpAnalysisSessionContext,
    type RpAnalysisSessionPort,
} from '../../packages/session/public/rp-analysis-session.ts';
import {
    normalizeRpChildAnalysisBinding,
    normalizeRpChildAnalysisResult,
    rpChildAnalysisDigest,
    RP_CHILD_ANALYSIS_MAX_TTL_MS,
    type RpChildAnalysisBindingV1,
    type RpChildAnalysisArtifactV1,
} from '../../packages/memory/public/rp-child-analysis.ts';
import {
    RP_CHARACTER_SOURCE_LIMITS,
    type RpCharacterSourceFound,
} from '../../packages/memory/public/rp-character-source.ts';
import {
    RP_SCENARIO_TEMPLATE_CATALOG,
    isRpScenarioTemplateCatalog,
    resolveRpScenarioTemplate,
} from './agent-loop-rp-scenario-template.ts';
import type { AgentLoopRefResolverRequest, AgentLoopRefResolution } from './agent-loop-continuation.ts';

export interface RpReviewedCharacterSource {
    readonly characterId: string;
    readonly sourceRef: string;
    readonly revision: string;
    readonly digest: string;
    readonly contentMode: 'nsf';
    readonly maxBytes: number;
    readonly maxFacts: number;
    readonly maxRelationships: number;
}

/** A fresh trusted-host review, not a model field or a claim inferred from Session defaults/character text. */
export interface RpAnalysisSourceAccess {
    readonly binding: RpChildAnalysisBindingV1;
    readonly readAllowed: true;
    readonly sourcePartition: 'reviewed-nsf-character-source';
    readonly sources: readonly RpReviewedCharacterSource[];
}

type Failure = Readonly<{ status: 'missing' | 'forbidden' | 'stale' | 'digest-mismatch' | 'expired' | 'unresolved' }>;
type Authorization =
    | Readonly<{
          status: 'allowed';
          context: RpAnalysisSessionContext;
          sources: readonly RpReviewedCharacterSource[];
      }>
    | Failure;
type ResultRead = Readonly<{ status: 'found'; artifact: RpChildAnalysisArtifactV1 }> | Failure;
const SOURCE_ADAPTER_BINDINGS = new WeakMap<object, RpChildAnalysisBindingV1>();

export type RpAnalysisSourceAdapter = ReturnType<typeof createRpAnalysisSourceAdapter>;

/** Construction identity only; neither structural metadata nor this check grants execution. */
export function isRpAnalysisSourceAdapter(input: unknown): input is RpAnalysisSourceAdapter {
    return !!input && typeof input === 'object' && SOURCE_ADAPTER_BINDINGS.has(input);
}

export function readRpAnalysisSourceBinding(input: unknown): RpChildAnalysisBindingV1 | null {
    return input && typeof input === 'object' ? (SOURCE_ADAPTER_BINDINGS.get(input) ?? null) : null;
}

function invalid(): never {
    throw new TypeError('rp-analysis-source-input-invalid');
}

function safeData<T>(input: T): T {
    // This validates own data and rejects accessors, Proxies, non-JSON values and toJSON hooks before copying.
    rpChildAnalysisDigest(input);
    return JSON.parse(JSON.stringify(input)) as T;
}

function exactKeys(input: object, keys: readonly string[]): void {
    if (Object.keys(input).sort().join('\0') !== [...keys].sort().join('\0')) invalid();
}

function integer(input: unknown, minimum: number, maximum: number): input is number {
    return Number.isSafeInteger(input) && Number(input) >= minimum && Number(input) <= maximum;
}

function watermark(source: RpReviewedCharacterSource) {
    return { sourceRef: source.sourceRef, revision: source.revision, digest: source.digest };
}

function normalizeAccess(input: RpAnalysisSourceAccess): RpAnalysisSourceAccess {
    const safe = safeData(input);
    exactKeys(safe, ['binding', 'readAllowed', 'sourcePartition', 'sources']);
    const binding = normalizeRpChildAnalysisBinding(safe.binding);
    if (
        safe.readAllowed !== true ||
        safe.sourcePartition !== 'reviewed-nsf-character-source' ||
        !Array.isArray(safe.sources) ||
        safe.sources.length < 1 ||
        safe.sources.length > 8
    )
        invalid();
    for (const source of safe.sources) {
        exactKeys(source, [
            'characterId',
            'sourceRef',
            'revision',
            'digest',
            'contentMode',
            'maxBytes',
            'maxFacts',
            'maxRelationships',
        ]);
        if (
            !/^char_[A-Za-z0-9_]{1,120}$/u.test(source.characterId) ||
            !/^rp-character:sha256:[a-f0-9]{64}$/u.test(source.sourceRef) ||
            !/^sha256:[a-f0-9]{64}$/u.test(source.revision) ||
            !/^sha256:[a-f0-9]{64}$/u.test(source.digest) ||
            source.contentMode !== 'nsf' ||
            !integer(source.maxBytes, 1, RP_CHARACTER_SOURCE_LIMITS.maxBytes) ||
            !integer(source.maxFacts, 0, RP_CHARACTER_SOURCE_LIMITS.maxFacts) ||
            !integer(source.maxRelationships, 0, RP_CHARACTER_SOURCE_LIMITS.maxRelationships)
        )
            invalid();
        Object.freeze(source);
    }
    if (
        new Set(safe.sources.map((source) => source.sourceRef)).size !== safe.sources.length ||
        new Set(safe.sources.map((source) => source.characterId)).size !== safe.sources.length ||
        rpChildAnalysisDigest(safe.sources.map(watermark)) !== binding.sourceDigest
    )
        invalid();
    return Object.freeze({ ...safe, binding, sources: Object.freeze(safe.sources) });
}

/** Caller is trusted composition; no instance is installed on any production route by this factory. */
export function createRpAnalysisSourceAdapter(
    options: Readonly<{
        session: RpAnalysisSessionPort;
        binding: RpChildAnalysisBindingV1;
        readAccess: () => RpAnalysisSourceAccess | null;
        clock: () => number;
        catalog?: typeof RP_SCENARIO_TEMPLATE_CATALOG;
    }>,
) {
    if (
        !isRpAnalysisSessionPort(options.session) ||
        typeof options.readAccess !== 'function' ||
        typeof options.clock !== 'function'
    )
        invalid();
    const session = options.session;
    const readAccess = options.readAccess;
    const clock = options.clock;
    const binding = normalizeRpChildAnalysisBinding(options.binding);
    const bindingDigest = rpChildAnalysisDigest(binding);
    const catalog = options.catalog ?? RP_SCENARIO_TEMPLATE_CATALOG;
    if (!isRpScenarioTemplateCatalog(catalog)) invalid();
    const template = resolveRpScenarioTemplate(
        catalog,
        binding.templateId,
        binding.templateVersion,
        binding.templateDigest,
    );
    const ownerRef = `rp-analysis-owner:${binding.sessionId}`;

    function authorize(): Authorization {
        try {
            const raw = readAccess();
            if (!raw) return Object.freeze({ status: 'forbidden' });
            const access = normalizeAccess(raw);
            if (
                access.sources.reduce((total, source) => total + source.maxBytes, 0) >
                template.contextPolicy.maxInputTokens
            )
                return Object.freeze({ status: 'forbidden' });
            if (rpChildAnalysisDigest(access.binding) !== bindingDigest) return Object.freeze({ status: 'forbidden' });
            const context = session.capture();
            if (!context) return Object.freeze({ status: 'unresolved' });
            if (context.sessionId !== binding.sessionId || context.activeContentMode === 'nsfw')
                return Object.freeze({ status: 'forbidden' });
            if (context.historyEpoch !== binding.historyEpoch || context.sourceRevision !== binding.sourceRevision)
                return Object.freeze({ status: 'stale' });
            return Object.freeze({ status: 'allowed', context, sources: access.sources });
        } catch {
            return Object.freeze({ status: 'forbidden' });
        }
    }

    function readCharacter(sourceRef: string): RpCharacterSourceFound | Failure {
        const access = authorize();
        if (access.status !== 'allowed') return access;
        const review = access.sources.find((source) => source.sourceRef === sourceRef);
        if (!review) return Object.freeze({ status: 'forbidden' });
        const result = session.readCharacter({
            context: access.context,
            characterId: review.characterId,
            maxBytes: review.maxBytes,
            maxFacts: review.maxFacts,
            maxRelationships: review.maxRelationships,
        });
        if (result.status === 'missing') return Object.freeze({ status: 'missing' });
        if (result.status === 'stale') return result;
        if (result.status !== 'found') return Object.freeze({ status: 'unresolved' });
        if (result.sourceRef !== review.sourceRef || result.sourceRevision !== review.revision)
            return Object.freeze({ status: 'stale' });
        if (result.digest !== review.digest) return Object.freeze({ status: 'digest-mismatch' });
        const after = authorize();
        if (after.status !== 'allowed') return after;
        if (rpChildAnalysisDigest(after.sources) !== rpChildAnalysisDigest(access.sources))
            return Object.freeze({ status: 'forbidden' });
        return result;
    }

    function readResult(payloadRef: string, payloadDigest: string): ResultRead {
        const access = authorize();
        if (access.status !== 'allowed') return access;
        try {
            const result = session.read({ payloadRef, payloadDigest, binding });
            if (result.status !== 'found') return result;
            const after = authorize();
            if (after.status !== 'allowed') return after;
            if (rpChildAnalysisDigest(after.sources) !== rpChildAnalysisDigest(access.sources))
                return Object.freeze({ status: 'forbidden' });
            return result;
        } catch {
            return Object.freeze({ status: 'unresolved' });
        }
    }

    function loaderRef(artifact: RpChildAnalysisArtifactV1): string {
        return (
            `rp-analysis-loader:${artifact.payloadRef.slice('rp-child-analysis:'.length)}:` +
            `${artifact.payloadDigest.slice(7)}:${bindingDigest.slice(7)}`
        );
    }

    const adapter = Object.freeze({
        ownerRef,
        /** Metadata-only current Session/ACL assertion; it grants no execution or business-write capability. */
        assertCurrent(): void {
            const access = authorize();
            if (access.status !== 'allowed') throw new Error(`rp-analysis-source-${access.status}`);
        },
        readCharacter,
        /** Host-owned task artifact publication, never a child Memory/business-write capability. */
        saveResult(input: unknown, ttlMs = RP_CHILD_ANALYSIS_MAX_TTL_MS): RpChildAnalysisArtifactV1 {
            const result = normalizeRpChildAnalysisResult(input);
            const access = authorize();
            if (access.status !== 'allowed') throw new Error(`rp-analysis-source-${access.status}`);
            if (
                !integer(ttlMs, 1, RP_CHILD_ANALYSIS_MAX_TTL_MS) ||
                result.templateId !== binding.templateId ||
                rpChildAnalysisDigest(result.sourceWatermarks) !== binding.sourceDigest ||
                result.conclusions.some((conclusion) =>
                    conclusion.evidenceRefs.some((ref) => !access.sources.some((source) => source.sourceRef === ref)),
                )
            )
                invalid();
            for (const source of access.sources) {
                const actual = readCharacter(source.sourceRef);
                if (actual.status !== 'found') throw new Error(`rp-analysis-source-${actual.status}`);
                if (actual.completeness === 'partial' && result.completeness === 'complete')
                    throw new Error('rp-analysis-source-incomplete');
            }
            const now = clock();
            if (!integer(now, 0, Number.MAX_SAFE_INTEGER - ttlMs)) invalid();
            const finalAccess = authorize();
            if (
                finalAccess.status !== 'allowed' ||
                rpChildAnalysisDigest(finalAccess.sources) !== rpChildAnalysisDigest(access.sources)
            )
                throw new Error('rp-analysis-source-forbidden');
            return session.append({ binding, result, createdAtMs: now, expiresAtMs: now + ttlMs });
        },
        /** CX-4 only sees location, freshness and bounded expansion metadata, never result body. */
        resolve(request: AgentLoopRefResolverRequest): AgentLoopRefResolution {
            let safe: AgentLoopRefResolverRequest;
            try {
                safe = safeData(request);
                exactKeys(safe, [
                    'refId',
                    'kind',
                    'ownerRef',
                    'expectedDigest',
                    ...(safe.expectedRevision === undefined ? [] : ['expectedRevision']),
                ]);
            } catch {
                return Object.freeze({ status: 'forbidden' });
            }
            if (safe.kind !== 'session-artifact' || safe.ownerRef !== ownerRef)
                return Object.freeze({ status: 'forbidden' });
            const read = readResult(safe.refId, safe.expectedDigest);
            if (
                read.status === 'forbidden' ||
                read.status === 'missing' ||
                read.status === 'stale' ||
                read.status === 'digest-mismatch'
            )
                return Object.freeze({ status: read.status });
            if (read.status === 'expired') return Object.freeze({ status: 'missing' });
            if (read.status !== 'found') return Object.freeze({ status: 'found' }); // CX-4 unresolved: no digest.
            const tokens = Buffer.byteLength(JSON.stringify(read.artifact.result), 'utf8');
            return Object.freeze({
                status: 'found',
                revision: binding.sourceRevision,
                digest: read.artifact.payloadDigest,
                expandable: Object.freeze({ loaderRef: loaderRef(read.artifact), tokens }),
            });
        },
        /** Stateless loader survives process restart. Its token identifies data; it never confers ACL authority. */
        expand(input: Readonly<{ loaderRef: string; budgetTokens: number }>) {
            let safe: typeof input;
            try {
                safe = safeData(input);
                exactKeys(safe, ['loaderRef', 'budgetTokens']);
            } catch {
                return Object.freeze({ status: 'forbidden' as const });
            }
            const match = /^rp-analysis-loader:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(safe.loaderRef);
            if (!match || match[3] !== bindingDigest.slice(7) || !integer(safe.budgetTokens, 0, 32_768))
                return Object.freeze({ status: 'forbidden' as const });
            const read = readResult(`rp-child-analysis:${match[1]}`, `sha256:${match[2]}`);
            if (read.status !== 'found') return read;
            const tokens = Buffer.byteLength(JSON.stringify(read.artifact.result), 'utf8');
            if (tokens > safe.budgetTokens) return Object.freeze({ status: 'budget-exhausted' as const, tokens });
            return Object.freeze({ status: 'found' as const, tokens, result: read.artifact.result });
        },
    });
    SOURCE_ADAPTER_BINDINGS.set(adapter, binding);
    return adapter;
}
