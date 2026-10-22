import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './', // 相对路径，方便部署到任意静态托管
  plugins: [react(), tailwindcss()],
})
