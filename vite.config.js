import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/cgv': {
        target: 'http://www.cgv.co.kr',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/cgv/, ''),
      },
    },
  },
})
