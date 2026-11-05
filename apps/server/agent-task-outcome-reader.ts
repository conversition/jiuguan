/** HC-4a: current authorized read of an existing Closure operation, never a new Task or an execution grant. */
import { isSafeOpaqueId } from '@jiuguan/mobile-contracts';
import { agentClosureToken } from '../../packages/agent-closure/index.ts';
import { readAgentClosureFile } from './agent-closure-store.ts';
import { buildAgentTaskOutcome, type AgentTaskOutcomeV1 } from './agent-task-outcome.ts';

export type AgentTaskOutcomeRead = Readonly<{ status: 'found'; outcome: AgentTaskOutcomeV1 }>
    | Readonly<{ status: 'missing' | 'forbidden' | 'unavailable' }>;

/** Trusted host composition supplies the actual file and its existing ACL + durable deletion authority. */
export function readAgentTaskOutcomeFile(input: Readonly<{
    file: string;
    rawSessionId: string;
    operationId: string;
    allowed(rawSessionId: string): boolean;
}>): AgentTaskOutcomeRead {
    if (typeof input.file !== 'string' || input.file.length === 0 || !isSafeOpaqueId(input.rawSessionId)
        || typeof input.allowed !== 'function') throw new Error('agent-task-outcome-read-invalid');
    try { agentClosureToken(input.operationId, 'operation-id'); }
    catch { throw new Error('agent-task-outcome-read-invalid'); }
    const allowed = () => {
        try { return input.allowed(input.rawSessionId) === true; } catch { return false; }
    };
    if (!allowed()) return Object.freeze({ status: 'forbidden' });
    try {
        const query = { operationId: input.operationId, sessionId: input.rawSessionId, limit: 1 };
        const first = readAgentClosureFile(input.file, query)[0];
        if (!allowed()) return Object.freeze({ status: 'forbidden' });
        if (!first) return Object.freeze({ status: 'missing' });
        const before = buildAgentTaskOutcome(first);
        const second = readAgentClosureFile(input.file, query)[0];
        if (!allowed()) return Object.freeze({ status: 'forbidden' });
        if (!second) return Object.freeze({ status: 'unavailable' });
        const after = buildAgentTaskOutcome(second);
        if (before.source.digest !== after.source.digest || before.source.revision !== after.source.revision)
            return Object.freeze({ status: 'unavailable' });
        return Object.freeze({ status: 'found', outcome: after });
    } catch {
        return Object.freeze({ status: allowed() ? 'unavailable' : 'forbidden' });
    }
}
