import { Download, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ScanState } from '../hooks/useScan'

const TIPS = [
  'T番号は「T + 13桁」。先頭1桁は検算用の数字です',
  'モデルはこの端末に保存され、次回からすぐ始まります',
  '画像は外部に送信されず、端末の中だけで処理されます',
  'レシートの「登録番号」付近を重点的に探します',
  'WebGPU 対応の端末では GPU で高速に読み取ります',
]

/** 画像の上に重ねる状況表示: モデル準備中は大きく、捜査中は小さなチップで */
export function ScanOverlay({ state }: { state: ScanState }) {
  const [tip, setTip] = useState(0)
  const preparing = state.status === 'scanning' && !!state.model && state.model.status !== 'ready'
  useEffect(() => {
    if (!preparing) return
    const t = setInterval(() => setTip((i) => (i + 1) % TIPS.length), 3500)
    return () => clearInterval(t)
  }, [preparing])

  if (state.status !== 'scanning') return null
  if (preparing) {
    const p = Math.round((state.model?.progress ?? 0) * 100)
    const downloading = state.model?.status === 'loading models' || state.model?.status?.startsWith('loading')
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[2px]">
        <div className="pop-in w-full max-w-xs rounded-2xl bg-white/95 p-5 text-center shadow-xl dark:bg-slate-900/95">
          <div className="relative mx-auto mb-3 flex h-14 w-14 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-teal-400/30" />
            <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-teal-600 text-white">
              {downloading ? <Download size={26} /> : <Sparkles size={26} />}
            </span>
          </div>
          <div className="font-semibold">OCRエンジンを準備中…</div>
          <div className="mt-0.5 text-xs text-slate-500">{downloading ? 'モデルをダウンロードしています(初回のみ)' : 'エンジンを起動しています'}</div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className="h-full rounded-full bg-gradient-to-r from-teal-500 to-sky-400 transition-[width] duration-300" style={{ width: `${Math.max(3, p)}%` }} />
          </div>
          <div className="mt-1 text-right font-mono text-xs text-slate-500">{p}%</div>
          <p key={tip} className="pop-in mt-2 min-h-8 text-[11px] leading-snug text-slate-500">💡 {TIPS[tip]}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center px-2">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full bg-slate-900/80 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur">
        <Loader2 size={14} className="shrink-0 animate-spin" />
        <span className="truncate">{state.progressLabel || '捜査中'}…</span>
        <span className="font-mono">{Math.round(state.progress * 100)}%</span>
      </div>
    </div>
  )
}
