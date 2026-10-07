import { createCanvas } from './image'

/** デモ用の架空の請求書画像を生成(番号 T7123456789012 は架空・検算OK) */
export function makeSampleInvoice(): HTMLCanvasElement {
  const W = 1240
  const H = 1754
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fdfdfb'
  ctx.fillRect(0, 0, W, H)
  const font = '"Hiragino Sans","Noto Sans JP","Yu Gothic",Meiryo,sans-serif'
  ctx.fillStyle = '#222'
  ctx.textBaseline = 'alphabetic'

  ctx.font = `bold 64px ${font}`
  ctx.fillText('請 求 書', W / 2 - 130, 150)
  ctx.font = `28px ${font}`
  ctx.fillText('株式会社サンプル商事 御中', 90, 270)
  ctx.fillRect(90, 285, 420, 2)
  ctx.fillText('請求日: 2026年10月1日', 820, 230)
  ctx.fillText('請求番号: INV-2026-0042', 820, 272)

  ctx.font = `bold 30px ${font}`
  ctx.fillText('架空デザイン株式会社', 780, 380)
  ctx.font = `24px ${font}`
  ctx.fillText('〒100-0000 東京都千代田区架空町1-2-3', 700, 420)
  ctx.fillText('TEL 03-0000-0000', 780, 456)
  ctx.font = `24px ${font}`
  ctx.fillText('登録番号: T7123456789012', 780, 494)

  ctx.font = `bold 34px ${font}`
  ctx.fillText('ご請求金額  ¥110,000-(税込)', 90, 420)

  // 明細表
  const top = 600
  const cols = [90, 640, 800, 950, 1150]
  ctx.lineWidth = 2
  ctx.strokeStyle = '#444'
  ctx.font = `24px ${font}`
  const rows = [
    ['品目', '数量', '単価', '金額'],
    ['Webサイト制作一式', '1', '80,000', '80,000'],
    ['保守サポート(10月分)', '1', '20,000', '20,000'],
    ['', '', '', ''],
    ['小計(10%対象)', '', '', '100,000'],
    ['消費税(10%)', '', '', '10,000'],
    ['合計', '', '', '110,000'],
  ]
  rows.forEach((r, i) => {
    const y = top + i * 60
    if (i === 0) {
      ctx.fillStyle = '#e8eef0'
      ctx.fillRect(cols[0], y, cols[4] - cols[0], 60)
      ctx.fillStyle = '#222'
    }
    ctx.strokeRect(cols[0], y, cols[4] - cols[0], 60)
    for (let k = 1; k < 4; k++) {
      ctx.beginPath()
      ctx.moveTo(cols[k], y)
      ctx.lineTo(cols[k], y + 60)
      ctx.stroke()
    }
    r.forEach((t, k) => {
      if (k === 0) ctx.fillText(t, cols[0] + 16, y + 40)
      else {
        const w = ctx.measureText(t).width
        ctx.fillText(t, cols[k + 1] - 16 - w, y + 40)
      }
    })
  })

  ctx.font = `22px ${font}`
  ctx.fillText('お振込先: 架空銀行 本店 普通 1234567 カクウデザイン(カ', 90, 1120)
  ctx.fillText('お支払期限: 2026年10月31日', 90, 1160)
  ctx.fillText('※ この請求書はデモ用の架空のものです。', 90, 1240)

  // 少しノイズを足して紙っぽく
  const img = ctx.getImageData(0, 0, W, H)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  ctx.putImageData(img, 0, 0)
  return c
}
