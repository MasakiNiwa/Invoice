/**
 * PaddleOCR エンジン(UI スレッド側)。推論は Web Worker(paddle.worker.ts)で行い、
 * 画面が固まらないようにする。WebGPU は Worker 内でも利用できる。
 */
import type { OcrBackend } from './engine'
import { modelsCached, type PaddleBackendPref, type Provider } from './paddle-core'
import { AbortError, type OcrParams, type OcrResult } from './pool'
import type { ServerEngine } from './server'

export { webGpuAvailable } from './paddle-core'
export type { PaddleBackendPref } from './paddle-core'

export const paddleAssetBase = () => new URL('./paddle/', document.baseURI).href

export interface PaddleStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  status: string
  progress: number
  /** server = Colab 版サーバーで認識 */
  provider: Provider | 'server' | null
  error?: string
}

type Listener = (s: PaddleStatus) => void

export class PaddleEngine implements OcrBackend {
  readonly pref: PaddleBackendPref
  onRecognizeProgress: ((p: number) => void) | null = null
  private worker: Worker | null = null
  private initPromise: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (r: OcrResult) => void; reject: (e: unknown) => void }>()
  private listeners = new Set<Listener>()
  status: PaddleStatus = { state: 'idle', status: '', progress: 0, provider: null }

  constructor(pref: PaddleBackendPref) {
    this.pref = pref
  }

  get label(): string {
    return `PaddleOCR PP-OCRv5 (${this.status.provider === 'webgpu' ? 'WebGPU' : 'WebAssembly'})`
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.status)
    return () => this.listeners.delete(fn)
  }

  private setStatus(s: Partial<PaddleStatus>) {
    this.status = { ...this.status, ...s }
    for (const l of this.listeners) l(this.status)
  }

  init(onProgress?: (status: string, progress: number) => void): Promise<void> {
    const unsub = onProgress ? this.subscribe((s) => s.state === 'loading' && onProgress(s.status, s.progress)) : null
    if (!this.initPromise) {
      this.setStatus({ state: 'loading', status: 'starting', progress: 0, error: undefined })
      this.initPromise = new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL('./paddle.worker.ts', import.meta.url), { type: 'module' })
        this.worker = w
        w.onmessage = (ev) => {
          const m = ev.data
          if (m.type === 'progress') this.setStatus({ status: m.status, progress: m.progress })
          else if (m.type === 'ready') {
            this.setStatus({ state: 'ready', progress: 1, provider: m.provider })
            resolve()
          } else if (m.type === 'init-error') {
            this.setStatus({ state: 'error', error: m.message })
            reject(new Error(m.message))
          } else if (m.type === 'rec-progress') this.onRecognizeProgress?.(m.progress)
          else if (m.type === 'result' || m.type === 'error') {
            const p = this.pending.get(m.id)
            this.pending.delete(m.id)
            if (!p) return
            if (m.type === 'result') p.resolve(m.result)
            else p.reject(m.aborted ? new AbortError() : new Error(m.message))
          }
        }
        w.onerror = (ev) => {
          const msg = ev.message || 'PaddleOCR ワーカーの起動に失敗しました'
          this.setStatus({ state: 'error', error: msg })
          reject(new Error(msg))
          for (const p of this.pending.values()) p.reject(new Error(msg))
          this.pending.clear()
        }
        w.postMessage({ type: 'init', pref: this.pref, base: paddleAssetBase() })
      })
      this.initPromise.catch(() => {
        this.initPromise = null
        this.worker?.terminate()
        this.worker = null
      })
    }
    return this.initPromise.finally(() => unsub?.())
  }

  async recognize(image: HTMLCanvasElement, params: OcrParams, signal?: AbortSignal): Promise<OcrResult> {
    if (signal?.aborted) throw new AbortError()
    await this.init()
    if (signal?.aborted) throw new AbortError()
    const img = image.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, image.width, image.height)
    const id = this.nextId++
    return new Promise<OcrResult>((resolve, reject) => {
      // 中止されたら、すぐに AbortError で終える(後から届いた結果は捨てる)。
      // 順番待ちのジョブは Worker 側でも取り消す(新しいスキャンを待たせない)
      const onAbort = () => {
        if (!this.pending.delete(id)) return
        this.worker?.postMessage({ type: 'cancel', ids: [id] })
        reject(new AbortError())
      }
      const done = () => signal?.removeEventListener('abort', onAbort)
      this.pending.set(id, {
        resolve: (r) => { done(); resolve(r) },
        reject: (e) => { done(); reject(e) },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.worker!.postMessage({ type: 'recognize', id, image: img, params }, [img.data.buffer])
    })
  }

  /** Worker を終了する(GPU/CPU の設定を切り替えたとき、古いモデルのメモリを解放する) */
  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.initPromise = null
    for (const p of this.pending.values()) p.reject(new AbortError())
    this.pending.clear()
    this.setStatus({ state: 'idle', status: '', progress: 0, provider: null })
  }

  /** モデルが保存済みか(初回ダウンロードの案内用) */
  static cached(): Promise<boolean> {
    return modelsCached(paddleAssetBase())
  }
}

/** PaddleOCR の実行先(ブラウザ内 / Colab 版サーバー)。どちらも同じ使い方ができる */
export type PaddleLike = PaddleEngine | ServerEngine

let shared: PaddleEngine | null = null
let server: ServerEngine | null = null
/** Colab 版サーバーで認識する(null でブラウザ内に戻す) */
export function setServerEngine(e: ServerEngine | null) {
  server = e
}
export function getPaddle(pref: PaddleBackendPref): PaddleLike {
  if (server) return server
  if (!shared || shared.pref !== pref) {
    shared?.dispose()
    shared = new PaddleEngine(pref)
  }
  return shared
}
