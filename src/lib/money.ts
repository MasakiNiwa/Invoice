/**
 * 金額トークンの抽出と、1行の中の「ラベル + 金額」の組への分割。
 *
 * 1行に意味の違う金額が並ぶ書き方(「合計 ¥1,100(内消費税 ¥100)」「10%対象 ¥1,100 内税 ¥100」)を
 * 行単位ではなく金額ごとに解釈するための共通処理。記載事項チェック・金額の集計の両方で使う。
 * 入力は normalizeRow 済みの文字列を想定(全角→半角、ー→- など)。
 */

export interface MoneyToken {
  value: number
  /** 文字列中の開始位置(符号を含む) */
  index: number
  end: number
  /** ¥ や 円 が付いていた */
  explicit: boolean
}

export interface MoneySegment extends MoneyToken {
  /** この金額の直前にある見出し(前の金額の後ろから、この金額の前まで) */
  label: string
  /** 見出し、または同じ行のそれより前にある税率 */
  rate: 10 | 8 | null
}

/** 符号: 「-」「△」「▲」。かな・漢字の直後の「-」は長音(ー)の可能性があるので符号にしない */
const SIGN = String.raw`(?:(?<![぀-ヿ一-鿿A-Za-z\d])-|[△▲])`
const EXPLICIT_RE = new RegExp(String.raw`(${SIGN})?\s?¥\s?(-)?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\s?円)?|(${SIGN})?\s?(\d{1,3}(?:,\d{3})+|\d+)\s?円`, 'g')
/** ¥・円の付かない数値。税率(10%)・日付・時刻・数量(3点)・番号の一部は除く */
const BARE_RE = new RegExp(String.raw`(${SIGN})?(?<![\d,./:#\-])(\d{1,3}(?:,\d{3})+|\d{2,8})(?![\d,./:%\-]|\s?(?:%|年|月|日|時|分|点|個|枚|件|名|人|台|回|kg|g\b|ml|L\b))`, 'g')
const DATE_LIKE_RE = /((?:19|20)\d{2}|令和\s?\d{1,2}|R\s?\d{1,2})\s?[年/.\-]\s?\d{1,2}\s?[月/.\-]\s?\d{1,2}\s?日?|\d{1,2}:\d{2}(?::\d{2})?|\d{2,4}-\d{2,4}-\d{3,4}/g

/** 桁区切りのカンマがピリオドに誤読されたもの(¥2.000)を直す */
function fixSeparators(s: string): string {
  return s.replace(/(?<=[¥\d])(\d{1,3})\.(\d{3})(?!\d)/g, '$1,$2')
}

/**
 * 金額トークンを抽出する。
 * @param loose ¥・円が1つも無い行では、裸の数値も金額とみなす(見出しのある行に限って使う)
 */
export function moneyTokens(text: string, loose = false): MoneyToken[] {
  const s = fixSeparators(text)
  const out: MoneyToken[] = []
  let m: RegExpExecArray | null
  EXPLICIT_RE.lastIndex = 0
  while ((m = EXPLICIT_RE.exec(s))) {
    const neg = !!(m[1] || m[2] || m[4])
    const v = Number((m[3] ?? m[5]).replace(/,/g, ''))
    if (!Number.isFinite(v)) continue
    out.push({ value: neg && v !== 0 ? -v : v, index: m.index + (m[0].length - m[0].trimStart().length), end: m.index + m[0].length, explicit: true })
  }
  if (out.length || !loose) return out
  // 日付・時刻・電話番号は空白に置き換えてから探す(位置は保つ)
  const masked = s.replace(DATE_LIKE_RE, (x) => ' '.repeat(x.length))
  BARE_RE.lastIndex = 0
  while ((m = BARE_RE.exec(masked))) {
    const v = Number(m[2].replace(/,/g, ''))
    if (!Number.isFinite(v)) continue
    out.push({ value: m[1] && v !== 0 ? -v : v, index: m.index, end: m.index + m[0].length, explicit: false })
  }
  return out
}

const RATE_IN_RE = /(?<![\d.])(10|8)\s?%/g
function lastRate(s: string): 10 | 8 | null {
  let r: 10 | 8 | null = null
  for (const m of s.matchAll(RATE_IN_RE)) r = Number(m[1]) as 10 | 8
  return r
}

/** 見出しのある行(税率・対象・税・合計など)では、¥ の無い数値も金額として読む */
const LOOSE_LINE_RE = /(%|対象|税|合計|小計|総額|金額|計\b|計\s|計$|請求|支払|料金|運賃)/

/** 1行を「見出し + 金額」の組に分ける */
export function moneySegments(line: string, loose?: boolean): MoneySegment[] {
  const s = fixSeparators(line)
  const tokens = moneyTokens(s, loose ?? LOOSE_LINE_RE.test(s))
  const out: MoneySegment[] = []
  let prevEnd = 0
  for (const t of tokens) {
    let label = s.slice(prevEnd, t.index).trim()
    // 金額の前に見出しが無い(「¥1,100 合計」のような書き方)ときは、後ろの文字を見出しにする
    if (!/[^\s()()\-:¥,.]/.test(label)) {
      const next = tokens[tokens.indexOf(t) + 1]
      const after = s.slice(t.end, next ? next.index : s.length).trim()
      if (/[぀-ヿ一-鿿]/.test(after) && out.length === 0) label = after
    }
    const rate = lastRate(label) ?? lastRate(s.slice(0, t.index)) ?? (tokens.length === 1 ? lastRate(s.slice(t.end)) : null)
    out.push({ ...t, label, rate })
    prevEnd = t.end
  }
  return out
}
