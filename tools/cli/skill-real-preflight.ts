/** @author Codex @date 2026-10-18 @version 1.1
 * 真实 Provider 前置体检 CLI（逻辑在 `skill-real-preflight-core.ts`，这里只负责 IO 与退出码）。
 *
 * 三条铁律：
 * 1. **fail closed**：只要没有一条候选通过（连模型 + 强制工具调用），退出码 1，绝不开始付费批次。
 * 2. **不外传凭据**：只打印长度与指纹，不打印 key 与响应体全文。
 * 3. **只读**：不写库、不改 `provider.json`、不落证据。
 *
 * 用法：
 *   pnpm skill:real-preflight
 *   pnpm skill:real-preflight -- --json
 *   JG_REAL_API_BASE=… JG_REAL_API_KEY=… JG_REAL_MODEL=… pnpm skill:real-preflight
 */
import {
    SKILL_REAL_PREFLIGHT_VERSION, collectSkillRealCandidates, judgeIndependenceReadiness,
    probeSkillRealCandidates, redactSkillRealKey,
} from './skill-real-preflight-core.ts';
import { parseSkillQualityJudgeEnvironment, SKILL_QUALITY_JUDGE_ENV } from '../../apps/server/skill-quality-authority.ts';

// This mode inspects the authoritative judge route only. It never loads keys,
// enumerates alternative endpoints, performs probes or authorizes a batch.
if (process.argv.includes('--inventory')) {
    const fields = Object.values(SKILL_QUALITY_JUDGE_ENV);
    const missing = fields.filter(name => process.env[name] === undefined);
    let route: 'configured' | 'missing' | 'invalid' = 'invalid';
    let reason: string | null = null;
    try {
        route = parseSkillQualityJudgeEnvironment() ? 'configured' : 'missing';
    } catch (error) {
        const code = error instanceof Error ? error.message : '';
        reason = /^skill-quality-judge-(?:env-unknown|env-incomplete|provider-invalid|model-invalid|independence-invalid)$/u.test(code)
            ? code : 'skill-quality-judge-inventory-failed';
    }
    console.log(JSON.stringify({ mode: 'read-only-judge-route-inventory', route, missing, reason,
        providerConnectivity: 'not-checked', generationIndependence: 'not-checked', paidBatchAuthorized: false,
        physicalCalls: 0 }));
    process.exit(route === 'configured' ? 0 : 1);
}

const json = process.argv.includes('--json');
const candidates = collectSkillRealCandidates();
if (candidates.length === 0) {
    console.error('没有找到任何候选配置（JG_REAL_*/data/provider.json/.env.local 全缺）');
    process.exit(2);
}
const probes = await probeSkillRealCandidates(candidates);
const independence = judgeIndependenceReadiness(candidates, probes);
const usable = probes.filter((item) => item.verdict === 'ok');

if (json) {
    console.log(JSON.stringify({
        preflightVersion: SKILL_REAL_PREFLIGHT_VERSION,
        generatedAt: new Date().toISOString(),
        candidates: candidates.map((item) => ({
            source: item.source, baseUrl: item.baseUrl, model: item.model,
            key: redactSkillRealKey(item.apiKey),
        })),
        probes,
        judgeIndependence: independence,
        // 只有「至少一条真通过」才算能开工；独立性单独给结论，不混进来。
        canStartPaidBatch: usable.length > 0,
        canStartDualJudge: usable.length > 0 && independence.ready,
    }, null, 2));
} else {
    for (const result of probes) {
        console.log(`[${result.source}] ${result.baseUrl} model=${result.model} `
            + `→ ${result.verdict}${result.httpStatus === null ? '' : ` (HTTP ${result.httpStatus})`}`
            + `${result.upstreamCode ? ` upstream=${result.upstreamCode}` : ''}`
            + `${result.note ? ` — ${result.note}` : ''}`);
    }
}

if (usable.length === 0) {
    if (!json) {
        console.error('\n真实通道不可用：没有任何候选能完成强制工具调用。**不要启动付费批次**。');
    }
    process.exit(1);
}
if (!independence.ready && !json) {
    console.error(`\n⚠️ 评委独立性不足：只有 ${independence.distinctProviderHosts} 个通过探测的不同上游，`
        + `生成器与双评委需要 ${independence.required} 个互不相同的 provider 来源`
        + '（探测失败或相同 host 的别名不算）。');
}
process.exit(0);
