/**
 * 適格請求書(インボイス)の記載事項チェック(目安)。
 *
 * 適格請求書の記載事項(消費税法57条の4第1項)
 *  1. 発行者の氏名又は名称 及び 登録番号
 *  2. 取引年月日
 *  3. 取引内容(軽減税率対象品目である旨)
 *  4. 税率ごとに区分して合計した対価の額 及び 適用税率
 *  5. 税率ごとに区分した消費税額等
 *  6. 書類の交付を受ける事業者の氏名又は名称
 * 適格簡易請求書(小売・飲食・タクシー等)は 6 を省略でき、4 の適用税率と 5 はどちらか一方でよい。
 *
 * OCR テキストに対する正規表現ベースの推定なので、結果はあくまで目安。
 */
import type { Rect } from './image'
import { toHalfWidth } from './tnumber'

export interface TextRow {
  text: string
  rect: Rect
}

export type CheckStatus = 'ok' | 'warn' | 'ng' | 'na'

export interface RequirementItem {
  id: 'issuer' | 'regno' | 'date' | 'content' | 'rateTotal' | 'tax' | 'recipient' | 'consistency'
  label: string
  status: CheckStatus
  /** 見つかった記載(抜粋) */
  evidence: string[]
  rects: Rect[]
  message: string
}

export interface RequirementReport {
  items: RequirementItem[]
  /** 適格簡易請求書(レシート等)らしい */
  simplified: boolean
  summary: CheckStatus
  summaryText: string
}

/** OCR テキストの正規化: 全角→半角、日本語文字間の空白除去、¥表記統一 */
export function normalizeRow(s: string): string {
  return toHalfWidth(s)
    .replace(/[￥]/g, '¥')
    .replace(/％/g, '%')
    .replace(/(?<=[^\x00-\x7f])\s+(?=[^\x00-\x7f])/g, '')
    .replace(/(?<=[^\x00-\x7f])\s+(?=[\d¥%])/g, '')
    .replace(/(?<=[\d%])\s+(?=[^\x00-\x7f])/g, '')
    .replace(/(?<=\d)\s+(?=%)/g, '')
    // 数字に挟まれた/隣接する O・l・I などは数字の誤読とみなす(日付・金額用)
    .replace(/(?<=\d)[Oo](?=\d|年|月|日|%)|(?<=[年月/.\-])[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[lI|](?=\d|年|月|日|%)|(?<=[年月/.\-])[lI|](?=\d)/g, '1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 金額らしき数値を抽出(¥1,234 / 1,234円) */
export function parseAmounts(s: string): number[] {
  const out: number[] = []
  const re = /¥\s?([\d,]+)|([\d,]+)\s?円/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const v = Number((m[1] ?? m[2]).replace(/,/g, ''))
    if (Number.isFinite(v) && v > 0) out.push(v)
  }
  return out
}

const DATE_RE = /((?:19|20)\d{2}|令和\s?\d{1,2}|R\s?\d{1,2}|令和元)\s?[年/.\-]\s?\d{1,2}\s?[月/.\-]\s?\d{1,2}\s?日?/
const ISSUER_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|NPO法人|医療法人|社会福祉法人|学校法人|\(株\)|\(有\)|㈱|㈲|事務所|商店|商事|店$|店\b|本店|支店|[^\s]店)/
const RECIPIENT_RE = /(御中|様|殿)(?!式)/
const RECEIPT_RE = /(領収書|領収証|レシート|お買上|お買い上げ|ご来店|お預り|お預かり|お釣|釣銭|POS|レジ|nanaco|Suica|PayPay|現金|クレジット)/i
const RATE_RE = /(10|8)\s?%/
const REDUCED_MARK_RE = /(軽減|※|\*|★|☆|#)/
const TAX_RE = /(消費税|内税|外税|税額|税等|内消費税|うち税|税\s?¥)/
const TOTAL_RE = /(対象|合計|小計|計|税込|税抜|お買上)/
const CONTENT_RE = /(品名|品目|内容|摘要|明細|但し|但|商品|項目|として|代|料|費)/

function rowsMatching(rows: { n: string; r: TextRow }[], re: RegExp) {
  return rows.filter((x) => re.test(x.n))
}

export function checkRequirements(rawRows: TextRow[], opts: { regNo: string | null; regNoWeak?: boolean }): RequirementReport {
  const rows = rawRows.map((r) => ({ n: normalizeRow(r.text), r })).filter((x) => x.n.length > 0)
  const ev = (xs: { n: string; r: TextRow }[], k = 3) => ({ evidence: xs.slice(0, k).map((x) => x.n.slice(0, 40)), rects: xs.slice(0, k).map((x) => x.r.rect) })
  const items: RequirementItem[] = []
  const simplified = rows.some((x) => RECEIPT_RE.test(x.n)) && !rows.some((x) => RECIPIENT_RE.test(x.n))

  // 1a. 登録番号
  items.push({
    id: 'regno',
    label: '登録番号',
    status: opts.regNo ? (opts.regNoWeak ? 'warn' : 'ok') : 'ng',
    evidence: opts.regNo ? [`T${opts.regNo}`] : [],
    rects: [],
    message: opts.regNo ? (opts.regNoWeak ? '番号は読めましたが「T」が確認できません' : '検算OKの登録番号があります') : '登録番号を確認できません',
  })

  // 1b. 発行者名
  const issuer = rowsMatching(rows, ISSUER_RE).filter((x) => !RECIPIENT_RE.test(x.n))
  items.push({
    id: 'issuer',
    label: '発行者の氏名・名称',
    status: issuer.length ? 'ok' : 'warn',
    ...ev(issuer, 2),
    message: issuer.length ? '会社名・店名らしき記載があります' : '会社名・店名を自動で特定できません(ロゴ等の場合は目視で確認)',
  })

  // 2. 取引年月日
  const dates = rowsMatching(rows, DATE_RE)
  items.push({
    id: 'date',
    label: '取引年月日',
    status: dates.length ? 'ok' : 'ng',
    evidence: dates.slice(0, 2).map((x) => (DATE_RE.exec(x.n)?.[0] ?? x.n).slice(0, 30)),
    rects: dates.slice(0, 2).map((x) => x.r.rect),
    message: dates.length ? '日付があります' : '日付を確認できません',
  })

  // 3. 取引内容(+軽減税率の旨)
  const content = rowsMatching(rows, CONTENT_RE).filter((x) => !TAX_RE.test(x.n))
  const amountRows = rows.filter((x) => parseAmounts(x.n).length > 0 && !TAX_RE.test(x.n) && !TOTAL_RE.test(x.n))
  const has8 = rows.some((x) => /8\s?%/.test(x.n))
  const reducedMarked = rows.some((x) => /軽減/.test(x.n) || (/8\s?%/.test(x.n) && REDUCED_MARK_RE.test(x.n)))
  const contentFound = content.length > 0 || amountRows.length > 0
  items.push({
    id: 'content',
    label: '取引内容' + (has8 ? '(軽減税率対象の旨)' : ''),
    status: !contentFound ? 'warn' : has8 && !reducedMarked ? 'warn' : 'ok',
    ...ev(content.length ? content : amountRows, 2),
    message: !contentFound
      ? '品名・内容らしき記載を確認できません'
      : has8 && !reducedMarked
        ? '8%の記載がありますが、軽減税率対象である旨(※印など)を確認できません'
        : has8 ? '取引内容と軽減税率対象の旨があります' : '取引内容らしき記載があります',
  })

  // 4. 税率ごとの合計額と適用税率
  const rateRows = rowsMatching(rows, RATE_RE)
  const rateTotal = rateRows.filter((x) => TOTAL_RE.test(x.n) || (parseAmounts(x.n).length > 0 && !TAX_RE.test(x.n)))
  items.push({
    id: 'rateTotal',
    label: '税率ごとの合計額・適用税率',
    status: rateTotal.length ? 'ok' : rateRows.length ? 'warn' : simplified ? 'warn' : 'ng',
    ...ev(rateTotal.length ? rateTotal : rateRows, 3),
    message: rateTotal.length ? '税率ごとの対象額があります' : rateRows.length ? '税率の記載はありますが、税率ごとの合計額を特定できません' : '適用税率(10%・8%)を確認できません',
  })

  // 5. 税率ごとの消費税額等
  const taxRows = rowsMatching(rows, TAX_RE)
  const taxOk = taxRows.some((x) => parseAmounts(x.n).length > 0 || /\d/.test(x.n))
  const rateOk = items[items.length - 1].status === 'ok'
  items.push({
    id: 'tax',
    label: '税率ごとの消費税額等',
    status: taxOk ? 'ok' : simplified && rateOk ? 'na' : 'ng',
    ...ev(taxRows, 3),
    message: taxOk ? '消費税額の記載があります' : simplified && rateOk ? '簡易インボイスは適用税率か税額のどちらかでよいため省略可' : '消費税額を確認できません',
  })

  // 6. 宛名
  const rec = rowsMatching(rows, RECIPIENT_RE)
  items.push({
    id: 'recipient',
    label: '宛名(交付を受ける事業者)',
    status: rec.length ? 'ok' : simplified ? 'na' : 'ng',
    ...ev(rec, 2),
    message: rec.length ? '宛名があります' : simplified ? 'レシート等の簡易インボイスなら省略可' : '宛名(〇〇御中・様)を確認できません',
  })

  // おまけ: 税額の検算(対象額 × 税率)
  const consistency = checkTaxConsistency(rows.map((x) => x.n))
  if (consistency) {
    items.push({
      id: 'consistency',
      label: '税額の検算',
      status: consistency.ok ? 'ok' : 'warn',
      evidence: consistency.lines,
      rects: [],
      message: consistency.message,
    })
  }

  const core = items.filter((i) => i.id !== 'consistency')
  const summary: CheckStatus = core.some((i) => i.status === 'ng') ? 'ng' : core.some((i) => i.status === 'warn') ? 'warn' : 'ok'
  const summaryText =
    summary === 'ok' ? '記載事項がそろっている可能性が高いです'
      : summary === 'warn' ? '一部、自動では確認できない項目があります'
        : '確認できない記載事項があります'
  return { items, simplified, summary, summaryText }
}

/** 「10%対象 ¥X」と「消費税(10%) ¥Y」の組から、内税/外税のどちらかで端数処理の範囲で一致するか */
export function checkTaxConsistency(lines: string[]): { ok: boolean; message: string; lines: string[] } | null {
  const results: { rate: number; base: number; tax: number; mode: string; ok: boolean }[] = []
  for (const rate of [10, 8]) {
    const rateRe = new RegExp(`(^|[^\\d])${rate}\\s?%`)
    const baseLine = lines.find((l) => rateRe.test(l) && /(対象|合計|計)/.test(l) && !/(消費税|税額|内税|税等)/.test(l) && parseAmounts(l).length)
    const taxLine = lines.find((l) => rateRe.test(l) && /(消費税|税額|内税|税等)/.test(l) && parseAmounts(l).length)
    if (!baseLine || !taxLine) continue
    const base = Math.max(...parseAmounts(baseLine))
    const tax = Math.max(...parseAmounts(taxLine))
    const inner = (base * rate) / (100 + rate)
    const outer = (base * rate) / 100
    const okInner = Math.abs(tax - inner) < 1
    const okOuter = Math.abs(tax - outer) < 1
    results.push({ rate, base, tax, mode: okInner ? '内税' : okOuter ? '外税' : '', ok: okInner || okOuter })
  }
  if (results.length === 0) return null
  const ok = results.every((r) => r.ok)
  return {
    ok,
    lines: results.map((r) => `${r.rate}%: 対象 ¥${r.base.toLocaleString()} → 税 ¥${r.tax.toLocaleString()} ${r.ok ? `(${r.mode}で一致)` : '(不一致?)'}`),
    message: ok ? '対象額と税額が端数処理の範囲で一致しています' : '対象額と税額が一致しないようです(OCRの誤読の可能性もあります)',
  }
}
