/** PDF 読み込み(pdf.js)。テキスト層の抽出とページの画像化。 */
import type { Rect } from './image'
import { createCanvas } from './image'

type PdfJs = typeof import('pdfjs-dist')
let pdfjsPromise: Promise<PdfJs> | null = null

/** pdf.js は大きいので必要になった時だけ読み込む */
async function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      return pdfjs
    })()
  }
  return pdfjsPromise
}

export interface PdfTextItem {
  str: string
  rect: Rect
}

export interface PdfPage {
  canvas: HTMLCanvasElement
  textItems: PdfTextItem[]
  pageNumber: number
  numPages: number
}

export function isPdf(file: Blob & { name?: string }): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name ?? '')
}

/** 指定ページを画像化し、テキスト層の文字列と位置(画像座標)を返す。 */
export async function loadPdfPage(file: Blob, pageNumber = 1, targetLongSide = 2800): Promise<PdfPage> {
  const pdfjs = await loadPdfJs()
  const data = new Uint8Array(await file.arrayBuffer())
  const task = pdfjs.getDocument({ data })
  const doc = await task.promise
  try {
    const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages))
    const base = page.getViewport({ scale: 1 })
    const scale = targetLongSide / Math.max(base.width, base.height)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(viewport.width, viewport.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise

    const tc = await page.getTextContent()
    const textItems: PdfTextItem[] = []
    for (const it of tc.items) {
      if (!('str' in it) || !it.str) continue
      const [, , , , e, f] = it.transform as number[]
      const fontH = Math.hypot(it.transform[2], it.transform[3]) || it.height
      const [x1, y1] = viewport.convertToViewportPoint(e, f)
      const [x2, y2] = viewport.convertToViewportPoint(e + it.width, f + fontH)
      textItems.push({
        str: it.str,
        rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
      })
    }
    return { canvas, textItems, pageNumber: page.pageNumber, numPages: doc.numPages }
  } finally {
    void task.destroy()
  }
}
