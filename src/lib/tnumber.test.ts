import { describe, expect, it } from 'vitest'
import {
  computeCheckDigit,
  extractTNumbers,
  formatTNumber,
  isValidDigits,
  parseManualInput,
  suggestCorrections,
  toHalfWidth,
} from './tnumber'

// 国税庁の法人番号(公開情報)
const NTA = '7000012050002'

describe('check digit', () => {
  it('computes known corporate number', () => {
    expect(computeCheckDigit('000012050002')).toBe(7)
    expect(isValidDigits(NTA)).toBe(true)
  })
  it('rejects wrong digits', () => {
    expect(isValidDigits('8000012050002')).toBe(false)
    expect(isValidDigits('700001205000')).toBe(false)
  })
  it('check digit is always 1..9', () => {
    for (let i = 0; i < 2000; i++) {
      const base = String(Math.floor(Math.random() * 1e12)).padStart(12, '0')
      const cd = computeCheckDigit(base)
      expect(cd).toBeGreaterThanOrEqual(1)
      expect(cd).toBeLessThanOrEqual(9)
    }
  })
})

describe('extractTNumbers', () => {
  it('plain', () => {
    const r = extractTNumbers(`登録番号: T${NTA}`)
    expect(r[0]).toMatchObject({ digits: NTA, hasT: true, valid: true })
  })
  it('separated and full width', () => {
    const r = extractTNumbers('登録番号 Ｔ７−００００−１２０５−０００２')
    expect(r[0]).toMatchObject({ digits: NTA, hasT: true, valid: true })
  })
  it('spaces', () => {
    const r = extractTNumbers('T 7 0000 1205 0002')
    expect(r[0]).toMatchObject({ digits: NTA, hasT: true })
  })
  it('lookalike letters inside digits', () => {
    const r = extractTNumbers('T70000I2O5000Z')
    expect(r[0]?.digits).toBe(NTA)
    expect(r[0]?.substitutions).toBeGreaterThan(0)
  })
  it('T misread as 7', () => {
    const r = extractTNumbers(`請求書 7${NTA} 円`)
    expect(r.some((x) => x.digits === NTA && x.hasT)).toBe(true)
  })
  it('ignores too long numbers', () => {
    expect(extractTNumbers('T70000120500021').length).toBe(0)
  })
  it('without T after keyword', () => {
    const r = extractTNumbers(`登録番号 ${NTA}`)
    expect(r[0]).toMatchObject({ digits: NTA, hasT: false, valid: true })
  })
})

describe('suggestCorrections', () => {
  it('finds confusable single-digit fix', () => {
    const broken = '7000012050008' // 末尾 2→8 の誤読想定
    expect(isValidDigits(broken)).toBe(false)
    const s = suggestCorrections(broken)
    expect(s.length).toBeGreaterThan(0)
    expect(s.every((x) => isValidDigits(x.digits))).toBe(true)
  })
  it('respects low confidence positions', () => {
    const s = suggestCorrections('7000012050008', [12])
    expect(s.every((x) => x.position === 12)).toBe(true)
  })
})

describe('misc', () => {
  it('format', () => expect(formatTNumber(NTA)).toBe('T7 0000 1205 0002'))
  it('halfwidth', () => expect(toHalfWidth('Ｔ１ー２')).toBe('T1-2'))
  it('manual input', () => {
    expect(parseManualInput(`t${NTA}`).valid).toBe(true)
    expect(parseManualInput('T123').message).toContain('13桁')
    expect(parseManualInput('8000012050002').expectedCheckDigit).toBe(7)
  })
})
