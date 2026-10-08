/**
 * 金額の集計: 明細(利用金額が並ぶ ETC 利用明細・レシートの品目など)を合計し、記載の合計と照合する。
 * 精算チェック用に、インボイスごとの金額(総額)も決める。
 */
import type { Rect } from './image'
import { normalizeRow, parseAmounts, repairKeywords, type TextRow } from './requirements'
import { inferTable, type TableModel } from './table'

export type LineKind = 'item' | 'total' | 'tax' | 'payment' | 'other'

export interface LineItem {
  text: string
  amount: number
  rect: Rect
  kind: LineKind
}

export interface AmountSummary {
  items: LineItem[]
  /** 明細(item)の合計 */
  itemsSum: number
  /** 記載されている合計(総額) */
  docTotal: number | null
  /** 消費税額の合計(外税の照合用) */
  taxTotal: number
  /** 明細の合計と記載の合計の照合 */
  match: 'equal' | 'equalWithTax' | 'diff' | null
  /** 推定した表の構造(金額の列) */
  table: TableModel | null
}

const TOTAL_RE = /(合計|総額|総計|請求金額|ご請求|御請求|お支払|支払金額|領収金額|ご利用額|ご利用金額|利用金額合計|税込金額|料金合計|お買上)/
/** 行頭が「金額」「運賃」「料金」で金額が続く(タクシーの領収書など) */
const LEADING_TOTAL_RE = /^(金額|運賃|料金|領収額|ご料金)\s?[:：]?\s?[¥\d]/
const SUBTOTAL_RE = /(小計|対象|内訳)/
const TAX_RE = /(消費税|税額|内税|外税|税等)/
const OTHER_RE = /(釣|残高|ポイント|電話|TEL|FAX|〒|No\.|番号|口座|会員)/i
/** 支払いの行(現金・カード・電子マネー)。合計の書かれていないレシートでは、これが合計の目安になる */
const PAYMENT_RE = /(支払|お預|預り|現金|クレジット|カード|nanaco|Suica|PASMO|ICOCA|PayPay|楽天|電子マネー|WAON|Edy|QUICPay|d払い|au\s?PAY)/i
/** ¥・円が無くても金額とみなしてよい表(見出しに「料金」「金額」「(円)」がある) */
const MONEY_HEADER_RE = /(料金|金額|\(円\)|円\)|運賃|通行料)/

/** ¥・円の付かない、行末側の数値(日付・時刻・電話番号の一部は除く) */
function bareAmount(n: string): number | null {
  const re = /(?<![\d,./:\-])(\d{1,3}(?:,\d{3})+|\d{2,7})(?![\d,./:\-%年月日時分])/g
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(n))) last = m
  if (!last) return null
  // 行の後ろ寄りにある数値だけ(金額は右端の列に書かれる)
  if (last.index < n.length * 0.4 && n.length > 12) return null
  const v = Number(last[1].replace(/,/g, ''))
  return v > 0 ? v : null
}

export function extractAmounts(rows: TextRow[]): AmountSummary {
  const norm = rows.map((r) => ({ r, n: repairKeywords(normalizeRow(r.text)) }))
  const moneyTable = norm.some((x) => MONEY_HEADER_RE.test(x.n))
  // 表の構造が分かれば、各行の金額は「金額の列」の数値から取る
  const table = inferTable(rows)
  const items: LineItem[] = []
  for (const [ri, { r, n }] of norm.entries()) {
    const amounts = parseAmounts(n)
    let amount = table?.rowAmounts[ri] ?? (amounts.length ? amounts[amounts.length - 1] : null)
    if (amount === null && moneyTable && !table) {
      // 見出し行(数値なし)や日付だけの行は除く
      if (MONEY_HEADER_RE.test(n) && !/\d{2,}/.test(n.replace(/\(円\)/, ''))) continue
      amount = bareAmount(n)
    }
    if (amount === null) continue
    const kind: LineKind = TAX_RE.test(n)
      ? 'tax'
      : OTHER_RE.test(n)
        ? 'other'
        : (TOTAL_RE.test(n) || LEADING_TOTAL_RE.test(n)) && !SUBTOTAL_RE.test(n) && !/お預|預り/.test(n)
          ? 'total'
          : PAYMENT_RE.test(n)
            ? 'payment'
            : SUBTOTAL_RE.test(n)
              ? 'other'
              : 'item'
    items.push({ text: n, amount, rect: r.rect, kind })
  }
  // 「合計」の文字が読めなかった合計行の推定: それより上の明細の合計(または+消費税)と同じ金額の明細は合計行とみなす
  // (税率ごとの「対象」小計+消費税 と同じ金額も合計行とみなす)
  let running = 0
  let runningTax = 0
  let runningSub = 0
  let count = 0
  for (const it of items) {
    if (it.kind === 'item') {
      const asTotal =
        count >= 2 &&
        (it.amount === running ||
          (runningTax > 0 && Math.abs(it.amount - running - runningTax) <= 1) ||
          (runningSub > 0 && runningTax > 0 && Math.abs(it.amount - runningSub - runningTax) <= 1))
      if (asTotal) {
        it.kind = 'total'
        continue
      }
      running += it.amount
      count++
    } else if (it.kind === 'tax') runningTax += it.amount
    else if (it.kind === 'other' && /対象/.test(it.text)) runningSub += it.amount
  }
  const itemsSum = items.filter((i) => i.kind === 'item').reduce((s, i) => s + i.amount, 0)
  const totals = items.filter((i) => i.kind === 'total').map((i) => i.amount)
  let docTotal = totals.length ? Math.max(...totals) : null
  if (docTotal === null) {
    // 合計の行が無いレシート: 支払いの金額(お預りは除く) → 税込の「対象」小計の合計 の順で合計とみなす
    const pays = items.filter((i) => i.kind === 'payment' && !/お預|預り/.test(i.text)).map((i) => i.amount)
    const subs = items.filter((i) => i.kind === 'other' && /対象/.test(i.text) && /(税込|内税|\()/.test(i.text)).reduce((s, i) => s + i.amount, 0)
    if (pays.length) docTotal = Math.max(...pays)
    else if (subs > 0) docTotal = subs
  }
  const taxTotal = items.filter((i) => i.kind === 'tax').reduce((s, i) => s + i.amount, 0)
  let match: AmountSummary['match'] = null
  if (docTotal !== null && itemsSum > 0) {
    if (itemsSum === docTotal) match = 'equal'
    else if (taxTotal > 0 && Math.abs(itemsSum + taxTotal - docTotal) <= 1) match = 'equalWithTax'
    else match = 'diff'
  }
  return { items, itemsSum, docTotal, taxTotal, match, table }
}

/** 選んだ明細だけで合計し直す(画面でチェックを外したとき用) */
export function sumSelected(items: LineItem[], selected: boolean[]): number {
  return items.reduce((s, it, i) => (selected[i] && it.kind === 'item' ? s + it.amount : s), 0)
}

/** インボイスの金額(精算チェック用): 記載の合計 → 明細の合計 の順 */
export function invoiceAmount(a: AmountSummary): { value: number; source: 'total' | 'items' } | null {
  if (a.docTotal !== null) return { value: a.docTotal, source: 'total' }
  if (a.itemsSum > 0) return { value: a.itemsSum, source: 'items' }
  return null
}
