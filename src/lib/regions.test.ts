import { describe, expect, it } from 'vitest'
import { clusterBoxes } from './regions'

/** 横書きの領収書(行の枠を並べる) */
const receipt = (x: number, y: number, n = 10) => Array.from({ length: n }, (_, i) => ({ x: x + (i % 3) * 10, y: y + i * 30, w: 200 + (i % 4) * 20, h: 20 }))
/** 90°倒れた領収書(縦長の枠が横に並ぶ) */
const sideways = (x: number, y: number, n = 10) => Array.from({ length: n }, (_, i) => ({ x: x + i * 30, y: y + (i % 3) * 10, w: 20, h: 200 + (i % 4) * 20 }))

describe('clusterBoxes', () => {
  it('one receipt stays one', () => {
    expect(clusterBoxes(receipt(0, 0))).toHaveLength(1)
  })
  it('two receipts far apart', () => {
    const c = clusterBoxes([...receipt(0, 0), ...receipt(0, 600)])
    expect(c).toHaveLength(2)
  })
  it('upright + sideways receipts touching are separated by orientation', () => {
    const c = clusterBoxes([...receipt(0, 400), ...sideways(0, 0)])
    expect(c).toHaveLength(2)
    expect(c.map((x) => x.vertical)).toEqual([true, false])
  })
  it('a big blank gap inside one receipt is re-joined unless a paper edge separates them', () => {
    const boxes = [...receipt(0, 0, 6), ...receipt(0, 6 * 30 + 150, 6)]
    expect(clusterBoxes(boxes)).toHaveLength(1)
    expect(clusterBoxes(boxes, 2.2, () => true)).toHaveLength(2)
  })
  it('a logo far above is absorbed', () => {
    const c = clusterBoxes([{ x: 50, y: -150, w: 80, h: 60 }, ...receipt(0, 0)])
    expect(c).toHaveLength(1)
  })
})
