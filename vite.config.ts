/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/omniroute': {
        target: 'http://localhost:20128',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/omniroute/, ''),
      },
      '/freetheai': {
        target: 'https://api.freetheai.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/freetheai/, ''),
        secure: true,
      },
      '/gemini': {
        target: 'https://generativelanguage.googleapis.com/v1beta/openai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gemini(\/v1)?/, ''),
        secure: true,
      },
      '/groq': {
        target: 'https://api.groq.com/openai/v1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/groq(\/v1)?/, ''),
        secure: true,
      },
      '/mistral': {
        target: 'https://api.mistral.ai/v1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mistral(\/v1)?/, ''),
        secure: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
})
