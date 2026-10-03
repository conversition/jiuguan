/** 生成耗时只由稳定墙钟起点计算；浏览器后台节流/组件重挂载不会丢失经过时间。 */
export function elapsedGenerationSeconds(startedAtMs: number | null | undefined, nowMs = Date.now()): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs) || startedAtMs == null) return 0;
  return Math.max(0, (nowMs - startedAtMs) / 1000);
}

/** 生成超时剩余时长；恢复一个已运行中的回合时不会重新获得完整超时额度。 */
export function remainingGenerationMs(startedAtMs: number, timeoutMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
  return Math.max(0, timeoutMs - Math.max(0, nowMs - startedAtMs));
}

export interface GenerationLease {
  token: number;
  sessionId: string;
  runId: string;
}

/**
 * React state is not a synchronous mutex: two click/keyboard handlers can both
 * observe busy=false before the next render. This gate gives each local
 * generation an identity and prevents stale callbacks releasing a newer one.
 */
export class GenerationOperationGate {
  private sequence = 0;
  private owner: GenerationLease | null = null;

  claim(sessionId: string, runId: string): GenerationLease | null {
    if (this.owner) return null;
    const lease = { token: ++this.sequence, sessionId, runId };
    this.owner = lease;
    return lease;
  }

  owns(lease: GenerationLease): boolean {
    return this.owner?.token === lease.token;
  }

  release(lease: GenerationLease): boolean {
    if (!this.owns(lease)) return false;
    this.owner = null;
    return true;
  }

  get active(): boolean {
    return this.owner !== null;
  }
}

/** The id exists before fetch starts, so even an immediate Stop has a target. */
export function createClientRunId(nowMs = Date.now()): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return 'web-' + nowMs.toString(36) + '-' + random;
}
