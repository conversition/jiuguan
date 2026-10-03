import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const webPackage = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

// 后端端口跟随 JG_WEB_PORT（审查 4.3 修复）
const webPort = process.env.JG_WEB_PORT ?? '17800';

export default defineConfig({
  plugins: [react()],
  define: {
    __JG_WEB_VERSION__: JSON.stringify(webPackage.version),
  },
  server: {
    port: 5173,
    // 初始化审查修复 #3：端口被占时报错退出而非静默换 5174（一键启动只会打开 5173，
    // 静默换端口会导致浏览器打开旧进程/空端口，表现为「页面打不开/无法初始化」）
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${webPort}`,
        // 后端精确校验 Host 以阻断 DNS rebinding；开发代理必须改写为目标 authority。
        changeOrigin: true,
      },
      // P3 受控 DSH 命名空间；不再给任意根路径或单插件特例做代理。
      '/ext': {
        target: `http://127.0.0.1:${webPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
