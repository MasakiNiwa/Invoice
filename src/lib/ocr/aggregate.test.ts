import { describe, expect, it } from 'vitest'
import { aggregate, isConfident, type Reading } from './aggregate'

const NTA = '7000012050002'
const rect = { x: 10, y: 10, w: 200, h: 20 }
const r = (digits: string, extra: Partial<Reading> = {}): Reading => ({
  digits, hasT: true, valid: digits === NTA, conf: 90, stage: 'anchor', rect, substitutions: 0, raw: digits, ...extra,
})

describe('aggregate', () => {
  it('JAN-like number without T is not primary', () => {
    // 4901234567894 は JAN として正しい。T番号の検算もたまたま通る場合のみ有効候補になるが、主候補にはしない
    const c = aggregate([r(NTA), { ...r('4901234567894'), hasT: false, stage: 'tile' }])
    expect(c[0].digits).toBe(NTA)
    expect(c.find((x) => x.digits === '4901234567894')?.likelyJan).toBe(true)
  })
  it('no corrections from context-less readings', () => {
    const c = aggregate([{ ...r('7000012050008'), hasT: false }])
    expect(c.some((x) => x.kind === 'corrected')).toBe(false)
  })
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
