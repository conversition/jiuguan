/** @author Codex @date 2026-10-13 @version 1.0
 * Keep artifact and carrier proofs identical at production and final adoption boundaries.
 */
import { createHash } from 'node:crypto';
import type { ChatRequest } from '../../proxy/public/client.ts';

export function interactivePreludeArtifactDigest(input: { directorPlan?: unknown; evidence: string }): string {
    return `sha256:${createHash('sha256').update(JSON.stringify([
        'interactive-prelude-v1', input.directorPlan ?? null, input.evidence,
    ])).digest('hex')}`;
}

export function interactiveEvidenceBlock(evidence: string): string {
    if (!evidence) return '';
    const bounded = evidence.replace(/<\/?harness_evidence\b/gi, (token) => token.replace('<', '&lt;'));
    return `\n\n<harness_evidence trust="untrusted">\n${bounded}\n</harness_evidence>`;
}

export function messageText(message: ChatRequest['messages'][number] | undefined): string | null {
    if (!message || message.role !== 'user') return null;
    return typeof message.content === 'string' ? message.content
        : Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('') : null;
}
