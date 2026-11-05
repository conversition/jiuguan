#!/usr/bin/env node
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Remove only the repository's generated runtime tree before a fresh tsc emit. */
export function cleanRuntimeOutput(repoRoot: string, outputDir = resolve(repoRoot, 'dist-runtime')): void {
  const root = resolve(repoRoot);
  const target = resolve(outputDir);
  if (target !== resolve(root, 'dist-runtime')) throw new Error('runtime-output-path-invalid');
  if (!existsSync(target)) return;
  const output = lstatSync(target);
  if (output.isSymbolicLink() || !output.isDirectory()) throw new Error('runtime-output-path-invalid');
  rmSync(target, { recursive: true, force: false, maxRetries: 5, retryDelay: 50 });
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(import.meta.dirname ?? '.', '..', '..');
  cleanRuntimeOutput(repoRoot);
}
