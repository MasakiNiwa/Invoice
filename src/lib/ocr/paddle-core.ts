/**
 * PaddleOCR (PP-OCRv5 mobile, 多言語=日本語対応) の推論本体。Web Worker 内で動く(DOM 非依存)。
 *
 * - 検出(DBNet): 確率マップ → 二値化 → 連結成分 → 枠を膨らませる(unclip)
 * - 認識(CTC):   高さ48pxに揃えた行画像 → 各時刻の最尤文字 → 重複と空白(blank)を除去
 * - バックエンド: WebGPU が使えれば GPU、なければ WebAssembly(CPU)
 * - モデルは Cache Storage に保存し、2回目以降・オフラインでも即座に使えるようにする
 */
import type * as Ort from 'onnxruntime-web'
import type { Rect } from '../image'
import { connectedComponents } from '../textlines'
import type { OcrLine, OcrParams, OcrResult, OcrSymbol } from './pool'

export type PaddleBackendPref = 'auto' | 'webgpu' | 'wasm'
export type Provider = 'webgpu' | 'wasm'

const REC_H = 48
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]
/** モデルを差し替えたら上げる(Cache Storage の世代) */
const MODEL_CACHE = 'invoice-paddle-ppocrv5-mobile-v1'

type Canvas2D = OffscreenCanvas
const mkCanvas = (w: number, h: number): Canvas2D => new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
const ctxOf = (c: Canvas2D) => c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D

export function webGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as Navigator & { gpu?: unknown }).gpu
}

/** Cache Storage を優先し、無ければダウンロードして保存(進捗付き) */
async function fetchCached(url: string, onProgress: (p: number) => void): Promise<Uint8Array> {
  let cache: Cache | null = null
  try {
    cache = await caches.open(MODEL_CACHE)
    const hit = await cache.match(url)
    if (hit) {
      onProgress(1)
      return new Uint8Array(await hit.arrayBuffer())
    }
  } catch {
    cache = null
  }
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
    if (total) onProgress(Math.min(0.99, got / total))
  }
  const out = new Uint8Array(got)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  try {
    await cache?.put(url, new Response(out.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } }))
  } catch {
    /* 容量不足などは無視(次回また取得する) */
  }
  onProgress(1)
  return out
}

/** 既にモデルが保存済みか(初回ダウンロードの案内表示用) */
export async function modelsCached(base: string): Promise<boolean> {
  try {
    const cache = await caches.open(MODEL_CACHE)
    return !!(await cache.match(`${base}det.ort`)) && !!(await cache.match(`${base}rec.onnx`))
  } catch {
    return false
  }
}

export class PaddleCore {
  private ort!: typeof Ort
  private det!: Ort.InferenceSession
  private rec!: Ort.InferenceSession
  private dict: string[] = []
  provider: Provider = 'wasm'

  async load(pref: PaddleBackendPref, base: string, onProgress: (status: string, p: number) => void) {
    const wantGpu = pref === 'webgpu' || (pref === 'auto' && webGpuAvailable())
    // WebGPU 版は CPU 実行もできるが wasm が大きい(27MB)ので、GPU を使わないときは CPU 版(14MB)を読む
    onProgress('loading onnxruntime', 0)
    this.ort = wantGpu ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm')
    this.ort.env.wasm.numThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
    const parts = [0, 0]
    const report = () => onProgress('loading models', (parts[0] * 4.9 + parts[1] * 16.6) / 21.5)
    const [detBytes, recBytes, dictText] = await Promise.all([
      fetchCached(`${base}det.ort`, (p) => { parts[0] = p; report() }),
      fetchCached(`${base}rec.onnx`, (p) => { parts[1] = p; report() }),
      fetchCached(`${base}dict.txt`, () => {}).then((b) => new TextDecoder().decode(b)),
    ])
    onProgress('initializing', 1)
    const create = (bytes: Uint8Array, gpu: boolean) =>
      this.ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' })
    this.provider = wantGpu ? 'webgpu' : 'wasm'
    try {
      this.det = await create(detBytes, wantGpu)
      this.rec = await create(recBytes, wantGpu)
    } catch (e) {
      if (!wantGpu) throw e
      console.warn('WebGPU で初期化できなかったため WebAssembly で再試行します', e)
      this.provider = 'wasm'
      this.det = await create(detBytes, false)
      this.rec = await create(recBytes, false)
    }
    // 辞書: 出力クラス index i の文字 = 辞書ファイルの i 行目(0 は blank 扱い)
    this.dict = dictText.split(/\r?\n/)
  }

  async recognize(img: ImageData, params: OcrParams, onProgress?: (p: number) => void): Promise<OcrResult> {
    const bmp = await createImageBitmap(img)
    try {
      const lineMode = params.psm === '7' || params.psm === '8' || params.psm === '13'
      if (lineMode) {
        const full = { x: 0, y: 0, w: img.width, h: img.height }
        const [r] = await this.recBatch(bmp, [full], params.recStretch ?? 1)
        return { text: r.text, conf: r.conf, lines: r.text ? [toLine(r.text, r.conf, full, r.symbols)] : [] }
      }
      // 全体解析は呼び出し側で解像度を決めている(スキャン強度)ので、ここでは上限だけ設ける
      const maxSide = params.psm === '3' ? 3200 : 1600
      const boxes = await this.detect(bmp, maxSide)
      if (params.detectOnly) return { text: '', conf: 0, lines: boxes.map((b) => toLine('', 0, b, [])) }
      const lines: OcrLine[] = []
      const B = 8
      // 幅の近い行をまとめるとパディングが減って速い
      const order = boxes.map((b, i) => ({ b, i, r: b.w / Math.max(1, b.h) })).sort((a, b) => a.r - b.r)
      for (let i = 0; i < order.length; i += B) {
        const batch = order.slice(i, i + B).map((o) => o.b)
        // 認識は検出枠より少し広めに切り出す(枠ぴったりだとカタカナ等の取りこぼしが多い)
        const rs = await this.recBatch(bmp, batch.map((b) => padRect(b, boxes, img.width, img.height, params.recPadY ?? 0.3, params.recPadX ?? 0.5)))
        rs.forEach((r, k) => {
          if (r.text.trim()) lines.push(toLine(r.text, r.conf, batch[k], r.symbols))
        })
        onProgress?.(Math.min(1, (i + B) / Math.max(1, order.length)))
      }
      lines.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      const conf = lines.length ? lines.reduce((s, l) => s + l.conf, 0) / lines.length : 0
      return { text: lines.map((l) => l.text).join('\n'), conf, lines }
    } finally {
      bmp.close()
    }
  }

  /** DBNet による文字行の検出。返り値は画像座標の矩形 */
  private async detect(image: ImageBitmap, maxSide: number): Promise<Rect[]> {
    const ratio = Math.min(1, maxSide / Math.max(image.width, image.height))
    const w = Math.max(32, Math.round((image.width * ratio) / 32) * 32)
    const h = Math.max(32, Math.round((image.height * ratio) / 32) * 32)
    const c = mkCanvas(w, h)
    const ctx = ctxOf(c)
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
    const out = await this.det.run({ [this.det.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, h, w]) })
    const prob = out[this.det.outputNames[0]].data as Float32Array
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
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
    return rects
  }

  /** 複数行をまとめて認識(幅を最大幅に揃えてバッチ実行) */
  private async recBatch(image: ImageBitmap, rects: Rect[], stretch = 1): Promise<{ text: string; conf: number; symbols: OcrSymbol[] }[]> {
    if (rects.length === 0) return []
    const widths = rects.map((r) => Math.min(3200, Math.max(16, Math.round(((r.w * REC_H) / Math.max(1, r.h)) * stretch))))
    const W = Math.max(...widths)
    const N = rects.length
    const plane = REC_H * W
    const input = new Float32Array(N * 3 * plane) // 0 = 正規化後の中間灰色でパディング
    const c = mkCanvas(W, REC_H)
    const ctx = ctxOf(c)
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
    const out = await this.rec.run({ [this.rec.inputNames[0]]: new this.ort.Tensor('float32', input, [N, 3, REC_H, W]) })
    const o = out[this.rec.outputNames[0]]
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
          const ch = this.dict[bi] ?? ''
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

/**
 * 認識用に検出枠を広げる。ただし隣の文字行に食い込まないよう、
 * 上下左右それぞれ「隣の枠までの隙間の45%」までに抑える(行間の詰まった文書で他の行を巻き込まない)
 */
export function padRect(r: Rect, all: Rect[], W: number, H: number, py: number, px: number): Rect {
  let up = r.y
  let down = H - (r.y + r.h)
  let left = r.x
  let right = W - (r.x + r.w)
  for (const o of all) {
    if (o === r) continue
    const xOverlap = Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x)
    const yOverlap = Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y)
    if (xOverlap > 0) {
      if (o.y + o.h <= r.y) up = Math.min(up, r.y - (o.y + o.h))
      else if (o.y >= r.y + r.h) down = Math.min(down, o.y - (r.y + r.h))
    }
    if (yOverlap > Math.min(r.h, o.h) * 0.3) {
      if (o.x + o.w <= r.x) left = Math.min(left, r.x - (o.x + o.w))
      else if (o.x >= r.x + r.w) right = Math.min(right, o.x - (r.x + r.w))
    }
  }
  const padUp = Math.min(r.h * py, up * 0.45)
  const padDown = Math.min(r.h * py, down * 0.45)
  const padL = Math.min(r.h * px, left * 0.45)
  const padR = Math.min(r.h * px, right * 0.45)
  const x0 = Math.max(0, r.x - padL)
  const y0 = Math.max(0, r.y - padUp)
  const x1 = Math.min(W, r.x + r.w + padR)
  const y1 = Math.min(H, r.y + r.h + padDown)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function toLine(text: string, conf: number, rect: Rect, symbols: OcrSymbol[]): OcrLine {
  return { text, conf, rect, words: [{ text, conf, rect, symbols }] }
}
