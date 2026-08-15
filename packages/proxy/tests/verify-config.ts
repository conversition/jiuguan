/**
 * proxy 包验证 - 运行时配置（启动流程审查 P0-2：data/provider.json 优先级 + 写入）
 * 优先级：显式 overrides > provider.json > env/.env.local > 默认
 * 注：模块级 env 在 import 时捕获，测试先设 process.env 再动态 import。
 */
import { rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.JG_API_KEY = 'env-key-from-dotenv';
process.env.JG_MODEL = 'env-model';
process.env.JG_API_BASE = 'https://env.example/v1';
// 隔离：配置文件写到临时路径，不触碰真实 data/provider.json
process.env.JG_PROVIDER_JSON = resolve('data', 'test-provider.json');

const { loadProviderConfig, writeProviderJson, readProviderJson, PROVIDER_JSON_PATH } = await import('../src/config.ts');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail}`); }
};

rmSync(PROVIDER_JSON_PATH, { force: true });

console.log('\n== 无 provider.json：env 生效（向后兼容）==');
const c1 = loadProviderConfig();
check('env key 生效', c1.apiKey === 'env-key-from-dotenv', c1.apiKey);
check('env model 生效', c1.model === 'env-model', c1.model);

console.log('\n== 写入 provider.json：优先于 env ==');
writeProviderJson({ apiKey: 'file-key-123', model: 'file-model' });
check('文件已写', readFileSync(PROVIDER_JSON_PATH, 'utf8').includes('file-key-123'));
const c2 = loadProviderConfig();
check('file key 优先于 env', c2.apiKey === 'file-key-123', c2.apiKey);
check('file model 优先于 env', c2.model === 'file-model', c2.model);
check('未覆盖字段回落 env base', c2.baseUrl === 'https://env.example/v1', c2.baseUrl);

console.log('\n== 显式 overrides 最高优先 ==');
const c3 = loadProviderConfig({ apiKey: 'override-key' });
check('overrides > file > env', c3.apiKey === 'override-key', c3.apiKey);

console.log('\n== 部分写入保留其余字段 ==');
writeProviderJson({ apiKey: 'key-v2' });
const file2 = JSON.parse(readFileSync(PROVIDER_JSON_PATH, 'utf8')) as Record<string, string>;
check('部分写入保留 model', file2.model === 'file-model' && file2.apiKey === 'key-v2', JSON.stringify(file2));

console.log('\n== readProviderJson 不回显安全 ==');
check('read 函数存在且含 key（内部使用）', readProviderJson().apiKey === 'key-v2');

// 清理测试文件
rmSync(PROVIDER_JSON_PATH, { force: true });
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
