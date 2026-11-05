import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 开发时把 /api 代理到 Express 后端，前端代码里不写死 host。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
