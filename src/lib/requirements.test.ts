import { describe, expect, it } from 'vitest'
import { checkRequirements, checkTaxConsistency, extractTaxBreakdown, normalizeRow, parseAmounts, parseDate, repairKeywords, type TextRow } from './requirements'

const rect = { x: 0, y: 0, w: 10, h: 10 }
const rows = (...t: string[]): TextRow[] => t.map((text) => ({ text, rect }))

describe('requirements', () => {
  it('normalizes Japanese OCR spacing', () => {
    expect(normalizeRow('内 消 費 税 等  10 %  ￥3')).toBe('内消費税等10%¥3')
  })
  it('maps simplified Chinese forms from multilingual OCR', () => {
    expect(normalizeRow('（内消费税等10%¥3）')).toBe('(内消費税等10%¥3)')
    expect(normalizeRow('税率10%对象')).toBe('税率10%対象')
  })
  it('fixes lookalikes in dates', () => {
    expect(normalizeRow('2O24年l2月23日')).toBe('2024年12月23日')
  })
  it('parses amounts', () => {
    expect(parseAmounts('合計 ¥1,100 (税込) 100円')).toEqual([1100, 100])
    expect(parseAmounts('8%対象 ¥2.000')).toEqual([2000])
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
  it('repairs OCR-garbled keywords', () => {
    expect(repairKeywords('内消貿税等10%¥3')).toContain('内消費税等')
    expect(repairKeywords('領収害')).toBe('領収書')
    expect(repairKeywords('事業者登録督号T1')).toContain('登録番号')
    expect(repairKeywords('東京都千代田区')).toBe('東京都千代田区')
    expect(repairKeywords('10%対象小計¥80,000')).toBe('10%対象小計¥80,000')
    expect(repairKeywords('但しプリント代として')).toBe('但しプリント代として')
  })
  it('validates dates', () => {
    const today = new Date(2026, 9, 8)
    expect(parseDate('2024年12月23日', today)).toMatchObject({ valid: true, beforeInvoiceSystem: false, future: false })
    expect(parseDate('令和5年9月30日', today)).toMatchObject({ year: 2023, valid: true, beforeInvoiceSystem: true })
    expect(parseDate('2024/02/30', today)?.valid).toBe(false)
    expect(parseDate('2029年1月1日', today)?.future).toBe(true)
  })
  it('extracts tax breakdown and checks total', () => {
    const b = extractTaxBreakdown(['10%対象 ¥1,000', '消費税(10%) ¥100', '8%対象 ¥500', '消費税(8%) ¥40', '合計 ¥1,640'])
    expect(b?.lines.map((l) => [l.rate, l.mode, l.ok])).toEqual([[10, '外税', true], [8, '外税', true]])
    expect(b?.totalOk).toBe(true)
    const bad = extractTaxBreakdown(['10%対象 ¥1,000', '消費税(10%) ¥100', '合計 ¥1,500'])
    expect(bad?.totalOk).toBe(false)
  })
  it('tax consistency outer tax', () => {
    expect(checkTaxConsistency(['10%対象 ¥1,000', '消費税(10%) ¥100'])?.ok).toBe(true)
    expect(checkTaxConsistency(['10%対象 ¥1,000', '消費税(10%) ¥150'])?.ok).toBe(false)
  })
})
