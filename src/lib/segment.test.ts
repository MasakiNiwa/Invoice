import { describe, expect, it } from 'vitest'
import { segmentInvoices } from './segment'
import type { TextRow } from './requirements'

const row = (text: string, x: number, y: number, w = 300, h = 20): TextRow => ({ text, rect: { x, y, w, h } })

/** 1つのインボイス(左上 x0,y0) */
function invoice(x0: number, y0: number, t: string, name: string): TextRow[] {
  return [
    row('領収書', x0 + 100, y0),
    row(`${name}`, x0, y0 + 30),
    row(`登録番号 T${t}`, x0, y0 + 60),
    row('2024年12月23日', x0, y0 + 90),
    row('10%対象 ¥1,100', x0, y0 + 160),
    row('内消費税 ¥100', x0, y0 + 190),
  ]
}

describe('segmentInvoices', () => {
  it('single invoice stays whole', () => {
    const rows = invoice(0, 0, '7123456789012', 'A店')
    expect(segmentInvoices(rows, [{ digits: '7123456789012', rect: rows[2].rect }], 1000, 1400)).toHaveLength(1)
  })
  it('two receipts side by side', () => {
    const a = invoice(0, 0, '7123456789012', 'A店')
    const b = invoice(600, 0, '7810648631842', 'B店')
    const segs = segmentInvoices([...a, ...b], [{ digits: '7123456789012', rect: a[2].rect }, { digits: '7810648631842', rect: b[2].rect }], 1000, 1400)
    expect(segs).toHaveLength(2)
    expect(segs[0].digits).toBe('7123456789012')
    expect(segs[0].rows.map((r) => r.text)).toContain('A店')
    expect(segs[1].rows.map((r) => r.text)).toContain('B店')
    expect(segs[1].rows.map((r) => r.text)).not.toContain('A店')
  })
  it('receipt without registration number is its own invoice', () => {
    const a = invoice(0, 0, '7123456789012', 'A交通')
    const b = invoice(600, 0, '7810648631842', 'B交通')
    const c = invoice(0, 500, '7123456789012', 'A交通')
    const d = invoice(600, 500, '', '個人タクシー').map((r) => (r.text.startsWith('登録番号') ? { ...r, text: 'TEL 03-0000-0000' } : r))
    const ts = [a[2], b[2], c[2]].map((r) => ({ digits: r.text.slice(-13), rect: r.rect }))
    const segs = segmentInvoices([...a, ...b, ...c, ...d], ts, 1200, 1400)
    expect(segs).toHaveLength(4)
    expect(segs.filter((s) => !s.digits)).toHaveLength(1)
  })
  it('two invoices stacked vertically (2x2 grid too)', () => {
    const rows = [...invoice(0, 0, '7123456789012', 'A'), ...invoice(0, 500, '7810648631842', 'B'), ...invoice(600, 0, '7000012050002', 'C'), ...invoice(600, 500, '1234567890128', 'D')]
    const ts = rows.filter((r) => r.text.startsWith('登録番号')).map((r) => ({ digits: r.text.slice(-13), rect: r.rect }))
    const segs = segmentInvoices(rows, ts, 1200, 1400)
    expect(segs).toHaveLength(4)
    for (const s of segs) expect(s.rows).toHaveLength(6)
  })
})
