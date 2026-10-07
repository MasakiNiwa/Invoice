import { describe, expect, it } from 'vitest'
import { aggregate, isConfident, type Reading } from './aggregate'

const NTA = '7000012050002'
const rect = { x: 10, y: 10, w: 200, h: 20 }
const r = (digits: string, extra: Partial<Reading> = {}): Reading => ({
  digits, hasT: true, valid: digits === NTA, conf: 90, stage: 'anchor', rect, substitutions: 0, raw: digits, ...extra,
})

describe('aggregate', () => {
  it('valid candidate ranks first', () => {
    const c = aggregate([r('7000012050008'), r('7000012050008'), r(NTA)])
    expect(c[0].digits).toBe(NTA)
    expect(c[0].valid).toBe(true)
  })
  it('consensus from noisy readings', () => {
    const c = aggregate([r('7000012050008'), r('7000012058002'), r('7008012050002')])
    expect(c.find((x) => x.digits === NTA)?.kind).toBe('consensus')
  })
  it('confidence detection', () => {
    expect(isConfident(aggregate([r(NTA), r(NTA), r(NTA)]))).toBe(true)
    expect(isConfident(aggregate([r(NTA)]))).toBe(false)
    expect(isConfident(aggregate([r(NTA, { stage: 'pdf' })]))).toBe(true)
  })
})
