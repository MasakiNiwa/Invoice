import { CheckCircle2, Cpu, Loader2, TriangleAlert, Zap } from 'lucide-react'
import { usePaddleStatus } from '../hooks/usePaddleStatus'
import { useSettings } from '../store/settings'

/** ホーム画面用: OCR エンジンの準備状況 */
export function EngineBadge() {
  const engine = useSettings((s) => s.engine)
  const st = usePaddleStatus()
  if (engine === 'tesseract') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Cpu size={13} /> Tesseract
      </span>
    )
  }
  if (!st || st.state === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Cpu size={13} /> PaddleOCR(読み込み時に準備します)
      </span>
    )
  }
  if (st.state === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
        <Loader2 size={13} className="animate-spin" /> PaddleOCR を準備中 {Math.round(st.progress * 100)}%
      </span>
    )
  }
  if (st.state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-300" title={st.error}>
        <TriangleAlert size={13} /> PaddleOCR を準備できません(Tesseract で読み取ります)
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
      <CheckCircle2 size={13} /> PaddleOCR 準備完了
      {st.provider === 'webgpu' ? (
        <span className="inline-flex items-center gap-0.5 font-semibold"><Zap size={12} />GPU</span>
      ) : (
        <span>(CPU)</span>
      )}
    </span>
  )
}
