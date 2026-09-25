import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' so the build works under any sub-path
export default defineConfig({
  base: './',
  plugins: [react()],
})
