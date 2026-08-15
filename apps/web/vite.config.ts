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
    },
  },
  build: {
    outDir: 'dist',
  },
});
