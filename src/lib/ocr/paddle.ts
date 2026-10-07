/**
 * PaddleOCR (PP-OCRv5 mobile, 多言語=日本語対応) を ONNX Runtime Web で動かすエンジン。
 *
 * - 検出(DBNet): 確率マップ → 二値化 → 連結成分 → 枠を膨らませる(unclip)
 * - 認識(CTC):   高さ48pxに揃えた行画像 → 各時刻の最尤文字 → 重複と空白(blank)を除去
 * - バックエンド: WebGPU が使えれば GPU、なければ WebAssembly(CPU)
 *
 * モデルは npm パッケージ pdfmarkdown-ppocrv5-models(Apache-2.0)から自前ホスティング。
 */
import type * as Ort from 'onnxruntime-web'
import { createCanvas, type Rect } from '../image'
import { connectedComponents } from '../textlines'
import type { OcrBackend } from './engine'
import { AbortError, type OcrLine, type OcrParams, type OcrResult, type OcrSymbol } from './pool'

export type PaddleBackendPref = 'auto' | 'webgpu' | 'wasm'

const REC_H = 48
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

interface Loaded {
  ort: typeof Ort
  det: Ort.InferenceSession
  rec: Ort.InferenceSession
  dict: string[]
  provider: 'webgpu' | 'wasm'
}

const assetBase = () => new URL('./paddle/', document.baseURI).href

export function webGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

async function fetchWithProgress(url: string, onProgress: (p: number) => void): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url} の取得に失敗しました (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    if (total) onProgress(got / total)
  }
  const out = new Uint8Array(got)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export class PaddleEngine implements OcrBackend {
  readonly pref: PaddleBackendPref
  onRecognizeProgress: ((p: number) => void) | null = null
  private loading: Promise<Loaded> | null = null
  private loaded: Loaded | null = null
  /** ONNX セッションは同時実行しない(順番待ち) */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(pref: PaddleBackendPref) {
    this.pref = pref
  }

  get label(): string {
    return `PaddleOCR PP-OCRv5 (${this.loaded?.provider === 'webgpu' ? 'WebGPU' : 'WebAssembly'})`
  }

  get provider(): 'webgpu' | 'wasm' | null {
    return this.loaded?.provider ?? null
  }

  init(onProgress?: (status: string, progress: number) => void): Promise<void> {
    if (!this.loading) {
      this.loading = this.load(onProgress ?? (() => {}))
      this.loading.catch(() => {
        this.loading = null
      })
    }
    return this.loading.then(() => undefined)
  }

  private async load(onProgress: (status: string, progress: number) => void): Promise<Loaded> {
    const wantGpu = this.pref === 'webgpu' || (this.pref === 'auto' && webGpuAvailable())
    // WebGPU 版は CPU 実行もできるが wasm が大きい(27MB)ので、GPU を使わないときは CPU 版(14MB)を読む
    const ort: typeof Ort = wantGpu ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm')
    // wasm 本体は Vite がバンドルして import.meta.url 基準で読み込む
    ort.env.wasm.numThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
    const base = assetBase()
    const parts = [0, 0, 0]
    const report = (i: number, p: number) => {
      parts[i] = p
      onProgress('loading paddleocr models', (parts[0] * 4.9 + parts[1] * 16.6 + parts[2] * 0.1) / 21.6)
    }
    const [detBytes, recBytes, dictText] = await Promise.all([
      fetchWithProgress(`${base}det.ort`, (p) => report(0, p)),
      fetchWithProgress(`${base}rec.onnx`, (p) => report(1, p)),
      fetch(`${base}dict.txt`).then((r) => {
        report(2, 1)
        return r.text()
      }),
    ])
    onProgress('initializing onnxruntime', 0.99)
    const create = async (bytes: Uint8Array, gpu: boolean) =>
      ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' })
    let provider: 'webgpu' | 'wasm' = wantGpu ? 'webgpu' : 'wasm'
    let det: Ort.InferenceSession
    let rec: Ort.InferenceSession
    try {
      det = await create(detBytes, wantGpu)
      rec = await create(recBytes, wantGpu)
    } catch (e) {
      if (!wantGpu) throw e
      console.warn('WebGPU で初期化できなかったため WebAssembly で再試行します', e)
      provider = 'wasm'
      det = await create(detBytes, false)
      rec = await create(recBytes, false)
    }
    // 辞書: 出力クラス index i の文字 = 辞書ファイルの i 行目(0 は blank 扱い)
    const dict = dictText.split(/\r?\n/)
    this.loaded = { ort, det, rec, dict, provider }
    return this.loaded
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  recognize(image: HTMLCanvasElement, params: OcrParams, signal?: AbortSignal): Promise<OcrResult> {
    return this.serial(async () => {
      if (signal?.aborted) throw new AbortError()
      const L = this.loaded ?? (await this.loading) ?? null
      if (!L) throw new Error('PaddleOCR が初期化されていません')
      const lineMode = params.psm === '7' || params.psm === '8' || params.psm === '13'
      if (lineMode) {
        const full = { x: 0, y: 0, w: image.width, h: image.height }
        const [r] = await this.recBatch(L, image, [full])
        const line = this.toLine(r.text, r.conf, full, r.symbols)
        return { text: r.text, conf: r.conf, lines: r.text ? [line] : [] }
      }
      // 全体解析は呼び出し側で解像度を決めている(スキャン強度)ので、ここでは上限だけ設ける
      const maxSide = params.psm === '3' ? 3200 : 1600
      const boxes = await this.detect(L, image, maxSide)
      if (signal?.aborted) throw new AbortError()
      const lines: OcrLine[] = []
      const B = 8
      for (let i = 0; i < boxes.length; i += B) {
        if (signal?.aborted) throw new AbortError()
        const batch = boxes.slice(i, i + B)
        const rs = await this.recBatch(L, image, batch)
        rs.forEach((r, k) => {
          if (r.text.trim()) lines.push(this.toLine(r.text, r.conf, batch[k], r.symbols))
        })
        this.onRecognizeProgress?.(Math.min(1, (i + B) / Math.max(1, boxes.length)))
      }
      lines.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      const conf = lines.length ? lines.reduce((s, l) => s + l.conf, 0) / lines.length : 0
      return { text: lines.map((l) => l.text).join('\n'), conf, lines }
    })
  }

  private toLine(text: string, conf: number, rect: Rect, symbols: OcrSymbol[]): OcrLine {
    return { text, conf, rect, words: [{ text, conf, rect, symbols }] }
  }

  /** DBNet による文字行の検出。返り値は image 座標の矩形 */
  private async detect(L: Loaded, image: HTMLCanvasElement, maxSide: number): Promise<Rect[]> {
    const ratio = Math.min(1, maxSide / Math.max(image.width, image.height))
    const w = Math.max(32, Math.round((image.width * ratio) / 32) * 32)
    const h = Math.max(32, Math.round((image.height * ratio) / 32) * 32)
    const c = createCanvas(w, h)
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(image, 0, 0, w, h)
    const px = ctx.getImageData(0, 0, w, h).data
    const plane = w * h
    const input = new Float32Array(3 * plane)
    for (let i = 0, j = 0; j < plane; i += 4, j++) {
      // BGR 順(PaddleOCR は OpenCV の BGR 画像に ImageNet の平均・分散を適用)
      input[j] = (px[i + 2] / 255 - DET_MEAN[0]) / DET_STD[0]
      input[plane + j] = (px[i + 1] / 255 - DET_MEAN[1]) / DET_STD[1]
      input[2 * plane + j] = (px[i] / 255 - DET_MEAN[2]) / DET_STD[2]
    }
    const out = await L.det.run({ [L.det.inputNames[0]]: new L.ort.Tensor('float32', input, [1, 3, h, w]) })
    const prob = out[L.det.outputNames[0]].data as Float32Array
    const bin = new Uint8Array(plane)
    for (let i = 0; i < plane; i++) bin[i] = prob[i] > 0.3 ? 1 : 0
    const comps = connectedComponents(bin, w, h)
    const sx = image.width / w
    const sy = image.height / h
    const rects: Rect[] = []
    for (const cp of comps) {
      if (cp.w < 3 || cp.h < 3) continue
      // 枠内の平均確率(box_thresh 0.6)
      let s = 0
      let n = 0
      for (let y = cp.y; y < cp.y + cp.h; y++) {
        for (let x = cp.x; x < cp.x + cp.w; x++) {
          const v = prob[y * w + x]
          if (v > 0.3) {
            s += v
            n++
          }
        }
      }
      if (n === 0 || s / n < 0.6) continue
      // unclip: 面積×比率/周長 だけ外側に広げる(DB は縮めた領域を予測するため)
      const d = (cp.w * cp.h * 1.5) / (2 * (cp.w + cp.h))
      const x0 = Math.max(0, (cp.x - d) * sx)
      const y0 = Math.max(0, (cp.y - d) * sy)
      const x1 = Math.min(image.width, (cp.x + cp.w + d) * sx)
      const y1 = Math.min(image.height, (cp.y + cp.h + d) * sy)
      // 縦書き(縦長)は対象外
      if (y1 - y0 > (x1 - x0) * 1.5 && x1 - x0 < 40) continue
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
    return rects
  }

  /** 複数行をまとめて認識(幅を最大幅に揃えてバッチ実行) */
  private async recBatch(L: Loaded, image: HTMLCanvasElement, rects: Rect[]): Promise<{ text: string; conf: number; symbols: OcrSymbol[] }[]> {
    if (rects.length === 0) return []
    const widths = rects.map((r) => Math.min(3200, Math.max(16, Math.round((r.w * REC_H) / Math.max(1, r.h)))))
    const W = Math.max(...widths)
    const N = rects.length
    const plane = REC_H * W
    const input = new Float32Array(N * 3 * plane) // 0 = 正規化後の中間灰色でパディング
    const c = createCanvas(W, REC_H)
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingQuality = 'high'
    rects.forEach((r, n) => {
      const w = widths[n]
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, W, REC_H)
      ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, w, REC_H)
      const px = ctx.getImageData(0, 0, w, REC_H).data
      const off = n * 3 * plane
      for (let y = 0; y < REC_H; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const j = y * W + x
          input[off + j] = px[i + 2] / 127.5 - 1
          input[off + plane + j] = px[i + 1] / 127.5 - 1
          input[off + 2 * plane + j] = px[i] / 127.5 - 1
        }
      }
    })
    const out = await L.rec.run({ [L.rec.inputNames[0]]: new L.ort.Tensor('float32', input, [N, 3, REC_H, W]) })
    const o = out[L.rec.outputNames[0]]
    const [, T, C] = o.dims as number[]
    const data = o.data as Float32Array
    return rects.map((r, n) => {
      // 有効な時刻数(パディング部分を除く)
      const Tn = Math.max(1, Math.round((T * widths[n]) / W))
      let text = ''
      let last = 0
      const confs: number[] = []
      const symbols: OcrSymbol[] = []
      const step = r.w / Tn
      for (let t = 0; t < Tn; t++) {
        const base = (n * T + t) * C
        let bi = 0
        let bv = -1
        for (let k = 0; k < C; k++) {
          const v = data[base + k]
          if (v > bv) {
            bv = v
            bi = k
          }
        }
        if (bi !== 0 && bi !== last) {
          const ch = L.dict[bi] ?? ''
          text += ch
          confs.push(bv)
          symbols.push({ text: ch, conf: bv * 100, rect: { x: r.x + t * step, y: r.y, w: step, h: r.h } })
        }
        last = bi
      }
      const conf = confs.length ? (confs.reduce((a, b) => a + b, 0) / confs.length) * 100 : 0
      return { text, conf, symbols }
    })
  }
}

let shared: PaddleEngine | null = null
export function getPaddle(pref: PaddleBackendPref): PaddleEngine {
  if (!shared || shared.pref !== pref) shared = new PaddleEngine(pref)
  return shared
}
