import { describe, expect, it } from 'vitest'
import { detailRowScore, voteRowText } from './pipeline'

describe('detail refinement', () => {
  it('scores requirement-related rows', () => {
    expect(detailRowScore('(税率10%対象 ¥40)', 10, -1)).toBeGreaterThanOrEqual(5)
    expect(detailRowScore('2024年12月23日', 10, -1)).toBeGreaterThanOrEqual(3)
    expect(detailRowScore('株式会社サンプル 御中', 10, -1)).toBeGreaterThanOrEqual(3)
    expect(detailRowScore('いつもありがとうございます', 10, -1)).toBeLessThan(2)
  })
  it('prefers the reading that dropped the fewest characters', () => {
    expect(voteRowText([
      { text: '株式会社商事御中', conf: 90 },
      { text: '株式会社サプル商事御中', conf: 85 },
      { text: '株式会社サンプル商事御中', conf: 80 },
      { text: '株式会社サル商事御中', conf: 88 },
    ])).toBe('株式会社サンプル商事御中')
  })
  it('keeps the original reading when noisy re-reads agree on an error', () => {
    expect(voteRowText([
      { text: '消費税(8%) ¥160', conf: 90, weight: 1.5 },
      { text: '|消費税(%) ¥160', conf: 85 },
      { text: '消費税(%) ¥160|', conf: 85 },
      { text: '消費税(8%) ¥160', conf: 80 },
    ])).toBe('消費税(8%) ¥160')
  })
  it('votes the most agreed reading', () => {
    expect(voteRowText([
      { text: '(税率10%対象¥4O)', conf: 55 },
      { text: '(税率10%対象 ¥40)', conf: 90 },
      { text: '(税率10%対象¥40)', conf: 80 },
    ]).replace(/\s/g, '')).toBe('(税率10%対象¥40)')
  })
})
