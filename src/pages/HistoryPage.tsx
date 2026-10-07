import { Download, ExternalLink, History, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { CopyButton } from '../components/CopyButton'
import { invoiceKohyoUrl } from '../lib/links'
import { formatTNumber } from '../lib/tnumber'
import { historyToCsv, useHistory } from '../store/history'
import { useSettings } from '../store/settings'

const SUMMARY_STYLE = {
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
  ng: 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300',
  na: 'bg-slate-100 text-slate-600',
} as const
const SUMMARY_LABEL = { ok: '記載事項OK', warn: '一部未確認', ng: '不足あり', na: '-' } as const

export default function HistoryPage() {
  const { entries, remove, clear } = useHistory()
  const saveHistory = useSettings((s) => s.saveHistory)

  const exportCsv = () => {
    const blob = new Blob([historyToCsv(entries)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `invoice-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">読み取り履歴</h1>
        <span className="text-xs text-slate-500">{entries.length} 件(この端末にのみ保存・最大50件)</span>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost px-3 py-2" onClick={exportCsv} disabled={entries.length === 0}>
            <Download size={16} /> CSV
          </button>
          <button
            className="btn-ghost px-3 py-2 text-rose-600"
            disabled={entries.length === 0}
            onClick={() => confirm('履歴をすべて削除しますか?') && clear()}
          >
            <Trash2 size={16} /> 全削除
          </button>
        </div>
      </div>

      {!saveHistory && (
        <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          設定で「履歴を保存」がオフのため、新しい読み取りは保存されません。
        </p>
      )}

      {entries.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-500">
          <History size={36} className="text-slate-300" />
          まだ履歴はありません。
          <Link to="/" className="text-teal-600 underline">請求書を読み取る</Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="card flex gap-3 p-3">
              {e.thumb ? (
                <img src={e.thumb} alt="" className="h-24 w-20 shrink-0 rounded-lg bg-slate-100 object-cover dark:bg-slate-800" />
              ) : (
                <div className="h-24 w-20 shrink-0 rounded-lg bg-slate-100 dark:bg-slate-800" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                  <span>{new Date(e.at).toLocaleString('ja-JP')}</span>
                  <span className="truncate">{e.name}</span>
                </div>
                <div className="mt-0.5 font-mono text-lg font-bold tracking-wide">
                  {e.digits ? formatTNumber(e.digits) : <span className="text-sm font-normal text-slate-400">T番号なし</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                  {e.requirements && <span className={`rounded-full px-2 py-0.5 ${SUMMARY_STYLE[e.requirements.summary]}`}>{SUMMARY_LABEL[e.requirements.summary]}</span>}
                  {e.requirements?.simplified && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">簡易</span>}
                  <span className="text-slate-400">{e.engine}・{e.seconds.toFixed(1)}秒</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {e.digits && (
                    <>
                      <a className="btn-primary px-3 py-1.5 text-xs" href={invoiceKohyoUrl(e.digits)} target="_blank" rel="noreferrer">
                        <ExternalLink size={14} /> 公表サイト
                      </a>
                      <CopyButton text={`T${e.digits}`} />
                    </>
                  )}
                  <button className="btn-ghost px-2 py-1.5 text-slate-400" title="この履歴を削除" onClick={() => remove(e.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
