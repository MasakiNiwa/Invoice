/**
 * 1枚の画像に写った複数の書類(領収書など)を見つける。
 *
 * 文字行の検出枠を「近さ」と「向き」でまとめる(クラスタリング)。
 * - 隙間が文字の高さの約2.5倍以内の枠どうしを同じ書類とみなす
 * - 細長い枠の向き(横書きの行 / 90°倒れた行)が違うものはつなげない(横向きに置かれた領収書を分ける)
 * - 行数の少ない小さな塊(ロゴ・印影など)は近くの書類に吸収する
 */
import type { Rect } from './image'

export interface DocCluster {
  rect: Rect
  boxes: Rect[]
  /** 行の大半が縦長(=書類が90°倒れている) */
  vertical: boolean
  /** 文字の高さの中央値 */
  textH: number
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)
const union = (rs: Rect[]): Rect => {
  const x0 = Math.min(...rs.map((r) => r.x))
  const y0 = Math.min(...rs.map((r) => r.y))
  const x1 = Math.max(...rs.map((r) => r.x + r.w))
  const y1 = Math.max(...rs.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
const gapBetween = (a: Rect, b: Rect) => {
  const gx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w))
  const gy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
  return Math.hypot(gx, gy)
}
/** 枠の向き: 'h' 横長, 'v' 縦長, 'n' どちらでもない(1文字など) */
const orient = (r: Rect): 'h' | 'v' | 'n' => (r.w > r.h * 2 ? 'h' : r.h > r.w * 2 ? 'v' : 'n')

/**
 * @param separated 2つの領域の間に紙の縁(明るさの段差)があるか。あれば別の書類とみなす(省略可)
 */
export function clusterBoxes(input: Rect[], linkFactor = 2.2, separated?: (a: Rect, b: Rect) => boolean): DocCluster[] {
  const boxes = input.filter((r) => r.w > 2 && r.h > 2)
  const n = boxes.length
  if (n === 0) return []
  // 文字の高さ: 細長い枠(行)の短辺の下位25%。傾いた行は枠が太るので、中央値より下を使う
  const lineHs = boxes.filter((b) => Math.max(b.w, b.h) > Math.min(b.w, b.h) * 2.5).map((b) => Math.min(b.w, b.h)).sort((a, b) => a - b)
  const globalH = lineHs.length >= 3 ? lineHs[Math.floor(lineHs.length * 0.25)] : median(boxes.map((b) => Math.min(b.w, b.h)))
  const parent = boxes.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < n; i++) {
    const a = boxes[i]
    const ta = Math.min(a.w, a.h, globalH)
    for (let j = i + 1; j < n; j++) {
      const b = boxes[j]
      const oa = orient(a)
      const ob = orient(b)
      if (oa !== 'n' && ob !== 'n' && oa !== ob) continue
      const tb = Math.min(b.w, b.h, globalH)
      if (gapBetween(a, b) <= linkFactor * Math.min(ta, tb)) {
        const ra = find(i)
        const rb = find(j)
        if (ra !== rb) parent[ra] = rb
      }
    }
  }
  const groups = new Map<number, Rect[]>()
  boxes.forEach((b, i) => {
    const r = find(i)
    ;(groups.get(r) ?? groups.set(r, []).get(r)!).push(b)
  })
  let clusters = [...groups.values()].map(toCluster)

  // 小さな塊(ロゴ・印影・ちぎれた行)を近くの大きな塊に吸収
  const maxLines = Math.max(...clusters.map((c) => c.boxes.length))
  const big = clusters.filter((c) => c.boxes.length >= 4 && c.boxes.length >= maxLines * 0.15)
  if (big.length === 0) return [toCluster(boxes)]
  for (const c of clusters) {
    if (big.includes(c)) continue
    let best = big[0]
    let bestD = Infinity
    for (const b of big) {
      const d = gapBetween(c.rect, b.rect)
      if (d < bestD) {
        bestD = d
        best = b
      }
    }
    best.boxes.push(...c.boxes)
  }
  clusters = big.map((c) => toCluster(c.boxes))

  // 同じ向きで隣り合う塊は、間に紙の縁が無ければ同じ書類(レシートの途中の大きな余白で切れたもの)
  for (let again = true; again; ) {
    again = false
    for (let i = 0; i < clusters.length && !again; i++) {
      for (let j = i + 1; j < clusters.length && !again; j++) {
        const A = clusters[i]
        const B = clusters[j]
        if (A.vertical !== B.vertical) continue
        const a = A.rect
        const b = B.rect
        // 行の向きに沿った方向の重なり(横書きなら横方向)と、それと直交する方向の隙間
        const overlap = A.vertical
          ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
          : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const narrower = A.vertical ? Math.min(a.h, b.h) : Math.min(a.w, b.w)
        const gap = A.vertical ? Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)) : Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h))
        // (同じ向きの書類どうしを誤ってまとめても、後の段階で表題・登録番号ごとに分けられるので、広めにまとめてよい)
        if (overlap < narrower * 0.5 || gap > globalH * 8) continue
        if (separated?.(a, b)) continue
        clusters[i] = toCluster([...A.boxes, ...B.boxes])
        clusters.splice(j, 1)
        again = true
      }
    }
  }

  // 枠が大きく重なる塊はまとめる
  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < clusters.length && !merged; i++) {
      for (let j = i + 1; j < clusters.length && !merged; j++) {
        const a = clusters[i].rect
        const b = clusters[j].rect
        const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ix > 0 && iy > 0 && ix * iy > Math.min(a.w * a.h, b.w * b.h) * 0.3) {
          clusters[i] = toCluster([...clusters[i].boxes, ...clusters[j].boxes])
          clusters.splice(j, 1)
          merged = true
        }
      }
    }
  }
  return clusters.sort((a, b) => (Math.abs(a.rect.y - b.rect.y) > Math.min(a.rect.h, b.rect.h) * 0.5 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x))
}

function toCluster(boxes: Rect[]): DocCluster {
  const v = boxes.filter((b) => orient(b) === 'v').length
  const h = boxes.filter((b) => orient(b) === 'h').length
  return { rect: union(boxes), boxes, vertical: v > h, textH: median(boxes.map((b) => Math.min(b.w, b.h))) }
}
