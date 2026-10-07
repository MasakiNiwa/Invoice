/**
 * 適格請求書発行事業者の登録番号(T番号)に関する純粋関数群。
 *
 * 形式: "T" + 13桁。先頭1桁がチェックディジット(法人番号と同じ計算方式)。
 *   検査用数字 = 9 - ( Σ(n=1..12) Pn × Qn  mod 9 )
 *   Pn: 基礎番号(12桁)の最下位から n 桁目の数字, Qn: n が奇数→1, 偶数→2
 */

/** 13桁の数字列のチェックディジットを計算する(base12 は12桁)。 */
export function computeCheckDigit(base12: string): number {
  if (!/^\d{12}$/.test(base12)) throw new Error('base must be 12 digits')
  let sum = 0
  for (let n = 1; n <= 12; n++) {
    const p = base12.charCodeAt(12 - n) - 48
    sum += p * (n % 2 === 1 ? 1 : 2)
  }
  return 9 - (sum % 9)
}

/** 13桁の数字列がチェックディジット的に正しいか。 */
export function isValidDigits(digits13: string): boolean {
  if (!/^\d{13}$/.test(digits13)) return false
  return computeCheckDigit(digits13.slice(1)) === digits13.charCodeAt(0) - 48
}

/** 全角英数字・各種ハイフン・空白などを半角に寄せる。 */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑‒–—―−ーｰ－﹣]/g, '-')
    .replace(/[　]/g, ' ')
}

/**
 * OCRで数字と取り違えやすい文字の対応表(数字文脈でのみ使用)。
 * 例: O→0, I/l/|→1, Z→2, S→5, B→8, G→6, q→9
 */
const DIGIT_LOOKALIKE: Record<string, string> = {
  O: '0', o: '0', D: '0', Q: '0', U: '0', '〇': '0', '○': '0',
  I: '1', l: '1', i: '1', '|': '1', '!': '1', ']': '1', '[': '1', J: '1',
  Z: '2', z: '2',
  E: '3',
  A: '4', h: '4',
  S: '5', s: '5', '$': '5',
  G: '6', b: '6',
  '?': '7',
  B: '8', '&': '8',
  g: '9', q: '9',
}

/** "T"と取り違えやすい文字 */
const T_LOOKALIKE = new Set(['T', 't', '7', 'Τ', 'т', '丁', '十', 'ｒ', 'Ｔ', '┬', '†', 'Y', 'f'])

export interface ExtractedNumber {
  /** 13桁の数字 */
  digits: string
  /** 直前に T(または T らしい文字)があったか */
  hasT: boolean
  /** チェックディジット一致 */
  valid: boolean
  /** 元テキスト中の開始/終了位置(正規化後テキスト基準) */
  start: number
  end: number
  /** 数字の取り違え補正を行った文字数 */
  substitutions: number
  /** 抽出元の生テキスト */
  raw: string
}

/**
 * 任意のテキストから T番号らしい13桁を抽出する。
 * - 区切り(空白・ハイフン・ドット・コロン)を許容
 * - 数字に似た英字は補正(補正数を記録)
 * - "登録番号" 等のキーワード直後なら T が欠けていても拾う
 */
export function extractTNumbers(text: string): ExtractedNumber[] {
  const s = toHalfWidth(text)
  const results: ExtractedNumber[] = []
  const seen = new Set<string>()
  const isSep = (c: string) => c === ' ' || c === '-' || c === '.' || c === '_' || c === '･' || c === '・'

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const isDigit = c >= '0' && c <= '9'
    const tLike = T_LOOKALIKE.has(c)
    if (!isDigit && !tLike && !(c in DIGIT_LOOKALIKE)) continue
    // 直前が数字なら、数字列の途中なのでスキップ(開始位置のみ見る)
    const prev = s[i - 1]
    if (prev && prev >= '0' && prev <= '9') continue
    // 直前が T らしい文字なら、その位置から既に読んでいる
    if (prev && T_LOOKALIKE.has(prev) && isDigit) continue

    // T接頭辞の判定: T らしい文字 + (区切り/コロン)* + 数字列
    let j = i
    let hasT = false
    if (tLike && c !== '7') {
      hasT = true
      j = i + 1
    } else if (c === '7') {
      // "7" + 13桁 の場合だけ T の誤認とみなす(後で判定)
    }
    while (j < s.length && (isSep(s[j]) || s[j] === ':' || s[j] === '：')) j++

    const tryRead = (from: number): { digits: string; end: number; subs: number } => {
      let digits = ''
      let subs = 0
      let k = from
      let sepRun = 0
      while (k < s.length && digits.length < 14) {
        const ch = s[k]
        if (ch >= '0' && ch <= '9') {
          digits += ch
          sepRun = 0
        } else if (ch in DIGIT_LOOKALIKE && digits.length > 0) {
          // 先頭以外の英字は数字文脈なら補正。ただし連続英字(単語)は不可
          const next = s[k + 1]
          const nextIsDigitish = next !== undefined && ((next >= '0' && next <= '9') || isSep(next) || next in DIGIT_LOOKALIKE)
          if (!nextIsDigitish && digits.length < 12) break
          digits += DIGIT_LOOKALIKE[ch]
          subs++
          sepRun = 0
        } else if (isSep(ch) && digits.length > 0) {
          sepRun++
          if (sepRun > 2) break
        } else {
          break
        }
        k++
      }
      return { digits, end: k, subs }
    }

    let read = tryRead(j)
    if (!hasT && (c === '7' || c === '1' || c === 'I' || c === 'l' || c === '|')) {
      // "7"/"1" + 13桁(計14桁)なら、先頭は T の誤読とみなす(T の横棒が欠けると 1、斜めに読むと 7 になりやすい)
      const alt = tryRead(i + 1)
      if (alt.digits.length === 13 && read.digits.length !== 13) {
        hasT = true
        read = { ...alt, subs: alt.subs + (c === '7' ? 0 : 1) }
      }
    }
    if (hasT && read.digits.length === 14 && (read.digits[0] === '1' || read.digits[0] === '7')) {
      // "T" 1文字が "T1"/"T7" と二重に読まれたケース: 先頭の 1/7 を捨てる
      const alt = tryRead(j + 1)
      if (alt.digits.length === 13 && isValidDigits(alt.digits)) read = { ...alt, subs: alt.subs + 1 }
    }
    if (read.digits.length !== 13) continue
    if (read.subs > 3) continue

    // キーワード文脈(登録番号/適格 等)が直前にあれば T 欠落を許容
    if (!hasT) {
      const before = s.slice(Math.max(0, i - 12), i)
      if (/(登録|番号|適格|インボイス|事業者|No|NO|no)/.test(before)) {
        // keep hasT=false but allowed
      } else if (read.subs > 0) {
        continue
      }
    }

    const key = `${read.digits}@${i}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({
      digits: read.digits,
      hasT,
      valid: isValidDigits(read.digits),
      start: i,
      end: read.end,
      substitutions: read.subs,
      raw: s.slice(i, read.end),
    })
  }
  return results
}

/** 数字の誤認しやすいペア(双方向) */
export const CONFUSABLE_DIGITS: Record<string, string[]> = {
  '0': ['8', '6', '9', '3'],
  '1': ['7', '4'],
  '2': ['7', '3'],
  '3': ['8', '5', '9', '2'],
  '4': ['1', '9'],
  '5': ['6', '3', '8'],
  '6': ['5', '8', '0'],
  '7': ['1', '2'],
  '8': ['3', '6', '0', '9', '5'],
  '9': ['8', '0', '4', '3'],
}

export interface CorrectionCandidate {
  digits: string
  position: number
  from: string
  to: string
}

/**
 * 検算NGの番号に対し、誤認しやすい1桁置換で検算OKになる候補を列挙する。
 * lowConfidencePositions を与えると、その桁を優先(他の桁は除外)する。
 */
export function suggestCorrections(digits13: string, lowConfidencePositions?: number[]): CorrectionCandidate[] {
  if (!/^\d{13}$/.test(digits13) || isValidDigits(digits13)) return []
  const positions = lowConfidencePositions && lowConfidencePositions.length > 0
    ? lowConfidencePositions
    : Array.from({ length: 13 }, (_, i) => i)
  const out: CorrectionCandidate[] = []
  for (const pos of positions) {
    const from = digits13[pos]
    for (const to of CONFUSABLE_DIGITS[from] ?? []) {
      const d = digits13.slice(0, pos) + to + digits13.slice(pos + 1)
      if (isValidDigits(d)) out.push({ digits: d, position: pos, from, to })
    }
  }
  return out
}

/** JAN(EAN-13)コードとして正しいか(商品コードとの取り違え判定用) */
export function isValidEan13(digits13: string): boolean {
  if (!/^\d{13}$/.test(digits13)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += (digits13.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10 === digits13.charCodeAt(12) - 48
}

/** 表示用: T1234-5678-9012-3 */
export function formatTNumber(digits13: string): string {
  if (!/^\d{13}$/.test(digits13)) return `T${digits13}`
  return `T${digits13.slice(0, 1)} ${digits13.slice(1, 5)} ${digits13.slice(5, 9)} ${digits13.slice(9, 13)}`
}

/** 手入力文字列を解析(T有無・区切り・全角を許容)。 */
export function parseManualInput(input: string): { digits: string | null; valid: boolean; expectedCheckDigit: number | null; message: string } {
  const s = toHalfWidth(input).replace(/[\s\-.:：]/g, '').replace(/^[Tt]/, '')
  if (s.length === 0) return { digits: null, valid: false, expectedCheckDigit: null, message: '' }
  if (!/^\d+$/.test(s)) return { digits: null, valid: false, expectedCheckDigit: null, message: '数字以外の文字が含まれています' }
  if (s.length !== 13) return { digits: null, valid: false, expectedCheckDigit: null, message: `13桁必要です(現在 ${s.length} 桁)` }
  const expected = computeCheckDigit(s.slice(1))
  const valid = expected === Number(s[0])
  return {
    digits: s,
    valid,
    expectedCheckDigit: expected,
    message: valid ? 'チェックディジット一致' : `チェックディジット不一致(先頭は ${expected} のはず)`,
  }
}
