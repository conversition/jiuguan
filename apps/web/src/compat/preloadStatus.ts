/**
 * FE-05.0 资源预载状态收口：**区分「脚本入口执行过」与「资源实际预热完成」**
 *
 * 为什么需要：报告此前记录资源预载 `executed: ok`，但那只能证明「脚本标签被插入并结束」，
 * 不能证明「它要预热的资源真的进了缓存」。二者混为一谈会让"网络断了但界面显示已就绪"成为可能。
 *
 * 本模块把证据分成两层：
 *  ① **入口层**：会话宿主的脚本执行结果（name/ok/error）——"执行过"；
 *  ② **缓存层**：从真实缓存接口**读回**的结果（缓存条目数）——"预热完成"。
 *
 * 三档结论（对应任务书给出的处理顺序，不额外造第四套机制）：
 *  - `cache-warm`  ：入口执行成功 **且** 提供期望清单且**逐项**在缓存中读回 → 才能说预热完成；
 *  - `cache-observed`：入口执行成功、缓存读回有实际条目，但**没有期望清单**（无法归因到本脚本）→
 *                   只声称"观察到缓存读回"，不声称"本脚本预热完成"；
 *  - `entry-only`  ：入口执行成功但**未读回**缓存 → 只声称"入口执行过"，不声称预热完成；
 *  - `degraded`    ：入口失败，或入口成功但缓存读回为空/缺项 → **局部降级**，普通按需加载继续工作；
 *  - `not-needed`  ：本会话没有会话级脚本，不需要预载（**不用 {} 冒充就绪**）。
 *
 * 纯逻辑（不依赖 DOM / 网络），网络读取由调用方注入。
 */

export interface PreloadScriptEvidence {
  name: string;
  /** 会话宿主报告该脚本已执行 */
  executed: boolean;
  ok: boolean;
  error?: string;
  /** 该脚本的已声明能力（用于判断它是否属于"需要网络/资源的预载类脚本"） */
  capabilities?: string[];
}

export interface PreloadCacheEvidence {
  /** 从真实缓存接口读回的条目数 */
  cachedCount: number;
  /** 来源标记（可审计：必须来自缓存读回，不是界面自报） */
  source: string;
  readAt: number;
  /** 可选：期望预热的资源标识（未知则为 undefined，此时不做"齐不齐"判断） */
  expected?: string[];
  /** 可选：已缓存资源标识 */
  cachedNames?: string[];
}

export type PreloadMode = 'not-needed' | 'cache-warm' | 'cache-observed' | 'entry-only' | 'degraded';

export interface PreloadVerdict {
  mode: PreloadMode;
  /** 入口层结论：会话级脚本是否执行过 */
  entryExecuted: boolean;
  /** 缓存层结论：是否**读回**到实际缓存 */
  cacheWarm: boolean;
  /** 可否对外声称"资源已预热完成"（只有 cache-warm 才能） */
  claimWarm: boolean;
  reason: string;
  /** 证据（报告/浏览器验收直接读取，不依赖控制台是否打印过 ok） */
  evidence: { scripts: PreloadScriptEvidence[]; cache: PreloadCacheEvidence | null; missing: string[] };
}

/** 该脚本是否属于"需要预热的资源类脚本"（按能力声明，不按名字） */
export function isPreloadScript(s: PreloadScriptEvidence): boolean {
  return (s.capabilities ?? []).includes('network-module');
}

export function evaluatePreload(
  scripts: PreloadScriptEvidence[],
  cache: PreloadCacheEvidence | null,
): PreloadVerdict {
  const relevant = scripts.filter(isPreloadScript);
  const missing: string[] = [];

  if (scripts.length === 0) {
    return {
      mode: 'not-needed', entryExecuted: false, cacheWarm: false, claimWarm: false,
      reason: '本会话没有准入为会话作用域的脚本：不需要预载（不冒充"已就绪"）',
      evidence: { scripts, cache, missing },
    };
  }

  const failed = scripts.filter((s) => !s.ok);
  const entryExecuted = scripts.some((s) => s.executed) && failed.length === 0;

  if (failed.length > 0) {
    for (const f of failed) missing.push(`${f.name}${f.error ? `(${f.error})` : ''}`);
    return {
      mode: 'degraded', entryExecuted: false, cacheWarm: false, claimWarm: false,
      reason: `资源预载入口执行失败（${missing.join('、')}）：保持局部降级，普通按需加载继续工作；不得宣称预热完成`,
      evidence: { scripts, cache, missing },
    };
  }

  if (relevant.length === 0) {
    return {
      mode: 'entry-only', entryExecuted, cacheWarm: false, claimWarm: false,
      reason: `会话脚本已执行（${scripts.map((s) => s.name).join('、')}），但其中没有声明资源类能力（network-module）：不涉及资源预热`,
      evidence: { scripts, cache, missing },
    };
  }

  if (!cache) {
    return {
      mode: 'entry-only', entryExecuted, cacheWarm: false, claimWarm: false,
      reason: '资源预载脚本入口执行过，但**未读回缓存**：只能声称"入口执行过"，不得声称"预热完成"',
      evidence: { scripts, cache: null, missing },
    };
  }

  if (cache.expected && cache.expected.length > 0) {
    const have = new Set(cache.cachedNames ?? []);
    for (const e of cache.expected) if (!have.has(e)) missing.push(e);
  } else {
    // 没有期望清单 → 缓存条目**无法归因**到本脚本：只能报告"观察到缓存"，不得宣称本脚本预热完成
    if (cache.cachedCount > 0) {
      return {
        mode: 'cache-observed', entryExecuted: true, cacheWarm: false, claimWarm: false,
        reason: `入口执行成功，缓存读回 ${cache.cachedCount} 项（来源：${cache.source}），`
          + '但清单未提供期望资源 → 无法归因到本脚本，只能报告"观察到缓存"，**不宣称预热完成**',
        evidence: { scripts, cache, missing },
      };
    }
    return {
      mode: 'degraded', entryExecuted: true, cacheWarm: false, claimWarm: false,
      reason: `入口已执行，但缓存读回为空（来源：${cache.source}）`
        + '：保持局部降级，普通按需加载继续工作；不得宣称预热完成',
      evidence: { scripts, cache, missing },
    };
  }

  const cacheWarm = cache.cachedCount > 0 && missing.length === 0;
  if (cacheWarm) {
    return {
      mode: 'cache-warm', entryExecuted: true, cacheWarm: true, claimWarm: true,
      reason: `入口执行成功且缓存读回 ${cache.cachedCount} 项（来源：${cache.source}）：资源预热完成`,
      evidence: { scripts, cache, missing },
    };
  }

  return {
    mode: 'degraded', entryExecuted, cacheWarm: false, claimWarm: false,
    reason: `入口已执行，但缓存读回为空${missing.length ? `或缺少 ${missing.join('、')}` : ''}（来源：${cache.source}）`
      + '：保持局部降级，普通按需加载继续工作；不得宣称预热完成',
    evidence: { scripts, cache, missing },
  };
}

/** 判定"哪些已执行的会话脚本属于预载类"（供报告使用；不改变调度） */
export function preloadScriptNames(scripts: PreloadScriptEvidence[]): string[] {
  return scripts.filter(isPreloadScript).map((s) => s.name);
}

/** 暴露给浏览器探针（只读；由 App 在会话宿主上报后写入判定结果） */
export function installPreloadProbe(verdict: PreloadVerdict | null): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__jgPreload = () => verdict;
}
