/** @author Codex @date 2026-10-18 @version 1.0
 * Candidate 结构化 Diff（只读）：回答「这一版到底改了什么」。
 *
 * 边界：
 * 1) 只比较不可变 bundle（manifest + 规范 JSON IR 正文），不比较运行结果、不比较质量；
 * 2) 输出是**有界**的：变更条数与 operation 键数都有上限，超了只标 `truncated`；
 * 3) 正文不是规范 JSON IR 时 `program=null`——此时仍比较 `bodyHash`，绝不猜语义；
 * 4) 结果与输入顺序无关：同一对 bundle 在任意主机上产出同一份条目顺序（码点排序）。
 */
import { createHash } from 'node:crypto';
import type { AgentSkillBundleV1 } from '@jiuguan/skill-hub';

export const SKILL_CANDIDATE_DIFF_VERSION = 'skill-candidate-diff-v1' as const;
export const SKILL_CANDIDATE_DIFF_MAX_CHANGES = 64;
export const SKILL_CANDIDATE_DIFF_MAX_OPERATION_KEYS = 32;

export interface SkillCandidateDiffSide {
    readonly candidateId: string;
    readonly bundleDigest: string;
    readonly state: string;
    readonly revision: number;
    readonly version: string;
    readonly bodyHash: string;
    readonly bodyTokens: number;
}

export interface SkillCandidateDiffEntry {
    readonly path: string;
    readonly kind: 'added' | 'removed' | 'changed';
    /** 已规范化并截断的展示值；不存在时为 null。 */
    readonly left: string | null;
    readonly right: string | null;
}

export interface SkillCandidateDiffProgram {
    readonly operationsLeft: number;
    readonly operationsRight: number;
    readonly addedOperationKeys: readonly string[];
    readonly removedOperationKeys: readonly string[];
    /** Same operations in a different order; order is significant to the program. */
    readonly orderChanged: boolean;
}

export interface SkillCandidateDiff {
    readonly diffVersion: typeof SKILL_CANDIDATE_DIFF_VERSION;
    readonly left: SkillCandidateDiffSide;
    readonly right: SkillCandidateDiffSide;
    readonly identical: boolean;
    readonly changes: readonly SkillCandidateDiffEntry[];
    readonly truncated: boolean;
    readonly program: SkillCandidateDiffProgram | null;
}

export interface SkillCandidateDiffInput {
    readonly left: Readonly<{
        candidateId: string;
        state: string;
        revision: number;
        bundle: AgentSkillBundleV1;
    }>;
    readonly right: SkillCandidateDiffInput['left'];
}

const MANIFEST_KEYS = Object.freeze([
    'manifestVersion', 'skillId', 'version', 'name', 'description', 'kind', 'owner',
    'capabilityIds', 'taskKinds', 'phases', 'contentModes', 'scope', 'riskTier', 'artifactKind',
    'requires', 'conflictsWith', 'conflictGroup', 'desiredTools', 'writableArtifactKinds',
    'limits', 'inputSchemaDigest', 'outputSchemaDigest', 'bodyHash', 'bodyTokens', 'sourceType',
    'sourceHash', 'sourceRevision', 'provenanceDigest', 'evaluatorId', 'autoPromotion', 'priority',
] as const);

/** 嵌套对象只展开一层（scope / limits），够用且不会把输出撑爆。 */
const NESTED_KEYS = Object.freeze(['scope', 'limits'] as const);

function canonical(input: unknown): string {
    if (input === null || typeof input === 'string' || typeof input === 'boolean'
        || typeof input === 'number') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    const row = input as Record<string, unknown>;
    return `{${Object.keys(row).sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function shortText(value: string, limit = 160): string {
    return value.length <= limit ? value : `${value.slice(0, limit)}…(${value.length}, ${digest(value)})`;
}

function digest(input: string): string {
    return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

function flatten(manifest: Record<string, unknown>): Map<string, string> {
    const map = new Map<string, string>();
    for (const key of MANIFEST_KEYS) {
        const value = manifest[key];
        if (value === undefined) continue;
        if ((NESTED_KEYS as readonly string[]).includes(key) && value
            && typeof value === 'object' && !Array.isArray(value)) {
            for (const inner of Object.keys(value as Record<string, unknown>).sort()) {
                map.set(`${key}.${inner}`, canonical((value as Record<string, unknown>)[inner]));
            }
            continue;
        }
        map.set(key, canonical(value));
    }
    return map;
}

function operationKeys(body: string): readonly string[] | null {
    let parsed: unknown;
    try { parsed = JSON.parse(body); }
    catch { return null; }
    const program = parsed as { programVersion?: unknown; operations?: unknown };
    if (!program || typeof program !== 'object'
        || program.programVersion !== 'agent-skill-program-v1'
        || !Array.isArray(program.operations)) return null;
    const keys: string[] = [];
    for (const operation of program.operations as readonly unknown[]) {
        const row = operation as { primitiveId?: unknown; args?: unknown };
        if (!row || typeof row !== 'object' || typeof row.primitiveId !== 'string') return null;
        // primitiveId + args 摘要：同一条 primitive 换参数就应算「变了」。
        keys.push(`${row.primitiveId}#${digest(canonical(row.args ?? null))}`);
    }
    return keys;
}

function side(input: SkillCandidateDiffInput['left']): SkillCandidateDiffSide {
    const manifest = input.bundle.header.manifest as unknown as Record<string, unknown>;
    return Object.freeze({
        candidateId: input.candidateId,
        bundleDigest: input.bundle.bundleDigest,
        state: String(input.state),
        revision: Number(input.revision),
        version: typeof manifest.version === 'string' ? manifest.version : '',
        bodyHash: typeof manifest.bodyHash === 'string' ? manifest.bodyHash : '',
        bodyTokens: Number(manifest.bodyTokens ?? 0),
    });
}

export function diffSkillCandidates(input: SkillCandidateDiffInput): SkillCandidateDiff {
    const leftManifest = input.left.bundle.header.manifest as unknown as Record<string, unknown>;
    const rightManifest = input.right.bundle.header.manifest as unknown as Record<string, unknown>;
    const left = flatten(leftManifest);
    const right = flatten(rightManifest);
    const allPaths = [...new Set([...left.keys(), ...right.keys()])].sort();

    const changes: SkillCandidateDiffEntry[] = [];
    let truncated = false;
    for (const path of allPaths) {
        const before = left.has(path) ? left.get(path)! : null;
        const after = right.has(path) ? right.get(path)! : null;
        if (before === after) continue;
        if (changes.length >= SKILL_CANDIDATE_DIFF_MAX_CHANGES) { truncated = true; break; }
        changes.push(Object.freeze({
            path: `manifest.${path}`,
            kind: before === null ? 'added' as const : after === null ? 'removed' as const : 'changed' as const,
            left: before === null ? null : shortText(before),
            right: after === null ? null : shortText(after),
        }));
    }

    const leftOperations = operationKeys(input.left.bundle.body);
    const rightOperations = operationKeys(input.right.bundle.body);
    let program: SkillCandidateDiffProgram | null = null;
    if (leftOperations && rightOperations) {
        const remaining = new Map<string, number>();
        for (const key of leftOperations) remaining.set(key, (remaining.get(key) ?? 0) + 1);
        const added: string[] = [];
        for (const key of rightOperations) {
            const count = remaining.get(key) ?? 0;
            if (count > 0) remaining.set(key, count - 1);
            else if (added.length < SKILL_CANDIDATE_DIFF_MAX_OPERATION_KEYS) added.push(key);
            else truncated = true;
        }
        const removed: string[] = [];
        for (const key of leftOperations) {
            const count = remaining.get(key) ?? 0;
            if (count <= 0) continue;
            remaining.set(key, count - 1);
            if (removed.length < SKILL_CANDIDATE_DIFF_MAX_OPERATION_KEYS) removed.push(key);
            else truncated = true;
        }
        const sortedLeft = [...leftOperations].sort();
        const sortedRight = [...rightOperations].sort();
        program = Object.freeze({
            operationsLeft: leftOperations.length,
            operationsRight: rightOperations.length,
            addedOperationKeys: Object.freeze(added.sort()),
            removedOperationKeys: Object.freeze(removed.sort()),
            orderChanged: leftOperations.length === rightOperations.length
                && sortedLeft.every((key, index) => key === sortedRight[index])
                && leftOperations.some((key, index) => key !== rightOperations[index]),
        });
    }

    return Object.freeze({
        diffVersion: SKILL_CANDIDATE_DIFF_VERSION,
        left: side(input.left),
        right: side(input.right),
        identical: changes.length === 0 && program !== null
            && program.addedOperationKeys.length === 0 && program.removedOperationKeys.length === 0
            && input.left.bundle.bundleDigest === input.right.bundle.bundleDigest,
        changes: Object.freeze(changes),
        truncated,
        program,
    });
}
