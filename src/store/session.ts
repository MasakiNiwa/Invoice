import { create } from 'zustand'
import type { Candidate } from '../lib/ocr/aggregate'

/** 画面をまたいで共有する読み取りセッション状態(ヘッダーのボタン用) */
interface SessionStore {
  /** 画像を読み込み中/表示中か */
  hasDoc: boolean
  /** 最有力のT番号候補 */
  best: Candidate | null
  scanning: boolean
  /** クリア要求のカウンタ(ScanPage が監視) */
  clearToken: number
  setDoc: (hasDoc: boolean) => void
  setResult: (best: Candidate | null, scanning: boolean) => void
  requestClear: () => void
}

export const useSession = create<SessionStore>()((set) => ({
  hasDoc: false,
  best: null,
  scanning: false,
  clearToken: 0,
  setDoc: (hasDoc) => set({ hasDoc }),
  setResult: (best, scanning) => set({ best, scanning }),
  requestClear: () => set((s) => ({ clearToken: s.clearToken + 1, hasDoc: false, best: null, scanning: false })),
}))
