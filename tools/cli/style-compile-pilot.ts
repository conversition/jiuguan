#!/usr/bin/env node
/** @author Codex @date 2026-10-20 @version 1.0
 * Offline registration of one immutable Style pilot budget; preview is strictly zero-write.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    acquireServerProcessLock, ServerProcessLockError,
} from '../../apps/server/process-lock.ts';
import {
    STYLE_COMPILE_JOB_DATA_DIRECTORY, StyleCompileJobStore,
} from '../../apps/server/skill-hub/style-compile-job-store.ts';
import {
    parseStyleCompilePilotPolicy, type StyleCompilePilotPolicy,
} from '../../apps/server/skill-hub/style-compile-pilot.ts';

export const STYLE_COMPILE_PILOT_ACK = 'style-compile-pilot-v1' as const;
const HELP = 'Usage: style-compile-pilot --data-dir <absolute-path> [--apply --ack style-compile-pilot-v1]\n'
    + 'Reads JG_STYLE_COMPILE_PILOT only. Defaults to a zero-write preview.\n'
    + 'Apply requires the server to be stopped; it does not enable delivery or Agent admission.';

type PilotArguments = Readonly<{ help: true }> | Readonly<{ help: false; dataDir: string; apply: boolean }>;


/** Reject ambiguous operator arguments before touching either the filesystem or policy environment. */
export function parseStyleCompilePilotArgs(argv: readonly string[]): PilotArguments {
    if (argv.length === 1 && argv[0] === '--help') return Object.freeze({ help: true });
    const seen = new Set<string>();
    let dataDir: string | undefined;
    let acknowledgement: string | undefined;
    let apply = false;
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]!;
        if (!['--data-dir', '--apply', '--ack'].includes(flag) || seen.has(flag)) {
            throw new Error('style-pilot-arguments-invalid');
        }
        seen.add(flag);
        if (flag === '--apply') {
            apply = true;
            continue;
        }
        const value = argv[++index];
        if (!value || value.startsWith('--') || !value.trim() || /[\u0000-\u001f]/u.test(value)) {
            throw new Error('style-pilot-arguments-invalid');
        }
        if (flag === '--data-dir') dataDir = value;
        else acknowledgement = value;
    }
    if (!dataDir || !isAbsolute(dataDir)
        || (process.platform === 'win32' && parse(dataDir).root.length < 3)) {
        throw new Error('style-pilot-data-dir-invalid');
    }
    if (apply ? acknowledgement !== STYLE_COMPILE_PILOT_ACK : acknowledgement !== undefined) {
        throw new Error('style-pilot-ack-required');
    }
    return Object.freeze({ help: false, dataDir, apply });
}


function registerBudget(dataDir: string, policy: StyleCompilePilotPolicy): void {
    const lock = acquireServerProcessLock({ dataDir, instanceId: 'style-pilot-cli-' + randomUUID() });
    let store: StyleCompileJobStore | undefined;
    try {
        lock.assertOwned();
        const now = new Date().toISOString();
        if (now >= policy.expiresAt) throw new Error('style-pilot-policy-expired');
        store = new StyleCompileJobStore({
            dataDir: join(dataDir, STYLE_COMPILE_JOB_DATA_DIRECTORY), now: () => new Date().toISOString(),
        });
        lock.assertOwned();
        store.openPilotBudget({ pilotIdDigest: policy.pilotIdDigest, policyDigest: policy.policyDigest,
            maxCalls: policy.maxCalls, maxCostMicrousd: policy.maxCostMicrousd, expiresAt: policy.expiresAt, now });
    } finally {
        try { store?.close(); } finally { lock.release(); }
    }
}


/** Preview never resolves operational roots, opens a database, takes a lock or changes runtime switches. */
export function runStyleCompilePilotCli(options: Readonly<{
    argv: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
    out?: (line: string) => void;
    err?: (line: string) => void;
}>): number {
    const out = options.out ?? ((line: string) => process.stdout.write(line + '\n'));
    const err = options.err ?? ((line: string) => process.stderr.write(line + '\n'));
    try {
        const args = parseStyleCompilePilotArgs(options.argv);
        if (args.help) {
            out(HELP);
            return 0;
        }
        const policy = parseStyleCompilePilotPolicy((options.env ?? process.env).JG_STYLE_COMPILE_PILOT);
        if (!policy) throw new Error('style-pilot-policy-required');
        if (new Date().toISOString() >= policy.expiresAt) throw new Error('style-pilot-policy-expired');
        if (args.apply) registerBudget(args.dataDir, policy);
        out(JSON.stringify({ version: STYLE_COMPILE_PILOT_ACK, pilotIdDigest: policy.pilotIdDigest,
            policyDigest: policy.policyDigest, maxCalls: policy.maxCalls, maxCostMicrousd: policy.maxCostMicrousd,
            expiresAt: policy.expiresAt, applied: args.apply }));
        return 0;
    } catch (error) {
        // Filesystem/SQLite errors may contain operator paths; emit only a fixed, redacted failure class.
        const code = error instanceof ServerProcessLockError ? error.code
            : error instanceof Error && /^style-(?:pilot|compile-job)-[a-z0-9-]+$/u.test(error.message)
                ? error.message : 'style-pilot-operation-failed';
        err(JSON.stringify({ applied: false, error: code }));
        return 1;
    }
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = runStyleCompilePilotCli({ argv: process.argv.slice(2) });
}
