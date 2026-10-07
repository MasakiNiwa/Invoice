/** 行テキストの組み立て */
import type { Rect } from './image'
import type { TextRow } from './requirements'

const median = (xs: number[]) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const unionRect = (rs: Rect[]): Rect => {
  const x0 = Math.min(...rs.map((r) => r.x))
  const y0 = Math.min(...rs.map((r) => r.y))
  const x1 = Math.max(...rs.map((r) => r.x + r.w))
  const y1 = Math.max(...rs.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * 記載事項チェック用: y が重なる単語を、間隔に関係なく1行にまとめる
 * (レシートの「税率10%対象 ……… ¥40」のように左右に離れた項目と金額を同じ行にする)
 */
export function groupFullRows<T extends { text: string; rect: Rect; conf?: number }>(items: T[]): TextRow[] {
  const sorted = items.filter((w) => w.text.trim() && w.rect.h > 0).sort((a, b) => a.rect.y + a.rect.h / 2 - (b.rect.y + b.rect.h / 2))
  const rows: T[][] = []
  for (const w of sorted) {
    const cy = w.rect.y + w.rect.h / 2
    const row = rows[rows.length - 1]
    if (row) {
      const hs = row.map((x) => x.rect.h)
      const h = median(hs)
      const rcy = median(row.map((x) => x.rect.y + x.rect.h / 2))
      if (Math.abs(cy - rcy) < Math.max(h, w.rect.h) * 0.45) {
        row.push(w)
        continue
      }
    }
    rows.push([w])
  }
  return rows.map((r) => {
    r.sort((a, b) => a.rect.x - b.rect.x)
    return { text: r.map((w) => w.text).join(' '), rect: unionRect(r.map((w) => w.rect)), parts: r.map((w) => ({ text: w.text, rect: w.rect, conf: w.conf })) }
  })
}

