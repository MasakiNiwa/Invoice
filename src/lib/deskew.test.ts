import { describe, expect, it } from 'vitest'
import { estimateSkew } from './deskew'

/** 傾いた「文字の行」を模した二値画像 */
function lines(w: number, h: number, deg: number): Uint8Array {
  const bin = new Uint8Array(w * h)
  const t = (deg * Math.PI) / 180
  for (let row = 0; row < 12; row++) {
    const y0 = 40 + row * 30
    for (let x = 30; x < w - 30; x++) {
      if ((x >> 3) % 3 === 0) continue // 文字の切れ目
      for (let dy = 0; dy < 12; dy++) {
        // 中心を軸に回転
        const cx = x - w / 2
        const cy = y0 + dy - h / 2
        const rx = Math.round(cx * Math.cos(t) - cy * Math.sin(t) + w / 2)
        const ry = Math.round(cx * Math.sin(t) + cy * Math.cos(t) + h / 2)
        if (rx >= 0 && rx < w && ry >= 0 && ry < h) bin[ry * w + rx] = 1
      }
    }
  }
  return bin
}

describe('estimateSkew', () => {
  for (const deg of [0, 3, -7.5, 12]) {
    it(`detects ${deg}°`, () => {
      const r = estimateSkew(lines(500, 440, deg), 500, 440)
      expect(Math.abs(r.angle - deg)).toBeLessThanOrEqual(0.5)
    })
  }
})
