/** OCR エンジン共通インターフェース(Tesseract / PaddleOCR を差し替え可能にする) */
import type { OcrParams, OcrResult } from './pool'

export interface OcrBackend {
  /** 表示名(ログ用) */
  readonly label: string
  /** モデル読み込み。onProgress は (状態, 0..1) */
  init(onProgress?: (status: string, progress: number) => void): Promise<void>
  /** params.psm: 7/8/13 = 1行, 3/6/11 = ページ/ブロック/まばら */
  recognize(image: HTMLCanvasElement, params: OcrParams, signal?: AbortSignal): Promise<OcrResult>
  /** 認識中の進捗(対応しているエンジンのみ) */
  onRecognizeProgress: ((p: number) => void) | null
}

export type EngineId = 'paddle' | 'tesseract'
