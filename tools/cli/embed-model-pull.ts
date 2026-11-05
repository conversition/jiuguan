/** @author Codex @date 2026-10-18 @version 1.0
 * 一次性把 bge 模型文件拉到本地 `models/`，让 transformers.js 走本地加载。
 *
 * 背景（2026-10-18 实测）：hf-mirror 很不稳定——同一个仓库里 `config.json`/`model.onnx` 能 200，
 * `tokenizer.json`/`model_quantized.onnx` 却 `UND_ERR_CONNECT_TIMEOUT`。transformers.js 任何一次
 * 下载失败都会让 bge provider 加载失败，`createEmbeddingProvider` 回落到 `hash-ngram`(256 维)，
 * 于是 PG 的 `vector(512)` 列全部拒绝写入（`expected 512 dimensions, not 256`），
 * 且 PG 语义检索因 `queryVec.length !== PG_VECTOR_DIMS` 静默返回空。
 *
 * 所以这里的关键是**重试**：对每个文件做指数退避，直到全部就位。模型文件不进 git（.gitignore）。
 *
 * 用法：
 *   pnpm embed:pull                 # 默认 Xenova/bge-small-zh-v1.5
 *   pnpm embed:pull -- --force      # 已存在也重新下载
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const MODEL = arg('--model') ?? 'Xenova/bge-small-zh-v1.5';
const REVISION = arg('--revision') ?? 'main';
const MIRROR = process.env.JG_HF_MIRROR ?? 'https://hf-mirror.com';
const OUT_ROOT = arg('--out') ?? resolve('models');
const force = process.argv.includes('--force');

/** transformers.js 在 dtype:'q8' 时请求 onnx/model_quantized.onnx；缺一不可。 */
const FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx',
] as const;

const ATTEMPTS = Number(arg('--attempts') ?? 6);
const TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function workspaceRoot(): string {
    let cursor = resolve(process.cwd());
    while (true) {
        if (existsSync(resolve(cursor, 'pnpm-workspace.yaml'))) return cursor;
        const parent = dirname(cursor);
        if (parent === cursor) return cursor;
        cursor = parent;
    }
}

async function downloadOne(rel: string): Promise<'ok' | 'exists'> {
    const outPath = join(OUT_ROOT, MODEL, rel);
    if (!force && existsSync(outPath) && statSync(outPath).size > 0) return 'exists';
    const url = `${MIRROR}/${MODEL}/resolve/${REVISION}/${rel}`;
    mkdirSync(dirname(outPath), { recursive: true });
    const tmp = `${outPath}.part`;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, {
                redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = new Uint8Array(await response.arrayBuffer());
            if (body.length === 0) throw new Error('empty body');
            writeFileSync(tmp, body);
            renameSync(tmp, outPath);
            const sha = createHash('sha256').update(body).digest('hex').slice(0, 12);
            console.log(`[pull] ${rel} ok (${(body.length / 1_048_576).toFixed(1)} MB, sha256:${sha}…)`);
            return 'ok';
        } catch (error) {
            const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            console.warn(`[pull] ${rel} 第 ${attempt}/${ATTEMPTS} 次失败：${reason}`);
            if (attempt < ATTEMPTS) await sleep(Math.min(30_000, 1_500 * 2 ** (attempt - 1)));
        }
    }
    throw new Error(`download-failed:${rel}`);
}

if (resolve(OUT_ROOT) !== join(workspaceRoot(), 'models') && !arg('--out')) {
    console.warn(`[pull] 输出目录不是仓库根的 models/：${OUT_ROOT}（transformers 默认在 cwd 找 models/，请确认一致）`);
}
let failed = 0;
for (const rel of FILES) {
    try {
        await downloadOne(rel);
    } catch (error) {
        failed += 1;
        console.error(`[pull] 放弃 ${rel}：${(error as Error).message}`);
    }
}
if (failed > 0) {
    console.error(`[pull] 有 ${failed} 个文件未就位；transformers 仍会尝试远程并可能再次回落 hash。请重跑本命令。`);
    process.exit(1);
}
console.log(`[pull] 全部就位：${join(OUT_ROOT, MODEL)}`);
