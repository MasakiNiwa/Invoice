import { useState } from 'react'
import { CheckCircle2, ExternalLink, Receipt, TriangleAlert } from 'lucide-react'
import { invoiceKohyoUrl } from '../lib/links'

export interface SettlementEntry {
  key: string
  label: string
  digits: string | null
  amount: number | null
  /** 金額を「記載の合計」ではなく明細の合計から求めた */
  estimated?: boolean
  onSelect?: () => void
}

/**
 * 精算チェック: たくさんの領収書(タクシー・ETC など)の合計金額と、
 * すべてが登録番号付きのインボイスとして読めたか(非登録事業者が混じっていないか)を確認する
 */
export function SettlementPanel({ entries }: { entries: SettlementEntry[] }) {
  const [expected, setExpected] = useState('')
  const withNo = entries.filter((e) => e.digits)
  const noNumber = entries.filter((e) => !e.digits)
  const noAmount = entries.filter((e) => e.amount === null)
  const sum = entries.reduce((s, e) => s + (e.amount ?? 0), 0)
  const sumRegistered = withNo.reduce((s, e) => s + (e.amount ?? 0), 0)
  const exp = Number(expected.replace(/[^\d]/g, ''))
  const hasExp = expected.trim() !== '' && Number.isFinite(exp)
  const diff = hasExp ? sum - exp : 0
  const allGood = noNumber.length === 0 && noAmount.length === 0

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Receipt size={16} className="text-teal-600" /> 精算チェック
        <span className="text-xs font-normal text-slate-500">領収書・インボイス {entries.length} 件</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-800/60">
          <div className="text-[11px] text-slate-500">合計金額</div>
          <div className="font-mono text-lg font-bold">¥{sum.toLocaleString()}</div>
        </div>
        <div className="rounded-xl bg-emerald-50 p-2 dark:bg-emerald-950/40">
          <div className="text-[11px] text-emerald-700 dark:text-emerald-300">登録番号あり</div>
          <div className="text-lg font-bold text-emerald-700 dark:text-emerald-300">{withNo.length} 件</div>
          <div className="font-mono text-[11px] text-emerald-700/80 dark:text-emerald-300/80">¥{sumRegistered.toLocaleString()}</div>
        </div>
        <div className={`rounded-xl p-2 ${noNumber.length ? 'bg-rose-50 dark:bg-rose-950/40' : 'bg-slate-50 dark:bg-slate-800/60'}`}>
          <div className={`text-[11px] ${noNumber.length ? 'text-rose-700 dark:text-rose-300' : 'text-slate-500'}`}>登録番号なし</div>
          <div className={`text-lg font-bold ${noNumber.length ? 'text-rose-700 dark:text-rose-300' : ''}`}>{noNumber.length} 件</div>
          <div className="font-mono text-[11px] text-slate-500">¥{(sum - sumRegistered).toLocaleString()}</div>
        </div>
        <div className={`rounded-xl p-2 ${noAmount.length ? 'bg-amber-50 dark:bg-amber-950/40' : 'bg-slate-50 dark:bg-slate-800/60'}`}>
          <div className={`text-[11px] ${noAmount.length ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500'}`}>金額が読めない</div>
          <div className={`text-lg font-bold ${noAmount.length ? 'text-amber-700 dark:text-amber-300' : ''}`}>{noAmount.length} 件</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="expected">精算金額</label>
        <input
          id="expected"
          inputMode="numeric"
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder="例: 12,345"
          className="w-40 rounded-xl border border-slate-300 bg-white px-3 py-2 text-right font-mono outline-none focus:border-teal-500 focus:ring-4 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950"
        />
        {hasExp && (
          diff === 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"><CheckCircle2 size={16} /> 合計と一致</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
              <TriangleAlert size={16} /> 差額 {diff > 0 ? '+' : ''}¥{diff.toLocaleString()}(読み取り合計 − 精算金額)
            </span>
          )
        )}
      </div>

      {allGood ? (
        <p className="mt-3 flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={16} /> すべて登録番号付きで、金額も読み取れました</p>
      ) : (
        <div className="mt-3 space-y-1 text-xs">
          {noNumber.length > 0 && <p className="font-medium text-rose-700 dark:text-rose-300">登録番号が見つからない領収書があります(非登録事業者・読み取り失敗の可能性)。選んで内容を確認してください。</p>}
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {entries.filter((e) => !e.digits || e.amount === null).map((e) => (
              <li key={e.key}>
                <button type="button" onClick={e.onSelect} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <span className="w-16 shrink-0 text-slate-500">{e.label}</span>
                  {!e.digits && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300">登録番号なし</span>}
                  {e.amount === null && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">金額なし</span>}
                  <span className="ml-auto font-mono">{e.amount !== null ? `¥${e.amount.toLocaleString()}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {withNo.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-slate-500">登録番号ありの {withNo.length} 件(公表サイトで登録状況を確認)</summary>
          <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {withNo.map((e) => (
              <li key={e.key} className="flex items-center gap-2 px-3 py-1.5">
                <button type="button" onClick={e.onSelect} className="w-16 shrink-0 text-left text-slate-500 hover:underline">{e.label}</button>
                <span className="font-mono">T{e.digits}</span>
                <span className="ml-auto font-mono">{e.amount !== null ? `¥${e.amount.toLocaleString()}${e.estimated ? '*' : ''}` : '-'}</span>
                <a href={invoiceKohyoUrl(e.digits!)} target="_blank" rel="noreferrer" className="text-teal-600" title="公表サイトで確認"><ExternalLink size={13} /></a>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        金額は各領収書の「合計」等の記載から読み取った目安です(* は明細の合計から推定)。登録番号が読めても、実際に登録されているか(取消・失効していないか)は公表サイトでご確認ください。
      </p>
    </div>
  )
}
