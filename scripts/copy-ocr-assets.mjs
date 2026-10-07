// OCR に必要なファイル(tesseract.js ワーカー・WASMコア・学習データ)を public/ocr/ にコピーする。
// CDN に依存せず、バージョン固定で自前ホスティングするため。
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pub = join(process.cwd(), 'public')
const out = join(pub, 'ocr')
mkdirSync(out, { recursive: true })
mkdirSync(join(pub, 'paddle'), { recursive: true })

// exports で package.json を公開していないパッケージもあるので node_modules から直接探す
const pkgDir = (name) => {
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = join(base, name)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  throw new Error(`package not found: ${name}`)
}
const files = [
  [join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), 'worker.min.js'],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [
    join(pkgDir('tesseract.js-core'), f),
    f,
  ]),
  ...['eng', 'jpn'].map((l) => [join(pkgDir(`@tesseract.js-data/${l}`), '4.0.0_best_int', `${l}.traineddata.gz`), `${l}.traineddata.gz`]),
  // PaddleOCR PP-OCRv5 mobile(多言語)
  [join(pkgDir('pdfmarkdown-ppocrv5-models'), 'detection', 'PP-OCRv5_mobile_det_infer.ort'), join('..', 'paddle', 'det.ort')],
  [join(pkgDir('pdfmarkdown-ppocrv5-models'), 'recognition', 'PP-OCRv5_mobile_rec_infer.onnx'), join('..', 'paddle', 'rec.onnx')],
  [join(pkgDir('pdfmarkdown-ppocrv5-models'), 'recognition', 'ppocrv5_dict.txt'), join('..', 'paddle', 'dict.txt')],
]

for (const [src, name] of files) {
  const dst = join(out, name)
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue
  copyFileSync(src, dst)
  console.log(`copied ${name}`)
}
