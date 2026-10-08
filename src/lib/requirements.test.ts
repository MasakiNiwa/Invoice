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
  it('fixes % misread as 96', () => {
    expect(normalizeRow('896对象小計 ¥2,000')).toBe('8%対象小計¥2,000')
    expect(normalizeRow('8%6対象 ¥2,000')).toBe('8%対象¥2,000')
    expect(normalizeRow('合計 ¥1,896')).toBe('合計¥1,896')
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
  it('taxi receipt addressed to 様 is a simplified invoice and passes', () => {
    const r = checkRequirements(
      rows('領 収 書', '株式会社サンプル商事 様', '金額 ¥3,120', '(うち消費税等10% ¥283)', '但し タクシー運賃として', '2026年9月8日', 'みどり自動車株式会社', '登録番号 T9803456789123'),
      { regNo: '9803456789123', today: new Date(2026, 9, 8) },
    )
    expect(r.simplified).toBe(true)
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

/** レビューで再現されたケース(見出しだけ・税率の片方の欠け・支払方法による簡易判定など) */
describe('requirements: review cases', () => {
  const normal = (...extra: string[]) => rows('請求書', '株式会社サンプル 御中', '発行: 株式会社テスト', '登録番号 T7000012050002', '2026年10月1日', 'Web制作費 一式', ...extra)
  const by = (r: ReturnType<typeof checkRequirements>) => Object.fromEntries(r.items.map((i) => [i.id, i.status]))
  const today = new Date(2026, 9, 9)
  it('keeps sign and zero in amounts', () => {
    expect(parseAmounts(normalizeRow('値引 -100円'))).toEqual([-100])
    expect(parseAmounts(normalizeRow('値引 ▲100円'))).toEqual([-100])
    expect(parseAmounts(normalizeRow('合計 ¥0'))).toEqual([0])
    expect(parseAmounts(normalizeRow('コーヒー ¥300'))).toEqual([300])
  })
  it('headings without amounts are not OK (R2)', () => {
    const r = checkRequirements(normal('10%対象', '消費税10%'), { regNo: '7000012050002', today })
    expect(by(r).rateTotal).not.toBe('ok')
    expect(by(r).tax).not.toBe('ok')
    expect(r.summary).not.toBe('ok')
  })
  it('a missing tax amount for one of two rates is not OK (R3)', () => {
    const r = checkRequirements(normal('10%対象 ¥110', '8%対象 ¥108 ※軽減税率', '消費税(10%) ¥10', '合計 ¥218'), { regNo: '7000012050002', today })
    expect(by(r).rateTotal).toBe('ok')
    expect(by(r).tax).toBe('warn')
    expect(r.summary).not.toBe('ok')
  })
  it('both rates with tax are OK', () => {
    const r = checkRequirements(normal('10%対象 ¥110', '8%対象 ¥108 ※軽減税率', '消費税(10%) ¥10', '消費税(8%) ¥8', '合計 ¥218'), { regNo: '7000012050002', today })
    expect(by(r)).toMatchObject({ rateTotal: 'ok', tax: 'ok', recipient: 'ok', consistency: 'ok', total: 'ok' })
  })
  it('paying in cash does not make an invoice simplified (R4)', () => {
    const r = checkRequirements(rows('株式会社テスト', '登録番号 T7000012050002', '2026年10月1日', 'Web制作費 ¥110,000', '10%対象 ¥110,000', '支払方法 現金'), { regNo: '7000012050002', today })
    expect(r.simplified).toBe(false)
    expect(by(r).recipient).toBe('ng')
    expect(by(r).tax).toBe('ng')
  })
  it('a receipt title alone is an uncertain simplified invoice', () => {
    const r = checkRequirements(rows('領収書', '株式会社テスト', '登録番号 T7000012050002', '2026年10月1日', 'Web制作費として', '金額 ¥110,000', '10%対象 ¥110,000'), { regNo: '7000012050002', today })
    expect(r.simplified).toBe(true)
    expect(r.kindSource).toBe('auto-weak')
    expect(by(r).recipient).toBe('warn')
    // 種類を指定すればそれに従う
    const n = checkRequirements(rows('領収書', '株式会社テスト', '金額 ¥110,000', '10%対象 ¥110,000'), { regNo: null, docKind: 'normal', today })
    expect(n.simplified).toBe(false)
    expect(by(n).recipient).toBe('ng')
  })
  it('a store name followed by its address is a retail issuer', () => {
    const r = checkRequirements(rows('領収書', '足立弘道1丁目店東京都足立区弘道1丁目1番15号', '登録番号 T7000012050002', '2026年10月1日', '但しプリント代として', '¥40', '(税率10%対象 ¥40)', '(内消費税等10% ¥3)'), { regNo: '7000012050002', today })
    expect(r.kindSource).toBe('auto')
    expect(r.summary).toBe('ok')
  })
  it('simplified receipt showing only the tax amount is accepted (R5)', () => {
    const r = checkRequirements(rows('〇〇食堂', '登録番号 T7000012050002', '2026年10月1日', 'ランチ代として', '合計 ¥330', '対象 ¥330(内消費税 ¥30)'), { regNo: '7000012050002', today })
    expect(r.simplified).toBe(true)
    expect(by(r).rateTotal).toBe('ok')
    expect(by(r).tax).toBe('ok')
  })
  it('reads total and tax on the same line (R8)', () => {
    const b = extractTaxBreakdown(['合計 ¥1,100(内消費税 ¥100)'])
    expect(b?.total).toBe(1100)
    const c = extractTaxBreakdown(['10%対象 ¥1,100(内消費税 ¥100)'])
    expect(c?.lines[0]).toMatchObject({ rate: 10, base: 1100, tax: 100, mode: '内税', ok: true })
  })
  it('respects explicit tax-included label (R10)', () => {
    const b = extractTaxBreakdown(['10%対象 税込 ¥1,000', '消費税(10%) ¥100', '合計 ¥1,000'])
    expect(b?.lines[0].ok).toBe(false)
    expect(checkTaxConsistency(['10%対象(税抜) ¥1,000', '消費税(10%) ¥100'])?.ok).toBe(true)
  })
  it('treats tomorrow as a future date (R11)', () => {
    expect(parseDate('2026/10/10', today)?.future).toBe(true)
    expect(parseDate('2026/10/09', today)?.future).toBe(false)
  })
})
