import { useEffect, useRef, type ReactNode } from 'react'
import type { Rect } from '../lib/image'
import type { ScanState } from '../hooks/useScan'
import { isPrimary, type StageId } from '../lib/ocr/aggregate'

const STAGE_COLOR: Record<StageId, string> = {
  pdf: '#0ea5e9',
  layout: '#6366f1',
  anchor: '#f59e0b',
  textline: '#a855f7',
  tile: '#14b8a6',
}

interface Props {
  image: HTMLCanvasElement
  state: ScanState
  highlight?: string | null
  /** 記載事項チェックなどで強調する領域 */
  highlightRects?: Rect[] | null
  /** 画像の上に重ねる表示(準備中・進捗など) */
  overlay?: ReactNode
}

const MAX_DISPLAY = 1600

/**
 * 画像 + 捜査オーバーレイ。
 * 背景(画像)と前景(オーバーレイ)の2枚のキャンバスを重ね、前景だけ毎フレーム描き直す。
 */
export function ScanViewer({ image, state, highlight, highlightRects, overlay }: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const hlRef = useRef(highlight)
  hlRef.current = highlight
  const hlRectsRef = useRef(highlightRects)
  hlRectsRef.current = highlightRects

  const scale = Math.min(1, MAX_DISPLAY / Math.max(image.width, image.height))
  const dw = Math.round(image.width * scale)
  const dh = Math.round(image.height * scale)

  useEffect(() => {
    const c = baseRef.current
    if (!c) return
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, dw, dh)
  }, [image, dw, dh])

  useEffect(() => {
    let raf = 0
    const draw = (now: number) => {
      const c = overRef.current
      if (!c) return
      const ctx = c.getContext('2d')!
      const s = stateRef.current
      ctx.clearRect(0, 0, c.width, c.height)
      const lw = Math.max(1.5, dw / 600)
      const R = (r: Rect) => [r.x * scale, r.y * scale, r.w * scale, r.h * scale] as const
      const scanning = s.status === 'scanning'

      // 検出した単語(薄く)
      ctx.lineWidth = lw * 0.6
      ctx.strokeStyle = 'rgba(99,102,241,0.35)'
      for (const r of s.marks.word) ctx.strokeRect(...R(r))
      // タイル
      if (scanning) {
        ctx.setLineDash([lw * 3, lw * 3])
        ctx.strokeStyle = 'rgba(20,184,166,0.25)'
        for (const r of s.marks.tile) ctx.strokeRect(...R(r))
        ctx.setLineDash([])
      }
      // 文字列らしい領域
      ctx.lineWidth = lw
      ctx.strokeStyle = 'rgba(168,85,247,0.75)'
      ctx.fillStyle = 'rgba(168,85,247,0.08)'
      for (const r of s.marks.textline) { ctx.fillRect(...R(r)); ctx.strokeRect(...R(r)) }
      // アンカー
      ctx.strokeStyle = 'rgba(245,158,11,0.95)'
      ctx.fillStyle = 'rgba(245,158,11,0.15)'
      for (const r of s.marks.anchor) { ctx.fillRect(...R(r)); ctx.strokeRect(...R(r)) }

      // 捜査中の領域(スキャナー演出)
      for (const f of s.focus) {
        const [x, y, w, h] = R(f.rect)
        const color = STAGE_COLOR[f.stage]
        ctx.save()
        ctx.fillStyle = color + '22'
        ctx.fillRect(x, y, w, h)
        ctx.strokeStyle = color
        ctx.lineWidth = lw * 1.6
        ctx.setLineDash([lw * 4, lw * 2])
        ctx.lineDashOffset = -now / 40
        ctx.strokeRect(x, y, w, h)
        ctx.setLineDash([])
        // 走査線
        const t = ((now - f.since) / 900) % 1
        const sy = y + h * t
        const grad = ctx.createLinearGradient(0, sy - h * 0.15, 0, sy)
        grad.addColorStop(0, color + '00')
        grad.addColorStop(1, color + '88')
        ctx.fillStyle = grad
        ctx.fillRect(x, Math.max(y, sy - h * 0.15), w, Math.min(h * 0.15, sy - y))
        ctx.fillStyle = color
        ctx.fillRect(x, sy - lw / 2, w, lw)
        ctx.restore()
      }

      // 候補
      const top = s.candidates.filter(isPrimary).slice(0, 3)
      const invalid = s.candidates.filter((c) => !isPrimary(c))
      const fontPx = Math.max(12, dw / 55)
      ctx.font = `bold ${fontPx}px ui-monospace, monospace`
      const drawCand = (digits: string, rects: Rect[], ok: boolean, emphasize: boolean) => {
        for (const r of rects) {
          const [x, y, w, h] = R(r)
          const pad = lw * 2
          ctx.lineWidth = emphasize ? lw * 3 : lw * 2
          ctx.strokeStyle = ok ? '#10b981' : '#f43f5e'
          ctx.fillStyle = ok ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.1)'
          if (emphasize) {
            ctx.shadowColor = ok ? '#10b981' : '#f43f5e'
            ctx.shadowBlur = 12 + 6 * Math.sin(now / 200)
          }
          ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad * 2)
          ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2)
          ctx.shadowBlur = 0
          if (ok || emphasize) {
            const label = `${ok ? '✓' : '✗'} T${digits}`
            const tw = ctx.measureText(label).width + 10
            const ly = y - pad - fontPx - 8 < 0 ? y + h + pad + 2 : y - pad - fontPx - 8
            ctx.fillStyle = ok ? '#059669' : '#e11d48'
            ctx.fillRect(x - pad, ly, tw, fontPx + 6)
            ctx.fillStyle = '#fff'
            ctx.fillText(label, x - pad + 5, ly + fontPx)
          }
        }
      }
      // 検算NGは、結果一覧でカーソルを合わせたときだけ表示(誤読候補で画面が騒がしくならないように)
      for (const c of invalid) if (hlRef.current === c.digits) drawCand(c.digits, c.rects.slice(0, 2), false, true)
      for (const c of top) drawCand(c.digits, c.rects.slice(0, 3), true, hlRef.current === c.digits || (!hlRef.current && c === top[0] && !scanning))

      // 記載事項の強調
      const hr = hlRectsRef.current
      if (hr) {
        ctx.lineWidth = lw * 2.5
        ctx.strokeStyle = '#0ea5e9'
        ctx.fillStyle = 'rgba(14,165,233,0.18)'
        for (const r of hr) {
          const [x, y, w, h] = R(r)
          ctx.fillRect(x - lw * 2, y - lw * 2, w + lw * 4, h + lw * 4)
          ctx.strokeRect(x - lw * 2, y - lw * 2, w + lw * 4, h + lw * 4)
        }
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [dw, dh, scale])

  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-800" style={{ aspectRatio: `${dw} / ${dh}` }}>
      <canvas ref={baseRef} width={dw} height={dh} className="absolute inset-0 h-full w-full" />
      <canvas ref={overRef} width={dw} height={dh} className="absolute inset-0 h-full w-full" />
      {overlay}
      {state.status === 'scanning' && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 overflow-hidden bg-teal-500/20">
          <div className="h-full bg-teal-500 transition-[width] duration-300" style={{ width: `${Math.round(state.progress * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

export function Legend() {
  const items: [string, string][] = [
    ['#6366f1', '検出した文字'],
    ['#f59e0b', 'アンカー(T・登録番号)'],
    ['#a855f7', '文字が並ぶ領域'],
    ['#14b8a6', 'タイル走査'],
    ['#10b981', 'T番号(検算OK)'],
  ]
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
          {l}
        </span>
      ))}
    </div>
  )
}
