/** @author Codex @date 2026-10-26 @version 1.0
 * Session-owned RP source/result ports. Metadata and storage ownership are not execution or ACL grants.
 */
import {
    computeSessionDatabaseSnapshot,
    type MemoryDb,
    type SessionAuthorityCoordinate,
} from '../../memory/public/session-database.ts';
import {
    readRpCharacterSource,
    type RpCharacterSourceInput,
    type RpCharacterSourceResult,
} from '../../memory/public/rp-character-source.ts';
import {
    RpChildAnalysisStore,
    type RpChildAnalysisBindingV1,
    type RpChildAnalysisResultV1,
    type RpChildAnalysisArtifactV1,
    type RpChildAnalysisReadResult,
} from '../../memory/public/rp-child-analysis.ts';

export interface RpAnalysisSessionContext {
    readonly sessionId: string;
    readonly historyEpoch: number;
    readonly sourceRevision: string;
    readonly authority: SessionAuthorityCoordinate;
    readonly activeContentMode: 'nsf' | 'nsfw' | null;
}

export interface RpAnalysisSessionPort {
    readonly version: 'rp-analysis-session-port-v1';
    capture(): RpAnalysisSessionContext | null;
    readCharacter(
        input: Readonly<{
            context: RpAnalysisSessionContext;
            characterId: string;
            maxBytes: number;
            maxFacts: number;
            maxRelationships: number;
        }>,
    ): RpCharacterSourceResult | Readonly<{ status: 'stale' }>;
    append(
        input: Readonly<{
            binding: RpChildAnalysisBindingV1;
            result: RpChildAnalysisResultV1;
            createdAtMs: number;
            expiresAtMs: number;
        }>,
    ): RpChildAnalysisArtifactV1;
    read(
        input: Readonly<{
            payloadRef: string;
            payloadDigest: string;
            binding: RpChildAnalysisBindingV1;
        }>,
    ): RpChildAnalysisReadResult;
}

const PORTS = new WeakSet<object>();

export function isRpAnalysisSessionPort(input: unknown): input is RpAnalysisSessionPort {
    return !!input && typeof input === 'object' && PORTS.has(input);
}

/** Internal factory: only ChatSession supplies its private namespace and actual live turn mode. */
export function createRpAnalysisSessionPort(
    options: Readonly<{
        memoryDb: MemoryDb;
        sessionKey: string;
        sessionId: string;
        readHistoryEpoch: () => number;
        readActiveContentMode: () => 'nsf' | 'nsfw' | null;
        clock: () => number;
    }>,
): RpAnalysisSessionPort {
    const { memoryDb } = options;
    // Explicit install precedes source capture. It is deliberately not a MemoryDb/ChatSession startup side effect.
    const owner = new RpChildAnalysisStore({
        memoryDb,
        sessionId: options.sessionId,
        contentMode: 'nsf',
        clock: options.clock,
        readCurrentAuthority: () => {
            if (options.readActiveContentMode() === 'nsfw') return null;
            return {
                historyEpoch: options.readHistoryEpoch(),
                sourceRevision: computeSessionDatabaseSnapshot(memoryDb).databaseRevision,
            };
        },
    });
    function capture(): RpAnalysisSessionContext | null {
        try {
            return memoryDb.withSessionClaimFence((fence) =>
                Object.freeze({
                    sessionId: options.sessionId,
                    historyEpoch: options.readHistoryEpoch(),
                    sourceRevision: fence.databaseSnapshot.databaseRevision,
                    authority: fence.authority,
                    activeContentMode: options.readActiveContentMode(),
                }),
            );
        } catch {
            return null;
        }
    }
    const port: RpAnalysisSessionPort = Object.freeze({
        version: 'rp-analysis-session-port-v1',
        capture,
        readCharacter(
            input: Parameters<RpAnalysisSessionPort['readCharacter']>[0],
        ): RpCharacterSourceResult | Readonly<{ status: 'stale' }> {
            try {
                return memoryDb.withSessionClaimFence((fence) => {
                    const expected = input.context;
                    if (
                        expected.sessionId !== options.sessionId ||
                        expected.sourceRevision !== fence.databaseSnapshot.databaseRevision ||
                        expected.historyEpoch !== options.readHistoryEpoch() ||
                        expected.authority.generation !== fence.authority.generation ||
                        expected.authority.revision !== fence.authority.revision ||
                        options.readActiveContentMode() === 'nsfw'
                    )
                        return Object.freeze({ status: 'stale' });
                    const request: RpCharacterSourceInput = {
                        sessionKey: options.sessionKey,
                        characterId: input.characterId,
                        maxBytes: input.maxBytes,
                        maxFacts: input.maxFacts,
                        maxRelationships: input.maxRelationships,
                    };
                    return readRpCharacterSource(memoryDb, request);
                });
            } catch {
                return Object.freeze({ status: 'stale' });
            }
        },
        append: (input: Parameters<RpAnalysisSessionPort['append']>[0]) => owner.append(input),
        read: (input: Parameters<RpAnalysisSessionPort['read']>[0]) => owner.read(input),
    });
    PORTS.add(port);
    return port;
}
