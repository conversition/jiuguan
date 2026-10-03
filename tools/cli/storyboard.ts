/**
 * tools/cli - 导演分镜 CLI 入口（Commit B）
 * 用法：
 *   node storyboard.ts --scene "深夜雨后铁桥，两人相拥坠落" [--shots 3] [--mode batch|shot]
 *       [--voice 亲密极简] [--workflow cinematic-default] [--db data/storyboard-run.db]
 * 说明：直连 provider（.env.local / data/provider.json）；记忆库可为空（批量召回自然退化为 0 命中）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady } from '../../packages/proxy/src/config.ts';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { HashEmbeddingProvider, createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { StoryboardOrchestrator } from './storyboard-orchestrator.ts';

function arg(k: string, d?: string): string | undefined {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
}

const scene = arg('--scene') ?? arg('--s');
if (!scene) {
  console.log('用法: node storyboard.ts --scene "场景描述" [--shots 3] [--mode batch|shot] [--voice 导演之声] [--workflow cinematic-default] [--db path]');
  process.exit(1);
}

const shots = Number(arg('--shots', '3'));
const mode = (arg('--mode') === 'shot' ? 'shot' : 'batch') as 'batch' | 'shot';
const dbPath = arg('--db', resolve('data', 'storyboard-run.db'))!;
if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });

const cfg = loadProviderConfig();
assertProviderReady(cfg);
const mem = new MemoryDb({ path: dbPath });
const ret = new RetrievalEngine(mem);
try {
  ret.setEmbeddingProvider(await createEmbeddingProvider(true));
} catch {
  ret.setEmbeddingProvider(new HashEmbeddingProvider());
}
const orch = new StoryboardOrchestrator({
  client: new OpenAICompatibleClient(cfg),
  ret,
  scanner: new LorebookScanner(mem),
  vms: new VariableManager(),
  mem,
  cardName: '导演分镜',
  round: 1,
});

const result = await orch.run(scene, { mode, shotCount: shots, workflow: arg('--workflow'), voice: arg('--voice') }, (label, detail) => {
  console.log(`\n━━ [${label}]${detail ? ` ${detail}` : ''} ━━`);
});

console.log(`\n${result.passed ? '✅' : '❌'} VP ${result.passed ? 'PASS' : 'FAIL'} ｜ 镜数 ${result.panels.length} ｜ errors ${result.errors.length} / warnings ${result.warnings.length}`);
if (result.errors.length) result.errors.slice(0, 8).forEach((e) => console.log(`  ✕ ${e}`));
if (result.directorsRead) console.log(`导演之声: ${result.directorsRead.voice} ｜ 意图: ${result.directorsRead.intention}`);
process.exit(result.passed ? 0 : 1);
