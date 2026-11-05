/** @author Codex @date 2026-10-17 @version 1.0
 * Administrator-only quality-suite boundary. Callers select a retained sample suite;
 * fixtures, judge bindings, prose and verdicts remain host-owned.
 */
import { evalRecord, evalSnapshot } from './skill-evaluate-data.ts';

export interface SkillQualitySuiteRuntimePort {
    submitSuite(input: { sampleSuiteId: string; idempotencyKey: string }): unknown;
    readSuite(suiteId: string): unknown | null;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{1,160}$/u;

export function submitSkillQualitySuite(runtime: SkillQualitySuiteRuntimePort | null, input: unknown) {
    if (!runtime) return { status: 503, body: { code: 'skill-quality-suite-unavailable' } };
    let body: Record<string, unknown>;
    try {
        body = evalRecord(evalSnapshot(input), ['idempotencyKey', 'sampleSuiteId']);
        if (typeof body.sampleSuiteId !== 'string' || !DIGEST.test(body.sampleSuiteId)
            || typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
            throw new Error('invalid');
        }
    } catch {
        return { status: 400, body: { code: 'skill-quality-suite-request-invalid' } };
    }
    try {
        return {
            status: 202,
            body: {
                suite: runtime.submitSuite({
                    sampleSuiteId: body.sampleSuiteId as string,
                    idempotencyKey: body.idempotencyKey as string,
                }),
            },
        };
    } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['skill-quality-suite-disabled', 'skill-quality-suite-source-unavailable'].includes(code)) {
            return { status: 409, body: { code } };
        }
        if (code === 'skill-quality-suite-model-unavailable') return { status: 503, body: { code } };
        if (code.includes('idempotency')) {
            return { status: 409, body: { code: 'skill-quality-suite-idempotency-conflict' } };
        }
        return { status: 503, body: { code: 'skill-quality-suite-storage-unavailable' } };
    }
}

export function readSkillQualitySuite(runtime: SkillQualitySuiteRuntimePort | null, suiteId: string) {
    if (!runtime) return { status: 503, body: { code: 'skill-quality-suite-unavailable' } };
    if (!DIGEST.test(suiteId)) {
        return { status: 400, body: { code: 'skill-quality-suite-invalid' } };
    }
    try {
        const suite = runtime.readSuite(suiteId);
        return suite
            ? { status: 200, body: { suite } }
            : { status: 404, body: { code: 'skill-quality-suite-not-found' } };
    } catch {
        return { status: 503, body: { code: 'skill-quality-suite-status-unavailable' } };
    }
}
