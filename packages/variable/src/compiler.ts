/**
 * variable 包 - 变量编译调度器（编译状态机 + 缓存 + 重试上限）
 *
 * 卡片加载时一次性编译：检测卡类型（MVU / 结构化 / 纯 NL / 混合 / 无）
 *   → 编译成 VariableManifest（校验通过 → Active）→ 缓存到磁盘
 *   → 运行期每回合由规则执行器跑确定性规则（零 token）。
 *
 * 状态机：Idle → Compiling → Active | Fallback
 *   - 编译最多 MAX_COMPILE_ATTEMPTS 次（初次 + 一次修正），每次产物过 validateManifest
 *   - 全部失败 → Fallback（变量静止，会话不受影响）
 *   - 产物绝不进对话 prompt（04 铁律：平台做确定性的事）
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseExpr } from './dsl.ts';
import { validateManifest } from './manifest.ts';
import type { VariableManifest } from './manifest.ts';

export type CompileState = 'idle' | 'compiling' | 'active' | 'fallback';

export type CardSource = 'mvu' | 'structured' | 'nl' | 'mixed' | 'none';

/** 卡片变量规格（编译输入）：由 session 在卡加载时收集 */
export interface CardVariableSpec {
  cardId: string;
  /** 卡面可编译文本（描述/剧本/设定等；MVU 卡可不带） */
  cardText: string;
  /** MVU 监控器脚本源码（tavern_helper 中 >10KB），有则直连桥不进编译 */
  engineScript?: string;
  /** 结构化变量声明（酒馆助手 JSON/YAML 解析结果） */
  structured?: { name: string; type: 'number' | 'string' | 'boolean'; default?: number | string | boolean }[];
}

/** 编译执行钩子（LLM 编译器 seam）：输入规格 + 上轮错误（第 2 次修正），输出候选 manifest 或 null */
export type CompileFn = (spec: CardVariableSpec, lastError?: string) => Promise<VariableManifest | null>;

const MAX_COMPILE_ATTEMPTS = 2;
const MVU_SCRIPT_MIN = 10 * 1024; // 监控器脚本判定阈值（>10KB）

/** 卡片文本指纹（缓存失效判断：内容变则重编） */
export function hashCard(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** 检测卡类型：MVU > 结构化 > 纯 NL（含「当…时」/「变量更新」等标记）> 混合 > 无 */
export function detectCardSource(spec: CardVariableSpec): CardSource {
  const hasEngine = (spec.engineScript?.length ?? 0) > MVU_SCRIPT_MIN;
  const hasStructured = (spec.structured?.length ?? 0) > 0;
  const hasNl = /当[^。\n]{0,20}时|变量更新|则[^。\n]{0,12}(加|减|变|更新|为)|好感|信任|金钱|等级/.test(spec.cardText);
  if (hasEngine && hasStructured) return 'mixed';
  if (hasEngine) return 'mvu';
  if (hasStructured) return 'structured';
  if (hasNl) return 'nl';
  return 'none';
}

/** 编译调度器：每卡一实例（缓存 key = cardId） */
export class VariableCompiler {
  private state: CompileState = 'idle';
  private attempts = 0;
  private lastError = '';
  private manifest: VariableManifest | null = null;
  private cacheHit = false;

  constructor(
    private cardId: string,
    private cacheDir: string,
    private compileFn?: CompileFn,
  ) {}

  stateOf(): CompileState { return this.state; }
  attemptsCount(): number { return this.attempts; }
  lastErrorOf(): string { return this.lastError; }
  /** 运行期清单（Active 后非空） */
  getManifest(): VariableManifest | null { return this.manifest; }
  /** 本轮编译是否命中缓存（供日志/监管） */
  wasCacheHit(): boolean { return this.cacheHit; }

  private cacheFile(): string { return join(this.cacheDir, `${this.cardId}.json`); }

  /** 编译入口：缓存命中直取；否则走 compileFn（≤MAX 次，校验通过即 Active） */
  async compile(spec: CardVariableSpec): Promise<{ manifest: VariableManifest | null; state: CompileState; cacheHit: boolean }> {
    // 已在 Active 且内容未变 → 直接返回
    if (this.state === 'active') return { manifest: this.manifest, state: this.state, cacheHit: this.cacheHit };
    if (this.state === 'fallback') return { manifest: null, state: this.state, cacheHit: false };
    if (this.state === 'compiling') throw new Error('编译进行中，勿重入');

    const hash = hashCard(spec.cardText);
    // 缓存命中（内容指纹一致）→ Active，不再消耗 token
    if (existsSync(this.cacheFile())) {
      try {
        const cached = JSON.parse(readFileSync(this.cacheFile(), 'utf8')) as { manifest: VariableManifest; cardHash: string };
        if (cached.cardHash === hash) {
          const v = validateManifest(cached.manifest, { parseExpr });
          if (v.ok) {
            this.manifest = v.manifest;
            this.state = 'active';
            this.cacheHit = true;
            return { manifest: this.manifest, state: this.state, cacheHit: true };
          }
        }
      } catch { /* 坏缓存：视为未命中，重编 */ }
    }

    this.state = 'compiling';
    this.attempts = 0;
    this.lastError = '';
    while (this.attempts < MAX_COMPILE_ATTEMPTS) {
      this.attempts++;
      let candidate: VariableManifest | null = null;
      try {
        candidate = await this.compileFn?.(spec, this.lastError || undefined) ?? null;
      } catch (e) {
        this.lastError = (e as Error).message;
        continue;
      }
      if (!candidate) {
        this.lastError = this.lastError || '编译器未返回产物';
        continue;
      }
      const v = validateManifest(candidate, { parseExpr });
      if (v.ok) {
        this.manifest = v.manifest;
        this.state = 'active';
        this.cacheHit = false;
        // 持久化缓存（含内容指纹）
        try {
          mkdirSync(this.cacheDir, { recursive: true });
          writeFileSync(this.cacheFile(), JSON.stringify({ manifest: this.manifest, cardHash: hash }), 'utf8');
        } catch { /* 缓存写失败不阻断 */ }
        return { manifest: this.manifest, state: this.state, cacheHit: false };
      }
      this.lastError = v.issues.join('; ');
    }
    this.state = 'fallback';
    return { manifest: null, state: this.state, cacheHit: false };
  }

  /** 内容变更 → 失效缓存，强制重编 */
  invalidate(): void {
    this.state = 'idle';
    this.manifest = null;
    try { rmSync(this.cacheFile(), { force: true }); } catch { /* 忽略 */ }
  }
}
