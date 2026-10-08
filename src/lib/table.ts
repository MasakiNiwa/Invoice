/**
 * 表構造の推定(罫線の無い表にも使える、文字片の位置からの推定)。
 *
 * - 数値の文字片の「右端」をそろえて並ぶ列としてまとめ(金額は右寄せで書かれる)、
 *   右端にあって数値が多い列を「金額の列」とする
 * - 見出し行(品名・数量・単価・金額 / 利用日・入口・出口・料金 など)から列の名前を付ける
 * - 各行の金額は「金額の列」にある数値から取る(数量・単価・日付の数字を金額と取り違えない)
 */
import type { Rect } from './image'
import { normalizeRow, type TextRow } from './requirements'

export interface TableColumn {
  /** 列の右端(中央値) */
  right: number
  left: number
  /** 見出し(あれば) */
  header?: string
  count: number
  numeric: boolean
}

export interface TableModel {
  columns: TableColumn[]
  /** 金額の列の番号 */
  amountCol: number
  /** 見出し行の番号(rows の index) */
  headerRow: number | null
  /** 金額の列の範囲(画面表示用) */
  amountRect: Rect
  /** 行ごとの金額の列の値 */
  rowAmounts: (number | null)[]
}

const HEADER_RE = /(品名|品目|商品名?|内容|摘要|数量|単価|金額|税率|利用日|利用年月日|入口|出口|料金|車種|日付|項目|小計)/g
const AMOUNT_HEADER_RE = /(金額|料金|通行料|税込|合計|価格)/

/** 文字片が金額らしい数値ならその値 */
export function numericValue(text: string): number | null {
  const t = normalizeRow(text).replace(/\s/g, '')
  const m = /^([-△▲])?[¥]?(-)?(\d{1,3}(?:,\d{3})+|\d{1,8})(?:円|-)?$/.exec(t)
  if (!m) return null
  const v = Number(m[3].replace(/,/g, ''))
  if (!Number.isFinite(v)) return null
  return (m[1] || m[2]) && v !== 0 ? -v : v
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)

export function inferTable(rows: TextRow[]): TableModel | null {
  type P = { row: number; text: string; rect: Rect; value: number | null }
  const parts: P[] = rows.flatMap((r, ri) => (r.parts?.length ? r.parts : [{ text: r.text, rect: r.rect }]).map((p) => ({ row: ri, text: p.text, rect: p.rect, value: numericValue(p.text) })))
  const nums = parts.filter((p) => p.value !== null)
  if (nums.length < 3) return null
  const h = median(parts.map((p) => p.rect.h)) || 10
  // 右端の位置で列にまとめる
  const sorted = [...nums].sort((a, b) => a.rect.x + a.rect.w - (b.rect.x + b.rect.w))
  const cols: P[][] = []
  for (const p of sorted) {
    const r = p.rect.x + p.rect.w
    const c = cols[cols.length - 1]
    if (c && r - median(c.map((q) => q.rect.x + q.rect.w)) < h * 1.2) c.push(p)
    else cols.push([p])
  }
  const good = cols.filter((c) => new Set(c.map((p) => p.row)).size >= 3)
  if (good.length === 0) return null
  // 金額の列: 見出しに「金額」「料金」がある列、無ければ右端の列(数値が多いもの)
  const header = rows.findIndex((r) => (normalizeRow(r.text).match(HEADER_RE) ?? []).length >= 2)
  const columns: TableColumn[] = good.map((c) => ({
    right: median(c.map((p) => p.rect.x + p.rect.w)),
    left: Math.min(...c.map((p) => p.rect.x)),
    count: new Set(c.map((p) => p.row)).size,
    numeric: true,
  }))
  if (header >= 0) {
    const hp = (rows[header].parts?.length ? rows[header].parts! : [{ text: rows[header].text, rect: rows[header].rect }])
    for (const col of columns) {
      // 列の範囲と横に重なる見出しの文字片
      const hit = hp.find((p) => p.rect.x <= col.right + h && p.rect.x + p.rect.w >= col.left - h)
      if (hit) col.header = normalizeRow(hit.text)
    }
  }
  let amountCol = columns.findIndex((c) => c.header && AMOUNT_HEADER_RE.test(c.header))
  if (amountCol < 0) {
    const maxCount = Math.max(...columns.map((c) => c.count))
    for (let i = columns.length - 1; i >= 0; i--) {
      if (columns[i].count >= Math.max(3, maxCount * 0.5)) {
        amountCol = i
        break
      }
    }
  }
  if (amountCol < 0) return null
  const col = columns[amountCol]
  const rowAmounts: (number | null)[] = rows.map(() => null)
  const inCol: P[] = []
  for (const p of nums) {
    const r = p.rect.x + p.rect.w
    if (Math.abs(r - col.right) < h * 1.2) {
      rowAmounts[p.row] = p.value
      inCol.push(p)
    }
  }
  const x0 = Math.min(...inCol.map((p) => p.rect.x))
  const y0 = Math.min(...inCol.map((p) => p.rect.y))
  const x1 = Math.max(...inCol.map((p) => p.rect.x + p.rect.w))
  const y1 = Math.max(...inCol.map((p) => p.rect.y + p.rect.h))
  return { columns, amountCol, headerRow: header >= 0 ? header : null, amountRect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, rowAmounts }
}
