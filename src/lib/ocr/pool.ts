/**
 * tesseract.js ワーカープール。
 * ジョブごとに異なるパラメータ(PSM・ホワイトリスト)を使えるよう、
 * 各ワーカーの現在パラメータを覚えておき、必要なときだけ setParameters する。
 */
import { createWorker, type Worker } from 'tesseract.js'
import type { Rect } from '../image'
import type { OcrBackend } from './engine'

export interface OcrSymbol { text: string; conf: number; rect: Rect }
export interface OcrWord { text: string; conf: number; rect: Rect; symbols: OcrSymbol[] }
export interface OcrLine { text: string; conf: number; rect: Rect; words: OcrWord[] }
export interface OcrResult { text: string; conf: number; lines: OcrLine[] }

export interface OcrParams {
  psm: '3' | '6' | '7' | '8' | '11' | '13'
  whitelist?: string
  /** 文字行の位置だけ求める(PaddleOCR のみ。認識を省略して高速) */
  detectOnly?: boolean
}

interface Slot {
  worker: Worker
  key: string
  busy: boolean
}

interface Job {
  image: HTMLCanvasElement
  params: OcrParams
  resolve: (r: OcrResult) => void
  reject: (e: unknown) => void
  signal?: AbortSignal
}

const toRect = (b: { x0: number; y0: number; x1: number; y1: number }): Rect => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 })

/** 自前ホスティングした OCR アセットの場所(GitHub Pages のサブパスでも動くよう baseURI 基準) */
function ocrAssetPaths() {
  const base = new URL('./ocr/', document.baseURI).href
  return { workerPath: `${base}worker.min.js`, corePath: base, langPath: base, workerBlobURL: false }
}

export class AbortError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortError'
  }
}

export class OcrPool implements OcrBackend {
  private slots: Slot[] = []
  private queue: Job[] = []
  private ready: Promise<void> | null = null
  readonly lang: string
  readonly size: number
  get label() {
    return `Tesseract (${this.lang} ×${this.size})`
  }
  /** 認識中の進捗(0..1)。ワーカー単位で通知される */
  onRecognizeProgress: ((p: number) => void) | null = null

  constructor(lang: string, size: number) {
    this.lang = lang
    this.size = Math.max(1, size)
  }

  /** モデル読み込み(初回はCDNからダウンロード) */
  init(onProgress?: (status: string, progress: number) => void): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const workers = await Promise.all(
          Array.from({ length: this.size }, (_, i) =>
            createWorker(this.lang, 1, {
              ...ocrAssetPaths(),
              logger: (m) => {
                if (m.status === 'recognizing text') this.onRecognizeProgress?.(m.progress ?? 0)
                else if (i === 0 && onProgress && m.status && !m.status.startsWith('recognizing')) onProgress(m.status, m.progress ?? 0)
              },
            }),
          ),
        )
        this.slots = workers.map((worker) => ({ worker, key: '', busy: false }))
        this.pump()
      })()
      this.ready.catch(() => {
        this.ready = null
      })
    }
    return this.ready
  }

  recognize(image: HTMLCanvasElement, params: OcrParams, signal?: AbortSignal): Promise<OcrResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortError())
      this.queue.push({ image, params, resolve, reject, signal })
      this.pump()
    })
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy) continue
      const job = this.queue.shift()
      if (!job) return
      if (job.signal?.aborted) {
        job.reject(new AbortError())
        continue
      }
      slot.busy = true
      void this.run(slot, job).finally(() => {
        slot.busy = false
        this.pump()
      })
    }
  }

  private async run(slot: Slot, job: Job) {
    try {
      const key = `${job.params.psm}|${job.params.whitelist ?? ''}`
      if (slot.key !== key) {
        await slot.worker.setParameters({
          tessedit_pageseg_mode: job.params.psm as never,
          tessedit_char_whitelist: job.params.whitelist ?? '',
          preserve_interword_spaces: '1',
        })
        slot.key = key
      }
      const { data } = await slot.worker.recognize(job.image, {}, { blocks: true, text: true })
      const lines: OcrLine[] = []
      for (const b of data.blocks ?? []) {
        for (const p of b.paragraphs) {
          for (const l of p.lines) {
            lines.push({
              text: l.text.replace(/\n$/, ''),
              conf: l.confidence,
              rect: toRect(l.bbox),
              words: l.words.map((w) => ({
                text: w.text,
                conf: w.confidence,
                rect: toRect(w.bbox),
                symbols: w.symbols.map((s) => ({ text: s.text, conf: s.confidence, rect: toRect(s.bbox) })),
              })),
            })
          }
        }
      }
      job.resolve({ text: data.text, conf: data.confidence, lines })
    } catch (e) {
      job.reject(e)
    }
  }

  /** 待機中のジョブを破棄 */
  clearQueue() {
    const q = this.queue
    this.queue = []
    for (const j of q) j.reject(new AbortError())
  }

  async terminate() {
    this.clearQueue()
    await Promise.all(this.slots.map((s) => s.worker.terminate()))
    this.slots = []
    this.ready = null
  }
}

/** 設定ごとにプールを使い回す */
const pools = new Map<string, OcrPool>()
export function getPool(lang: string, size: number): OcrPool {
  const key = `${lang}#${size}`
  let p = pools.get(key)
  if (!p) {
    // 同じ言語で数の違う古いプールは解放
    for (const [k, old] of pools) {
      if (k.startsWith(`${lang}#`)) {
        void old.terminate()
        pools.delete(k)
      }
    }
    p = new OcrPool(lang, size)
    pools.set(key, p)
  }
  return p
}
