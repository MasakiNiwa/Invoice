import { useState } from 'react'
import { BadgeCheck, ExternalLink, Keyboard, XCircle } from 'lucide-react'
import { invoiceKohyoUrl } from '../lib/links'
import { formatTNumber, parseManualInput } from '../lib/tnumber'

/** T番号の手入力検算 */
export function ManualCheck() {
  const [v, setV] = useState('')
  const r = parseManualInput(v)
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Keyboard size={16} className="text-teal-600" /> 手入力で検算
      </div>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        inputMode="text"
        placeholder="例: T1234567890123(ハイフン・空白・全角OK)"
        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-base outline-none focus:border-teal-500 focus:ring-4 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950"
      />
      {r.message && (
        <div className={`mt-2 flex flex-wrap items-center gap-2 text-sm ${r.valid ? 'text-emerald-600' : 'text-rose-600'}`}>
          {r.valid ? <BadgeCheck size={16} /> : <XCircle size={16} />}
          {r.digits && <span className="font-mono font-semibold">{formatTNumber(r.digits)}</span>}
          <span>{r.message}</span>
          {r.digits && (
            <a className="btn-ghost ml-auto px-3 py-1.5 text-xs" href={invoiceKohyoUrl(r.digits)} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> 公表サイト
            </a>
          )}
        </div>
      )}
    </div>
  )
}
