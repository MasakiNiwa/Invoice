/** 画像の読み込みと前処理(ブラウザ Canvas ベース)。 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Preprocess = 'gray' | 'binary' | 'binaryInv' | 'contrast'

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D が利用できません')
  return ctx
}

/** 画像ファイル/Blob を Canvas に描画する(EXIFの向きはブラウザ任せ)。最大辺 maxSide に縮小。 */
export async function blobToCanvas(blob: Blob, maxSide = 4000): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const c = createCanvas(bmp.width * scale, bmp.height * scale)
  const ctx = ctx2d(c)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  return c
}

/** Canvas からグレースケール配列を得る。 */
export function toGray(c: HTMLCanvasElement): Uint8Array {
  const { data } = ctx2d(c).getImageData(0, 0, c.width, c.height)
  const g = new Uint8Array(c.width * c.height)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // 透明部分は白扱い
    const a = data[i + 3] / 255
    const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    g[j] = v * a + 255 * (1 - a)
  }
  return g
}

/** 大津の二値化しきい値 */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/** 平均輝度が暗い(白抜き文字の可能性) */
export function isMostlyDark(gray: Uint8Array): boolean {
  let s = 0
  for (let i = 0; i < gray.length; i++) s += gray[i]
  return s / gray.length < 110
}

/** 縮小した Canvas を作る */
export function downscale(src: HTMLCanvasElement, maxSide: number): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height))
  if (scale === 1) return { canvas: src, scale }
  const c = createCanvas(src.width * scale, src.height * scale)
  const ctx = ctx2d(c)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, c.width, c.height)
  return { canvas: c, scale }
}

export function clampRect(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const x2 = Math.min(w, Math.ceil(r.x + r.w))
  const y2 = Math.min(h, Math.ceil(r.y + r.h))
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) }
}

/**
 * 元画像の rect を切り出し、scale 倍に拡大して前処理し、周囲に白余白を付けた Canvas を返す。
 * Tesseract は文字の周りに余白がある方が安定する。
 */
export function cropForOcr(src: HTMLCanvasElement, rect: Rect, scale: number, mode: Preprocess, padding = 16): HTMLCanvasElement {
  const r = clampRect(rect, src.width, src.height)
  const w = Math.max(1, Math.round(r.w * scale))
  const h = Math.max(1, Math.round(r.h * scale))
  const work = createCanvas(w, h)
  const wctx = ctx2d(work)
  wctx.imageSmoothingEnabled = true
  wctx.imageSmoothingQuality = 'high'
  wctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h)

  const img = wctx.getImageData(0, 0, w, h)
  const d = img.data
  const gray = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]

  let invert = mode === 'binaryInv'
  if (mode === 'gray' || mode === 'contrast') {
    // コントラスト伸長(1%〜99%)
    let lo = 0
    let hi = 255
    if (mode === 'contrast') {
      const hist = new Array<number>(256).fill(0)
      for (let i = 0; i < gray.length; i++) hist[gray[i]]++
      let acc = 0
      for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc > gray.length * 0.01) { lo = t; break } }
      acc = 0
      for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc > gray.length * 0.01) { hi = t; break } }
      if (hi - lo < 10) { lo = 0; hi = 255 }
    }
    if (isMostlyDark(gray)) invert = true
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
      let v = ((gray[j] - lo) * 255) / (hi - lo)
      v = Math.max(0, Math.min(255, v))
      if (invert) v = 255 - v
      d[i] = d[i + 1] = d[i + 2] = v
      d[i + 3] = 255
    }
  } else {
    const t = otsuThreshold(gray)
    if (mode === 'binary' && isMostlyDark(gray)) invert = true
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
      let v = gray[j] > t ? 255 : 0
      if (invert) v = 255 - v
      d[i] = d[i + 1] = d[i + 2] = v
      d[i + 3] = 255
    }
  }
  wctx.putImageData(img, 0, 0)

  const out = createCanvas(w + padding * 2, h + padding * 2)
  const octx = ctx2d(out)
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(work, padding, padding)
  return out
}

/** 矩形の重なり率(IoU) */
export function iou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** a と b の重なり面積 / 小さい方の面積 */
export function overlapRatio(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const m = Math.min(a.w * a.h, b.w * b.h)
  return m > 0 ? inter / m : 0
}
