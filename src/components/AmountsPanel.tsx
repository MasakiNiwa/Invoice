import { useEffect, useState } from 'react'
import { Calculator, CheckCircle2, TriangleAlert } from 'lucide-react'
import type { Rect } from '../lib/image'
import { sumSelected, type AmountSummary } from '../lib/amounts'

const KIND_LABEL = { item: '明細', total: '合計', tax: '税', other: 'その他' } as const

interface Props {
  amounts: AmountSummary | null
  title?: string
  onHover?: (rects: Rect[] | null) => void
}

/** 金額の集計: 明細(ETC の利用金額・レシートの品目など)を合計し、記載の合計と照合する */
export function AmountsPanel({ amounts, title, onHover }: Props) {
  const [sel, setSel] = useState<boolean[]>([])
  useEffect(() => {
    setSel(amounts?.items.map((i) => i.kind === 'item') ?? [])
  }, [amounts])
  if (!amounts || amounts.items.length === 0) return null
  const items = amounts.items
  const sum = sumSelected(items, sel.map((v, i) => v && items[i]?.kind === 'item'))
  const selectedOthers = items.reduce((s, it, i) => (sel[i] && it.kind !== 'item' ? s + it.amount : s), 0)
  const total = sum + selectedOthers
  const doc = amounts.docTotal
  const tax = amounts.taxTotal
  const diff = doc !== null ? total - doc : null
  const ok = diff === 0 || (tax > 0 && doc !== null && Math.abs(total + tax - doc) <= 1 && !items.some((it, i) => sel[i] && it.kind === 'tax'))
  const itemCount = sel.filter(Boolean).length
  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Calculator size={16} className="text-teal-600" /> 金額の集計
        {title && <span className="text-indigo-600 dark:text-indigo-300">({title})</span>}
        <span className="text-xs font-normal text-slate-500">チェックした行を合計します</span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-3">
        <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-800/60">
          <div className="text-[11px] text-slate-500">選んだ {itemCount} 行の合計</div>
          <div className="font-mono text-lg font-bold">¥{total.toLocaleString()}</div>
        </div>
        <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-800/60">
          <div className="text-[11px] text-slate-500">記載の合計</div>
          <div className="font-mono text-lg font-bold">{doc !== null ? `¥${doc.toLocaleString()}` : '-'}</div>
        </div>
        <div className={`col-span-2 flex items-center justify-center gap-1 rounded-xl p-2 text-sm font-medium sm:col-span-1 ${doc === null ? 'bg-slate-50 text-slate-500 dark:bg-slate-800/60' : ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}`}>
          {doc === null ? '合計の記載なし' : ok ? (
            <><CheckCircle2 size={16} /> 一致{diff !== 0 && tax > 0 ? '(+消費税)' : ''}</>
          ) : (
            <><TriangleAlert size={16} /> 差額 ¥{diff!.toLocaleString()}</>
          )}
        </div>
      </div>
      <ul className="max-h-72 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 text-xs dark:divide-slate-800 dark:border-slate-800">
        {items.map((it, i) => (
          <li key={i} onMouseEnter={() => onHover?.([it.rect])} onMouseLeave={() => onHover?.(null)}>
            <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
              <input type="checkbox" className="accent-teal-600" checked={!!sel[i]} onChange={(e) => setSel((s) => s.map((v, k) => (k === i ? e.target.checked : v)))} />
              <span className={`w-10 shrink-0 rounded px-1 text-center text-[10px] ${it.kind === 'item' ? 'bg-teal-50 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>{KIND_LABEL[it.kind]}</span>
              <span className="min-w-0 flex-1 truncate">{it.text}</span>
              <span className="shrink-0 font-mono font-semibold">¥{it.amount.toLocaleString()}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-slate-400">「合計」「小計」「消費税」「お預り」などの行は初期状態では合計に含めません。必要に応じてチェックを付け外ししてください。</p>
    </div>
  )
}
