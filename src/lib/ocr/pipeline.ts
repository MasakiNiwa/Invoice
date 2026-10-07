/**
 * 多段捜査パイプライン。
 *
 *  Stage 0 pdf      : PDF テキスト層から直接抽出
 *  Stage 1 layout   : 縮小画像を日本語+英語で OCR → アンカー(T / 登録番号 等)と文字サイズを推定
 *  Stage 2 anchor   : アンカー右側・下側を切り出し、文字高を揃えて拡大 → 数字専用 OCR
 *  Stage 3 textline : 連結成分で「同じ大きさの文字が横に並ぶ領域」を検出 → 数字専用 OCR
 *  Stage 4 tile     : 重なりタイル × ズームレベルで全体を走査(見落とし対策)
 *
 * UI はイベント(ScanEvent)を受け取って可視化する。
 */
import type { Rect, Preprocess } from '../image'
import { clampRect, cropForOcr, downscale, otsuThreshold, overlapRatio, toGray } from '../image'
import type { PdfTextItem } from '../pdf'
import { binarize, connectedComponents, findTextLines } from '../textlines'
import { extractTNumbers, toHalfWidth } from '../tnumber'
import type { Settings } from '../../store/settings'
import { aggregate, isConfident, type Candidate, type Reading, type StageId, STAGE_LABEL } from './aggregate'
import { AbortError, getPool, type OcrParams, type OcrPool, type OcrResult, type OcrWord } from './pool'

export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export type MarkKind = 'word' | 'anchor' | 'textline' | 'tile'

export type ScanEvent =
  | { type: 'stage'; stage: StageId; status: 'start' | 'done' | 'skip'; note?: string }
  | { type: 'focus'; id: number; stage: StageId; rect: Rect; label: string }
  | { type: 'unfocus'; id: number }
  | { type: 'peek'; stage: StageId; image: HTMLCanvasElement; text: string; label: string }
  | { type: 'marks'; kind: MarkKind; rects: Rect[] }
  | { type: 'reading'; reading: Reading }
  | { type: 'candidates'; candidates: Candidate[] }
  | { type: 'progress'; value: number; label: string }
  | { type: 'log'; level: LogLevel; message: string; stage?: StageId }
  | { type: 'model'; status: string; progress: number }

export interface ScanInput {
  canvas: HTMLCanvasElement
  pdfTextItems?: PdfTextItem[]
}

export const STAGES: StageId[] = ['pdf', 'layout', 'anchor', 'textline', 'tile']

const DIGIT_WHITELIST = 'T0123456789-'
const KEYWORD_RE = /(登録番号|登録No|登録NO|登録N0|適格請求書|インボイス|事業者番号|登録)/

interface Plan {
  maxAnchorRois: number
  targetHeights: number[]
  variants: Preprocess[]
  maxTextlines: number
  tileLevels: number[]
  tileVariants: Preprocess[]
}

const PLANS: Record<Settings['strength'], Plan> = {
  quick: { maxAnchorRois: 6, targetHeights: [40], variants: ['contrast'], maxTextlines: 6, tileLevels: [], tileVariants: ['contrast'] },
  standard: { maxAnchorRois: 12, targetHeights: [34, 48], variants: ['contrast', 'binary'], maxTextlines: 12, tileLevels: [2, 3], tileVariants: ['contrast'] },
  thorough: { maxAnchorRois: 24, targetHeights: [28, 40, 56], variants: ['contrast', 'binary', 'gray'], maxTextlines: 30, tileLevels: [2, 3, 4], tileVariants: ['contrast', 'binary'] },
}

const STAGE_SPAN: Record<StageId, [number, number]> = {
  pdf: [0.02, 0.05],
  layout: [0.05, 0.3],
  anchor: [0.3, 0.55],
  textline: [0.55, 0.75],
  tile: [0.75, 1],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
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

interface Row { words: OcrWord[]; rect: Rect; text: string }

/** Tesseract の行分割に頼らず、単語を y 中心と x 間隔で行にまとめ直す */
export function groupWordsIntoRows(words: OcrWord[]): Row[] {
  const ws = words.filter((w) => w.text.trim() && w.rect.w > 0 && w.rect.h > 0).sort((a, b) => a.rect.x - b.rect.x)
  const rows: { words: OcrWord[] }[] = []
  for (const w of ws) {
    const cy = w.rect.y + w.rect.h / 2
    const row = rows.find((r) => {
      const last = r.words[r.words.length - 1]
      const lh = Math.max(last.rect.h, w.rect.h)
      const lcy = last.rect.y + last.rect.h / 2
      const gap = w.rect.x - (last.rect.x + last.rect.w)
      return Math.abs(lcy - cy) < lh * 0.5 && gap < lh * 2.5 && gap > -lh
    })
    if (row) row.words.push(w)
    else rows.push({ words: [w] })
  }
  return rows.map((r) => ({ words: r.words, rect: unionRect(r.words.map((w) => w.rect)), text: r.words.map((w) => w.text).join(' ') }))
}

/** OCR 結果から T番号の読み取りを作る。mapRect で元画像座標へ変換。 */
export function readingsFromOcr(res: OcrResult, mapRect: (r: Rect) => Rect, stage: StageId, detail: string): Reading[] {
  const words = res.lines.flatMap((l) => l.words)
  const rows = groupWordsIntoRows(words)
  const out: Reading[] = []
  for (const row of rows) {
    const spans: { start: number; end: number; w: OcrWord }[] = []
    let text = ''
    for (const w of row.words) {
      if (text) text += ' '
      spans.push({ start: text.length, end: text.length + w.text.length, w })
      text += w.text
    }
    for (const m of extractTNumbers(text)) {
      const hit = spans.filter((s) => s.end > m.start && s.start < m.end)
      if (hit.length === 0) continue
      const conf = hit.reduce((s, h) => s + h.w.conf, 0) / hit.length
      out.push({
        digits: m.digits,
        hasT: m.hasT,
        valid: m.valid,
        conf,
        stage,
        rect: mapRect(unionRect(hit.map((h) => h.w.rect))),
        substitutions: m.substitutions,
        raw: m.raw,
        detail,
      })
    }
  }
  return out
}

export async function runScan(
  input: ScanInput,
  settings: Settings,
  emit: (e: ScanEvent) => void,
  signal: AbortSignal,
): Promise<Candidate[]> {
  const src = input.canvas
  const W = src.width
  const H = src.height
  const plan = PLANS[settings.strength]
  const readings: Reading[] = []
  let focusId = 0
  let candidates: Candidate[] = []

  const check = () => {
    if (signal.aborted) throw new AbortError()
  }
  const log = (level: LogLevel, message: string, stage?: StageId) => emit({ type: 'log', level, message, stage })
  const progress = (stage: StageId, frac: number) => {
    const [a, b] = STAGE_SPAN[stage]
    emit({ type: 'progress', value: a + (b - a) * Math.max(0, Math.min(1, frac)), label: STAGE_LABEL[stage] })
  }
  const addReadings = (rs: Reading[]) => {
    if (rs.length === 0) return
    const before = new Set(candidates.filter((c) => c.valid).map((c) => c.digits))
    for (const r of rs) {
      readings.push(r)
      emit({ type: 'reading', reading: r })
    }
    candidates = aggregate(readings)
    emit({ type: 'candidates', candidates })
    for (const c of candidates) {
      if (c.valid && !before.has(c.digits)) log('success', `検算OKの候補を発見: T${c.digits}`, rs[0].stage)
    }
  }
  const confident = () => settings.earlyExit && isConfident(candidates)

  // ---------- モデル準備 ----------
  const layoutLang = settings.useJapanese ? 'jpn+eng' : 'eng'
  const layoutPool = getPool(layoutLang, 1)
  const digitPool = getPool('eng', settings.workers)
  log('info', `OCRモデルを準備中(${layoutLang} / 数字用 eng ×${settings.workers})…初回はダウンロードに時間がかかります`)
  emit({ type: 'progress', value: 0.01, label: 'OCRモデル準備' })
  await Promise.all([
    layoutPool.init((status, p) => emit({ type: 'model', status, progress: p })),
    digitPool.init(),
  ])
  check()
  emit({ type: 'model', status: 'ready', progress: 1 })

  /** 切り出し → 前処理 → OCR → 読み取り登録 */
  const readCrop = async (pool: OcrPool, rect: Rect, scale: number, mode: Preprocess, params: OcrParams, stage: StageId, label: string) => {
    check()
    const r = clampRect(rect, W, H)
    const pad = 16
    const crop = cropForOcr(src, r, scale, mode, pad)
    const id = ++focusId
    if (settings.showAnimation) emit({ type: 'focus', id, stage, rect: r, label })
    try {
      const res = await pool.recognize(crop, params, signal)
      check()
      const detail = `${mode} ×${scale.toFixed(2)} psm${params.psm}`
      const found = readingsFromOcr(res, (q) => ({ x: r.x + (q.x - pad) / scale, y: r.y + (q.y - pad) / scale, w: q.w / scale, h: q.h / scale }), stage, detail)
      if (settings.showAnimation) emit({ type: 'peek', stage, image: crop, text: res.text.trim(), label: `${label}(${detail})` })
      addReadings(found)
      if (settings.slowMo > 0) await sleep(settings.slowMo)
      return { res, found }
    } finally {
      if (settings.showAnimation) emit({ type: 'unfocus', id })
    }
  }

  /** 複数ジョブを並列実行(プールが自動で振り分け)。進捗も更新。 */
  const runAll = async <T>(stage: StageId, jobs: (() => Promise<T>)[], stopWhenConfident = true) => {
    let done = 0
    const results: T[] = []
    // 先に全部キューへ入れると早期終了できないので、ワーカー数ずつ流す
    const batch = Math.max(1, settings.workers)
    for (let i = 0; i < jobs.length; i += batch) {
      check()
      if (stopWhenConfident && confident()) {
        log('info', '十分確からしい候補があるため、残りを省略しました', stage)
        break
      }
      const rs = await Promise.all(jobs.slice(i, i + batch).map((j) => j().finally(() => progress(stage, ++done / jobs.length))))
      results.push(...rs)
    }
    return results
  }

  // ---------- Stage 0: PDF テキスト層 ----------
  emit({ type: 'stage', stage: 'pdf', status: input.pdfTextItems ? 'start' : 'skip', note: input.pdfTextItems ? undefined : 'PDFではありません' })
  if (input.pdfTextItems) {
    const items = input.pdfTextItems
    // 行ごと(y の近いもの)に連結して抽出
    const rows: PdfTextItem[][] = []
    for (const it of [...items].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
      const row = rows.find((r) => Math.abs(r[0].rect.y + r[0].rect.h / 2 - (it.rect.y + it.rect.h / 2)) < Math.max(r[0].rect.h, it.rect.h) * 0.5)
      if (row) row.push(it)
      else rows.push([it])
    }
    const found: Reading[] = []
    for (const row of rows) {
      row.sort((a, b) => a.rect.x - b.rect.x)
      let text = ''
      const spans: { start: number; end: number; it: PdfTextItem }[] = []
      for (const it of row) {
        if (text) text += ' '
        spans.push({ start: text.length, end: text.length + it.str.length, it })
        text += it.str
      }
      for (const m of extractTNumbers(text)) {
        const hit = spans.filter((s) => s.end > m.start && s.start < m.end)
        found.push({ digits: m.digits, hasT: m.hasT, valid: m.valid, conf: 99, stage: 'pdf', rect: unionRect(hit.map((h) => h.it.rect)), substitutions: m.substitutions, raw: m.raw, detail: 'テキスト層' })
      }
    }
    log(found.length ? 'success' : 'info', found.length ? `PDFのテキスト層から ${found.length} 件抽出` : `PDFテキスト層(${items.length}要素)にT番号は見当たりません`, 'pdf')
    addReadings(found)
    emit({ type: 'stage', stage: 'pdf', status: 'done' })
    progress('pdf', 1)
  }

  // ---------- Stage 1: 全体レイアウト解析 ----------
  check()
  let layoutRows: Row[] = []
  let charH = 0
  if (confident()) {
    emit({ type: 'stage', stage: 'layout', status: 'skip', note: 'テキスト層で確定' })
  } else {
    emit({ type: 'stage', stage: 'layout', status: 'start' })
    const { canvas: small, scale: s } = downscale(src, 2400)
    log('info', `全体を ${small.width}×${small.height}px でレイアウト解析`, 'layout')
    progress('layout', 0)
    layoutPool.onRecognizeProgress = (p) => progress('layout', p * 0.95)
    const { res } = await readCrop(layoutPool, { x: 0, y: 0, w: W, h: H }, s, 'gray', { psm: '3' }, 'layout', '全体').finally(() => {
      layoutPool.onRecognizeProgress = null
    })
    const map = (q: Rect): Rect => ({ x: (q.x - 16) / s, y: (q.y - 16) / s, w: q.w / s, h: q.h / s })
    const words = res.lines.flatMap((l) => l.words).map((w) => ({ ...w, rect: map(w.rect), symbols: [] }))
    layoutRows = groupWordsIntoRows(words)
    emit({ type: 'marks', kind: 'word', rects: words.map((w) => w.rect) })
    const digitWordHeights = words.filter((w) => /\d/.test(w.text)).map((w) => w.rect.h)
    charH = median(digitWordHeights) || median(words.map((w) => w.rect.h)) || H / 80
    log('info', `${words.length} 語を検出。推定文字高 ≒ ${charH.toFixed(1)}px`, 'layout')
    emit({ type: 'stage', stage: 'layout', status: 'done' })
  }
  progress('layout', 1)

  // ---------- Stage 2: アンカー周辺精査 ----------
  check()
  const anchorRois: { rect: Rect; h: number; label: string }[] = []
  if (layoutRows.length === 0 || confident()) {
    emit({ type: 'stage', stage: 'anchor', status: 'skip', note: layoutRows.length === 0 ? 'アンカーなし' : '確定済み' })
  } else {
    emit({ type: 'stage', stage: 'anchor', status: 'start' })
    const anchorRects: Rect[] = []
    const pushRoi = (rect: Rect, h: number, label: string) => {
      const r = clampRect(rect, W, H)
      if (r.w < 4 || r.h < 4) return
      if (anchorRois.some((a) => overlapRatio(a.rect, r) > 0.75)) return
      anchorRois.push({ rect: r, h, label })
    }
    for (const row of layoutRows) {
      const rowH = median(row.words.map((w) => w.rect.h)) || charH
      // T で始まり数字が続く語
      row.words.forEach((w, i) => {
        const t = toHalfWidth(w.text)
        const next = row.words[i + 1]
        const isT = /^[TtＴ][\d\-OIlSB]/.test(t) || (/^[TtＴ]$/.test(t) && next && /^\d/.test(toHalfWidth(next.text)))
        if (!isT) return
        const h = w.rect.h || rowH
        anchorRects.push(w.rect)
        pushRoi({ x: w.rect.x - h * 0.8, y: w.rect.y - h * 0.7, w: h * 19, h: h * 2.4 }, h, `「${w.text.slice(0, 6)}」の右側`)
      })
      // キーワード(登録番号など)
      const compact = toHalfWidth(row.words.map((w) => w.text).join('')).replace(/\s/g, '')
      const m = KEYWORD_RE.exec(compact)
      if (m) {
        const endOffset = m.index + m[0].length
        let acc = 0
        let endWord = row.words[row.words.length - 1]
        for (const w of row.words) {
          acc += toHalfWidth(w.text).replace(/\s/g, '').length
          if (acc >= endOffset) { endWord = w; break }
        }
        const endX = endWord.rect.x + endWord.rect.w
        const kwRect = unionRect(row.words.slice(0, row.words.indexOf(endWord) + 1).map((w) => w.rect))
        anchorRects.push(kwRect)
        const h = rowH
        pushRoi({ x: endX, y: row.rect.y - h * 0.6, w: h * 22, h: row.rect.h + h * 1.2 }, h, `「${m[0]}」の右側`)
        pushRoi({ x: kwRect.x - h * 2, y: row.rect.y + row.rect.h - h * 0.3, w: h * 24, h: h * 2.6 }, h, `「${m[0]}」の下側`)
      }
    }
    emit({ type: 'marks', kind: 'anchor', rects: anchorRects })
    const rois = anchorRois.slice(0, plan.maxAnchorRois)
    log('info', `アンカー ${anchorRects.length} 個 → 精査領域 ${rois.length} 個`, 'anchor')
    const jobs = rois.flatMap((roi) =>
      plan.targetHeights.flatMap((th) =>
        plan.variants.map((v) => () => readCrop(digitPool, roi.rect, Math.max(0.5, Math.min(6, th / roi.h)), v, { psm: '7', whitelist: DIGIT_WHITELIST }, 'anchor', roi.label)),
      ),
    )
    await runAll('anchor', jobs)
    emit({ type: 'stage', stage: 'anchor', status: 'done' })
  }
  progress('anchor', 1)

  // ---------- Stage 3: 文字列らしさ検出 ----------
  check()
  if (confident()) {
    emit({ type: 'stage', stage: 'textline', status: 'skip', note: '確定済み' })
  } else {
    emit({ type: 'stage', stage: 'textline', status: 'start' })
    const { canvas: small, scale: s } = downscale(src, 2000)
    const gray = toGray(small)
    const bin = binarize(gray, otsuThreshold(gray))
    const cc = connectedComponents(bin, small.width, small.height)
    const lines = findTextLines(cc, { minChars: 11, maxChars: 26, minCharHeight: 5, maxCharHeight: small.height / 8 })
      .map((l) => ({ ...l, x: l.x / s, y: l.y / s, w: l.w / s, h: l.h / s, charHeight: l.charHeight / s }))
      .filter((l) => !anchorRois.some((a) => overlapRatio(a.rect, l) > 0.85))
    const picked = lines.filter((l) => l.score > 0.3).slice(0, plan.maxTextlines)
    emit({ type: 'marks', kind: 'textline', rects: picked })
    log('info', `連結成分 ${cc.length} 個から、文字が並ぶ領域を ${lines.length} 個検出 → 上位 ${picked.length} 個を精査`, 'textline')
    const jobs = picked.flatMap((l) =>
      plan.variants.slice(0, 2).map((v) => () => {
        const h = l.charHeight
        const rect = { x: l.x - h * 1.5, y: l.y - h * 0.5, w: l.w + h * 2.5, h: l.h + h }
        return readCrop(digitPool, rect, Math.max(0.5, Math.min(6, 40 / h)), v, { psm: '7', whitelist: DIGIT_WHITELIST }, 'textline', `${l.count}文字の並び`)
      }),
    )
    await runAll('textline', jobs)
    emit({ type: 'stage', stage: 'textline', status: 'done' })
  }
  progress('textline', 1)

  // ---------- Stage 4: タイル走査 ----------
  check()
  let levels = plan.tileLevels
  if (levels.length === 0 && !candidates.some((c) => c.valid)) levels = [2]
  if (confident() || levels.length === 0) {
    emit({ type: 'stage', stage: 'tile', status: 'skip', note: confident() ? '確定済み' : '不要' })
  } else {
    emit({ type: 'stage', stage: 'tile', status: 'start' })
    const jobs: (() => Promise<unknown>)[] = []
    const allTiles: Rect[] = []
    for (const n of levels) {
      const long = Math.max(W, H)
      const tileSide = long / (n - (n - 1) * 0.25)
      const step = tileSide * 0.75
      const cols = Math.max(1, Math.ceil((W - tileSide) / step) + 1)
      const rows = Math.max(1, Math.ceil((H - tileSide) / step) + 1)
      for (let ry = 0; ry < rows; ry++) {
        for (let cx = 0; cx < cols; cx++) {
          const rect = clampRect({ x: Math.min(cx * step, Math.max(0, W - tileSide)), y: Math.min(ry * step, Math.max(0, H - tileSide)), w: tileSide, h: tileSide }, W, H)
          allTiles.push(rect)
          const scale = Math.max(0.5, Math.min(4, 2000 / Math.max(rect.w, rect.h)))
          for (const v of plan.tileVariants) {
            jobs.push(() => readCrop(digitPool, rect, scale, v, { psm: '11', whitelist: DIGIT_WHITELIST }, 'tile', `ズーム${n} タイル(${cx + 1},${ry + 1})`))
          }
        }
      }
    }
    emit({ type: 'marks', kind: 'tile', rects: allTiles })
    log('info', `ズームレベル ${levels.join(' → ')} で ${allTiles.length} タイルを走査`, 'tile')
    await runAll('tile', jobs)
    emit({ type: 'stage', stage: 'tile', status: 'done' })
  }
  progress('tile', 1)

  const valid = candidates.filter((c) => c.valid)
  if (valid.length) log('success', `完了: 検算OKの候補 ${valid.length} 件(最有力 T${valid[0].digits})`)
  else if (candidates.length) log('warn', '完了: 検算OKの候補はありませんでした。画像の向き・解像度をご確認ください')
  else log('warn', '完了: T番号らしい文字列は見つかりませんでした')
  emit({ type: 'progress', value: 1, label: '完了' })
  return candidates
}
