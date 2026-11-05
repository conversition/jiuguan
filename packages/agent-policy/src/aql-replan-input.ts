/**
 * @author  : Codex
 * @time    : 2026-10-27
 * @function: Validate and render the five existing AQL inputs without granting source or execution authority.
 * @version : v1.0
 */
export const AQL_REPLAN_INPUT_VERSION = 'aql-replan-input-v1' as const;

export interface AqlReplanInputSnapshot {
    readonly version: typeof AQL_REPLAN_INPUT_VERSION;
    readonly playerInput: string;
    readonly recent: string;
    readonly bars: Readonly<Record<string, number>>;
    readonly longterm: string;
    readonly lastPlan: string;
}

const SNAPSHOT_KEYS = Object.freeze(['version', 'playerInput', 'recent', 'bars', 'longterm', 'lastPlan']);

function ownData(value: unknown): Record<string, PropertyDescriptor> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return null;
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    }
    return descriptors;
}

/** Validate already-clipped host inputs; cloning preserves the deployed bars JSON property order. */
export function parseAqlReplanInput(value: unknown): Readonly<AqlReplanInputSnapshot> | null {
    try {
        const fields = ownData(value);
        if (!fields || Reflect.ownKeys(fields).length !== SNAPSHOT_KEYS.length) return null;
        if (SNAPSHOT_KEYS.some((key) => !Object.hasOwn(fields, key))) return null;
        if (fields.version!.value !== AQL_REPLAN_INPUT_VERSION) return null;
        const playerInput: unknown = fields.playerInput!.value;
        const recent: unknown = fields.recent!.value;
        const longterm: unknown = fields.longterm!.value;
        const lastPlan: unknown = fields.lastPlan!.value;
        if (typeof playerInput !== 'string' || playerInput.length > 300) return null;
        if (typeof recent !== 'string' || recent.length > 614) return null;
        if (typeof longterm !== 'string' || typeof lastPlan !== 'string') return null;
        const barFields = ownData(fields.bars!.value);
        if (!barFields) return null;
        const entries: Array<[string, number]> = [];
        for (const key of Object.keys(barFields)) {
            const bar: unknown = barFields[key]!.value;
            if (typeof bar !== 'number' || !Number.isFinite(bar)) return null;
            entries.push([key, bar]);
        }
        return Object.freeze({
            version: AQL_REPLAN_INPUT_VERSION,
            playerInput,
            recent,
            bars: Object.freeze(Object.fromEntries(entries)),
            longterm,
            lastPlan,
        });
    } catch {
        return null;
    }
}

/** Keep the existing labels, fallback text, whitespace, and optional last-plan segment byte-for-byte. */
export function renderAqlReplanInput(snapshot: Readonly<AqlReplanInputSnapshot>): string {
    return [
        `本轮玩家输入：\n${snapshot.playerInput}`,
        `最近对话：\n${snapshot.recent || '（无）'}`,
        `推进槽：${JSON.stringify(snapshot.bars)}`,
        `长期摘要：\n${snapshot.longterm || '（无）'}`,
        snapshot.lastPlan ? `上轮规划的下轮焦点：${snapshot.lastPlan}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');
}
