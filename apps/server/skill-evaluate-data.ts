/** @author Codex @date 2026-10-16 @version 1.0
 * Passive bounded data helpers for the independent, non-operational Skill evaluation slice.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';


function invalid(): never { throw new Error('skill-evaluate-data-invalid'); }


export function evalRecord(input: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
        invalid();
    }
    for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    }
    return input as Record<string, unknown>;
}


export function evalDense(input: unknown, minimum: number, maximum: number): readonly unknown[] {
    if (!Array.isArray(input) || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
        || input.length < minimum || input.length > maximum
        || Reflect.ownKeys(input).length !== input.length + 1) invalid();
    return Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        return descriptor.value;
    });
}


export function evalToken(input: unknown): string {
    if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,239}$/u.test(input)) invalid();
    return input;
}


export function evalHash(input: unknown): string {
    if (typeof input !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(input)) invalid();
    return input;
}


export function evalTime(input: unknown): string {
    if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))
        || new Date(input).toISOString() !== input) invalid();
    return input;
}


export function evalCanonical(input: unknown): string {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(evalCanonical).join(',')}]`;
    const value = input as Record<string, unknown>;
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${evalCanonical(value[key])}`);
    return `{${entries.join(',')}}`;
}


export function evalRawDigest(input: string): string {
    return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}


export function evalDigest(input: unknown): string { return evalRawDigest(evalCanonical(input)); }


export function evalFreeze<T>(input: T): T {
    if (input && typeof input === 'object') { Object.values(input).forEach(evalFreeze); Object.freeze(input); }
    return input;
}


export function evalSnapshot(input: unknown, seen = new Set<object>(), depth = 0,
    budget = { nodes: 0, characters: 0 }): unknown {
    if (++budget.nodes > 4_096 || depth > 24) invalid();
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
        budget.characters += input.length;
        if (input.length > 65_536 || budget.characters > 262_144) invalid();
        return input;
    }
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || seen.has(input)) invalid();
    seen.add(input);
    try {
        if (Array.isArray(input)) return evalDense(input, 0, 128)
            .map((item) => evalSnapshot(item, seen, depth + 1, budget));
        const keys = Reflect.ownKeys(input);
        if (keys.some((key) => typeof key !== 'string')) invalid();
        const value = evalRecord(input, keys as string[]);
        const output: Record<string, unknown> = Object.create(null);
        for (const key of Object.keys(value)) output[key] = evalSnapshot(value[key], seen, depth + 1, budget);
        return output;
    } finally { seen.delete(input); }
}


/** JSON.parse alone silently accepts duplicate keys; submission contracts must reject ambiguous bytes. */
export function evalUniqueJson(text: string): unknown {
    const parsed: unknown = JSON.parse(text);
    let index = 0;
    let nodes = 0;
    const whitespace = () => { while (index < text.length && /\s/u.test(text[index]!)) index += 1; };
    const string = (): string => {
        const start = index++;
        while (index < text.length) {
            if (text[index] === '\\') { index += 2; continue; }
            if (text[index++] === '"') return JSON.parse(text.slice(start, index)) as string;
        }
        return invalid();
    };
    const value = (depth: number): void => {
        if (depth > 16 || ++nodes > 128) invalid();
        whitespace();
        if (text[index] === '{') {
            index += 1; whitespace();
            const keys = new Set<string>();
            if (text[index] === '}') { index += 1; return; }
            while (index < text.length) {
                whitespace(); const key = string();
                if (keys.has(key)) invalid();
                keys.add(key); whitespace(); index += 1; value(depth + 1); whitespace();
                if (text[index++] === '}') return;
            }
        } else if (text[index] === '[') {
            index += 1; whitespace();
            if (text[index] === ']') { index += 1; return; }
            while (index < text.length) {
                value(depth + 1); whitespace();
                if (text[index++] === ']') return;
            }
        } else if (text[index] === '"') { string(); }
        else { while (index < text.length && !/[\s,}\]]/u.test(text[index]!)) index += 1; }
    };
    value(0);
    return parsed;
}
