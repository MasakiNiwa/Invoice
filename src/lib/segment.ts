/**
 * 1ページ(1枚の画像)に複数のインボイスが含まれる場合の領域分割。
 *
 * 1. XY-cut: 行の位置の投影から、大きな空白の帯(縦または横)で再帰的に分割してブロックを作る
 * 2. 種(シード): 異なる登録番号を含むブロック(2つ以上あるとき)。無ければ「請求書」「領収書」などの表題を含むブロック
 * 3. それ以外のブロックは、同じ列で上にある最も近い種へ(無ければ中心が最も近い種へ)割り当てる
 */
import type { Rect } from './image'
import type { TextRow } from './requirements'
import { normalizeRow, repairKeywords } from './requirements'

export interface InvoiceSegment {
  index: number
  rect: Rect
  rows: TextRow[]
  /** この領域の登録番号(13桁) */
  digits: string | null
}

export interface TNumberLocation {
  digits: string
  rect: Rect
}

const TITLE_RE = /(御?請求書|領収書|領収証|納品書|レシート|請求明細|Invoice|INVOICE|RECEIPT)/

const union = (rs: Rect[]): Rect => {
  const x0 = Math.min(...rs.map((r) => r.x))
  const y0 = Math.min(...rs.map((r) => r.y))
  const x1 = Math.max(...rs.map((r) => r.x + r.w))
  const y1 = Math.max(...rs.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

/** 投影の空白区間のうち最大のもの [開始, 終了] */
function largestGap(spans: [number, number][], lo: number, hi: number): [number, number] | null {
  const s = [...spans].sort((a, b) => a[0] - b[0])
  let cur = lo
  let best: [number, number] | null = null
  for (const [a, b] of s) {
    if (a > cur && (!best || a - cur > best[1] - best[0])) best = [cur, a]
    cur = Math.max(cur, b)
  }
  void hi
  // 端の余白は分割に使わない(内側の空白だけ)
  if (best && best[0] === lo) return null
  return best
}

/** XY-cut で行をブロックに分ける */
export function xyCut(rows: TextRow[], rowH: number, pageW: number): TextRow[][] {
  const out: TextRow[][] = []
  const rec = (rs: TextRow[], depth: number) => {
    if (rs.length <= 1 || depth > 12) {
      if (rs.length) out.push(rs)
      return
    }
    const box = union(rs.map((r) => r.rect))
    const yGap = largestGap(rs.map((r) => [r.rect.y, r.rect.y + r.rect.h]), box.y, box.y + box.h)
    const xGap = largestGap(rs.map((r) => [r.rect.x, r.rect.x + r.rect.w]), box.x, box.x + box.w)
    const yScore = yGap ? (yGap[1] - yGap[0]) / (rowH * 2.5) : 0
    const xScore = xGap ? (xGap[1] - xGap[0]) / Math.max(rowH * 3, pageW * 0.04) : 0
    if (yScore < 1 && xScore < 1) {
      out.push(rs)
      return
    }
    if (xScore >= yScore && xGap) {
      const mid = (xGap[0] + xGap[1]) / 2
      rec(rs.filter((r) => center(r.rect).x < mid), depth + 1)
      rec(rs.filter((r) => center(r.rect).x >= mid), depth + 1)
    } else if (yGap) {
      const mid = (yGap[0] + yGap[1]) / 2
      rec(rs.filter((r) => center(r.rect).y < mid), depth + 1)
      rec(rs.filter((r) => center(r.rect).y >= mid), depth + 1)
    }
  }
  rec(rows, 0)
  return out
}

export function segmentInvoices(rows: TextRow[], tNumbers: TNumberLocation[], pageW: number, pageH: number): InvoiceSegment[] {
  const whole = (): InvoiceSegment[] => [
    { index: 0, rect: rows.length ? union(rows.map((r) => r.rect)) : { x: 0, y: 0, w: pageW, h: pageH }, rows, digits: tNumbers[0]?.digits ?? null },
  ]
  const distinct = [...new Map(tNumbers.map((t) => [t.digits, t])).values()]
  // 表題は単独の短い行(「※この請求書は…」のような文中の語は除く)
  const titleRows = rows.filter((r) => {
    const t = repairKeywords(normalizeRow(r.text)).replace(/\s/g, '')
    return t.length <= 10 && TITLE_RE.test(t)
  })
  if (rows.length < 4 || (distinct.length <= 1 && titleRows.length <= 1)) return whole()

  const rowH = median(rows.map((r) => r.rect.h)) || 20
  const blocks = xyCut(rows, rowH, pageW).map((rs) => ({ rows: rs, rect: union(rs.map((r) => r.rect)) }))
  if (blocks.length <= 1) return whole()

  // 種: 登録番号が2種類以上ならそれぞれの番号、そうでなければ表題
  type Seed = { key: string; digits: string | null; blocks: number[] }
  const seeds: Seed[] = []
  const blockOf = (p: { x: number; y: number }) => blocks.findIndex((b) => inside(p, b.rect))
  if (distinct.length >= 2) {
    for (const t of tNumbers) {
      const bi = blockOf(center(t.rect))
      if (bi < 0) continue
      let s = seeds.find((x) => x.digits === t.digits)
      if (!s) seeds.push((s = { key: t.digits, digits: t.digits, blocks: [] }))
      if (!s.blocks.includes(bi)) s.blocks.push(bi)
    }
  } else {
    titleRows.forEach((r, i) => {
      const bi = blockOf(center(r.rect))
      if (bi >= 0 && !seeds.some((s) => s.blocks.includes(bi))) seeds.push({ key: `title${i}`, digits: null, blocks: [bi] })
    })
  }
  if (seeds.length <= 1) return whole()

  // 残りのブロックを割り当てる
  const owner = new Map<number, number>()
  seeds.forEach((s, si) => s.blocks.forEach((b) => owner.set(b, si)))
  // 種の領域(同じ列の判定用)
  const seedRect = (si: number) => union(seeds[si].blocks.map((b) => blocks[b].rect))
  blocks.forEach((b, bi) => {
    if (owner.has(bi)) return
    const c = center(b.rect)
    let best = -1
    let bestD = Infinity
    seeds.forEach((_, si) => {
      const sr = seedRect(si)
      const overlap = Math.min(sr.x + sr.w, b.rect.x + b.rect.w) - Math.max(sr.x, b.rect.x)
      const sameCol = overlap > Math.min(sr.w, b.rect.w) * 0.3
      const above = sr.y <= b.rect.y + rowH
      const sc = center(sr)
      // 同じ列・上にある種を強く優先
      const d = Math.hypot(sc.x - c.x, sc.y - c.y) * (sameCol ? (above ? 0.3 : 0.7) : 1.5)
      if (d < bestD) {
        bestD = d
        best = si
      }
    })
    owner.set(bi, best)
  })
  // 種に表題も無く、登録番号の無い種への割り当てだけが残った場合も含めて領域をまとめる
  const segs: InvoiceSegment[] = seeds.map((s, si) => {
    const bs = blocks.filter((_, bi) => owner.get(bi) === si)
    const rs = bs.flatMap((b) => b.rows).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    const digits = s.digits ?? tNumbers.find((t) => bs.some((b) => inside(center(t.rect), b.rect)))?.digits ?? null
    return { index: si, rect: union(bs.map((b) => b.rect)), rows: rs, digits }
  })
  // 上から、左から順に番号を振る
  segs.sort((a, b) => (Math.abs(a.rect.y - b.rect.y) > rowH * 3 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x))
  segs.forEach((s, i) => (s.index = i))
  return segs
}
