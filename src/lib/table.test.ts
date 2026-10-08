import { describe, expect, it } from 'vitest'
import { inferTable, numericValue } from './table'
import type { TextRow } from './requirements'

/** 文字片(x, 幅)から行を作る */
const row = (y: number, ...cells: [string, number, number][]): TextRow => ({
  text: cells.map((c) => c[0]).join(' '),
  rect: { x: 0, y, w: 600, h: 20 },
  parts: cells.map(([text, x, w]) => ({ text, rect: { x, y, w, h: 20 } })),
})

describe('table', () => {
  it('numeric cells', () => {
    expect(numericValue('¥1,320')).toBe(1320)
    expect(numericValue('2,810')).toBe(2810)
    expect(numericValue('△100')).toBe(-100)
    expect(numericValue('-¥1,000')).toBe(-1000)
    expect(numericValue('2026/09/01')).toBeNull()
  })
  it('amount column is taken from the header and right alignment, not quantities', () => {
    const rows = [
      row(0, ['品名', 0, 60], ['数量', 300, 40], ['単価', 380, 40], ['金額', 520, 40]),
      row(30, ['Web制作', 0, 80], ['1', 330, 10], ['60,000', 370, 50], ['60,000', 510, 50]),
      row(60, ['保守', 0, 40], ['2', 330, 10], ['10,000', 370, 50], ['20,000', 510, 50]),
      row(90, ['部品 3個セット', 0, 140], ['3', 330, 10], ['500', 390, 30], ['1,500', 520, 40]),
      row(120, ['合計', 0, 40], ['81,500', 510, 50]),
    ]
    const t = inferTable(rows)!
    expect(t.columns[t.amountCol].header).toBe('金額')
    expect(t.rowAmounts).toEqual([null, 60000, 20000, 1500, 81500])
  })
  it('ETC-like table with bare numbers', () => {
    const rows = [
      row(0, ['利用年月日', 0, 100], ['入口IC', 150, 60], ['出口IC', 300, 60], ['通行料金(円)', 480, 100]),
      row(30, ['2026/09/01', 0, 100], ['三郷', 150, 40], ['東京', 300, 40], ['1,320', 540, 40]),
      row(60, ['2026/09/03', 0, 100], ['東京', 150, 40], ['厚木', 300, 40], ['1,360', 540, 40]),
      row(90, ['2026/09/10', 0, 100], ['加平', 150, 40], ['箱崎', 300, 40], ['1,050', 540, 40]),
    ]
    const t = inferTable(rows)!
    expect(t.rowAmounts).toEqual([null, 1320, 1360, 1050])
  })
})
