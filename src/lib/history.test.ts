import { describe, expect, it } from 'vitest'
import { historyToCsv } from '../store/history'

describe('history csv', () => {
  it('escapes and adds BOM', () => {
    const csv = historyToCsv([
      { id: '1', at: '2026-10-08T00:00:00Z', name: 'a "b".jpg', thumb: '', digits: '7810648631842', others: [], requirements: { summary: 'ok', text: 'OK', simplified: true }, engine: 'PaddleOCR', seconds: 9.5 },
    ])
    expect(csv.startsWith('﻿"日時"')).toBe(true)
    expect(csv).toContain('"a ""b"".jpg"')
    expect(csv).toContain('"T7810648631842"')
    expect(csv).toContain('selRegNo=7810648631842')
  })
})
