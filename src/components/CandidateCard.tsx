import { AlertTriangle, BadgeCheck, ExternalLink, Sparkles, Vote, XCircle } from 'lucide-react'
import type { Candidate } from '../lib/ocr/aggregate'
import { STAGE_LABEL } from '../lib/ocr/aggregate'
import { houjinBangouUrl, invoiceKohyoUrl } from '../lib/links'
import { formatTNumber } from '../lib/tnumber'
import { CopyButton } from './CopyButton'

interface Props {
  c: Candidate
  rank: number
  onHover?: (digits: string | null) => void
}

export function CandidateCard({ c, rank, onHover }: Props) {
  const best = rank === 0 && c.valid
  return (
    <div
      className={`pop-in rounded-2xl border p-4 transition ${best ? 'border-emerald-300 bg-emerald-50/70 shadow-md dark:border-emerald-700 dark:bg-emerald-950/40' : c.valid ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900' : 'border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/20'}`}
      onMouseEnter={() => onHover?.(c.digits)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {c.valid ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300">
            <BadgeCheck size={14} /> 検算OK
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700 dark:bg-rose-900/60 dark:text-rose-300">
            <XCircle size={14} /> 検算NG
          </span>
        )}
        {best && <span className="rounded-full bg-emerald-600 px-2 py-0.5 font-semibold text-white">最有力</span>}
        {c.kind === 'consensus' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300"><Vote size={12} /> 多数決で合成</span>
        )}
        {c.kind === 'corrected' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300"><Sparkles size={12} /> 推定補正</span>
        )}
        {!c.hasT && (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300"><AlertTriangle size={12} /> T未検出</span>
        )}
        <span className="ml-auto text-slate-500">信頼度 {c.confidence}%</span>
      </div>

      <div className="mt-2 font-mono text-2xl font-bold tracking-wider sm:text-3xl">{formatTNumber(c.digits)}</div>

      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className={`h-full ${c.valid ? 'bg-emerald-500' : 'bg-rose-400'}`} style={{ width: `${c.confidence}%` }} />
      </div>

      <div className="mt-2 text-xs text-slate-500">
        {c.votes > 0 && <>票数 {c.votes} ・ </>}
        発見: {c.stages.map((s) => STAGE_LABEL[s]).join(' / ')}
        {c.note && <> ・ {c.note}</>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <a className={c.valid ? 'btn-primary' : 'btn-ghost'} href={invoiceKohyoUrl(c.digits)} target="_blank" rel="noreferrer">
          <ExternalLink size={16} /> 公表サイトで確認
        </a>
        <CopyButton text={`T${c.digits}`} />
        <a className="btn-ghost px-3 py-2 text-xs" href={houjinBangouUrl(c.digits)} target="_blank" rel="noreferrer" title="法人の場合、登録番号のT以降は法人番号と同じです">
          法人番号サイト
        </a>
      </div>
    </div>
  )
}
