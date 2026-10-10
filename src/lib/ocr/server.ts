/**
 * Colab 版サーバーの文字認識(PaddleOCR を Colab の GPU/CPU で実行)。
 *
 * アプリが Colab 版サーバーから配信されているとき(./api/status が応答するとき)だけ使う。
 * GitHub Pages 版ではこれまでどおりブラウザ内で認識する。
 * ブラウザにモデルをダウンロードせず、画像だけを送って結果を受け取る。
 */
import type { OcrBackend } from './engine'
import { AbortError, type OcrParams, type OcrResult } from './pool'
import type { PaddleStatus } from './paddle'

export interface ServerInfo {
  app: 'invoice-colab'
  version: string
  provider: 'cuda' | 'cpu'
  gpu: string | null
  /** 同時に送ってよい認識ジョブの数 */
  parallel: number
}

const api = (path: string) => new URL(`./api/${path}`, document.baseURI).href

/** ログインの期限が切れたらログイン画面へ */
function toLogin() {
  location.href = new URL('./login', document.baseURI).href
}

/** Colab 版サーバーから配信されているか調べる(GitHub Pages では 404 になり null) */
export async function detectServer(): Promise<ServerInfo | null> {
  if (/\.github\.io$/.test(location.hostname)) return null
  try {
    const res = await fetch(api('status'), { cache: 'no-store', credentials: 'same-origin' })
    const json = await res.json().catch(() => null)
    if (res.status === 401 && json?.app === 'invoice-colab') {
      toLogin()
      return null
    }
    return res.ok && json?.app === 'invoice-colab' ? (json as ServerInfo) : null
  } catch {
    return null
  }
}

/** 送る画像の形式: 大きな画像(全体解析)は JPEG、切り出した行や小さな画像は劣化の無い PNG */
function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const big = canvas.width * canvas.height > 1_500_000
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を変換できません'))), big ? 'image/jpeg' : 'image/png', big ? 0.92 : undefined),
  )
}

type Listener = (s: PaddleStatus) => void

export class ServerEngine implements OcrBackend {
  readonly pref = 'server' as const
  readonly info: ServerInfo
  onRecognizeProgress: ((p: number) => void) | null = null
  status: PaddleStatus
  private listeners = new Set<Listener>()

  constructor(info: ServerInfo) {
    this.info = info
    this.status = { state: 'ready', status: '', progress: 1, provider: 'server' }
  }

  get label(): string {
    return `PaddleOCR PP-OCRv5 (Colab ${this.info.provider === 'cuda' ? `GPU${this.info.gpu ? `: ${this.info.gpu}` : ''}` : 'CPU'})`
  }

  /** ブラウザ側の並列数(サーバーは複数の認識を同時に処理できる) */
  get parallel(): number {
    return Math.max(1, this.info.parallel || 1)
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

  /** モデルはサーバー側にあるので、ブラウザでの準備は不要 */
  async init(): Promise<void> {}

  async recognize(image: HTMLCanvasElement, params: OcrParams, signal?: AbortSignal): Promise<OcrResult> {
    if (signal?.aborted) throw new AbortError()
    const body = await encode(image)
    if (signal?.aborted) throw new AbortError()
    const q = new URLSearchParams({ psm: params.psm })
    if (params.detectOnly) q.set('detectOnly', '1')
    if (params.recPadY) q.set('recPadY', String(params.recPadY))
    if (params.recPadX) q.set('recPadX', String(params.recPadX))
    if (params.recStretch) q.set('recStretch', String(params.recStretch))
    let res: Response
    try {
      res = await fetch(api(`ocr?${q}`), { method: 'POST', body, headers: { 'content-type': body.type }, credentials: 'same-origin', signal })
    } catch (e) {
      if (signal?.aborted) throw new AbortError()
      this.setStatus({ state: 'error', error: 'Colab のサーバーに接続できません(ノートブックが停止していないか確認してください)' })
      throw e
    }
    if (res.status === 401) {
      toLogin()
      throw new AbortError()
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      throw new Error(`Colab サーバーでの文字認識に失敗しました: ${j.detail ?? res.status}`)
    }
    if (this.status.state !== 'ready') this.setStatus({ state: 'ready', error: undefined })
    return (await res.json()) as OcrResult
  }

  dispose() {}
}
