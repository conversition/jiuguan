/** @author Codex @date 2026-10-16 @version 1.0
 * Administrator build endpoint, never a chat-generation or candidate-publication endpoint.
 */
import type { SkillCompileRuntime } from './skill-hub/skill-compile-runtime.ts';
import { types as nodeTypes } from 'node:util';

export function submitSkillCompile(runtime: SkillCompileRuntime | null, input: unknown) {
    if (!runtime) return { status: 503, body: { code: 'skill-compile-unavailable' } };
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
        || Reflect.ownKeys(input).some((key) => typeof key !== 'string'
            || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) {
        return { status: 400, body: { code: 'skill-compile-request-invalid' } };
    }
    const body = input as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'idempotencyKey,rawSessionId,spec'
        || typeof body.rawSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(body.rawSessionId)
        || typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(body.idempotencyKey)) {
        return { status: 400, body: { code: 'skill-compile-request-invalid' } };
    }
    try {
        const job = runtime.submit({
            rawSessionId: body.rawSessionId,
            idempotencyKey: body.idempotencyKey, spec: body.spec
        });
        return { status: 202, body: { job } };
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'skill-compile-disabled') return { status: 409, body: { code: message } };
        if (message === 'skill-compile-source-unavailable') return { status: 409, body: { code: message } };
        if (message === 'skill-compile-model-unavailable') return { status: 503, body: { code: message } };
        if (message.includes('idempotency')) {
            return { status: 409, body: { code: 'skill-compile-idempotency-conflict' } };
        }
        if (message === 'skill-compile-spec-invalid' || message === 'skill-compile-data-invalid'
            || message === 'skill-compile-created-in-future') {
            return { status: 400, body: { code: 'skill-compile-request-invalid' } };
        }
        return { status: 503, body: { code: 'skill-compile-storage-unavailable' } };
    }
}


export function readSkillCompile(runtime: SkillCompileRuntime | null, jobId: string) {
    if (!runtime) return { status: 503, body: { code: 'skill-compile-unavailable' } };
    if (!/^sha256:[a-f0-9]{64}$/.test(jobId)) {
        return { status: 400, body: { code: 'skill-compile-job-invalid' } };
    }
    try {
        const job = runtime.readJob(jobId);
        return job ? { status: 200, body: { job } } : { status: 404, body: { code: 'skill-compile-job-not-found' } };
    } catch { return { status: 503, body: { code: 'skill-compile-status-unavailable' } }; }
}
