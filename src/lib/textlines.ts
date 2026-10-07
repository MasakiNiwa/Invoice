/**
 * 連結成分解析による「文字列らしい領域」の検出。
 *
 * 発想: T番号は「同じくらいの大きさの文字が、ほぼ等間隔に横へ 13〜20 個並ぶ」。
 * 二値化画像の連結成分(≒1文字)を求め、高さが近く、ベースラインが揃い、
 * 間隔が文字高程度の成分を連鎖させて行候補とする。
 */
import type { Rect } from './image'

export interface Component extends Rect {
  area: number
}

export interface TextLine extends Rect {
  /** 構成する成分数 */
  count: number
  /** 推定文字高 */
  charHeight: number
  /** T番号らしさ(0..1) */
  score: number
  /** 文字間の大きな隙間(文字高の0.8倍超)で区切った部分。「登録番号  T1234…」の番号部分だけを取り出すのに使う */
  segments: { x: number; w: number; count: number }[]
}

/** 二値画像(1=黒)から連結成分(8近傍)を抽出。union-find。 */
export function connectedComponents(bin: Uint8Array, w: number, h: number): Component[] {
  const labels = new Int32Array(w * h)
  const parent: number[] = [0]
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  let next = 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!bin[i]) continue
      const n: number[] = []
      if (x > 0 && labels[i - 1]) n.push(labels[i - 1])
      if (y > 0) {
        const up = i - w
        if (labels[up]) n.push(labels[up])
        if (x > 0 && labels[up - 1]) n.push(labels[up - 1])
        if (x < w - 1 && labels[up + 1]) n.push(labels[up + 1])
      }
      if (n.length === 0) {
        parent.push(next)
        labels[i] = next++
      } else {
        let m = n[0]
        for (const v of n) if (v < m) m = v
        labels[i] = m
        for (const v of n) if (v !== m) union(m, v)
      }
    }
  }
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; area: number }>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x]
      if (!l) continue
      const r = find(l)
      const b = boxes.get(r)
      if (!b) boxes.set(r, { x0: x, y0: y, x1: x, y1: y, area: 1 })
      else {
        if (x < b.x0) b.x0 = x
        if (x > b.x1) b.x1 = x
        if (y < b.y0) b.y0 = y
        if (y > b.y1) b.y1 = y
        b.area++
      }
    }
  }
  return [...boxes.values()].map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area }))
}

export interface LineOptions {
  minChars?: number
  maxChars?: number
  minCharHeight?: number
  maxCharHeight?: number
}

/**
 * 成分を横方向に連鎖させて文字列候補を作る。
 * 数字は縦長(幅 ≦ 高さ×1.1)・高さが揃う・間隔が狭い、という特徴を使う。
 */
export function findTextLines(components: Component[], opts: LineOptions = {}): TextLine[] {
  const minChars = opts.minChars ?? 10
  const maxChars = opts.maxChars ?? 24
  const minH = opts.minCharHeight ?? 6
  const maxH = opts.maxCharHeight ?? 200

  // 文字らしい成分だけ残す
  const cs = components
    .filter((c) => c.h >= minH && c.h <= maxH && c.w <= c.h * 1.6 && c.w >= 1 && c.area >= 4)
    .sort((a, b) => a.x - b.x)

  const used = new Uint8Array(cs.length)
  const lines: TextLine[] = []

  for (let i = 0; i < cs.length; i++) {
    if (used[i]) continue
    const chain = [i]
    let last = cs[i]
    let sumH = last.h
    // 右方向へ貪欲に連鎖
    for (let j = i + 1; j < cs.length; j++) {
      if (used[j]) continue
      const c = cs[j]
      const avgH = sumH / chain.length
      const gap = c.x - (last.x + last.w)
      if (gap > avgH * 3) {
        // x ソートなので、これ以上離れたものは全部遠い可能性が高いが、別の行の成分が挟まるので継続判定
        if (c.x - (last.x + last.w) > avgH * 6) break
        continue
      }
      if (gap < -avgH * 0.3) continue
      const hRatio = c.h / avgH
      if (hRatio < 0.6 || hRatio > 1.5) continue
      // ベースライン(下端)と中心の揃い
      const bottomDiff = Math.abs(c.y + c.h - (last.y + last.h))
      const centerDiff = Math.abs(c.y + c.h / 2 - (last.y + last.h / 2))
      if (bottomDiff > avgH * 0.35 && centerDiff > avgH * 0.35) continue
      chain.push(j)
      last = c
      sumH += c.h
      if (chain.length > maxChars * 2) break
    }
    if (chain.length < minChars) continue
    for (const k of chain) used[k] = 1
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const hs: number[] = []
    const gaps: number[] = []
    for (let k = 0; k < chain.length; k++) {
      const c = cs[chain[k]]
      x0 = Math.min(x0, c.x)
      y0 = Math.min(y0, c.y)
      x1 = Math.max(x1, c.x + c.w)
      y1 = Math.max(y1, c.y + c.h)
      hs.push(c.h)
      if (k > 0) {
        const p = cs[chain[k - 1]]
        gaps.push(c.x - (p.x + p.w))
      }
    }
    hs.sort((a, b) => a - b)
    const charHeight = hs[Math.floor(hs.length / 2)]
    const segments: TextLine['segments'] = []
    let segStart = 0
    for (let k = 1; k <= chain.length; k++) {
      const brk = k === chain.length || gaps[k - 1] > charHeight * 0.8
      if (!brk) continue
      const a = cs[chain[segStart]]
      const b = cs[chain[k - 1]]
      segments.push({ x: a.x, w: b.x + b.w - a.x, count: k - segStart })
      segStart = k
    }
    // 高さの揃い具合と個数の T番号らしさ
    const hVar = hs.reduce((s, v) => s + Math.abs(v - charHeight), 0) / hs.length / charHeight
    const n = chain.length
    const countScore = n >= 13 && n <= 20 ? 1 : n > maxChars ? 0.2 : 0.6
    const score = Math.max(0, Math.min(1, countScore * (1 - hVar * 1.5)))
    lines.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, count: n, charHeight, score, segments })
  }
  return lines.sort((a, b) => b.score - a.score)
}

/** グレー画像 → 二値(1=黒)。しきい値は大津法の結果を渡す。 */
export function binarize(gray: Uint8Array, threshold: number, invert = false): Uint8Array {
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) {
    const dark = gray[i] < threshold
    out[i] = (invert ? !dark : dark) ? 1 : 0
  }
  return out
}
