/**
 * 書類の検出と正規化(UI スレッド側)。
 * 1. 縮小画像で文字行を検出 → 近さと向きでまとめて書類ごとの領域に分ける(regions.ts)
 * 2. 書類ごとに切り出し、90°単位の向きを直し(文字行の形と読み比べ)、細かな傾きを直す(deskew.ts)
 */
import { binarize } from './textlines'
import { cropRect, downscale, otsuThreshold, rotateCanvas, rotateCanvasDeg, toGray, type Rect } from './image'
import { estimateSkew } from './deskew'
import { clusterBoxes } from './regions'
import type { OcrBackend } from './ocr/engine'
import { detectRotation } from './ocr/pipeline'

export interface FoundDocument {
  /** 元画像での位置 */
  rect: Rect
  /** 正規化(向き・傾き補正)した画像 */
  canvas: HTMLCanvasElement
  /** 90°単位の回転 */
  rotation: 0 | 90 | 180 | 270
  /** 細かな傾き補正の角度(度) */
  skew: number
}

/** 画像に写っている書類の領域を探す(PaddleOCR の文字行検出を使う) */
export async function findDocumentRects(src: HTMLCanvasElement, backend: OcrBackend, signal?: AbortSignal): Promise<Rect[]> {
  const { canvas: small, scale } = downscale(src, 1600)
  const det = await backend.recognize(small, { psm: '11', detectOnly: true }, signal)
  const boxes = det.lines.map((l) => ({ x: l.rect.x / scale, y: l.rect.y / scale, w: l.rect.w / scale, h: l.rect.h / scale }))
  // 紙の縁の判定用: 縮小画像の明るさ
  const g = toGray(small)
  const W = small.width
  const H = small.height
  /** 2つの領域の間の帯に、帯を横切る明るさの段差(紙の縁)があるか */
  const separated = (a: Rect, b: Rect) => {
    const s = (r: Rect) => ({ x0: r.x * scale, y0: r.y * scale, x1: (r.x + r.w) * scale, y1: (r.y + r.h) * scale })
    const A = s(a)
    const B = s(b)
    const horizontalGap = Math.max(A.y0, B.y0) >= Math.min(A.y1, B.y1)
    if (horizontalGap) {
      // 上下に並ぶ: 間の行ごとに、縦方向の明るさの変化が帯の幅の多くで起きていれば縁
      const y0 = Math.floor(Math.min(A.y1, B.y1))
      const y1 = Math.ceil(Math.max(A.y0, B.y0))
      const x0 = Math.max(0, Math.floor(Math.max(A.x0, B.x0)))
      const x1 = Math.min(W - 1, Math.ceil(Math.min(A.x1, B.x1)))
      if (x1 - x0 < 10) return false
      // 紙の縁 = 明るさの「段差」(上下で明るさが違う)。罫線や枠線(両側とも白)は縁とみなさない
      // 両側が一様(文字の無い紙・背景)で、平均の明るさが違うときだけ縁とみなす
      const band = (ya: number, yb: number) => {
        let s = 0
        let s2 = 0
        let n = 0
        for (let y = Math.max(0, ya); y < Math.min(H, yb); y++)
          for (let x = x0; x < x1; x += 2) {
            const v = g[y * W + x]
            s += v
            s2 += v * v
            n++
          }
        const m = n ? s / n : 0
        return { m, sd: n ? Math.sqrt(Math.max(0, s2 / n - m * m)) : 99 }
      }
      for (let y = Math.max(8, y0); y < Math.min(H - 8, y1); y++) {
        const p = band(y - 8, y - 2)
        const q = band(y + 2, y + 8)
        if (p.sd < 10 && q.sd < 10 && Math.abs(p.m - q.m) > 10) return true
      }
      return false
    }
    // 左右に並ぶ
    const x0 = Math.floor(Math.min(A.x1, B.x1))
    const x1 = Math.ceil(Math.max(A.x0, B.x0))
    const y0 = Math.max(0, Math.floor(Math.max(A.y0, B.y0)))
    const y1 = Math.min(H - 1, Math.ceil(Math.min(A.y1, B.y1)))
    if (y1 - y0 < 10) return false
    const band = (xa: number, xb: number) => {
      let s = 0
      let s2 = 0
      let n = 0
      for (let x = Math.max(0, xa); x < Math.min(W, xb); x++)
        for (let y = y0; y < y1; y += 2) {
          const v = g[y * W + x]
          s += v
          s2 += v * v
          n++
        }
      const m = n ? s / n : 0
      return { m, sd: n ? Math.sqrt(Math.max(0, s2 / n - m * m)) : 99 }
    }
    for (let x = Math.max(8, x0); x < Math.min(W - 8, x1); x++) {
      const p = band(x - 8, x - 2)
      const q = band(x + 2, x + 8)
      if (p.sd < 10 && q.sd < 10 && Math.abs(p.m - q.m) > 10) return true
    }
    return false
  }
  const clusters = clusterBoxes(boxes, 2.2, separated)
  ;(globalThis as unknown as { __invoiceDocs?: unknown }).__invoiceDocs = { scale, raw: boxes.map((b) => [b.x, b.y, b.w, b.h].map(Math.round)), boxes: boxes.length, clusters: clusters.map((c) => ({ rect: c.rect, n: c.boxes.length, vertical: c.vertical, textH: c.textH })) }
  return clusters.map((c) => {
    const m = c.textH * 2.5
    return { x: c.rect.x - m, y: c.rect.y - m, w: c.rect.w + m * 2, h: c.rect.h + m * 2 }
  })
}

/**
 * 文字行の検出結果から傾きを求める(背景や紙の縁に影響されない)。
 * 細長い文字行それぞれの傾き(画素の主成分の向き)の中央値。
 */
export async function textLineSkew(src: HTMLCanvasElement, backend: OcrBackend, signal?: AbortSignal): Promise<number | null> {
  const { canvas: small } = downscale(src, 1280)
  const det = await backend.recognize(small, { psm: '11', detectOnly: true }, signal)
  const angles = det.lines
    .filter((l) => (l.elongation ?? 0) > 4 && l.angle !== undefined)
    .map((l) => {
      // 横書きの行として -45°〜45° に寄せる
      let a = l.angle!
      while (a > 45) a -= 90
      while (a <= -45) a += 90
      return a
    })
    .sort((a, b) => a - b)
  if (angles.length < 3) return null
  return angles[Math.floor(angles.length / 2)]
}

/** 細かな傾きを推定して直す(投影プロファイル法。文字行の検出が使えないとき用)。はっきり傾いているときだけ回す */
export function deskew(src: HTMLCanvasElement): { canvas: HTMLCanvasElement; angle: number } {
  const { canvas: small } = downscale(src, 1000)
  const gray = toGray(small)
  const bin = binarize(gray, otsuThreshold(gray))
  const { angle, confidence } = estimateSkew(bin, small.width, small.height, 20)
  if (Math.abs(angle) < 0.4 || confidence < 0.15) return { canvas: src, angle: 0 }
  return { canvas: rotateCanvasDeg(src, -angle), angle }
}

/** ±2° の範囲で残りの傾きを細かく測る(文字らしい成分だけで投影プロファイル) */
function fineSkew(src: HTMLCanvasElement): number {
  const { canvas: small } = downscale(src, 1200)
  const gray = toGray(small)
  const bin = binarize(gray, otsuThreshold(gray))
  const { angle, confidence } = estimateSkew(bin, small.width, small.height, 2)
  return Math.abs(angle) >= 0.3 && confidence > 0.05 ? angle : 0
}

/** 書類を切り出して、向き(90°単位)と傾きを直す */
export async function normalizeDocument(src: HTMLCanvasElement, rect: Rect | null, backend: OcrBackend, signal?: AbortSignal): Promise<FoundDocument> {
  let canvas = rect ? cropRect(src, rect) : src
  const rot = (await detectRotation(canvas, backend, signal)) ?? 0
  if (rot) canvas = rotateCanvas(canvas, rot)
  // 傾き: 文字行の向きから測って回し、残りをもう一度測って直す(大きく傾いていると1回目は浅めに出るため)。
  // 最後に投影プロファイル法で ±2° の範囲を細かく詰める
  const base = canvas
  let skew = 0
  for (let i = 0; i < 2; i++) {
    const s = await textLineSkew(skew ? rotateCanvasDeg(base, -skew) : base, backend, signal).catch(() => null)
    if (s === null) {
      if (i === 0) {
        const d = deskew(base)
        skew = d.angle
      }
      break
    }
    if (Math.abs(s) < 0.4) break
    skew += s
  }
  if (skew) canvas = rotateCanvasDeg(base, -skew)
  const fine = fineSkew(canvas)
  if (fine) {
    skew += fine
    canvas = rotateCanvasDeg(base, -skew)
  }
  skew = Math.round(skew * 10) / 10
  return { rect: rect ?? { x: 0, y: 0, w: src.width, h: src.height }, canvas, rotation: rot, skew }
}

/** 画像から書類を探して、それぞれ正規化する */
export async function findDocuments(src: HTMLCanvasElement, backend: OcrBackend, signal?: AbortSignal): Promise<FoundDocument[]> {
  const rects = await findDocumentRects(src, backend, signal)
  // 書類が1つでも、文字のある範囲に切り出してから傾きを測る(机の木目などの背景に惑わされないように)
  if (rects.length <= 1) return [await normalizeDocument(src, rects[0] ?? null, backend, signal)]
  const out: FoundDocument[] = []
  for (const r of rects) out.push(await normalizeDocument(src, r, backend, signal))
  return out
}

/** 保存しておいた補正(切り出し・90°回転・傾き)を、再描画したページにもう一度かける */
export function applyNormalization(src: HTMLCanvasElement, n: { rect: Rect | null; rotation: 0 | 90 | 180 | 270; skew: number }): HTMLCanvasElement {
  let c = n.rect ? cropRect(src, n.rect) : src
  if (n.rotation) c = rotateCanvas(c, n.rotation)
  if (n.skew) c = rotateCanvasDeg(c, -n.skew)
  return c
}
