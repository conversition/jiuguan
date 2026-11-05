/** @author Codex @date 2026-10-26 @version 1.0
 * Bounded CharacterStore readback only. Host-owned ACL, partition and live fences remain outside this module.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { MemoryDb } from './db.ts';
import {
    CharacterStore,
    canonicalCharacterReadback,
    characterReadbackDigest,
    type CharacterReadback,
    type CharacterProjection,
} from './character.ts';
import { StateStore } from './state-store.ts';
import {
    inspectSessionAuthoritySchema,
    readSessionAuthorityCoordinate,
    type SessionAuthorityCoordinate,
} from './session-authority.ts';

export const RP_CHARACTER_SOURCE_VERSION = 'rp-character-source-v1' as const;
export const RP_CHARACTER_SOURCE_LIMITS = Object.freeze({
    maxBytes: 65_536,
    maxStoredBytes: 262_144,
    maxFacts: 32,
    maxRelationships: 16,
    maxAliases: 16,
} as const);

export interface RpCharacterSourceInput {
    readonly sessionKey: string;
    readonly characterId: string;
    readonly maxBytes: number;
    readonly maxFacts: number;
    readonly maxRelationships: number;
}

export interface RpCharacterSourceBody {
    readonly characterId: string;
    readonly identityName: string;
    readonly aliases: readonly string[];
    readonly profile: CharacterReadback['profile'];
    readonly facts: CharacterReadback['facts'];
    readonly relationships: CharacterReadback['relationships'];
    readonly historyCount: number;
    readonly unresolvedCount: number;
    readonly omitted: Readonly<{ aliases: number; profile: number; facts: number; relationships: number }>;
}

export interface RpCharacterSourceFound {
    readonly version: typeof RP_CHARACTER_SOURCE_VERSION;
    readonly status: 'found';
    readonly sourceKind: 'character';
    readonly sourceRef: string;
    readonly sourceRevision: string;
    readonly semanticSourceRevision: string;
    readonly digest: string;
    readonly authority: SessionAuthorityCoordinate;
    readonly characterId: string;
    readonly entityVersion: number;
    readonly snapshotId: string;
    readonly headRevision: number;
    readonly historyEpoch: number;
    readonly estimatedTokens: number;
    readonly bytes: number;
    readonly completeness: 'complete' | 'partial';
    readonly body: RpCharacterSourceBody;
}

export type RpCharacterSourceResult =
    | RpCharacterSourceFound
    | Readonly<{
          version: typeof RP_CHARACTER_SOURCE_VERSION;
          status: 'missing' | 'invalid' | 'limit-exceeded';
          reasonCode:
              | 'rp-character-source-missing'
              | 'rp-character-source-invalid'
              | 'rp-character-source-limit-exceeded';
      }>;

function digest(input: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function freeze<T>(input: T): T {
    if (input && typeof input === 'object') {
        for (const value of Object.values(input)) freeze(value);
        Object.freeze(input);
    }
    return input;
}

function failure(status: 'missing' | 'invalid' | 'limit-exceeded'): RpCharacterSourceResult {
    return Object.freeze({ version: RP_CHARACTER_SOURCE_VERSION, status, reasonCode: `rp-character-source-${status}` });
}

function validInteger(input: unknown, minimum: number, maximum: number): input is number {
    return Number.isSafeInteger(input) && Number(input) >= minimum && Number(input) <= maximum;
}

function normalizedInput(input: RpCharacterSourceInput): RpCharacterSourceInput | null {
    if (
        !input ||
        typeof input !== 'object' ||
        types.isProxy(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
        return null;
    const keys = Reflect.ownKeys(input);
    if (
        keys.some((key) => typeof key !== 'string') ||
        [...keys].sort().join(',') !== 'characterId,maxBytes,maxFacts,maxRelationships,sessionKey'
    )
        return null;
    const values: Record<string, unknown> = {};
    for (const key of keys) {
        if (typeof key !== 'string') return null;
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
        values[key] = descriptor.value;
    }
    if (
        typeof values.sessionKey !== 'string' ||
        !values.sessionKey.trim() ||
        values.sessionKey.length > 240 ||
        values.sessionKey !== values.sessionKey.trim() ||
        /[\u0000-\u001f\u007f]/u.test(values.sessionKey) ||
        typeof values.characterId !== 'string' ||
        !/^char_[A-Za-z0-9_]{1,120}$/u.test(values.characterId) ||
        !validInteger(values.maxBytes, 1, RP_CHARACTER_SOURCE_LIMITS.maxBytes) ||
        !validInteger(values.maxFacts, 0, RP_CHARACTER_SOURCE_LIMITS.maxFacts) ||
        !validInteger(values.maxRelationships, 0, RP_CHARACTER_SOURCE_LIMITS.maxRelationships)
    )
        return null;
    return values as unknown as RpCharacterSourceInput;
}

function validProjection(projection: CharacterProjection, sessionKey: string, characterId: string): boolean {
    if (
        projection.schemaVersion !== 1 ||
        projection.characterId !== characterId ||
        projection.scope?.sessionId !== sessionKey ||
        !validInteger(projection.entityVersion, 1, Number.MAX_SAFE_INTEGER) ||
        !validInteger(projection.scope.historyEpoch, 0, Number.MAX_SAFE_INTEGER) ||
        typeof projection.head?.snapshotId !== 'string' ||
        !projection.head.snapshotId ||
        !validInteger(projection.head.headRevision, 0, Number.MAX_SAFE_INTEGER) ||
        typeof projection.identity?.name !== 'string' ||
        !projection.identity.name ||
        !Array.isArray(projection.identity.aliases) ||
        projection.identity.aliases.some((alias) => typeof alias !== 'string') ||
        !projection.profile ||
        typeof projection.profile !== 'object' ||
        Array.isArray(projection.profile) ||
        !projection.facts ||
        typeof projection.facts !== 'object' ||
        Array.isArray(projection.facts) ||
        !Array.isArray(projection.relationships) ||
        !Array.isArray(projection.history) ||
        !Array.isArray(projection.unresolved) ||
        projection.unresolved.some((value) => typeof value !== 'string')
    )
        return false;
    const kinds = new Set(['fact', 'recall', 'plan', 'hypothesis', 'quoted', 'correction']);
    const statuses = new Set(['confirmed', 'pending', 'unresolved', 'last-known', 'unknown']);
    for (const fact of [
        ...Object.values(projection.profile),
        ...Object.values(projection.facts),
        ...projection.relationships,
        ...projection.history,
    ]) {
        if (
            !fact ||
            typeof fact !== 'object' ||
            !kinds.has(fact.factKind) ||
            !statuses.has(fact.status) ||
            !fact.effectiveAt ||
            typeof fact.effectiveAt !== 'object' ||
            !Array.isArray(fact.sourceRefs) ||
            fact.sourceRefs.some(
                (ref) =>
                    !ref ||
                    typeof ref !== 'object' ||
                    !['message', 'am', 'lore', 'card', 'user'].includes(ref.source) ||
                    typeof ref.recordId !== 'string' ||
                    !ref.recordId,
            )
        )
            return false;
    }
    return projection.relationships.every(
        (relationship) =>
            typeof relationship.relationshipId === 'string' &&
            Boolean(relationship.relationshipId) &&
            typeof relationship.fromCharacterId === 'string' &&
            typeof relationship.toCharacterId === 'string' &&
            typeof relationship.type === 'string' &&
            ['objective', 'subjective'].includes(relationship.perspective),
    );
}

function boundedBody(readback: CharacterReadback, input: RpCharacterSourceInput): RpCharacterSourceBody | null {
    const aliases: string[] = [];
    const profile: CharacterReadback['profile'][number][] = [];
    const facts: CharacterReadback['facts'][number][] = [];
    const relationships: CharacterReadback['relationships'][number][] = [];
    const body = (): RpCharacterSourceBody => ({
        characterId: readback.characterId,
        identityName: readback.identityName,
        aliases,
        profile,
        facts,
        relationships,
        historyCount: readback.history.length,
        unresolvedCount: readback.unresolved.length,
        omitted: {
            aliases: readback.aliases.length - aliases.length,
            profile: readback.profile.length - profile.length,
            facts: readback.facts.length - facts.length,
            relationships: readback.relationships.length - relationships.length,
        },
    });
    const withinBudget = () => Buffer.byteLength(JSON.stringify(body()), 'utf8') <= input.maxBytes;
    if (!withinBudget()) return null;
    const add = <T>(target: T[], value: T): void => {
        target.push(value);
        if (!withinBudget()) target.pop();
    };
    for (const alias of readback.aliases.slice(0, RP_CHARACTER_SOURCE_LIMITS.maxAliases)) add(aliases, alias);
    for (const fact of readback.profile) {
        if (profile.length + facts.length >= input.maxFacts) break;
        add(profile, fact);
    }
    for (const fact of readback.facts) {
        if (profile.length + facts.length >= input.maxFacts) break;
        add(facts, fact);
    }
    for (const relationship of readback.relationships) {
        if (relationships.length >= input.maxRelationships) break;
        add(relationships, relationship);
    }
    return freeze(body());
}

/**
 * Reads one already-initialized Character projection. No migration, hydration, Provider, recall or business write.
 * The caller must bind this primitive inside a trusted Session owner and independently enforce ACL/partition.
 */
export function readRpCharacterSource(
    memory: MemoryDb,
    untrustedInput: RpCharacterSourceInput,
): RpCharacterSourceResult {
    try {
        const input = normalizedInput(untrustedInput);
        if (!input) return failure('invalid');
        const db = memory.db;
        inspectSessionAuthoritySchema(db);
        const authority = readSessionAuthorityCoordinate(db);
        const registry = db
            .prepare('SELECT 1 AS present FROM character_registry WHERE session_key=? AND character_id=?')
            .get(input.sessionKey, input.characterId);
        if (!registry) return failure('missing');
        const row = db
            .prepare(
                `SELECT initialized, length(CAST(state_json AS BLOB)) AS bytes FROM state_snapshot
             WHERE scope='character' AND scope_key=? AND branch_key='main'`,
            )
            .get(`${input.sessionKey}:${input.characterId}`) as { initialized: number; bytes: number } | undefined;
        if (!row || row.initialized !== 1) return failure('missing');
        if (!validInteger(row.bytes, 1, RP_CHARACTER_SOURCE_LIMITS.maxStoredBytes)) return failure('limit-exceeded');
        const store = new StateStore(db);
        const projection = new CharacterStore(db, store).readProjection(input.sessionKey, input.characterId);
        if (!projection || !validProjection(projection, input.sessionKey, input.characterId)) return failure('invalid');
        const aliasSize = db
            .prepare(
                `SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(alias AS BLOB))),0) AS bytes
             FROM character_alias WHERE session_key=? AND character_id=?`,
            )
            .get(input.sessionKey, input.characterId) as { count: number; bytes: number };
        if (aliasSize.count > 64 || aliasSize.bytes > RP_CHARACTER_SOURCE_LIMITS.maxStoredBytes)
            return failure('limit-exceeded');
        const aliases = db
            .prepare('SELECT alias FROM character_alias WHERE session_key=? AND character_id=? ORDER BY alias LIMIT 65')
            .all(input.sessionKey, input.characterId) as { alias: string }[];
        if (aliases.some((alias) => typeof alias.alias !== 'string')) return failure('invalid');
        const historyEpoch = store.historyEpoch(input.sessionKey);
        const currentProjection = {
            ...projection,
            identity: { ...projection.identity, aliases: aliases.map((alias) => alias.alias) },
            scope: { ...projection.scope, historyEpoch },
        };
        const readback = canonicalCharacterReadback(currentProjection);
        const body = boundedBody(readback, input);
        if (!body) return failure('limit-exceeded');
        const after = readSessionAuthorityCoordinate(db);
        if (authority.generation !== after.generation || authority.revision !== after.revision)
            return failure('invalid');
        const sourceRef = `rp-character:${digest({ sessionKey: input.sessionKey, characterId: input.characterId })}`;
        const sourceRevision = digest({
            version: RP_CHARACTER_SOURCE_VERSION,
            sourceRef,
            historyEpoch,
            readbackDigest: characterReadbackDigest(currentProjection),
        });
        const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
        return freeze({
            version: RP_CHARACTER_SOURCE_VERSION,
            status: 'found',
            sourceKind: 'character',
            sourceRef,
            sourceRevision,
            semanticSourceRevision: sourceRevision,
            digest: digest(body),
            authority,
            characterId: input.characterId,
            entityVersion: readback.entityVersion,
            snapshotId: readback.snapshotId,
            headRevision: readback.headRevision,
            historyEpoch,
            estimatedTokens: bytes,
            bytes,
            completeness:
                Object.values(body.omitted).some((count) => count > 0) ||
                body.historyCount > 0 ||
                body.unresolvedCount > 0
                    ? 'partial'
                    : 'complete',
            body,
        });
    } catch {
        return failure('invalid');
    }
}
