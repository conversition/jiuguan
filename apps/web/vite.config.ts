import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后端端口跟随 JG_WEB_PORT（审查 4.3 修复）
const webPort = process.env.JG_WEB_PORT ?? '17800';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${webPort}`,
      // DSH 插件路由（如 /dsh-whale/*）：同源转发到后端，widget.js 相对路径 fetch 才能命中
      '/dsh-whale': `http://127.0.0.1:${webPort}`,
      // DSH 插件可视化约定入口 /<插件id>/widget.js（宿主 dsh-host 为每个带 UI 插件挂别名），
      // 正则兜底使任意插件 id 都可转发，不受前缀巧合影响
      '^/[^/]+/widget\\.js$': `http://127.0.0.1:${webPort}`,
    },
  },
  build: {
    outDir: 'dist',
  },
});
