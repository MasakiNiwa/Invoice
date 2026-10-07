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
  /** 行を構成する元の文字行(検出枠)。精査で読み直すときに使う */
  parts?: { text: string; rect: Rect; conf?: number }[]
}

export type CheckStatus = 'ok' | 'warn' | 'ng' | 'na'

export interface RequirementItem {
  id: 'issuer' | 'regno' | 'date' | 'content' | 'rateTotal' | 'tax' | 'recipient' | 'consistency' | 'total'
  label: string
  status: CheckStatus
  /** 見つかった記載(抜粋) */
  evidence: string[]
  rects: Rect[]
  message: string
}

export interface TaxRateLine {
  rate: 10 | 8
  /** 税率ごとの対象額(税込 or 税抜) */
  base: number | null
  tax: number | null
  /** 内税/外税 の判定結果 */
  mode: '内税' | '外税' | null
  ok: boolean | null
}

export interface TaxBreakdown {
  lines: TaxRateLine[]
  total: number | null
  /** 税率ごとの金額の合計が総額と一致するか */
  totalOk: boolean | null
}

export interface ParsedDate {
  year: number
  month: number
  day: number
  valid: boolean
  /** インボイス制度(2023/10/1)開始前 */
  beforeInvoiceSystem: boolean
  future: boolean
  text: string
}

export interface RequirementReport {
  items: RequirementItem[]
  breakdown: TaxBreakdown | null
  dates: ParsedDate[]
  /** 適格簡易請求書(レシート等)らしい */
  simplified: boolean
  summary: CheckStatus
  summaryText: string
}

/**
 * 多言語OCR(PaddleOCR)が日本語の漢字を簡体字で出力することがあるため、
 * 請求書・レシートに頻出する字だけ日本の字体に寄せる
 */
const SIMPLIFIED_TO_JA: Record<string, string> = {
  对: '対', 费: '費', 领: '領', 收: '収', 识: '識', 侧: '側', 计: '計', 额: '額', 单: '単', 价: '価',
  发: '発', 书: '書', 业: '業', 务: '務', 货: '貨', 买: '買', 卖: '売', 贩: '販', 销: '販', 数: '数',
  总: '総', 钱: '銭', 现: '現', 应: '応', 预: '預', 还: '還', 内: '内', 种: '種', 类: '類', 证: '証',
  请: '請', 记: '記', 录: '録', 号: '号', 册: '冊', 盖: '蓋', 区: '区', 东: '東', 京: '京',
  会: '会', 员: '員', 银: '銀', 达: '込', 测: '測', 认: '認', 页: '頁', 积: '積', 点: '点', 余: '余', 实: '実', 际: '際', 时: '時', 间: '間',
  电: '電', 话: '話', 场: '場', 车: '車', 乐: '楽', 气: '気', 饮: '飲', 食: '食', 酒: '酒', 头: '頭',
}

/** OCR テキストの正規化: 全角→半角、日本語文字間の空白除去、¥表記統一 */
export function normalizeRow(s: string): string {
  return toHalfWidth(s)
    .replace(/[\u4e00-\u9fff]/g, (c) => SIMPLIFIED_TO_JA[c] ?? c)
    .replace(/[|｜]/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/：/g, ':')
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

/**
 * OCR の誤読に強いキーワード修復。
 * 同じ長さの区間で、違う文字が「見た目が似ていて取り違えやすい漢字」の組み合わせだけなら
 * 正しい表記に置き換える(例: 「消貿税」「消費稅」→「消費税」、「領収害」→「領収書」、「登録督号」→「登録番号」)。
 * 5文字以上のキーワードは、それに加えて任意の漢字1文字の違いまで許容する。
 */
const FUZZY_KEYWORDS = [
  '内消費税等', '消費税等', '消費税', '税込合計', '合計金額', 'ご請求金額', '御請求金額', '請求金額', '税抜金額', '税込金額',
  '領収書', '領収証', '請求書', '納品書', '登録番号', '軽減税率', '対象額', '適格請求書', 'お買上', '但し書',
]
/** 正しい字 → OCR が出しがちな字(簡体字・形の似た字) */
const CONFUSABLE: Record<string, string> = {
  費: '貿賀费責貴', 税: '稅祝悦説', 書: '害善晝畫', 番: '督香畨審备畓', 録: '緑碌錄', 領: '頜鎖', 収: '收', 額: '頟客', 対: '对討',
  象: '像', 計: '訃討', 込: '迄', 請: '清諸靖', 求: '來', 号: '弓', 登: '澄', 消: '清', 金: '全', 合: '含', 証: '正', 納: '約',
  品: '晶', 軽: '経', 減: '滅减', 率: '卒', 適: '摘', 格: '恪', 抜: '扱', 但: '伹',
}
const FUZZY_SET = new Set(FUZZY_KEYWORDS)
const isKanji = (c: string) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c)
export function repairKeywords(s: string): string {
  let out = s
  for (const kw of FUZZY_KEYWORDS) {
    if (out.includes(kw)) continue
    const L = kw.length
    for (let i = 0; i + L <= out.length; i++) {
      const win = out.slice(i, i + L)
      // 既に別の正しいキーワードになっている区間は書き換えない(領収書 ↔ 領収証 など)
      if (FUZZY_SET.has(win)) continue
      let diff = 0
      let free = L >= 5 ? 1 : 0
      let ok = true
      for (let k = 0; k < L; k++) {
        if (win[k] === kw[k]) continue
        diff++
        if (CONFUSABLE[kw[k]]?.includes(win[k])) continue
        if (free > 0 && isKanji(win[k]) && isKanji(kw[k])) {
          free--
          continue
        }
        ok = false
        break
      }
      if (ok && diff > 0 && diff <= Math.ceil(L / 3)) {
        out = out.slice(0, i) + kw + out.slice(i + L)
        break
      }
    }
  }
  return out
}

/** 金額らしき数値を抽出(¥1,234 / 1,234円) */
export function parseAmounts(text: string): number[] {
  let s = text
  const out: number[] = []
  // 桁区切りのカンマがピリオドに誤読されたもの(¥2.000)も金額として扱う
  s = s.replace(/(?<=[¥\d])(\d{1,3})\.(\d{3})(?!\d)/g, '$1,$2')
  const re = /¥\s?([\d,]+)|([\d,]+)\s?円/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const v = Number((m[1] ?? m[2]).replace(/,/g, ''))
    if (Number.isFinite(v) && v > 0) out.push(v)
  }
  return out
}

const DATE_RE = /((?:19|20)\d{2}|令和\s?\d{1,2}|R\s?\d{1,2}|令和元)\s?[年/.\-]\s?\d{1,2}\s?[月/.\-]\s?\d{1,2}\s?日?/
const DATE_PARTS_RE = /((?:19|20)\d{2})|(?:令和|R)\s?(\d{1,2}|元)/

/** 日付の妥当性(実在する日付か・制度開始前でないか・未来でないか) */
export function parseDate(text: string, today = new Date()): ParsedDate | null {
  const m = DATE_RE.exec(text)
  if (!m) return null
  const y = DATE_PARTS_RE.exec(m[1])
  if (!y) return null
  const year = y[1] ? Number(y[1]) : 2018 + (y[2] === '元' ? 1 : Number(y[2]))
  const nums = m[0].slice(m[1].length).match(/\d{1,2}/g) ?? []
  const month = Number(nums[0])
  const day = Number(nums[1])
  const d = new Date(year, month - 1, day)
  const valid = month >= 1 && month <= 12 && d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  return {
    year, month, day, valid,
    beforeInvoiceSystem: valid && d < new Date(2023, 9, 1),
    future: valid && d > tomorrow,
    text: `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
  }
}

const TOTAL_ONLY_RE = /(合計|総額|請求金額|お買上|税込金額|ご利用額)/
const NOT_TOTAL_RE = /(小計|対象|消費税|税額|内税|外税|お預|釣|残高|ポイント)/

/** 税率ごとの対象額・税額と総額を取り出し、整合性を検算する */
export function extractTaxBreakdown(lines: string[]): TaxBreakdown | null {
  const res: TaxRateLine[] = []
  for (const rate of [10, 8] as const) {
    const rateRe = new RegExp(`(^|[^\\d])${rate}\\s?%`)
    const baseLine = lines.find((l) => rateRe.test(l) && /(対象|合計|計|税込|税抜)/.test(l) && !/(消費税|税額|内税|税等)/.test(l) && parseAmounts(l).length)
    const taxLine = lines.find((l) => rateRe.test(l) && /(消費税|税額|内税|外税|税等)/.test(l) && parseAmounts(l).length)
    if (!baseLine && !taxLine) continue
    const base = baseLine ? Math.max(...parseAmounts(baseLine)) : null
    const tax = taxLine ? Math.max(...parseAmounts(taxLine)) : null
    let mode: TaxRateLine['mode'] = null
    let ok: boolean | null = null
    if (base !== null && tax !== null) {
      // 端数処理(切捨て・四捨五入・切上げ)を許容して ±1円
      if (Math.abs(tax - (base * rate) / (100 + rate)) < 1) mode = '内税'
      else if (Math.abs(tax - (base * rate) / 100) < 1) mode = '外税'
      ok = mode !== null
    }
    res.push({ rate, base, tax, mode, ok })
  }
  // 総額: 「合計」「請求金額」など(小計・対象・税額・お預り等は除く)の最大金額
  const totals = lines.filter((l) => TOTAL_ONLY_RE.test(l) && !NOT_TOTAL_RE.test(l)).flatMap(parseAmounts)
  const total = totals.length ? Math.max(...totals) : null
  if (res.length === 0 && total === null) return null
  let totalOk: boolean | null = null
  const withBase = res.filter((r) => r.base !== null)
  if (total !== null && withBase.length > 0) {
    const sumIn = withBase.reduce((s, r) => s + (r.base ?? 0), 0)
    const sumOut = withBase.reduce((s, r) => s + (r.base ?? 0) + (r.mode === '外税' ? r.tax ?? 0 : 0), 0)
    const tol = withBase.length
    totalOk = Math.abs(sumIn - total) <= tol || Math.abs(sumOut - total) <= tol
  }
  return { lines: res, total, totalOk }
}
const ISSUER_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|NPO法人|医療法人|社会福祉法人|学校法人|\(株\)|\(有\)|㈱|㈲|事務所|商店|商事|店$|店\b|本店|支店|[^\s]店|食堂|[^\s]堂$|[^\s]屋$|亭|カフェ|クリニック|医院|病院|薬局|ホテル|旅館|工業|工房|製作所)/
const RECIPIENT_RE = /(御中|様|殿)(?!式)/
const RECEIPT_RE = /(領収書|領収証|レシート|お買上|お買い上げ|ご来店|お預り|お預かり|お釣|釣銭|POS|レジ|nanaco|Suica|PayPay|現金|クレジット)/i
const RATE_RE = /(10|8)\s?%/
const REDUCED_MARK_RE = /(軽減|※|\*|★|☆|#)/
const TAX_RE = /(消費税|内税|外税|税額|税等|内消費税|うち税|税\s?¥)/
const TOTAL_RE = /(対象|合計|小計|総計|税込|税抜|お買上)/
const CONTENT_RE = /(品名|品目|内容|摘要|明細|但し|但|商品|項目|として|代|料|費)/

function rowsMatching(rows: { n: string; r: TextRow }[], re: RegExp) {
  return rows.filter((x) => re.test(x.n))
}

export function checkRequirements(rawRows: TextRow[], opts: { regNo: string | null; regNoWeak?: boolean; today?: Date }): RequirementReport {
  const rows = rawRows.map((r) => ({ n: repairKeywords(normalizeRow(r.text)), r })).filter((x) => x.n.length > 0)
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
  // 発行者名は登録番号の近く(前後数行)か、上の方に書かれることが多いので、その順に並べる
  const regIdx = opts.regNo ? rows.findIndex((x) => x.n.replace(/\D/g, '').includes(opts.regNo!.slice(-8))) : -1
  const issuer = rowsMatching(rows, ISSUER_RE)
    .filter((x) => !RECIPIENT_RE.test(x.n))
    .map((x) => ({ x, d: regIdx >= 0 ? Math.abs(rows.indexOf(x) - regIdx) : rows.indexOf(x) }))
    .sort((a, b) => a.d - b.d)
    .map((v) => v.x)
  items.push({
    id: 'issuer',
    label: '発行者の氏名・名称',
    status: issuer.length ? 'ok' : 'warn',
    ...ev(issuer, 2),
    message: issuer.length ? '会社名・店名らしき記載があります' : '会社名・店名を自動で特定できません(ロゴ等の場合は目視で確認)',
  })

  // 2. 取引年月日(実在する日付か・制度開始前でないか・未来でないかも確認)
  const dateRows = rowsMatching(rows, DATE_RE)
  const parsed = dateRows.map((x) => ({ x, d: parseDate(x.n, opts.today) })).filter((v): v is { x: (typeof rows)[number]; d: ParsedDate } => !!v.d)
  const goodDates = parsed.filter((v) => v.d.valid && !v.d.future)
  const dateItem = (() => {
    if (parsed.length === 0) return { status: 'ng' as CheckStatus, message: '日付を確認できません' }
    if (goodDates.length === 0) return { status: 'warn' as CheckStatus, message: parsed.some((v) => !v.d.valid) ? '日付らしき記載がありますが、実在しない日付です(誤読の可能性)' : '未来の日付になっています(誤読の可能性)' }
    if (goodDates.every((v) => v.d.beforeInvoiceSystem)) return { status: 'warn' as CheckStatus, message: 'インボイス制度の開始(2023年10月1日)より前の日付です' }
    return { status: 'ok' as CheckStatus, message: `日付があります(${goodDates[0].d.text})` }
  })()
  items.push({
    id: 'date',
    label: '取引年月日',
    ...dateItem,
    evidence: (goodDates.length ? goodDates : parsed).slice(0, 2).map((v) => (DATE_RE.exec(v.x.n)?.[0] ?? v.x.n).slice(0, 30)),
    rects: (goodDates.length ? goodDates : parsed).slice(0, 2).map((v) => v.x.r.rect),
  })

  // 3. 取引内容(+軽減税率の旨)
  const content = rowsMatching(rows, CONTENT_RE).filter((x) => !TAX_RE.test(x.n))
  const amountRows = rows.filter((x) => parseAmounts(x.n).length > 0 && !TAX_RE.test(x.n) && !TOTAL_RE.test(x.n))
  const has8 = rows.some((x) => /8\s?%/.test(x.n))
  // 軽減税率の旨: 「軽減」の記載、8% の行の印、または品目に ※★ 等の印(8% の行と合わせて「※は軽減税率対象」を示す慣行)
  const reducedMarked = rows.some((x) => /軽減/.test(x.n) || (/8\s?%/.test(x.n) && REDUCED_MARK_RE.test(x.n))) ||
    (has8 && rows.some((x) => /^[※★☆*]|[※★☆]/.test(x.n) && parseAmounts(x.n).length > 0))
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

  // 金額の検算: 対象額 × 税率 = 税額、税率ごとの金額の合計 = 総額
  const breakdown = extractTaxBreakdown(rows.map((x) => x.n))
  const checked = breakdown?.lines.filter((l) => l.ok !== null) ?? []
  if (checked.length) {
    const ok = checked.every((l) => l.ok)
    items.push({
      id: 'consistency',
      label: '税額の検算',
      status: ok ? 'ok' : 'warn',
      evidence: checked.map((l) => `${l.rate}%: 対象 ¥${l.base!.toLocaleString()} → 税 ¥${l.tax!.toLocaleString()} ${l.ok ? `(${l.mode}で一致)` : '(不一致?)'}`),
      rects: [],
      message: ok ? '対象額と税額が端数処理の範囲で一致しています' : '対象額と税額が一致しないようです(OCRの誤読の可能性もあります)',
    })
  }
  if (breakdown && breakdown.totalOk !== null) {
    items.push({
      id: 'total',
      label: '合計の検算',
      status: breakdown.totalOk ? 'ok' : 'warn',
      evidence: [`合計 ¥${breakdown.total!.toLocaleString()}`, ...breakdown.lines.filter((l) => l.base !== null).map((l) => `${l.rate}%対象 ¥${l.base!.toLocaleString()}`)],
      rects: [],
      message: breakdown.totalOk ? '税率ごとの金額の合計が総額と一致しています' : '税率ごとの金額の合計が総額と一致しないようです(誤読の可能性もあります)',
    })
  }

  const core = items.filter((i) => i.id !== 'consistency' && i.id !== 'total')
  const summary: CheckStatus = core.some((i) => i.status === 'ng') ? 'ng' : core.some((i) => i.status === 'warn') ? 'warn' : 'ok'
  const summaryText =
    summary === 'ok' ? '記載事項がそろっている可能性が高いです'
      : summary === 'warn' ? '一部、自動では確認できない項目があります'
        : '確認できない記載事項があります'
  return { items, simplified, summary, summaryText, breakdown, dates: parsed.map((v) => v.d) }
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
