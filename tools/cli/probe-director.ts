/**
 * 临时探针：真实 provider 跑一遍 StoryboardOrchestrator（同 /api/storyboard/run），
 * 验证分镜管线是否真的产出内容。跑完即删。
 */
import { resolve } from 'node:path';
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { HashEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { LorebookScanner } from '../../packages/core/src/scanner.ts';
import { VariableManager } from '../../packages/variable/src/vms.ts';
import { OpenAICompatibleClient } from '../../packages/proxy/src/client.ts';
import { loadProviderConfig, assertProviderReady } from '../../packages/proxy/src/config.ts';
import { StoryboardOrchestrator } from './storyboard-orchestrator.ts';

const cfg = loadProviderConfig();
assertProviderReady(cfg);
console.log('[probe] provider:', cfg.baseUrl, cfg.model);

const mem = new MemoryDb({ path: resolve('data', 'probe-director.db') });
const ret = new RetrievalEngine(mem);
ret.setEmbeddingProvider(new HashEmbeddingProvider());
const orch = new StoryboardOrchestrator({
  client: new OpenAICompatibleClient(cfg),
  ret,
  scanner: new LorebookScanner(mem),
  vms: new VariableManager(),
  mem,
  cardName: '探针卡',
  round: 1,
});

const scene = '深夜雨后的铁桥，她独自站在栏杆边，手里攥着一封没有寄出的信，路灯把道的光芒洒在潮湿的路面。';
const result = await orch.run(scene, { mode: 'batch', shotCount: 3, workflow: 'cinematic-default' }, (label, detail) => {
  console.log(`  [stage] ${label}${detail ? ` ${detail}` : ''}`);
});

console.log('\n[probe] result ==========');
console.log('  passed:', result.passed);
console.log('  directorsRead:', result.directorsRead ? JSON.stringify(result.directorsRead) : 'null');
console.log('  panels:', result.panels.length);
console.log('  panel0 keys:', result.panels[0] ? Object.keys(result.panels[0]).join(',') : '(none)');
console.log('  panel0 pp:', result.panels[0]?.positive_prompt?.slice(0, 80));
console.log('  sequence:', result.sequence ? result.sequence.narrative?.slice(0, 60) : 'null');
console.log('  humanized:', result.humanized ? result.humanized.summary : 'null');
console.log('  errors:', result.errors.slice(0, 6));
console.log('  warnings:', result.warnings.slice(0, 6));
process.exit(0);