import { Download, ExternalLink, FileStack, Loader2, Square } from 'lucide-react'
import type { InvoiceResult } from '../lib/analyze'
import { invoiceKohyoUrl } from '../lib/links'
import { formatTNumber } from '../lib/tnumber'
import type { ScanState } from '../hooks/useScan'

export interface BatchItem {
  page: number
  state: ScanState
  invoices: InvoiceResult[]
}

export interface Batch {
  name: string
  total: number
  items: BatchItem[]
  running: boolean
  current: number
}

const SUMMARY = {
  ok: ['記載事項OK', 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'],
  warn: ['一部未確認', 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'],
  ng: ['不足あり', 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300'],
  na: ['-', 'bg-slate-100 text-slate-500'],
} as const

export function batchToCsv(b: Batch): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`
  const head = ['ファイル', 'ページ', 'インボイス', '登録番号', '公表サイト', '記載事項チェック', '簡易インボイス']
  const rows = b.items.flatMap((it) =>
    it.invoices.map((inv) => [
      b.name,
      String(it.page),
      String(inv.index + 1),
      inv.digits ? `T${inv.digits}` : '',
      inv.digits ? invoiceKohyoUrl(inv.digits) : '',
      inv.report?.summaryText ?? '',
      inv.report ? (inv.report.simplified ? 'はい' : 'いいえ') : '',
    ]),
  )
  return '﻿' + [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n'
}

interface Props {
  batch: Batch
  selected: { page: number; inv: number } | null
  onSelect: (page: number, inv: number) => void
  onStop: () => void
}

/** 複数ページ PDF の一括読み取り結果 */
export function BatchPanel({ batch, selected, onSelect, onStop }: Props) {
  const invoices = batch.items.reduce((s, it) => s + it.invoices.length, 0)
  const found = batch.items.reduce((s, it) => s + it.invoices.filter((i) => i.digits).length, 0)
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([batchToCsv(batch)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${batch.name.replace(/\.pdf$/i, '')}-invoices.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
        <FileStack size={16} className="text-teal-600" /> PDF一括チェック
        <span className="text-xs font-normal text-slate-500">
          {batch.items.length}/{batch.total} ページ・インボイス {invoices} 件(登録番号あり {found} 件)
        </span>
        <div className="ml-auto flex gap-2">
          {batch.running ? (
            <button className="btn-danger px-3 py-1.5 text-xs" onClick={onStop}><Square size={12} /> 停止</button>
          ) : (
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={exportCsv} disabled={invoices === 0}><Download size={14} /> CSV</button>
          )}
        </div>
      </div>
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className="h-full bg-teal-500 transition-[width]" style={{ width: `${(batch.items.length / Math.max(1, batch.total)) * 100}%` }} />
      </div>
      {batch.running && (
        <p className="mb-2 flex items-center gap-1 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> {batch.current} ページ目を読み取り中…(終わったページから確認できます)</p>
      )}
      <ul className="max-h-80 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
        {batch.items.flatMap((it) =>
          it.invoices.map((inv) => {
            const active = selected?.page === it.page && selected.inv === inv.index
            const sm = SUMMARY[inv.report?.summary ?? 'na']
            return (
              <li key={`${it.page}-${inv.index}`}>
                <button
                  type="button"
                  disabled={batch.running}
                  onClick={() => onSelect(it.page, inv.index)}
                  className={`flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left transition hover:bg-slate-50 disabled:cursor-default dark:hover:bg-slate-800/60 ${active ? 'bg-teal-50 dark:bg-teal-900/30' : ''}`}
                >
                  <span className="w-14 shrink-0 text-xs text-slate-500">p.{it.page}{it.invoices.length > 1 ? ` #${inv.index + 1}` : ''}</span>
                  <span className="font-mono font-semibold">{inv.digits ? formatTNumber(inv.digits) : <span className="font-sans text-xs font-normal text-slate-400">登録番号なし</span>}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${sm[1]}`}>{sm[0]}</span>
                  {inv.digits && (
                    <a className="ml-auto text-teal-600 hover:underline" href={invoiceKohyoUrl(inv.digits)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="公表サイトで確認">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </button>
              </li>
            )
          }),
        )}
      </ul>
    </div>
  )
}
