import { describe, expect, it } from 'vitest'
import { extractAmounts, invoiceAmount } from './amounts'
import type { TextRow } from './requirements'

const rect = { x: 0, y: 0, w: 10, h: 10 }
const rows = (...t: string[]): TextRow[] => t.map((text) => ({ text, rect }))

describe('amounts', () => {
  it('ETC statement: bare numbers in a fee column', () => {
    const a = extractAmounts(rows(
      'ETC利用照会サービス 利用明細',
      '利用年月日 入口IC 出口IC 通行料金(円)',
      '2026/09/01 首都高速 三郷 東名 東京 1,320',
      '2026/09/03 東名 東京 東名 厚木 1,360',
      '2026/09/10 首都高速 加平 首都高速 箱崎 1,050',
      '合計 3,730',
    ))
    expect(a.items.filter((i) => i.kind === 'item').map((i) => i.amount)).toEqual([1320, 1360, 1050])
    expect(a.itemsSum).toBe(3730)
    expect(a.docTotal).toBe(3730)
    expect(a.match).toBe('equal')
  })
  it('receipt with outer tax', () => {
    const a = extractAmounts(rows('文具 ¥1,000', 'お茶 ¥200', '小計 ¥1,200', '消費税 ¥116', '合計 ¥1,316', 'お預り ¥2,000', 'お釣 ¥684'))
    expect(a.itemsSum).toBe(1200)
    expect(a.docTotal).toBe(1316)
    expect(a.match).toBe('equalWithTax')
    expect(invoiceAmount(a)).toEqual({ value: 1316, source: 'total' })
  })
  it('does not take dates, times or phone numbers as amounts', () => {
    const a = extractAmounts(rows('料金(円)', '2026/09/01 12:30', 'TEL 03-1234-5678'))
    expect(a.items).toHaveLength(0)
  })
  it('taxi receipt: 金額 line is the total', () => {
    const a = extractAmounts(rows('領収書', '金額 ¥3,120', '(うち消費税等10% ¥283)', '但し タクシー運賃として'))
    expect(a.docTotal).toBe(3120)
  })
  it('infers an unreadable total line from the running sum', () => {
    const a = extractAmounts(rows('文具 ¥1,000', '※お茶 ¥216', '10%対象 ¥1,000', '消費税(10%) ¥100', '8%対象 ¥200', '消費税(8%) ¥16', '合言十 ¥1,332'))
    expect(a.docTotal).toBe(1332)
    expect(a.itemsSum).toBe(1216)
    const b = extractAmounts(rows('文具 ¥1,000', '※お茶 ¥216', '10%対象 ¥1,000', '消費税(10%) ¥100', '8%対象 ¥200', '消費税(8%) ¥16', '合言十 ¥1,316'))
    expect(b.docTotal).toBe(1316)
  })
  it('detects mismatch', () => {
    expect(extractAmounts(rows('A ¥100', 'B ¥200', '合計 ¥500')).match).toBe('diff')
  })
})
