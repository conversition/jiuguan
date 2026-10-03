/**
 * AQL 归因聚合 CLI（M3）
 * 用法：
 *   node --experimental-strip-types --experimental-transform-types tools/cli/analyze-quality.ts            # 扫 data/session-*.db
 *   node ... analyze-quality.ts --db data/session-xxx.db                                                   # 单库
 *   node ... analyze-quality.ts --db data/session-xxx.db --usage-db data/model-usage.sqlite                # 只读关联真实 usage
 *   node ... analyze-quality.ts --apply                                                                     # 自动应用低风险建议到 adaptive-config（半自动）
 * 输出：各库负反馈率汇总 + 按置信排序的改进建议；--apply 只写低风险项（summary/budget），高风险（rag）仅展示。
 */
import { resolve } from 'node:path';
import { analyzeQualityDb, scanSessionDbs, qualityMinSample } from './quality.ts';
import { correlateAqlUsageFiles } from './quality-usage.ts';
import { readAdaptiveConfig, writeAdaptiveConfig } from '../../packages/prompt/src/adaptive.ts';

const find = (argv: string[], k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function main() {
  const apply = process.argv.includes('--apply');
  const single = find(process.argv, '--db');
  const usageDb = find(process.argv, '--usage-db');
  const dataDir = find(process.argv, '--dir') ?? resolve('data');
  const files = single ? [resolve(single)] : scanSessionDbs(dataDir);
  const min = qualityMinSample();

  if (files.length === 0) {
    console.log(`（无会话 db：${dataDir}）`);
    return;
  }

  let totalRounds = 0;
  let totalNeg = 0;
  const lowRisk: { dim: string; action: string }[] = [];
  for (const file of files) {
    const r = analyzeQualityDb(file);
    totalRounds += r.rounds;
    totalNeg += r.negativeRounds;
    console.log(`\n▸ ${r.sessionId}  rounds=${r.rounds} 负反馈=${r.negativeRounds}（${(r.retryRate * 100).toFixed(0)}%） 契约失败=${r.planFailedRounds}`);
    if (usageDb) {
      const costs = correlateAqlUsageFiles(file, resolve(usageDb));
      const provider = costs.filter((row) => row.selected.source === 'provider').length;
      const estimated = costs.filter((row) => row.selected.source === 'estimated').length;
      const unavailable = costs.filter((row) => row.selected.source === 'unavailable').length;
      const tokens = costs.reduce((sum, row) => sum + (row.selected.totalTokens ?? 0), 0);
      console.log(`  成本关联 accepted=${costs.length} provider=${provider} estimated=${estimated} unavailable=${unavailable} tokens=${tokens}`);
    }
    for (const e of r.entries.filter((x) => x.negative >= 2)) {
      console.log(`  词条[${e.id}]「${e.label.slice(0, 24)}」 ${e.negative}/${e.appeared} 率${(e.rate * 100).toFixed(0)}% miss=${e.miss}（负${e.missNegative}）`);
    }
    if (r.suggestions.length === 0) { console.log('  （无建议）'); continue; }
    for (const s of r.suggestions) {
      console.log(`  [${s.dimension}/${s.risk}] ${s.action}  (${s.confidence})`);
      if (apply && s.risk === 'low') lowRisk.push({ dim: s.dimension, action: `${s.dimension}.${s.target} ← ${s.action}` });
    }
  }

  if (apply && lowRisk.length > 0) {
    const cfg = readAdaptiveConfig();
    const sum = cfg.summary ?? {};
    // summary/budget 低风险收敛（保守步长，可回滚）
    if (lowRisk.some((x) => x.dim === 'summary')) {
      sum.roundsDelta = Math.max(-5, (sum.roundsDelta ?? 0) - 2);
      sum.longtermTokensDelta = (sum.longtermTokensDelta ?? 0) + 300;
    }
    if (lowRisk.some((x) => x.dim === 'budget')) {
      sum.windowTokensDelta = (sum.windowTokensDelta ?? 0) + 1000;
    }
    cfg.summary = sum;
    cfg.meta = { ...(cfg.meta ?? {}), updatedAt: new Date().toISOString(), note: `analyze-quality --apply 自动应用 ${lowRisk.length} 条低风险建议` };
    writeAdaptiveConfig(cfg);
    console.log(`\n[apply] 已写 data/adaptive-config.json（低风险 ${lowRisk.length} 条；高风险需面板一键应用或手工）`);
  } else if (apply) {
    console.log('\n[apply] 无低风险建议');
  }

  console.log(`\n汇总：${files.length} 库 / ${totalRounds} 轮 / 负反馈 ${totalNeg} 轮（门槛 minSample=${min}）`);
  if (apply) {
    console.log('[提示] 高风险（rag 提升/别名补齐）仅展示，交付人在前端「质量」面板或直接编辑 adaptive-config.json 应用。');
  }
}

main();
