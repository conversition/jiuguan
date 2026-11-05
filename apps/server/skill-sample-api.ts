/** @author Codex @date 2026-10-16 @version 1.0
 * Administrators request host-owned neutral pairs, never submit prose, arbitrary fixtures or verdicts.
 */
import { evalRecord, evalSnapshot } from './skill-evaluate-data.ts';
import type { SkillSampleRuntime } from './skill-hub/skill-sample-runtime.ts';

export interface SkillSampleSuiteRuntimePort {
    submitSuite(input: { compileJobId: string; idempotencyKey: string }): unknown;
    readSuite(suiteId: string): unknown | null;
}

export function submitSkillSample(runtime: SkillSampleRuntime | null, input: unknown) {
    if (!runtime) return { status: 503, body: { code: 'skill-sample-unavailable' } };
    let body: Record<string, unknown>;
    try {
        body = evalRecord(evalSnapshot(input), ['compileJobId', 'idempotencyKey']);
        if (typeof body.compileJobId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.compileJobId)
            || typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(body.idempotencyKey)) {
            throw new Error('invalid');
        }
    } catch { return { status: 400, body: { code: 'skill-sample-request-invalid' } }; }
    try {
        return {
            status: 202, body: {
                job: runtime.submit({
                    compileJobId: body.compileJobId as string, idempotencyKey: body.idempotencyKey as string,
                })
            }
        };
    } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['skill-sample-disabled', 'skill-sample-source-unavailable'].includes(code)) {
            return { status: 409, body: { code } };
        }
        if (code === 'skill-sample-model-unavailable') return { status: 503, body: { code } };
        if (code.includes('idempotency')) {
            return { status: 409, body: { code: 'skill-sample-idempotency-conflict' } };
        }
        return { status: 503, body: { code: 'skill-sample-storage-unavailable' } };
    }
}


export function readSkillSample(runtime: SkillSampleRuntime | null, jobId: string) {
    if (!runtime) return { status: 503, body: { code: 'skill-sample-unavailable' } };
    if (!/^sha256:[a-f0-9]{64}$/.test(jobId)) return { status: 400, body: { code: 'skill-sample-job-invalid' } };
    try {
        const job = runtime.readJob(jobId);
        return job ? { status: 200, body: { job } } : { status: 404, body: { code: 'skill-sample-job-not-found' } };
    } catch { return { status: 503, body: { code: 'skill-sample-status-unavailable' } }; }
}


/** Suite fixtures remain host-owned; callers can select only the retained compile source and idempotency key. */
export function submitSkillSampleSuite(runtime: SkillSampleSuiteRuntimePort | null, input: unknown) {
    if (!runtime) return { status: 503, body: { code: 'skill-sample-suite-unavailable' } };
    let body: Record<string, unknown>;
    try {
        body = evalRecord(evalSnapshot(input), ['compileJobId', 'idempotencyKey']);
        if (typeof body.compileJobId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.compileJobId)
            || typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(body.idempotencyKey)) {
            throw new Error('invalid');
        }
    } catch { return { status: 400, body: { code: 'skill-sample-suite-request-invalid' } }; }
    try {
        return {
            status: 202, body: {
                suite: runtime.submitSuite({
                    compileJobId: body.compileJobId as string, idempotencyKey: body.idempotencyKey as string,
                })
            }
        };
    } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['skill-sample-suite-disabled', 'skill-sample-suite-source-unavailable'].includes(code)) {
            return { status: 409, body: { code } };
        }
        if (code === 'skill-sample-suite-model-unavailable') return { status: 503, body: { code } };
        if (code.includes('idempotency')) {
            return { status: 409, body: { code: 'skill-sample-suite-idempotency-conflict' } };
        }
        return { status: 503, body: { code: 'skill-sample-suite-storage-unavailable' } };
    }
}


export function readSkillSampleSuite(runtime: SkillSampleSuiteRuntimePort | null, suiteId: string) {
    if (!runtime) return { status: 503, body: { code: 'skill-sample-suite-unavailable' } };
    if (!/^sha256:[a-f0-9]{64}$/.test(suiteId)) {
        return { status: 400, body: { code: 'skill-sample-suite-invalid' } };
    }
    try {
        const suite = runtime.readSuite(suiteId);
        return suite
            ? { status: 200, body: { suite } }
            : { status: 404, body: { code: 'skill-sample-suite-not-found' } };
    } catch { return { status: 503, body: { code: 'skill-sample-suite-status-unavailable' } }; }
}
