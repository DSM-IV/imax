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
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'http://www.cgv.co.kr/',
        },
      },
    },
  },
})
