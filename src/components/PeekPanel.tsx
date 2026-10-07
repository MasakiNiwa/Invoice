import { useEffect, useRef } from 'react'
import { Search } from 'lucide-react'
import type { Peek } from '../hooks/useScan'
import { STAGE_LABEL } from '../lib/ocr/aggregate'

/** ルーペ: 今まさに OCR にかけた前処理済み画像と、読めた文字 */
export function PeekPanel({ peek }: { peek: Peek | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !peek) return
    const maxW = 640
    const maxH = 160
    const s = Math.min(maxW / peek.image.width, maxH / peek.image.height, 1)
    c.width = Math.max(1, Math.round(peek.image.width * s))
    c.height = Math.max(1, Math.round(peek.image.height * s))
    c.getContext('2d')!.drawImage(peek.image, 0, 0, c.width, c.height)
  }, [peek])

  return (
    <div className="card p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Search size={16} className="text-teal-600" />
        ルーペ
        {peek && <span className="truncate text-xs font-normal text-slate-500">{STAGE_LABEL[peek.stage]} / {peek.label}</span>}
      </div>
      {peek ? (
        <div key={peek.n} className="pop-in">
          <div className="flex min-h-16 items-center justify-center overflow-hidden rounded-lg border border-dashed border-slate-300 bg-white p-1 dark:border-slate-700">
            <canvas ref={ref} className="max-h-40 max-w-full" />
          </div>
          <div className="mt-2 rounded-lg bg-slate-900 px-3 py-2 font-mono text-xs text-emerald-300 break-all whitespace-pre-wrap max-h-24 overflow-auto">
            {peek.text ? peek.text.slice(0, 400) : '(文字なし)'}
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-500">捜査が始まると、OCRにかけている部分がここに表示されます。</p>
      )}
    </div>
  )
}
