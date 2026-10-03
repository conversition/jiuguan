#!/usr/bin/env node
/**
 * PostgreSQL/pgvector 安全自检：不输出 DSN、用户名或密码，只报告连通性与索引规模。
 */
import { getPgVectorStore } from '../../packages/memory/src/pg-vector.ts';

async function main(): Promise<void> {
  const pg = await getPgVectorStore();
  try {
    if (!pg.isReady) {
      console.error('PostgreSQL/pgvector: unavailable（检查 JG_PG_DSN、服务与 vector 扩展）');
      process.exitCode = 1;
      return;
    }
    const [chunks, aliases] = await Promise.all([pg.chunkCount(), pg.aliasCount()]);
    console.log(JSON.stringify({
      ready: true,
      role: 'derived-semantic-index',
      chunks,
      aliases,
      authoritativeStore: 'sqlite',
    }));
  } finally {
    await pg.close();
  }
}

void main();
