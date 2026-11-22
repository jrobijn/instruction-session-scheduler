import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Forward API calls to the Go backend so the dev setup is same-origin, like production.
  server: { proxy: { '/api': 'http://localhost:3001' } },
})
