import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
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
  plugins: [
    react(),
    tailwindcss(),
    // Colab 版のノートブック・サーバーが UI の版を確認するためのファイル
    {
      name: 'version-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version, commit, date: new Date().toISOString() }) })
      },
    },
    // PWA: ホーム画面に追加・オフライン動作。アプリ本体は事前キャッシュ、大きな OCR エンジン(wasm)は初回利用時にキャッシュ
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'インボイス確認ツール',
        short_name: 'インボイス確認',
        description: 'インボイス(適格請求書)の登録番号と記載事項を画像・PDFからチェック',
        lang: 'ja',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: '#0f766e',
        background_color: '#f8fafc',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,woff2}'],
        // OCR のモデル・wasm は大きいので事前キャッシュせず、使ったときにキャッシュする
        globIgnores: ['**/ocr/**', '**/paddle/**', '**/*.wasm'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        // Colab 版サーバーのログイン画面と API、開発版(/dev/)のページは本番のキャッシュから返さない
        navigateFallbackDenylist: [/\/login$/, /\/api\//, /\/dev\//],
        runtimeCaching: [
          { urlPattern: /\.wasm$/, handler: 'CacheFirst', options: { cacheName: 'ocr-wasm', expiration: { maxEntries: 8 } } },
          { urlPattern: /\/ocr\//, handler: 'CacheFirst', options: { cacheName: 'ocr-tesseract', expiration: { maxEntries: 16 } } },
          // 日本語 PDF の文字対応表(CMap)・標準フォント。使ったものをオフラインでも使えるよう保存する
          { urlPattern: /\/pdfjs\//, handler: 'CacheFirst', options: { cacheName: 'pdfjs-assets', expiration: { maxEntries: 200 } } },
        ],
      },
    }),
  ],
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
