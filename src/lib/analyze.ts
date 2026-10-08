/** スキャン結果を「インボイスごと」の結果にまとめる(1ページに複数のインボイスがあっても分ける) */
import type { Rect } from './image'
import { isPrimary, type Candidate } from './ocr/aggregate'
import { checkRequirements, type RequirementReport, type TextRow } from './requirements'
import { findTitleRows, segmentInvoices } from './segment'
import { groupFullRows, groupPhrases } from './rows'
import { extractAmounts, invoiceAmount, type AmountSummary } from './amounts'

export interface InvoiceResult {
  index: number
  rect: Rect
  digits: string | null
  report: RequirementReport | null
  /** 明細と合計の集計 */
  amounts: AmountSummary | null
  /** このインボイスの金額(精算チェック用) */
  amount: { value: number; source: 'total' | 'items' } | null
  /** この領域の行(金額の集計を画面でやり直すとき用) */
  rows: TextRow[]
}

export function analyzeScan(candidates: Candidate[], textRows: TextRow[] | null, pageW: number, pageH: number): InvoiceResult[] {
  const primary = candidates.filter(isPrimary)
  const weak = candidates.find((c) => c.valid && c.context && !c.hasT && !c.likelyJan)
  const tLocs = primary.filter((c) => c.rects.length).map((c) => ({ digits: c.digits, rect: c.rects[0] }))
  const rows = textRows ?? []
  if (rows.length === 0) {
    return [{ index: 0, rect: { x: 0, y: 0, w: pageW, h: pageH }, digits: primary[0]?.digits ?? null, report: null, amounts: null, amount: null, rows: [] }]
  }
  // 横に並んだ別々のインボイスが1行に結合されないよう、元の文字片(検出枠・テキスト層の要素)で領域分割し、
  // 領域ごとに行を組み立て直す
  const atoms: TextRow[] = rows.flatMap((r) => (r.parts?.length ? r.parts.map((p) => ({ text: p.text, rect: p.rect, parts: [p] })) : [r]))
  // 表題は「近い文字片だけをつないだ語句」で探す(横に並んだ領収書の表題が1行に結合されないように)
  const titles = findTitleRows(groupPhrases(atoms.flatMap((a) => a.parts ?? [a]))).map((r) => r.rect)
  const segs = segmentInvoices(atoms, tLocs, pageW, pageH, titles).map((s) => ({ ...s, rows: groupFullRows(s.rows.flatMap((r) => r.parts ?? [r])) }))
  return segs.map((s) => {
    const single = segs.length === 1
    const regNo = s.digits ?? (single ? primary[0]?.digits ?? weak?.digits ?? null : null)
    const regNoWeak = !s.digits && !(single && primary[0]) && !!regNo
    const amounts = extractAmounts(s.rows)
    // 金額は「記載の合計」を優先。無ければ記載事項チェックで取れた総額、明細の合計の順
    const report = checkRequirements(s.rows, { regNo, regNoWeak })
    const amount = amounts.docTotal !== null ? invoiceAmount(amounts) : report.breakdown?.total ? { value: report.breakdown.total, source: 'total' as const } : invoiceAmount(amounts)
    return { index: s.index, rect: s.rect, digits: regNo, report, amounts, amount, rows: s.rows }
  })
}
