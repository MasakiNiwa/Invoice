/** スキャン結果を「インボイスごと」の結果にまとめる(1ページに複数のインボイスがあっても分ける) */
import type { Rect } from './image'
import { isPrimary, type Candidate } from './ocr/aggregate'
import { checkRequirements, type RequirementReport, type TextRow } from './requirements'
import { segmentInvoices } from './segment'
import { groupFullRows } from './rows'

export interface InvoiceResult {
  index: number
  rect: Rect
  digits: string | null
  report: RequirementReport | null
}

export function analyzeScan(candidates: Candidate[], textRows: TextRow[] | null, pageW: number, pageH: number): InvoiceResult[] {
  const primary = candidates.filter(isPrimary)
  const weak = candidates.find((c) => c.valid && c.context && !c.hasT && !c.likelyJan)
  const tLocs = primary.filter((c) => c.rects.length).map((c) => ({ digits: c.digits, rect: c.rects[0] }))
  const rows = textRows ?? []
  if (rows.length === 0) {
    return [{ index: 0, rect: { x: 0, y: 0, w: pageW, h: pageH }, digits: primary[0]?.digits ?? null, report: null }]
  }
  // 横に並んだ別々のインボイスが1行に結合されないよう、元の文字片(検出枠・テキスト層の要素)で領域分割し、
  // 領域ごとに行を組み立て直す
  const atoms: TextRow[] = rows.flatMap((r) => (r.parts?.length ? r.parts.map((p) => ({ text: p.text, rect: p.rect, parts: [p] })) : [r]))
  const segs = segmentInvoices(atoms, tLocs, pageW, pageH).map((s) => ({ ...s, rows: groupFullRows(s.rows.flatMap((r) => r.parts ?? [r])) }))
  return segs.map((s) => {
    const single = segs.length === 1
    const regNo = s.digits ?? (single ? primary[0]?.digits ?? weak?.digits ?? null : null)
    const regNoWeak = !s.digits && !(single && primary[0]) && !!regNo
    return { index: s.index, rect: s.rect, digits: regNo, report: checkRequirements(s.rows, { regNo, regNoWeak }) }
  })
}
