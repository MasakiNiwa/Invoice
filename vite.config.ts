import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
let commit = process.env.GITHUB_SHA?.slice(0, 7) ?? ''
if (!commit) {
  try {
    commit = execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    commit = 'dev'
  }
}

// GitHub Pages(サブパス)でも動くよう相対パス + HashRouter
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  // Worker 内でも動的 import(onnxruntime の遅延読み込み)を使うため ES モジュール形式
  worker: { format: 'es' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __COMMIT__: JSON.stringify(commit),
  },
  test: {
    environment: 'node',
  },
})
