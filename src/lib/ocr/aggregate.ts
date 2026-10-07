/** 読み取り結果(reading)を候補(candidate)に集計する。純粋関数。 */
import type { Rect } from '../image'
import { overlapRatio } from '../image'
import { isValidDigits, isValidEan13, suggestCorrections } from '../tnumber'

export type StageId = 'pdf' | 'layout' | 'anchor' | 'textline' | 'tile'

export const STAGE_LABEL: Record<StageId, string> = {
  pdf: 'PDFテキスト層',
  layout: '全体レイアウト解析',
  anchor: 'アンカー周辺精査',
  textline: '文字列らしさ検出',
  tile: 'タイル走査',
}

const STAGE_WEIGHT: Record<StageId, number> = {
  pdf: 4,
  layout: 1,
  anchor: 1.3,
  textline: 1.15,
  tile: 0.9,
}

export interface Reading {
  digits: string
  hasT: boolean
  valid: boolean
  /** 0..100 */
  conf: number
  stage: StageId
  rect: Rect
  substitutions: number
  raw: string
  /** 補足(前処理・倍率など) */
  detail?: string
  /** 「登録番号」や T のアンカー付近で読めたか */
  context?: boolean
}

export type CandidateKind = 'read' | 'consensus' | 'corrected'

export interface Candidate {
  digits: string
  valid: boolean
  kind: CandidateKind
  score: number
  /** 0..100 の目安 */
  confidence: number
  votes: number
  hasT: boolean
  stages: StageId[]
  rects: Rect[]
  note?: string
  /** アンカー(登録番号・T)付近で読めた */
  context: boolean
  /** T も文脈も無く、JANコードとしても正しい = 商品コードの可能性 */
  likelyJan: boolean
}

/** T番号として有力か(T付き or 登録番号の近く、かつ商品コードらしくない) */
export function isPrimary(c: Candidate): boolean {
  return c.valid && (c.hasT || c.context) && !c.likelyJan
}

export function readingWeight(r: Reading): number {
  const conf = Math.max(0.05, Math.min(1, r.conf / 100))
  return conf * (r.hasT ? 1.2 : 0.8) * Math.pow(0.7, r.substitutions) * STAGE_WEIGHT[r.stage]
}

function mergeRects(rects: Rect[], r: Rect) {
  if (!rects.some((x) => overlapRatio(x, r) > 0.6)) rects.push(r)
}

/** 位置ごとの桁多数決 */
function consensusOf(group: Reading[]): string | null {
  const ds = group.filter((r) => r.digits.length === 13)
  if (ds.length < 3) return null
  let out = ''
  for (let i = 0; i < 13; i++) {
    const tally = new Map<string, number>()
    for (const r of ds) tally.set(r.digits[i], (tally.get(r.digits[i]) ?? 0) + readingWeight(r))
    let best = ''
    let bestV = -1
    for (const [d, v] of tally) if (v > bestV) { best = d; bestV = v }
    out += best
  }
  return out
}

export function aggregate(readings: Reading[]): Candidate[] {
  const map = new Map<string, Candidate>()
  const add = (digits: string, kind: CandidateKind, w: number, r: Reading | null, note?: string) => {
    let c = map.get(digits)
    if (!c) {
      c = { digits, valid: isValidDigits(digits), kind, score: 0, confidence: 0, votes: 0, hasT: false, stages: [], rects: [], note, context: false, likelyJan: false }
      map.set(digits, c)
    }
    // read > consensus > corrected の優先で種類を更新
    const rank = { read: 2, consensus: 1, corrected: 0 }
    if (rank[kind] > rank[c.kind]) { c.kind = kind; c.note = note }
    c.score += w
    if (r) {
      if (kind === 'read') c.votes++
      c.hasT ||= r.hasT
      c.context ||= !!r.context
      if (!c.stages.includes(r.stage)) c.stages.push(r.stage)
      mergeRects(c.rects, r.rect)
    }
  }

  for (const r of readings) add(r.digits, 'read', readingWeight(r), r)

  // 位置でグループ化してコンセンサス
  const groups: Reading[][] = []
  for (const r of readings) {
    const g = groups.find((g) => overlapRatio(g[0].rect, r.rect) > 0.5)
    if (g) g.push(r)
    else groups.push([r])
  }
  for (const g of groups) {
    const c = consensusOf(g)
    if (c && isValidDigits(c) && !g.some((r) => r.digits === c)) {
      const w = g.reduce((s, r) => s + readingWeight(r), 0) * 0.5
      add(c, 'consensus', w, { ...g[0], digits: c, hasT: g.some((r) => r.hasT), context: g.some((r) => r.context) }, `${g.length}件の読み取りを桁ごとに多数決`)
    }
  }

  // 検算NGの候補に対する1桁補正(同位置に検算OKの候補が無い場合のみ)
  const validCands = [...map.values()].filter((c) => c.valid)
  for (const c of [...map.values()]) {
    if (c.valid || c.kind !== 'read') continue
    // 補正は T 付き or 文脈ありの読み取りに限る(商品コード等からの誤補正を防ぐ)
    if (!c.hasT && !c.context) continue
    const nearValid = validCands.some((v) => v.rects.some((a) => c.rects.some((b) => overlapRatio(a, b) > 0.3)))
    if (nearValid) continue
    const fixes = suggestCorrections(c.digits)
    if (fixes.length === 0 || fixes.length > 3) continue
    for (const f of fixes) {
      add(f.digits, 'corrected', (c.score * 0.35) / fixes.length, null, `${f.position + 1}桁目 ${f.from}→${f.to} と推定`)
      const nc = map.get(f.digits)!
      nc.hasT ||= c.hasT
      nc.context ||= c.context
      for (const s of c.stages) if (!nc.stages.includes(s)) nc.stages.push(s)
      for (const r of c.rects) mergeRects(nc.rects, r)
    }
  }

  const list = [...map.values()]
  for (const c of list) {
    const base = 1 - Math.exp(-c.score / 1.5)
    let conf = base * 100
    if (!c.valid) conf *= 0.35
    if (c.kind === 'corrected') conf *= 0.5
    c.likelyJan = !c.hasT && !c.context && isValidEan13(c.digits)
    if (!c.hasT && !c.context) conf *= 0.4
    else if (!c.hasT) conf *= 0.85
    if (c.likelyJan) conf *= 0.5
    c.confidence = Math.round(Math.max(1, Math.min(99, conf)))
  }
  return list.sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)) || Number(b.valid) - Number(a.valid) || b.confidence - a.confidence || b.score - a.score)
}

/** 早期終了してよいほど確からしい候補があるか */
export function isConfident(cands: Candidate[]): boolean {
  return cands.some((c) => c.valid && c.kind === 'read' && c.hasT && (c.stages.includes('pdf') || (c.votes >= 3 && c.confidence >= 80)))
}
