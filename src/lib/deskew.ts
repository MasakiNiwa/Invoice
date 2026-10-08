import { connectedComponents } from './textlines'
/**
 * 傾き補正(投影プロファイル法)。
 * 文字の画素を少しずつ回転させながら水平方向に投影し、行と行間のメリハリ(投影の変化の二乗和)が
 * 最大になる角度を傾きとする。粗く(1°)探してから細かく(0.2°)詰める。
 */

/**
 * 文字らしい大きさの連結成分だけを残した二値画像にする。
 * 写真の背景(机・影)や紙の縁のような大きな塊は、傾きの推定を狂わせるので除く。
 */
export function keepTextLikeComponents(bin: Uint8Array, w: number, h: number): Uint8Array {
  const comps = connectedComponents(bin, w, h)
  const hs = comps.filter((c) => c.h >= 3 && c.w >= 1 && c.h < h / 8).map((c) => c.h).sort((a, b) => a - b)
  const medH = hs[Math.floor(hs.length / 2)] || 10
  const out = new Uint8Array(bin.length)
  for (const c of comps) {
    // 文字の高さの 0.4〜3倍、幅は高さの 4倍まで(罫線・紙の縁・背景の塊を除く)
    if (c.h < Math.max(3, medH * 0.4) || c.h > medH * 3 || c.w > c.h * 4 || c.w > w / 6) continue
    // 塗りつぶされた大きな四角(背景)も除く
    if (c.area > c.w * c.h * 0.9 && c.w * c.h > medH * medH * 2) continue
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) if (bin[y * w + x]) out[y * w + x] = 1
  }
  return out
}

/** 二値画像(1=インク)から、計算用に間引いたインク画素の座標を取る */
export function inkPoints(bin: Uint8Array, w: number, h: number, maxPoints = 40000): { xs: Float32Array; ys: Float32Array } {
  let n = 0
  for (let i = 0; i < bin.length; i++) n += bin[i]
  const step = Math.max(1, Math.ceil(n / maxPoints))
  const xs: number[] = []
  const ys: number[] = []
  let k = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue
      if (k++ % step) continue
      xs.push(x - w / 2)
      ys.push(y - h / 2)
    }
  }
  return { xs: Float32Array.from(xs), ys: Float32Array.from(ys) }
}

/** その角度で回転したときの水平投影のメリハリ */
export function profileScore(xs: Float32Array, ys: Float32Array, deg: number, h: number): number {
  const t = (deg * Math.PI) / 180
  const s = Math.sin(t)
  const c = Math.cos(t)
  const bins = Math.ceil(h * 1.5) + 4
  const off = bins / 2
  const hist = new Float32Array(bins)
  for (let i = 0; i < xs.length; i++) {
    const y = -xs[i] * s + ys[i] * c + off
    const b = y | 0
    if (b >= 0 && b < bins) hist[b]++
  }
  let score = 0
  for (let i = 1; i < bins; i++) {
    const d = hist[i] - hist[i - 1]
    score += d * d
  }
  return score
}

/**
 * 文字の行の傾き(度、画像座標で時計回りが正)を推定する。まっすぐにするには -angle だけ回転する。
 * @param range 探す範囲(±度)
 */
export function estimateSkew(bin: Uint8Array, w: number, h: number, range = 20): { angle: number; confidence: number } {
  const { xs, ys } = inkPoints(keepTextLikeComponents(bin, w, h), w, h)
  if (xs.length < 200) return { angle: 0, confidence: 0 }
  const scores: { a: number; s: number }[] = []
  for (let a = -range; a <= range; a += 1) scores.push({ a, s: profileScore(xs, ys, a, h) })
  scores.sort((p, q) => q.s - p.s)
  let best = scores[0]
  for (let a = best.a - 1; a <= best.a + 1 + 1e-6; a += 0.2) {
    const s = profileScore(xs, ys, a, h)
    if (s > best.s) best = { a, s }
  }
  // 信頼度: 最良と 0° の差(はっきり傾いているほど大きい)、および最良と中央値の比
  const sorted = scores.map((x) => x.s).sort((p, q) => p - q)
  const median = sorted[Math.floor(sorted.length / 2)] || 1
  const confidence = Math.min(1, (best.s / median - 1) / 2)
  return { angle: Math.round(best.a * 10) / 10, confidence }
}
