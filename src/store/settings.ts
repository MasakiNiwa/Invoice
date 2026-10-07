import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ScanStrength = 'quick' | 'standard' | 'thorough'
export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
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
    { name: 'invoice-checker-settings', version: 1 },
  ),
)

export function pickSettings(s: Settings): Settings {
  const { workers, useJapanese, strength, earlyExit, showAnimation, slowMo, showCorrections, theme } = s
  return { workers, useJapanese, strength, earlyExit, showAnimation, slowMo, showCorrections, theme }
}
