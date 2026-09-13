import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.VITE_BACKEND_PORT || 8000}`,
        changeOrigin: true,
      },
    },
  },
  // ✅ 新增多页面配置
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',    // 主页面
        intro: 'intro_ch.html',   // 介绍页面
        intro_en: 'intro_en.html',   // 介绍页面
        document: 'document_ch.html', // 中文文档
        document_en: 'document_en.html', // 英文文档
      },
    },
  },
});