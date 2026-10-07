import { describe, expect, it } from 'vitest'
import { padRect } from './paddle-core'

describe('padRect', () => {
  it('pads isolated lines fully', () => {
    const r = { x: 100, y: 100, w: 200, h: 20 }
    expect(padRect(r, [r], 1000, 1000, 0.3, 0.5)).toEqual({ x: 90, y: 94, w: 220, h: 32 })
  })
  it('does not bite into neighbor lines', () => {
    const r = { x: 100, y: 100, w: 200, h: 20 }
    const above = { x: 120, y: 76, w: 200, h: 20 } // 隙間 4px
    const p = padRect(r, [r, above], 1000, 1000, 0.3, 0.5)
    expect(p.y).toBeCloseTo(100 - 4 * 0.45)
  })
})
