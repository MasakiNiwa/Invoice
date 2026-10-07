import { useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { LogEntry } from '../hooks/useScan'

const ICON = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: XCircle }
const COLOR = { info: 'text-slate-400', success: 'text-emerald-500', warn: 'text-amber-500', error: 'text-rose-500' }

export function ScanLog({ logs }: { logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs.length])
  return (
    <div ref={ref} className="max-h-56 overflow-auto pr-1 text-xs">
      {logs.length === 0 && <p className="text-slate-500">ログはまだありません。</p>}
      <ul className="space-y-1">
        {logs.map((l) => {
          const Icon = ICON[l.level]
          return (
            <li key={l.id} className="pop-in flex gap-2">
              <span className="w-12 shrink-0 text-right font-mono text-slate-400">{(l.t / 1000).toFixed(1)}s</span>
              <Icon size={14} className={`mt-0.5 shrink-0 ${COLOR[l.level]}`} />
              <span className={l.level === 'success' ? 'font-medium text-emerald-700 dark:text-emerald-300' : ''}>{l.message}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
