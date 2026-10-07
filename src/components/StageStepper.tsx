import { Check, Loader2, MinusCircle } from 'lucide-react'
import type { ScanState } from '../hooks/useScan'
import { STAGE_LABEL } from '../lib/ocr/aggregate'
import { STAGES } from '../lib/ocr/pipeline'

export function StageStepper({ state }: { state: ScanState }) {
  return (
    <ol className="grid grid-cols-6 gap-1">
      {STAGES.map((id, i) => {
        const st = state.stages[id]
        const color =
          st.status === 'done' ? 'bg-emerald-500 text-white' :
          st.status === 'running' ? 'bg-teal-500 text-white ring-4 ring-teal-500/20' :
          st.status === 'skip' ? 'bg-slate-200 text-slate-400 dark:bg-slate-800' :
          'bg-slate-100 text-slate-400 dark:bg-slate-800'
        return (
          <li key={id} className="flex flex-col items-center text-center" title={st.note}>
            <span className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition ${color}`}>
              {st.status === 'done' ? <Check size={16} /> : st.status === 'running' ? <Loader2 size={16} className="animate-spin" /> : st.status === 'skip' ? <MinusCircle size={14} /> : i}
            </span>
            <span className={`mt-1 text-[10px] leading-tight sm:text-xs ${st.status === 'running' ? 'font-semibold text-teal-700 dark:text-teal-300' : 'text-slate-500'}`}>
              {STAGE_LABEL[id]}
            </span>
            {st.note && st.status === 'skip' && <span className="text-[9px] text-slate-400">{st.note}</span>}
          </li>
        )
      })}
    </ol>
  )
}
