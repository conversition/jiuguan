import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后端端口跟随 JG_WEB_PORT（审查 4.3 修复）
const webPort = process.env.JG_WEB_PORT ?? '17800';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 初始化审查修复 #3：端口被占时报错退出而非静默换 5174（一键启动只会打开 5173，
    // 静默换端口会导致浏览器打开旧进程/空端口，表现为「页面打不开/无法初始化」）
    strictPort: true,
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
