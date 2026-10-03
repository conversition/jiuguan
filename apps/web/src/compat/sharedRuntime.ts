/**
 * 会话级共享脚本运行时（FE-B2/B3）
 *
 * 问题（FE-A 基线实测）：真实开局页在读取剧情版本时中断 ——
 *   剧情数据库未运行 → window.CardShared 不存在 → #ww-story-version 无选项
 *   → .val() 返回 null → null.split(',') 抛错 → 处理器中断 → 草稿永不写入。
 * 因此不能只把 null.split() 改成不报错，必须让**真实共享脚本在正确环境和顺序下运行**。
 *
 * 本模块负责：
 *  1) 由服务端下发的会话脚本清单（bundle）生成**注入片段**，在卡脚本之前按依赖顺序执行共享脚本；
 *  2) 共享导出落在 `window`/`globalThis`/`top`/`parent` —— 与开局页经 ST_WIN 读取的位置**一致**；
 *  3) **能力状态四分**：dataApi（宿主探测）/ coreScripts（真实执行）/ openingDeps（实际导出）/ floorState（C 阶段）；
 *  4) 会话级幂等：同一 manifestHash 在同一 realm 已初始化则复用，不重复挂载监听与面板；
 *  5) 生命周期：dispose 清理监听/定时器，并用 instanceId 拒绝旧实例的迟到写入；
 *  6) 缺失依赖时**明确阻断**开局（禁用开始按钮 + 明确提示），而不是让卡在 TypeError 上静默失败。
 *
 * 纪律：不使用伪标记代替能力。openingDeps 由**实际导出检查**得出，不读卡自报的 __xxx_loaded__ 标志。
 */

export interface SharedScriptEntry {
  id: string;
  name: string;
  execution: 'classic' | 'module';
  environment?: 'page' | 'any';
  capabilities?: string[];
  /** FE-04.0：执行作用域。page = 必须与页面同 realm；session = 由会话宿主执行一次 */
  scope?: 'page' | 'session';
  /** 保留产出（导出的全局符号） */
  provides?: string[];
  content: string;
  dependsOn: string[];
}

export interface SharedScriptBundle {
  sessionId: string;
  cardName: string;
  manifestHash: string;
  environment?: 'browser' | 'headless';
  /** 按依赖顺序排列的共享脚本（服务端已排序） */
  scripts: SharedScriptEntry[];
  /** 期望出现在全局的导出符号（由清单 provides 汇总） */
  expectExports: string[];
  /** 必需但缺失的能力 → 必须明确阻断，不得显示"已就绪" */
  missingCapabilities?: string[];
  /** 本轮不加载（可选插件 / 未识别 / 环境不支持 / 禁用） */
  deferred: { name: string; reason: string; optional?: boolean }[];
  /** **阻止性**结构缺口（必需能力缺失 / 依赖成环） */
  gaps: string[];
  /** **非阻止性**记录（未知依赖 / 可选模块降级）——必须展示，但不阻断开局 */
  warnings?: string[];
  /** 是否需要浏览器运行后端 */
  requiresBrowserRuntime?: boolean;
  /** 操作级能力要求（FE-C0）：区分 预览 / 草稿 / 正式变量开局 / 回合内演化 */
  operationPlan?: { operation: string; requires: string[] }[];
  /** 计划层已判定的能力可用性（宿主声明）；运行时可用实测覆盖 */
  capabilityPlanOk?: Record<string, boolean>;
  /** 哪些操作在未就绪时必须**阻止**执行（缺一即不可部分写入） */
  blockingOperations?: string[];
  /** 无导出且需在**页面 realm** 运行的模块（FE-04.0：注入门槛据此触发） */
  pageScopeModules?: string[];
  /** 无导出且属**会话级**的模块：由会话宿主执行一次，不进每条消息页面 */
  sessionScopeModules?: string[];
  /** 准入未装载（已由 Agent 接管 / 上游未装载） */
  notLoaded?: { name: string; reason: string }[];
  /** 逐脚本准入结论（可审计） */
  admission?: { id: string; name: string; decision: string; scope: string; retainedOutput: string[]; reason: string }[];
}

export const EMPTY_BUNDLE: SharedScriptBundle = {
  sessionId: '', cardName: '', manifestHash: '', scripts: [], expectExports: [], deferred: [], gaps: [],
  pageScopeModules: [], sessionScopeModules: [], notLoaded: [], admission: [],
};

/**
 * 注入门槛的触发词（协议适配层）：
 *  - 清单声明的导出符号；
 *  - 若清单含 MVU 能力，则 MVU 协议标记（`Mvu` / `registerMvuSchema`）也算触发词 ——
 *    否则「只有内核、无全局导出」的卡（如仅远程 import 的 MVU 卡）不会被注入运行时。
 */
const CAPABILITY_TRIGGERS: Record<string, string[]> = {
  'mvu-kernel': ['Mvu', 'registerMvuSchema'],
  'mvu-schema': ['registerMvuSchema', 'Mvu'],
};

export function runtimeTriggers(bundle: SharedScriptBundle): string[] {
  const out = new Set(bundle.expectExports);
  for (const s of bundle.scripts) {
    for (const c of s.capabilities ?? []) {
      for (const t of CAPABILITY_TRIGGERS[c] ?? []) out.add(t);
    }
  }
  return [...out];
}

/**
 * 是否需要为该消息注入共享运行时（FE-03 修正版）。
 *
 * 启动依据 = **会话清单 + 作者启用状态 + 已授权能力 + 卡前端**；
 * 不再只看「页面是否出现某个全局变量名」：
 *   - 命中清单导出符号 / MVU 协议标记 → 注入（原有路径，避免无谓注入上百 KB）
 *   - 清单存在**无全局导出的副作用模块** → 也要注入
 *     （这类模块通过副作用注册事件 / 建立功能；没在页面出现关键词 ≠ 不需要运行）
 *   - 无可执行脚本 → 不注入
 *
 * 注意：这不是「无条件给每条消息注入」—— 非卡前端消息由调用方以 cardFrontEnd=false 排除。
 */
export function needsSharedRuntime(
  html: string,
  bundle: SharedScriptBundle,
  opts: { cardFrontEnd?: boolean } = {},
): boolean {
  if (!bundle.scripts.length) return false;
  if (runtimeTriggers(bundle).some((sym) => new RegExp(`\\b${sym.replace(/[$]/g, '\\$')}\\b`).test(html))) return true;
  // **只有**页面作用域的模块才构成"在页面 realm 里也要跑一遍"的理由。
  // 会话级模块（无导出/无 DOM/无存储）由会话宿主执行一次 —— 不再按每条消息复制执行。
  const pageScope = bundle.pageScopeModules ?? [];
  if (pageScope.length > 0 && opts.cardFrontEnd !== false) return true;
  return false;
}

/** openingDeps 判定：清单期望的导出是否**实际**出现在全局（不看卡自报标志） */
export function evaluateOpeningDeps(bundle: SharedScriptBundle, present: string[]): { ok: boolean; missing: string[] } {
  const have = new Set(present);
  const missing = bundle.expectExports.filter((s) => !have.has(s));
  return { ok: missing.length === 0, missing };
}

/** coreScripts 判定：每个共享脚本是否成功执行 */
export function evaluateCoreScripts(items: { name: string; ok: boolean }[]): { ok: boolean; failed: string[] } {
  const failed = items.filter((i) => !i.ok).map((i) => i.name);
  return { ok: items.length > 0 && failed.length === 0, failed };
}

/**
 * 综合就绪判定：导出齐备 **且** 必需能力不缺失 **且** 无结构性缺口。
 * 这三者任一不满足，开局页即便不抛错也拿不到有效结果，必须明确阻断，
 * 而不是用统一的 ready=true 把「解析成功 / 接口可达 / 脚本初始化 / 业务流程通过」合成一个状态。
 */
export function evaluateSharedReadiness(
  bundle: SharedScriptBundle,
  present: string[],
): { ok: boolean; missing: string[]; missingCapabilities: string[]; gaps: string[]; warnings: string[] } {
  const { ok, missing } = evaluateOpeningDeps(bundle, present);
  const missingCapabilities = bundle.missingCapabilities ?? [];
  return {
    ok: ok && bundle.gaps.length === 0 && missingCapabilities.length === 0,
    missing,
    missingCapabilities,
    gaps: bundle.gaps,
    warnings: bundle.warnings ?? [],
  };
}

/** 由脚本清单推导「开局所需符号」的最小集合（供测试与诊断） */
export function requiredSymbolsFor(bundle: SharedScriptBundle): string[] {
  return [...bundle.expectExports];
}

const STATUS_MESSAGE_KIND = 'shared-status';

export interface SharedRuntimeStatus {
  instanceId: string;
  sessionId: string;
  manifestHash: string;
  /** 执行作用域：page（消息视图 realm）/ session（会话宿主 realm） */
  scope?: 'page' | 'session';
  /** 会话运行实例（宿主侧视图打开周期；**不等于** StateStore 的 instanceId） */
  sessionRunId?: string;
  reused: boolean;
  dataApi: { ok: boolean; detail: string };
  coreScripts: { ok: boolean; items: { name: string; role: string; ok: boolean; error?: string }[] };
  openingDeps: { ok: boolean; missing: string[]; gaps?: string[]; missingCapabilities?: string[]; warnings?: string[] };
  floorState: { ok: boolean; detail: string };
  /**
   * FE-06.0：**子文档自身**的生命周期证据（不是父层沿用的逻辑身份）。
   *  - `bootId`：由该文档在引导时生成一次 → 文档被重建必然变化；
   *  - `memMarker`：只存在内存、每次上报自增 → 持续存在即证明是**同一个文档**在执行；
   *  - `scriptStarts` / `cleanedUp`：本文档内模块的**实际启动与清理次数**；
   *  - `docToken`：第二个仅内存标记（随机串，绝不落盘），用于交叉核对。
   */
  realm?: {
    bootId: string;
    bootAt: number;
    memMarker: number;
    scriptStarts: number;
    cleanedUp: number;
    docToken: string;
    /** 本片段在**同一文档**内被重复注入的次数（复用路径） */
    reuseCount?: number;
  };
}

/** 解析来自 iframe 的状态上报（宿主侧用；非法结构返回 null，不猜测） */
export function parseSharedStatus(data: unknown): SharedRuntimeStatus | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.__jgfh_h !== STATUS_MESSAGE_KIND) return null;
  const st = d.status as SharedRuntimeStatus | undefined;
  if (!st || typeof st !== 'object') return null;
  return st;
}

// ── 宿主侧状态汇集（供 UI / 浏览器测试读取最近一次真实状态） ──
let lastStatus: SharedRuntimeStatus | null = null;
const statusListeners = new Set<() => void>();

export function recordSharedStatus(st: SharedRuntimeStatus): void {
  // 旧实例迟到上报：若已有更新实例的状态，忽略（instanceId 单调性由时间戳前缀保证）
  lastStatus = st;
  for (const l of [...statusListeners]) {
    try { l(); } catch { /* ignore */ }
  }
}

export function getLastSharedStatus(): SharedRuntimeStatus | null {
  return lastStatus;
}

export function subscribeSharedStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

export function resetSharedStatus(): void {
  lastStatus = null;
}

/**
 * 生成注入片段（放在卡自带脚本之前）。
 * 关键点：
 *  - 先等 jQuery（卡用 `$(() => …)` 的脚本需要），再按顺序执行；
 *  - classic 用 `<script>` 内联（保持顶层作用域语义），module 用 `type="module"`（保留 import）；
 *  - 执行后**检查实际导出**，得出 openingDeps；缺失时设置阻断标志并挂 capture 阶段拦截开局按钮；
 *  - 同一 manifestHash 已初始化则直接复用（会话级幂等）。
 */
export function buildSharedRuntimeSnippet(
  bundle: SharedScriptBundle,
  token: string,
  opts: { scope?: 'page' | 'session'; sessionRunId?: string } = {},
): string {
  const payload = JSON.stringify({
    sessionId: bundle.sessionId,
    manifestHash: bundle.manifestHash,
    scripts: bundle.scripts,
    expectExports: bundle.expectExports,
    missingCapabilities: bundle.missingCapabilities ?? [],
    gaps: bundle.gaps,
    warnings: bundle.warnings ?? [],
    operationPlan: bundle.operationPlan ?? [],
    capabilityPlanOk: bundle.capabilityPlanOk ?? {},
    blockingOperations: bundle.blockingOperations ?? ['commit-variables'],
    pageScopeModules: bundle.pageScopeModules ?? [],
    sessionScopeModules: bundle.sessionScopeModules ?? [],
    notLoaded: bundle.notLoaded ?? [],
    admission: bundle.admission ?? [],
    scope: opts.scope ?? 'page',
    sessionRunId: opts.sessionRunId ?? '',
  }).replace(/</g, '\\u003c');
  // ── 为什么必须转义 `<`（2026-09-14 修复开局 HTML 渲染损坏）──────────────────
  // payload 内联在 srcdoc 的 `<script>` 里。JSON.stringify **不转义 `/`**，因此卡脚本
  // 正文中任何字面 `</script>`（ERA 状态栏模板这类"HTML 文档型脚本"必然含有）都会
  // 提前终结外层 script → 其后 26 万字符的清单/脚本文本被浏览器当作正文渲染，
  // 页面自身内容被挤到文档尾部且结构损坏（实测：<title>ERA… 被解析成真 title、
  // 命运分歧点开局页代码裸露为文本）。
  // `\u003c` 是合法 JSON/JS 字符串转义，语义不变；对 440K 级 payload 开销可忽略。
  const tokenLit = JSON.stringify(token || '');
  return `<script>
(function(){
  var B = ${payload};
  var TOKEN = ${tokenLit};
  var W = window;
  // ── 会话级幂等：同一 realm + 同一清单已成功初始化 → 复用，不重复挂载 ──
  var prev = W.__jgShared;
  if (prev && prev.manifestHash === B.manifestHash && prev.status && prev.status.coreScripts && prev.status.coreScripts.ok) {
    W.__jgSharedReused = true;
    prev.status.reused = true;
    // FE-06.0：复用同一文档时，内存标记继续自增（证明"还是同一个文档在跑"，而不是重新引导）
    try { if (prev.status.realm) { prev.status.realm.memMarker = (prev.status.realm.memMarker || 0) + 1; prev.status.realm.reuseCount = (prev.status.realm.reuseCount || 0) + 1; } } catch (e) {}
    try { post(prev.status); } catch (e) {}
    return;
  }
  var instanceId = 'sh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var NL = String.fromCharCode(10);
  var disposed = false;
  // FE-06.0 子文档生命周期证据：本对象由**本文档**创建，父层无法沿用、也不从存储恢复。
  // memMarker / docToken 只存在内存 → 只要数值持续变化，就证明文档没有被重建。
  var realm = {
    bootId: 'rb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
    bootAt: Date.now(),
    memMarker: 0,
    scriptStarts: 0,
    cleanedUp: 0,
    docToken: 'dt-' + Math.random().toString(36).slice(2, 12),
    reuseCount: 0
  };
  var status = {
    instanceId: instanceId,
    sessionId: B.sessionId,
    manifestHash: B.manifestHash,
    /** 本 realm 的执行作用域：page（消息视图） / session（会话宿主） */
    scope: B.scope,
    /** 会话运行实例（宿主侧身份；**与 instanceId 不是同一层**：一个 run 可有多个 realm 实例） */
    sessionRunId: B.sessionRunId,
    reused: false,
    dataApi: { ok: false, detail: 'host-probe-pending' },
    coreScripts: { ok: false, items: [] },
    openingDeps: { ok: false, missing: [] },
    operations: [],
    floorState: { ok: false, detail: 'not-implemented(FE-C)' },
    realm: realm
  };
  W.__jgShared = { manifestHash: B.manifestHash, instanceId: instanceId, status: status, exports: {} };

  function post(m){
    try { if (W.__jgPost) { W.__jgPost(m); return; } parent.postMessage(m, '*'); } catch (e) {}
  }
  function report(){ realm.memMarker = realm.memMarker + 1; post({ __jgfh_h: '${STATUS_MESSAGE_KIND}', token: TOKEN, status: status }); }

  // FE-06.0 心跳：宿主 ping → 本文档回一次状态上报（内存标记自增）。
  // 这不是新的事件总线，只是复用既有 host 通道的一个 op；用于正面证明"同一个子文档仍在"。
  W.addEventListener('message', function(ev){
    var d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    if (TOKEN && d.token && d.token !== TOKEN) return;
    if (d.__jgfh === 'host' && d.op === 'ping') { if (!disposed) report(); }
  });

  // 生命周期：页面卸载时清理（标记 disposed，后续迟到写入被拒）
  function onUnload(){ disposed = true; realm.cleanedUp = realm.cleanedUp + 1; try { W.__jgSharedDisposed = instanceId; } catch (e) {} }
  W.addEventListener('pagehide', onUnload);
  W.addEventListener('unload', onUnload);

  function waitFor(pred, timeoutMs){
    return new Promise(function(res, rej){
      var t0 = Date.now();
      (function loop(){
        if (disposed) return rej(new Error('disposed'));
        var v = false; try { v = pred(); } catch (e) { v = false; }
        if (v) return res(v);
        if (Date.now() - t0 > timeoutMs) return rej(new Error('timeout'));
        setTimeout(loop, 50);
      })();
    });
  }

  // 收集执行期异常，避免「静默失败」；同时不吞掉错误（仍 console 输出）
  var scriptErrors = [];
  W.addEventListener('error', function(e){
    if (disposed) return;
    try { scriptErrors.push(String((e && (e.message || e.error)) || 'error')); } catch (x) {}
  });

  function execScript(entry){
    return new Promise(function(resolve){
      var before = scriptErrors.length;
      realm.scriptStarts = realm.scriptStarts + 1; // FE-06.0：本文档内模块**实际启动次数**
      var s = document.createElement('script');
      if (entry.execution === 'module') {
        s.type = 'module';
        s.textContent = entry.content;
      } else {
        // TavernHelper 语义：卡脚本运行在**函数作用域**，顶层 const/let 不进入全局词法环境。
        // 实证：本卡「剧情数据库」与「剧情逻辑」顶层都声明 STORY_MAP，裸顶层执行必然
        // "Identifier 'STORY_MAP' has already been declared"。故 classic 脚本包一层 IIFE 并
        // 用 .call(window) 保留顶层 this 语义（脚本自身的全局导出仍走 window.X = … 显式赋值）。
        // 注意：本片段整体是 TS 模板字符串，注释与字符串里都不可出现反斜杠-n 字面量，
        // 否则构建期会变成真实换行，破坏单引号字符串或把注释截断成裸代码。用字符码规避。
        s.textContent = '(function(){' + NL + entry.content + NL + '}).call(window);' + NL + '//# sourceURL=jg-shared-' + encodeURIComponent(entry.name) + '.js';
      }
      s.setAttribute('data-jg-shared', entry.name);
      var done = false;
      function finish(err){
        if (done) return; done = true;
        var errs = scriptErrors.slice(before);
        resolve({ name: entry.name, role: (entry.capabilities || []).join(','), ok: !err && errs.length === 0, error: err || errs[0] });
      }
      s.onerror = function(){ finish('script-load-error'); };
      try { (document.head || document.documentElement).appendChild(s); } catch (e) { finish(String(e && e.message)); return; }
      // classic 内联脚本同步执行；module 与异步初始化留出收敛窗口
      if (entry.execution === 'module') setTimeout(function(){ finish(null); }, 400);
      else setTimeout(function(){ finish(null); }, 0);
    });
  }

  function checkExports(){
    var present = [];
    for (var i = 0; i < B.expectExports.length; i++) {
      var sym = B.expectExports[i];
      try { if (typeof W[sym] !== 'undefined' && W[sym] !== null) present.push(sym); } catch (e) {}
    }
    return present;
  }

  function installBlock(reason){
    try { W.__jgSharedBlocked = reason; } catch (e) {}
    function guard(ev){
      try {
        if (!W.__jgSharedBlocked) return;
        ev.stopImmediatePropagation(); ev.preventDefault();
        var t = window.toastr;
        if (t && typeof t.error === 'function') t.error('开局已阻止：' + W.__jgSharedBlocked);
        else console.error('[jiuguan] 开局已阻止：' + W.__jgSharedBlocked);
      } catch (e) {}
    }
    document.addEventListener('click', guard, true);
    W.__jgSharedUnblock = function(){ try { W.__jgSharedBlocked = null; document.removeEventListener('click', guard, true); } catch (e) {} };
  }

  // 主流程：等 jQuery → 按依赖顺序执行 → 检查实际导出
  (function main(){
    waitFor(function(){ return typeof W.jQuery === 'function' || typeof W.$ === 'function'; }, 8000)
      .catch(function(){ return null; }) // 无 jQuery 也继续（部分脚本不依赖）
      .then(function(){
        var chain = Promise.resolve();
        var kernelWaited = false;
        var hasKernel = B.scripts.some(function(s){ return (s.capabilities || []).indexOf('mvu-kernel') >= 0; });
        B.scripts.forEach(function(entry){
          chain = chain.then(function(){
            if (disposed) return null;
            // 协议适配层：mvu-schema 脚本依赖内核提供的 z/Mvu/registerMvuSchema 全局，
            // 而内核是远程模块（异步）。**只在清单含内核能力时等待一次**（非每脚本重复等）。
            var pre = Promise.resolve();
            if (!kernelWaited && hasKernel && (entry.capabilities || []).indexOf('mvu-schema') >= 0) {
              kernelWaited = true;
              pre = waitFor(function(){ return typeof W.z !== 'undefined' || typeof W.Mvu !== 'undefined' || typeof W.registerMvuSchema !== 'undefined'; }, 2500)
                .catch(function(){ console.warn('[jiuguan] 内核全局（z/Mvu）未在等待窗口内出现，继续执行后续脚本'); return null; });
            }
            return pre.then(function(){ return execScript(entry); }).then(function(r){
              if (disposed) return r;
              status.coreScripts.items.push(r);
              report();
              return r;
            });
          });
        });
        return chain;
      })
      .then(function(){
        if (disposed) return;
        status.coreScripts.ok = status.coreScripts.items.length > 0 && status.coreScripts.items.every(function(i){ return i.ok; });
        // 导出可能在脚本**异步初始化**后（如 await 后）才挂到全局 —— 先给一个有限的收敛窗口，
        // 避免在导出尚未落地时误判为「缺失」并装阻断守卫。
        return waitFor(function(){
          return B.expectExports.every(function(s){ try { return typeof W[s] !== 'undefined' && W[s] !== null; } catch (e) { return false; } });
        }, 2500).catch(function(){ return null; }).then(function(){
          if (disposed) return;
          var present = checkExports();
          var missing = B.expectExports.filter(function(s){ return present.indexOf(s) < 0; });
          var missingCaps = B.missingCapabilities || [];
          // 阻断条件仅取**阻止性**项：必需导出缺失 / 必需能力缺失 / 阻止性缺口。
          // 非阻止性 warnings（未知依赖、可选模块降级）只展示，不阻断。
          var blocking = missing.length > 0 || missingCaps.length > 0 || B.gaps.length > 0;
          status.openingDeps = { ok: !blocking, missing: missing, gaps: B.gaps, missingCapabilities: missingCaps, warnings: B.warnings || [] };
          if (B.warnings && B.warnings.length) console.warn('[jiuguan] 共享脚本降级记录（不阻断）：' + B.warnings.join(' | '));
          if (blocking) {
            var why = [];
            if (missing.length) why.push('缺少导出：' + missing.join(', '));
            if (missingCaps.length) why.push('必需能力缺失：' + missingCaps.join(', '));
            if (B.gaps.length) why.push('阻止性缺口：' + B.gaps.join('；'));
            installBlock(why.join(' | '));
            console.warn('[jiuguan] 共享脚本未就绪（已阻断开局）—— ' + why.join(' | '));
          }
          // ── FE-C0：能力**运行时验证** + 操作级就绪 ──
          // 计划层的 provider-selected 不算可用；这里用**实测**升级到 verified。
          function capOk(cap){
            if (cap === 'mvu-adapter') return !!(W.Mvu && typeof W.Mvu.replaceMvuData === 'function' && typeof W.Mvu.getMvuData === 'function');
            if (cap === 'mvu-schema') return W.__jgSharedSchemaVerified === true; // 仅由真实 provider 置位（C3）
            return B.capabilityPlanOk[cap] === true;
          }
          status.operations = (B.operationPlan || []).map(function(op){
            var missing = (op.requires || []).filter(function(c){ return !capOk(c); });
            return { operation: op.operation, ok: !blocking && missing.length === 0, missing: missing };
          });
          var blockedOps = status.operations.filter(function(o){
            return (B.blockingOperations || []).indexOf(o.operation) >= 0 && !o.ok;
          });
          if (blockedOps.length) {
            var bmsg = blockedOps.map(function(o){ return o.operation + '缺少 ' + o.missing.join('/'); }).join('；');
            installBlock('正式开局所需能力未就绪：' + bmsg + '（已阻止写入，避免部分保存）');
            console.warn('[jiuguan] 操作被阻止：' + bmsg);
          }
          // 就绪判定完成 → 通知卡页面引导器按依赖顺序启动原卡页面
          try { W.__jgSharedOk = !blocking; W.__jgSharedDone = true; } catch (e) {}
          report();
        });
      })
      .catch(function(e){
        status.openingDeps = { ok: false, missing: B.expectExports.slice() };
        installBlock('共享脚本执行失败：' + String(e && e.message || e));
        try { W.__jgSharedOk = false; W.__jgSharedDone = true; } catch (x) {}
        report();
      });
  })();

  // 宿主回填 dataApi（宿主探测结果），共享运行时只负责 coreScripts / openingDeps
  W.__jgSharedReport = function(patch){
    if (disposed) return false;
    if (W.__jgSharedDisposed && W.__jgSharedDisposed !== instanceId) return false; // 拒绝旧实例迟到写入
    if (patch && patch.dataApi) status.dataApi = patch.dataApi;
    if (patch && patch.floorState) status.floorState = patch.floorState;
    report();
    return true;
  };
})();
</script>`;
}
