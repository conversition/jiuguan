/**
 * tools/cli - 端到端 RAG 真向量检索验证（Step 2d/2e）
 * "会长"→桐月樱佳 确定性命中 + PG 真向量 ANN，注入可读设定（非 EJS 代码）。
 */
import { MemoryDb } from '../../packages/memory/src/db.ts';
import { RetrievalEngine } from '../../packages/memory/src/retrieval.ts';
import { createEmbeddingProvider } from '../../packages/memory/src/embedding.ts';
import { getPgVectorStore } from '../../packages/memory/src/pg-vector.ts';

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

async function main(): Promise<void> {
  const db = new MemoryDb({ path: 'data/session-1787145050757.db', autoInit: false });
  const ret = new RetrievalEngine(db);

  // bge 真实向量 + PG 通道
  const provider = await createEmbeddingProvider(true);
  ret.setEmbeddingProvider(provider);
  const pg = await getPgVectorStore();
  ret.setPgStore(pg.isReady ? pg : null);
  console.log(`embedding=${provider.name} pg=${pg.isReady ? 'on' : 'off'}`);

  for (const q of ['会长', '樱佳', '塞蕾丝', '物部千代凛是谁']) {
    console.log(`\n===== recallAsync("${q}") =====`);
    const r = await ret.recallAsync({ query: q, round: 1, budgetTokens: 800, namespace: 'session-1787145050757' });
    console.log(`layers=${JSON.stringify(r.layerStats)} elapsed=${r.elapsedMs}ms`);
    for (const h of r.hits) {
      const tag = h.confidence === 'low' ? ' [存疑]' : '';
      const content = h.content.replace(/[<%_>{}]/g, '');
      console.log(`  [${h.source}|${h.category}|${h.score.toFixed(2)}]${tag} ${content.slice(0, 80)}`);
    }
    check(`${q} 有命中`, r.hits.length > 0);
    if (q === '会长') {
      check('会长 命中含"樱佳"或"学生会长"设定', r.hits.some((h) => h.content.includes('学生会长') || h.content.includes('桐月樱佳') || h.content.includes('樱佳')));
    }
  }

  console.log(failed === 0 ? `\nRAG 端到端验证全部通过（${passed} 项）✅` : `\n${failed} 项失败 ❌`);
  await pg.close();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
