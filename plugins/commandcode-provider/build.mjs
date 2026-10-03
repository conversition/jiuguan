import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = import.meta.dirname;
const outDir = resolve(root, 'bundle');
await rm(outDir, { recursive: true, force: true });
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    target: 'node22',
    outDir,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    ssr: resolve(root, 'src/index.ts'),
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        inlineDynamicImports: true,
      },
    },
  },
});
