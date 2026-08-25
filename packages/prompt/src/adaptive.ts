/**
 * prompt 包 - 自适应引擎（AQL M4）
 *
 * 半自动改进的运行时载体：把归因建议写入 data/adaptive-config.json（gitignore）。
 * 范式仿 provider.json 热读（packages/proxy/src/config.ts）：每次读取重读文件 → 会话侧 resolveOverride 生效；
 * 全部键可整体 reset（写 {}）回落到 env/默认 —— 可逆，不污染源码。
 *
 * 键空间（risk 由写入方标注）：
 *  - retrieval.{boostIds, dropThreshold, vecThreshold, weights}  循环A · 低/高
 *  - archive.{aliasAdditions[]}                                 循环A · 高（别名补齐需人工确认）
 *  - summary.{roundsDelta, longtermTokensDelta, windowTokensDelta} 循环B · 低
 *  - replan.{narrowK, replanK}                                  循环C · 低
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** RRF 通道权重（自包含类型，避免 memory 包反向依赖；对齐 DEFAULT_WEIGHTS） */
export interface RrfWeights {
  wBm25: number;
  wVec: number;
  wRecency: number;
  wAmPriority: number;
}

export interface AliasAddition {
  /** 用户常用称谓（如「会长」） */
  alias: string;
  /** 实体规范名（如「桐月樱佳」） */
  entityName: string;
  /** 简短说明/来源（如「环比重试率 3/5 高」） */
  note?: string;
}

export interface AdaptiveConfig {
  retrieval?: {
    boostIds?: number[];
    dropThreshold?: number;
    vecThreshold?: number;
    weights?: Partial<RrfWeights>;
  };
  archive?: { aliasAdditions?: AliasAddition[] };
  summary?: { roundsDelta?: number; longtermTokensDelta?: number; windowTokensDelta?: number };
  replan?: { narrowK?: number; replanK?: number };
  meta?: { updatedAt?: string; note?: string };
}

/** 配置文件路径（环境可覆盖：JG_ADAPTIVE_CONFIG；默认仓库 data/ 下） */
export function adaptiveConfigPath(): string {
  return process.env.JG_ADAPTIVE_CONFIG ?? resolve('data', 'adaptive-config.json');
}

/** 热读（每次读取重读文件；缺文件/坏 JSON → 空配置 {}） */
export function readAdaptiveConfig(): AdaptiveConfig {
  try {
    const raw = readFileSync(adaptiveConfigPath(), 'utf8');
    const cfg = JSON.parse(raw) as AdaptiveConfig;
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

/** 写入（缺目录自动建；坏路径抛错由调用方兜底） */
export function writeAdaptiveConfig(cfg: AdaptiveConfig): void {
  const p = adaptiveConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 重置（写空配置 → 行为回落到 env/默认） */
export function resetAdaptiveConfig(): void {
  writeAdaptiveConfig({});
}

/** 循环A 检索覆盖 */
export function adaptiveRetrieval(): { boostIds: number[]; dropThreshold?: number; vecThreshold?: number; weights?: Partial<RrfWeights> } {
  const r = readAdaptiveConfig().retrieval ?? {};
  return { boostIds: r.boostIds ?? [], dropThreshold: r.dropThreshold, vecThreshold: r.vecThreshold, weights: r.weights };
}

/** 循环A 别名补齐（merge 进实体名册） */
export function adaptiveAliasAdditions(): AliasAddition[] {
  return readAdaptiveConfig().archive?.aliasAdditions ?? [];
}

/** 循环B 纪要参数 Δ（与 env/默认相加） */
export function adaptiveSummaryDeltas(): { roundsDelta: number; longtermTokensDelta: number; windowTokensDelta: number } {
  const s = readAdaptiveConfig().summary ?? {};
  return {
    roundsDelta: s.roundsDelta ?? 0,
    longtermTokensDelta: s.longtermTokensDelta ?? 0,
    windowTokensDelta: s.windowTokensDelta ?? 0,
  };
}

/** 循环C 重规划门阈值（默认收窄 2、重规划 3） */
export function adaptiveReplanThresholds(): { narrowK: number; replanK: number } {
  const r = readAdaptiveConfig().replan ?? {};
  return { narrowK: r.narrowK ?? 2, replanK: r.replanK ?? 3 };
}