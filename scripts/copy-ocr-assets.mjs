// OCR に必要なファイル(tesseract.js ワーカー・WASMコア・学習データ)を public/ocr/ にコピーする。
// CDN に依存せず、バージョン固定で自前ホスティングするため。
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const out = join(process.cwd(), 'public', 'ocr')
mkdirSync(out, { recursive: true })

const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`))
const files = [
  [join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), 'worker.min.js'],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [
    join(pkgDir('tesseract.js-core'), f),
    f,
  ]),
  ...['eng', 'jpn'].map((l) => [join(pkgDir(`@tesseract.js-data/${l}`), '4.0.0_best_int', `${l}.traineddata.gz`), `${l}.traineddata.gz`]),
]

for (const [src, name] of files) {
  const dst = join(out, name)
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue
  copyFileSync(src, dst)
  console.log(`copied ${name}`)
}
