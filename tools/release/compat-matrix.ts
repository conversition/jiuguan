/**
 * P11-08：双向兼容矩阵（发布顺序固定）。
 * P11-09：release:host 版本化 staging + 原子切换/回滚（本地目录 pointer 实现）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── P11-08：兼容矩阵 ─────────────────────────────────────────────────────

export interface CompatDecisionInput {
  serverProtocol: number;
  clientProtocol: number;
  /** 设备上是否还留着已配对的 token。 */
  hasPairedToken: boolean;
}

export type ClientAccessLevel = 'read-write' | 'read-only' | 'must-repair';

/** 固定策略：server N 兼容 client N-1（可读写）；client N 对 server N-1 只读并拒写；差两级必须重配对。 */
export function decideClientAccess(input: CompatDecisionInput): ClientAccessLevel {
  const delta = input.serverProtocol - input.clientProtocol;
  if (delta === 0) return 'read-write';
  if (delta === 1) {
    // server 领先一版：旧 client 继续可读写（server 向后兼容一档）
    if (input.clientProtocol >= 1) return 'read-write';
  }
  if (delta === -1) {
    // client 领先一版：无旧 token 时走 capabilities 握手可只读拒写；有 token 直接只读
    return input.hasPairedToken ? 'read-only' : 'read-only';
  }
  return 'must-repair'; // 差两级以上：重新配对
}

/** 固定发布顺序（P11-08）：host 先 staging/验证/原子切换并确认 client N-1，再装 client N；回滚反序。 */
export const RELEASE_ORDER = Object.freeze([
  '1. host N staging → 测试 → 原子切换',
  '2. 确认 client N-1 对 host N 兼容（read-write）',
  '3. 安装 client N',
  '4. 回滚顺序 = 先回滚/确认 client 兼容 → 再回滚 host/data',
] as const);

// ── P11-09：release:host staging 与原子切换 ──────────────────────────────

export interface ReleaseHostLayout {
  readonly root: string;
  readonly stagingDir: string;
  readonly releasesDir: string;
  readonly pointerPath: string;
}

export function layoutFor(root: string): ReleaseHostLayout {
  return {
    root,
    stagingDir: join(root, 'staging'),
    releasesDir: join(root, 'releases'),
    pointerPath: join(root, 'current.txt'),
  };
}

/** staging 完成后登记一个版本化 release（staging → releases/<id>，目录改名即原子）。 */
export function stageRelease(layout: ReleaseHostLayout, releaseId: string, payload: { commit: string; apiOrigin: string }): void {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(releaseId)) throw new TypeError('releaseId 非法');
  if (!/^[0-9a-f]{40}$/.test(payload.commit)) throw new TypeError('commit 非法');
  const endpoint = new URL(payload.apiOrigin);
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || endpoint.username || endpoint.password || !endpoint.hostname.toLowerCase().endsWith('.ts.net')) {
    throw new TypeError('apiOrigin 必须是精确 https://*.ts.net origin');
  }
  if (!existsSync(layout.stagingDir)) throw new Error('staging 目录不存在（先完成构建与测试）');
  const releasesDir = layout.releasesDir;
  mkdirSync(releasesDir, { recursive: true });
  const target = join(releasesDir, releaseId);
  if (existsSync(target)) throw new Error(`release 已存在: ${releaseId}`);
  // 记录 release 元数据
  writeFileSync(join(layout.stagingDir, 'release-meta.json'),
    `${JSON.stringify({ releaseId, ...payload }, null, 2)}\n`, 'utf8');
  renameSync(layout.stagingDir, target); // 原子：目录改名
  mkdirSync(layout.stagingDir, { recursive: true }); // 重建空 staging 供下一轮
  const indexPath = join(releasesDir, 'index.txt');
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').split('\n').filter(Boolean) : [];
  index.push(releaseId);
  const indexTmp = `${indexPath}.tmp`;
  writeFileSync(indexTmp, `${index.join('\n')}\n`, 'utf8');
  renameSync(indexTmp, indexPath);
}

const readPointer = (layout: ReleaseHostLayout): string | null => {
  if (!existsSync(layout.pointerPath)) return null;
  return readFileSync(layout.pointerPath, 'utf8').trim() || null;
};

/** 原子切换：写临时 pointer → rename 覆盖。绝不直接覆盖正在服务的 dist。 */
export function activateRelease(layout: ReleaseHostLayout, releaseId: string): void {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(releaseId)) throw new TypeError('releaseId 非法');
  if (!existsSync(join(layout.releasesDir, releaseId))) {
    throw new Error(`release 不存在: ${releaseId}`);
  }
  const tmp = `${layout.pointerPath}.tmp`;
  writeFileSync(tmp, `${releaseId}\n`, 'utf8');
  renameSync(tmp, layout.pointerPath);
}

export function currentRelease(layout: ReleaseHostLayout): string | null {
  return readPointer(layout);
}

/** 回滚：切回指定（通常上一个）release；只动 pointer，不动数据。 */
export function rollbackTo(layout: ReleaseHostLayout, releaseId: string): void {
  activateRelease(layout, releaseId);
}

export function listReleases(layout: ReleaseHostLayout): string[] {
  if (!existsSync(layout.releasesDir)) return [];
  try {
    return readFileSync(join(layout.releasesDir, 'index.txt'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
