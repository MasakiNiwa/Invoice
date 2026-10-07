import { describe, expect, it } from 'vitest'
import { checkRequirements, checkTaxConsistency, normalizeRow, parseAmounts, type TextRow } from './requirements'

const rect = { x: 0, y: 0, w: 10, h: 10 }
const rows = (...t: string[]): TextRow[] => t.map((text) => ({ text, rect }))

describe('requirements', () => {
  it('normalizes Japanese OCR spacing', () => {
    expect(normalizeRow('内 消 費 税 等  10 %  ￥3')).toBe('内消費税等10%¥3')
  })
  it('fixes lookalikes in dates', () => {
    expect(normalizeRow('2O24年l2月23日')).toBe('2024年12月23日')
  })
  it('parses amounts', () => {
    expect(parseAmounts('合計 ¥1,100 (税込) 100円')).toEqual([1100, 100])
  })
  it('receipt (simplified invoice) like the 7-Eleven sample', () => {
    const r = checkRequirements(
      rows('セブン-イレブン足立弘道1丁目店', '事業者登録番号 T7810648631842', '2024年12月23日(月) 19:06', '領収書', '¥40', '(税率10%対象 ¥40)', '(内消費税等 10% ¥3)', '但しプリント代として', 'nanaco支払 ¥40'),
      { regNo: '7810648631842' },
    )
    expect(r.simplified).toBe(true)
    const by = Object.fromEntries(r.items.map((i) => [i.id, i.status]))
    expect(by).toMatchObject({ regno: 'ok', issuer: 'ok', date: 'ok', content: 'ok', rateTotal: 'ok', tax: 'ok', recipient: 'na', consistency: 'ok' })
    expect(r.summary).toBe('ok')
  })
  it('invoice missing recipient and tax', () => {
    const r = checkRequirements(rows('請求書', '株式会社テスト', '2026/10/01', 'Web制作 ¥100,000'), { regNo: null })
    const by = Object.fromEntries(r.items.map((i) => [i.id, i.status]))
    expect(by.regno).toBe('ng')
    expect(by.recipient).toBe('ng')
    expect(by.tax).toBe('ng')
    expect(r.summary).toBe('ng')
  })
  it('reduced rate needs mark', () => {
    const r = checkRequirements(rows('株式会社A 御中', '令和6年4月1日', 'お茶 ¥108', '8%対象 ¥108', '消費税 8% ¥8'), { regNo: '7123456789012' })
    expect(r.items.find((i) => i.id === 'content')?.status).toBe('warn')
  })
  it('tax consistency outer tax', () => {
    expect(checkTaxConsistency(['10%対象 ¥1,000', '消費税(10%) ¥100'])?.ok).toBe(true)
    expect(checkTaxConsistency(['10%対象 ¥1,000', '消費税(10%) ¥150'])?.ok).toBe(false)
  })
})
