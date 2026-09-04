/**
 * fix-pack-init 一键应用脚本
 *
 * 用途：把 fixed-files/ 里的修复文件按原始相对路径覆盖到目标 jiuguan 项目根目录。
 * 前提：本文件夹（fix-pack-init）位于目标项目根目录下。
 *
 * 运行： node apply-fixes.mjs          （在 fix-pack-init 目录内）
 *       node fix-pack-init/apply-fixes.mjs   （在项目根目录）
 *
 * 可加 --dry-run 只预览不写入。
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const TARGET_ROOT = resolve(PACK_ROOT, '..');
const FIXED = join(PACK_ROOT, 'fixed-files');
const DRY = process.argv.includes('--dry-run');

/** 修复文件 → 目标相对路径（与项目原始布局一致） */
const FILES = [
  '一键启动.bat',
  'pnpm-workspace.yaml',
  'apps/server/server.ts',
  'apps/web/vite.config.ts',
];

console.log(`修复包:   ${PACK_ROOT}`);
console.log(`目标项目: ${TARGET_ROOT}`);
console.log(DRY ? '模式:     预览（--dry-run）' : '模式:     实际写入');
console.log('');

// 基本存在性校验，防止拷错位置
for (const marker of ['package.json', 'apps', 'packages', 'tools']) {
  if (!existsSync(join(TARGET_ROOT, marker))) {
    console.error(`[中止] 目标目录缺少 ${marker} —— 请把 fix-pack-init 整个文件夹放在 jiuguan 项目根目录下再运行。`);
    process.exit(1);
  }
}

let ok = 0;
for (const rel of FILES) {
  const src = join(FIXED, rel);
  const dst = join(TARGET_ROOT, rel);
  if (!existsSync(src)) {
    console.error(`[缺失] fixed-files/${rel} 不存在，修复包可能不完整`);
    process.exit(1);
  }
  const status = existsSync(dst) ? '覆盖' : '新增';
  console.log(`  [${status}] ${rel}`);
  if (!DRY) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  ok++;
}

console.log('');
if (DRY) {
  console.log(`预览完成：共 ${ok} 个文件将被写入。去掉 --dry-run 再运行即实际应用。`);
} else {
  console.log(`应用完成：${ok} 个文件已写入目标项目。`);
  console.log('');
  console.log('后续建议：');
  console.log('  1. 关闭所有旧的 jiuguan 终端窗口/进程（或双击项目根目录的 停止.bat）');
  console.log('  2. 由于 pnpm-workspace.yaml 改动，建议执行一次 pnpm install');
  console.log('  3. 双击 一键启动.bat 启动，或运行 fix-pack-init/tests/run-tests.bat 验证修复');
}
