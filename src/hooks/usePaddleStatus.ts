import { useEffect, useState } from 'react'
import { getPaddle, type PaddleStatus } from '../lib/ocr/paddle'
import { useSettings } from '../store/settings'

/** PaddleOCR の準備状況を購読する(エンジンが Tesseract のときは null) */
export function usePaddleStatus(): PaddleStatus | null {
  const engine = useSettings((s) => s.engine)
  const pref = useSettings((s) => s.paddleBackend)
  const [st, setSt] = useState<PaddleStatus | null>(null)
  useEffect(() => {
    if (engine !== 'paddle') {
      setSt(null)
      return
    }
    return getPaddle(pref).subscribe(setSt)
  }, [engine, pref])
  return st
}

/** アプリを開いたら、画像を選んでいる間にモデルを先読みしておく(データセーバー時は除く) */
export function usePreloadModels() {
  const engine = useSettings((s) => s.engine)
  const pref = useSettings((s) => s.paddleBackend)
  const preload = useSettings((s) => s.preloadModels)
  useEffect(() => {
    if (engine !== 'paddle' || !preload) return
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    if (conn?.saveData) return
    const run = () => void getPaddle(pref).init().catch(() => {})
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 2000 })
    else setTimeout(run, 500)
  }, [engine, pref, preload])
}
