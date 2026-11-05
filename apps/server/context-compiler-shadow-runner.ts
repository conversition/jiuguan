import { withProviderWorkSettlement } from '../../packages/proxy/public/provider-runtime.ts';
import { buildContextCompilerModelRequest } from '../../packages/harness/public/context-compiler.ts';
import { estimateTokens } from '../../packages/prompt/public/assembly.ts';

/** Shadow-specific response instructions; active compiler request bytes stay unchanged. */
export function buildContextCompilerShadowRequest(input: Parameters<typeof buildContextCompilerModelRequest>[0]) {
  const compiled = buildContextCompilerModelRequest(input);
  const first = compiled.request.messages[0];
  if (!first || first.role !== 'system' || typeof first.content !== 'string') throw new Error('context-shadow-request-invalid');
  const instruction = [
    '根对象只允许 version、sourceDigest、targetTokens、facts、causalTimeline、activeConstraints、openThreads、negativeFacts、unresolvedConflicts、omitted、coverage，全部必填。',
    'version 必须为 context-capsule-v1；sourceDigest 和 targetTokens 必须原样复制输入。',
    'facts 每项为 {sourceId,claim,confidence}，confidence 是0到1的数；causalTimeline 每项为 {sourceIds,event}；activeConstraints 每项为 {sourceIds,rule}；openThreads 每项为 {sourceIds,summary}；negativeFacts 每项为 {sourceIds,claim}；unresolvedConflicts 每项为 {sourceIds,alternatives}，alternatives 至少两项；omitted 每项为 {sourceId,reasonCode}。',
    '这些字段均为数组，无内容则用 []。coverage 必须为 {requiredIds,retainedIds}，requiredIds 原样复制输入 requiredSourceIds；所有 sourceIds 为非空字符串数组。不要输出 schema、timeline、statement 等其他字段。',
  ].join('\n');
  const request = { ...compiled.request, deepseekJsonOutput: true,
    messages: [{ ...first, content: `${first.content}\n${instruction}` }, ...compiled.request.messages.slice(1)] };
  const tokens = request.messages.reduce((sum, message) => sum + estimateTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)), 0);
  if (tokens > (input.maxInputTokens ?? 12_000)) throw new Error('context-shadow-input-budget-exceeded');
  return { request, expectation: compiled.expectation };
}

export interface ContextCompilerShadowEvidence {
  readonly baselineRequestDigest: string; readonly inputDigest: string; readonly sourceDigest: string;
  readonly sourceDigests: readonly string[]; readonly sourceTokens: readonly number[];
  readonly shadowRequestDigest: string; readonly capsuleDigest: string;
  readonly targetTokens: number; readonly promptTokens: number; readonly completionTokens: number;
}
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
function evidence(value: ContextCompilerShadowEvidence): ContextCompilerShadowEvidence {
  if (!value || ![value.baselineRequestDigest, value.inputDigest, value.sourceDigest, value.shadowRequestDigest,
    value.capsuleDigest].every(item => typeof item === 'string' && DIGEST.test(item))
    || !Array.isArray(value.sourceDigests) || value.sourceDigests.length < 1 || value.sourceDigests.length > 64
    || value.sourceDigests.some(item => typeof item !== 'string' || !DIGEST.test(item))
    || !Array.isArray(value.sourceTokens) || value.sourceTokens.length !== value.sourceDigests.length
    || value.sourceTokens.some(item => !Number.isSafeInteger(item) || item < 0)
    || ![value.targetTokens, value.promptTokens, value.completionTokens].every(item => Number.isSafeInteger(item) && item >= 0))
    throw new Error('context-compiler-shadow-evidence-invalid');
  return Object.freeze({ baselineRequestDigest: value.baselineRequestDigest, inputDigest: value.inputDigest,
    sourceDigest: value.sourceDigest, sourceDigests: Object.freeze([...value.sourceDigests]),
    sourceTokens: Object.freeze([...value.sourceTokens]),
    shadowRequestDigest: value.shadowRequestDigest, capsuleDigest: value.capsuleDigest,
    targetTokens: value.targetTokens, promptTokens: value.promptTokens, completionTokens: value.completionTokens });
}

/** Bounded, process-local executor. Work is host-owned; no source or result is retained in metrics. */
export class ContextCompilerShadowRunner {
  private readonly schedule: (task: () => void) => void;
  private pending: { sessionId: string; work: (signal: AbortSignal, markSent: () => void) => Promise<void | ContextCompilerShadowEvidence> } | undefined;
  private active: { sessionId: string; controller: AbortController; settled: Promise<void> } | undefined;
  private scheduled = false;
  private closed = false;
  private attempts = 0;
  private sourceRead = 0;
  private completed = 0;
  private sent = 0;
  private failed = 0;
  private dropped = 0;
  private cancelled = 0;
  private lastEvidence: ContextCompilerShadowEvidence | null = null;
  private lastEvidenceSessionId: string | null = null;

  constructor(options: { schedule?: (task: () => void) => void } = {}) {
    this.schedule = options.schedule ?? ((task) => { setImmediate(task); });
  }

  enqueue(input: { sessionId: string; work: (signal: AbortSignal, markSent: () => void) => Promise<void | ContextCompilerShadowEvidence> }): boolean {
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId || typeof input.work !== 'function')
      throw new TypeError('context-compiler-shadow-job-invalid');
    this.attempts++;
    if (this.closed || this.pending) { this.dropped++; return false; }
    this.pending = { sessionId: input.sessionId, work: input.work };
    this.wake();
    return true;
  }

  recordSourceRead(): void { this.sourceRead++; }

  snapshot() {
    return Object.freeze({ attempts: this.attempts, sourceRead: this.sourceRead, sent: this.sent, completed: this.completed, failed: this.failed,
      dropped: this.dropped, cancelled: this.cancelled, inFlight: this.active ? 1 : 0,
      pending: this.pending ? 1 : 0, closed: this.closed, adopted: 0, semanticQuality: 'not-evaluated' as const,
      lastEvidence: this.lastEvidence });
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (this.lastEvidenceSessionId === sessionId) { this.lastEvidence = null; this.lastEvidenceSessionId = null; }
    if (this.pending?.sessionId === sessionId) { this.pending = undefined; this.cancelled++; }
    const active = this.active;
    if (active?.sessionId === sessionId) { active.controller.abort(); await active.settled; }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lastEvidence = null; this.lastEvidenceSessionId = null;
    if (this.pending) { this.pending = undefined; this.cancelled++; }
    const active = this.active;
    if (active) { active.controller.abort(); await active.settled; }
  }

  private wake(): void {
    if (this.closed || this.active || this.scheduled || !this.pending) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (this.closed || this.active || !this.pending) return;
      const job = this.pending; this.pending = undefined;
      const controller = new AbortController();
      let sent = false;
      const markSent = () => {
        if (sent || controller.signal.aborted) throw new Error('context-compiler-shadow-dispatch-invalid');
        sent = true; this.sent++;
      };
      // Start on a microtask only after active is installed, so synchronous
      // delegate failures and cancellation races share the same settlement path.
      const settled = Promise.resolve().then(() => withProviderWorkSettlement(() => {
        if (controller.signal.aborted) throw new Error('context-compiler-shadow-cancelled');
        return job.work(controller.signal, markSent);
      }))
        .then((value) => { if (controller.signal.aborted) this.cancelled++; else {
          try { if (value !== undefined) { this.lastEvidence = evidence(value); this.lastEvidenceSessionId = job.sessionId; } this.completed++; }
          catch { this.failed++; }
        } },
          () => { if (controller.signal.aborted) this.cancelled++; else this.failed++; })
        .finally(() => { this.active = undefined; this.wake(); });
      this.active = { sessionId: job.sessionId, controller, settled };
    });
  }
}
