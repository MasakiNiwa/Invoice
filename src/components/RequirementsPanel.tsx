import { CheckCircle2, CircleHelp, ClipboardCheck, MinusCircle, XCircle } from 'lucide-react'
import type { Rect } from '../lib/image'
import type { CheckStatus, RequirementReport, TextRow } from '../lib/requirements'
import { normalizeRow } from '../lib/requirements'

const ICON: Record<CheckStatus, typeof CheckCircle2> = { ok: CheckCircle2, warn: CircleHelp, ng: XCircle, na: MinusCircle }
const COLOR: Record<CheckStatus, string> = {
  ok: 'text-emerald-500',
  warn: 'text-amber-500',
  ng: 'text-rose-500',
  na: 'text-slate-400',
}
const SUMMARY_BG: Record<CheckStatus, string> = {
  ok: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  ng: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  na: 'bg-slate-50 text-slate-700',
}

interface Props {
  report: RequirementReport | null
  scanning: boolean
  japaneseOff: boolean
  rows?: TextRow[]
  onHover?: (rects: Rect[] | null) => void
}

/** 適格請求書の記載事項チェック(目安) */
export function RequirementsPanel({ report, scanning, japaneseOff, rows, onHover }: Props) {
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <ClipboardCheck size={16} className="text-teal-600" /> インボイス記載事項チェック
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-normal text-slate-500 dark:bg-slate-800">目安</span>
        {report?.simplified && <span className="ml-auto rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-normal text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">簡易インボイス(レシート)と判定</span>}
      </div>
      {japaneseOff ? (
        <p className="text-xs text-slate-500">設定の「日本語レイアウト解析」がオフのため、チェックできません。</p>
      ) : !report ? (
        <p className="text-xs text-slate-500">{scanning ? '全体のレイアウト解析が終わるとチェック結果が表示されます…' : 'チェックに使える文字情報がありません。'}</p>
      ) : (
        <>
          <div className={`mb-3 rounded-xl px-3 py-2 text-sm font-medium ${SUMMARY_BG[report.summary]}`}>{report.summaryText}</div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {report.items.map((it) => {
              const Icon = ICON[it.status]
              return (
                <li
                  key={it.id}
                  className="flex gap-2 py-2"
                  onMouseEnter={() => it.rects.length && onHover?.(it.rects)}
                  onMouseLeave={() => onHover?.(null)}
                  onClick={() => it.rects.length && onHover?.(it.rects)}
                >
                  <Icon size={18} className={`mt-0.5 shrink-0 ${COLOR[it.status]}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{it.label}</div>
                    <div className="text-xs text-slate-500">{it.message}</div>
                    {it.evidence.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {it.evidence.map((e, i) => (
                          <span key={i} className="max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{e}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          {rows && rows.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-slate-500">読み取った全文({rows.length}行)</summary>
              <ol className="mt-1 max-h-64 overflow-auto rounded-lg bg-slate-50 p-2 font-mono text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                {rows.map((r, i) => (
                  <li key={i} className="cursor-default hover:bg-sky-100 dark:hover:bg-sky-900/40" onMouseEnter={() => onHover?.([r.rect])} onMouseLeave={() => onHover?.(null)}>
                    {normalizeRow(r.text)}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            OCRの文字から自動で推定した結果です。最終的な判断は請求書の原本でご確認ください。簡易インボイス(小売・飲食・タクシー等)は宛名を省略でき、適用税率と税額はどちらか一方の記載でよいとされています。
          </p>
        </>
      )}
    </div>
  )
}
