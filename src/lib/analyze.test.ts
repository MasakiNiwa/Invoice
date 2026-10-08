import { describe, expect, it } from 'vitest'
import { analyzeScan } from './analyze'
import { aggregate, isPrimary, type Candidate } from './ocr/aggregate'
import { isValidDigits } from './tnumber'
import type { TextRow } from './requirements'

const R = (x: number, y: number, w = 200, h = 20) => ({ x, y, w, h })

describe('analyzeScan', () => {
  it('a corrected (estimated) number is never OK (R1)', () => {
    expect(isValidDigits('2000012050002')).toBe(false)
    const cands = aggregate([{ digits: '2000012050002', hasT: true, valid: false, conf: 90, stage: 'layout', rect: R(10, 40), substitutions: 0, raw: 'T2000012050002' }])
    expect(cands.some((c) => c.kind === 'corrected' && c.valid)).toBe(true)
    expect(cands.filter(isPrimary)).toHaveLength(0)
    const rows: TextRow[] = ['領収書', '〇〇食堂', '登録番号 T2000012050002', '2026年10月1日', 'ランチ代として', '合計 ¥1,100', '(10%対象 ¥1,100 内消費税 ¥100)'].map((text, i) => ({ text, rect: R(10, i * 30) }))
    const [inv] = analyzeScan(cands, rows, 600, 400)
    expect(inv.digits).not.toBeNull()
    const regno = inv.report!.items.find((i) => i.id === 'regno')!
    expect(regno.status).toBe('warn')
    expect(inv.report!.summary).not.toBe('ok')
  })
  it('two receipts from the same shop both get the number (R9)', () => {
    const left = (x: number): TextRow[] =>
      ['領収書', '〇〇食堂', '登録番号 T7000012050002', '2026年10月1日', 'ランチ代として', '合計 ¥1,100', '(10%対象 ¥1,100 内消費税 ¥100)'].map((text, i) => ({ text, rect: R(x, 20 + i * 30) }))
    const rows = [...left(20), ...left(700)]
    const cand: Candidate = {
      digits: '7000012050002', valid: true, kind: 'read', score: 5, confidence: 95, votes: 2, hasT: true, stages: ['pdf'],
      rects: [R(20, 80), R(700, 80)], context: true, likelyJan: false, shadowed: false,
    }
    const invs = analyzeScan([cand], rows, 1000, 300)
    expect(invs).toHaveLength(2)
    expect(invs.map((v) => v.digits)).toEqual(['7000012050002', '7000012050002'])
    expect(invs.map((v) => v.amount?.value)).toEqual([1100, 1100])
  })
})
