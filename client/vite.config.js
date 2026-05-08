import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    global: 'window',
    'process.env': {},
    process: {
      env: {},
      nextTick: (fn) => setTimeout(fn, 0),
    },
  },
  optimizeDeps: {
    include: ['simple-peer'],
  },
})
