import { describe, expect, it } from 'vitest'
import { connectedComponents, findTextLines } from './textlines'

function drawBoxes(w: number, h: number, boxes: [number, number, number, number][]) {
  const bin = new Uint8Array(w * h)
  for (const [x, y, bw, bh] of boxes) {
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) bin[yy * w + xx] = 1
  }
  return bin
}

describe('textlines', () => {
  it('finds a row of 14 similar glyphs', () => {
    const boxes: [number, number, number, number][] = []
    for (let i = 0; i < 14; i++) boxes.push([10 + i * 14, 20, 9, 16])
    // ノイズ
    boxes.push([5, 80, 60, 3])
    const bin = drawBoxes(260, 100, boxes)
    const cc = connectedComponents(bin, 260, 100)
    expect(cc.length).toBe(15)
    const lines = findTextLines(cc)
    expect(lines.length).toBe(1)
    expect(lines[0].count).toBe(14)
    expect(lines[0].score).toBeGreaterThan(0.8)
    expect(lines[0].segments.length).toBe(1)
  })
  it('splits segments at wide gaps', () => {
    const boxes: [number, number, number, number][] = []
    for (let i = 0; i < 4; i++) boxes.push([10 + i * 14, 20, 12, 16])
    for (let i = 0; i < 14; i++) boxes.push([100 + i * 12, 20, 9, 16])
    const bin = drawBoxes(300, 60, boxes)
    const lines = findTextLines(connectedComponents(bin, 300, 60), { minChars: 8 })
    expect(lines[0].segments.map((s) => s.count)).toEqual([4, 14])
  })
})
