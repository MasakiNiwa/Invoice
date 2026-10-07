import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ScanStrength = 'quick' | 'standard' | 'thorough'
export type Theme = 'system' | 'light' | 'dark'
export type Engine = 'paddle' | 'tesseract'
export type PaddleBackendPref = 'auto' | 'webgpu' | 'wasm'

export interface Settings {
  /** OCR エンジン */
  engine: Engine
  /** PaddleOCR の実行環境(auto = WebGPU が使えれば GPU) */
  paddleBackend: PaddleBackendPref
  /** アプリを開いたらモデルを先読み */
  preloadModels: boolean
  /** 横倒し・上下逆の画像を自動で回転(PaddleOCR) */
  autoRotate: boolean
  /** 記載事項に関係する行を拡大して読み直す */
  refineRequirements: boolean
  /** 複数ページの PDF は全ページを一括で読み取る */
  batchPdf: boolean
  /** 読み取り結果を履歴に保存 */
  saveHistory: boolean
  /** 数字OCRの並列ワーカー数 */
  workers: number
  /** 全体レイアウト解析に日本語モデルを使う(「登録番号」等のキーワード検出) */
  useJapanese: boolean
  strength: ScanStrength
  /** 確からしい候補が見つかったら残りの走査を省略 */
  earlyExit: boolean
  /** 走査中の様子を表示 */
  showAnimation: boolean
  /** 演出用の待ち時間(ms)。0で最速 */
  slowMo: number
  /** 推定補正候補を表示 */
  showCorrections: boolean
  theme: Theme
}

export const defaultSettings: Settings = {
  engine: 'paddle',
  paddleBackend: 'auto',
  preloadModels: true,
  autoRotate: true,
  saveHistory: true,
  refineRequirements: true,
  batchPdf: true,
  workers: Math.min(4, Math.max(1, Math.floor((typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2) / 2) || 2)),
  useJapanese: true,
  strength: 'standard',
  earlyExit: true,
  showAnimation: true,
  slowMo: 0,
  showCorrections: true,
  theme: 'system',
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void
  reset: () => void
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...defaultSettings,
      set: (patch) => set(patch),
      reset: () => set(defaultSettings),
    }),
    {
      name: 'invoice-checker-settings',
      version: 2,
      // v1 → v2: エンジン設定を追加(既存ユーザーにも既定値を補う)
      migrate: (persisted) => ({ ...defaultSettings, ...(persisted as Partial<Settings>) }),
    },
  ),
)

export function pickSettings(s: Settings): Settings {
  const { engine, paddleBackend, preloadModels, autoRotate, saveHistory, refineRequirements, batchPdf, workers, useJapanese, strength, earlyExit, showAnimation, slowMo, showCorrections, theme } = s
  return { engine, paddleBackend, preloadModels, autoRotate, saveHistory, refineRequirements, batchPdf, workers, useJapanese, strength, earlyExit, showAnimation, slowMo, showCorrections, theme }
}
