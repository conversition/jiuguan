/** @author Codex @date 2026-10-16 @version 1.0
 * Administrators may request fixed conformance evaluation, never submit their own plans or verdicts.
 */
import { types as nodeTypes } from 'node:util';
import type { SkillEvaluateRuntime } from './skill-hub/skill-evaluate-runtime.ts';

export function submitSkillEvaluate(runtime: SkillEvaluateRuntime | null, input: unknown) {
    if (!runtime) return { status: 503, body: { code: 'skill-evaluate-unavailable' } };
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
        return { status: 400, body: { code: 'skill-evaluate-request-invalid' } };
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || keys.some((key) => !['compileJobId', 'idempotencyKey'].includes(String(key))
        || !Object.getOwnPropertyDescriptor(input, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))) {
        return { status: 400, body: { code: 'skill-evaluate-request-invalid' } };
    }
    const body = input as Record<string, unknown>;
    if (typeof body.compileJobId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.compileJobId)
        || typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(body.idempotencyKey)) {
        return { status: 400, body: { code: 'skill-evaluate-request-invalid' } };
    }
    try {
        return {
            status: 202, body: {
                job: runtime.submit({
                    compileJobId: body.compileJobId,
                    idempotencyKey: body.idempotencyKey
                })
            }
        };
    } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['skill-evaluate-disabled', 'skill-evaluate-source-unavailable'].includes(code)) {
            return { status: 409, body: { code } };
        }
        if (code === 'skill-evaluate-model-unavailable') return { status: 503, body: { code } };
        if (code.includes('idempotency')) {
            return { status: 409, body: { code: 'skill-evaluate-idempotency-conflict' } };
        }
        return { status: 503, body: { code: 'skill-evaluate-storage-unavailable' } };
    }
}


export function readSkillEvaluate(runtime: SkillEvaluateRuntime | null, jobId: string) {
    if (!runtime) return { status: 503, body: { code: 'skill-evaluate-unavailable' } };
    if (!/^sha256:[a-f0-9]{64}$/.test(jobId)) return { status: 400, body: { code: 'skill-evaluate-job-invalid' } };
    try {
        const job = runtime.readJob(jobId);
        return job ? { status: 200, body: { job } } : { status: 404, body: { code: 'skill-evaluate-job-not-found' } };
    } catch { return { status: 503, body: { code: 'skill-evaluate-status-unavailable' } }; }
}
