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
import { clampRect, cropForOcr, downscale, findTextBand, iou, otsuThreshold, overlapRatio, toGray } from '../image'
import type { PdfTextItem } from '../pdf'
import type { TextRow } from '../requirements'
import { binarize, connectedComponents, findTextLines, type TextLine } from '../textlines'
import { extractTNumbers, toHalfWidth } from '../tnumber'
import type { Settings } from '../../store/settings'
import { aggregate, isConfident, isPrimary, type Candidate, type Reading, type StageId, STAGE_LABEL } from './aggregate'
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
  | { type: 'textrows'; source: 'pdf' | 'ocr'; rows: TextRow[] }

export interface ScanInput {
  canvas: HTMLCanvasElement
  pdfTextItems?: PdfTextItem[]
}

export const STAGES: StageId[] = ['pdf', 'layout', 'anchor', 'textline', 'tile']

const DIGIT_WHITELIST = 'T0123456789-'
const KEYWORD_RE = /(登録番号|登録No|登録NO|登録N0|適格請求書|インボイス|事業者番号|登録)/

interface Plan {
  /** 全体レイアウト解析の最大辺(大きいほど小さい文字に強いが遅い) */
  layoutMaxSide: number
  maxAnchorRois: number
  targetHeights: number[]
  variants: Preprocess[]
  maxTextlines: number
  tileLevels: number[]
  tileVariants: Preprocess[]
}

const PLANS: Record<Settings['strength'], Plan> = {
  quick: { layoutMaxSide: 2000, maxAnchorRois: 6, targetHeights: [52], variants: ['contrast'], maxTextlines: 6, tileLevels: [], tileVariants: ['contrast'] },
  standard: { layoutMaxSide: 2800, maxAnchorRois: 12, targetHeights: [48, 64], variants: ['contrast', 'adaptive'], maxTextlines: 12, tileLevels: [2, 3], tileVariants: ['contrast'] },
  thorough: { layoutMaxSide: 3600, maxAnchorRois: 24, targetHeights: [36, 52, 72], variants: ['contrast', 'adaptive', 'binary'], maxTextlines: 30, tileLevels: [2, 3, 4], tileVariants: ['contrast', 'adaptive'] },
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

/**
 * 記載事項チェック用: y が重なる単語を、間隔に関係なく1行にまとめる
 * (レシートの「税率10%対象 ……… ¥40」のように左右に離れた項目と金額を同じ行にする)
 */
export function groupFullRows<T extends { text: string; rect: Rect }>(items: T[]): TextRow[] {
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
    return { text: r.map((w) => w.text).join(' '), rect: unionRect(r.map((w) => w.rect)) }
  })
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
  /** 「登録番号」や T の周辺(文脈)領域 */
  const contextRects: Rect[] = []
  const addReadings = (rs: Reading[]) => {
    if (rs.length === 0) return
    for (const r of rs) r.context ||= r.stage === 'anchor' || contextRects.some((c) => overlapRatio(c, r.rect) > 0.5)
    const before = new Set(candidates.filter((c) => c.valid).map((c) => c.digits))
    for (const r of rs) {
      readings.push(r)
      emit({ type: 'reading', reading: r })
    }
    candidates = aggregate(readings)
    emit({ type: 'candidates', candidates })
    for (const c of candidates) {
      if (isPrimary(c) && !before.has(c.digits)) log('success', `検算OKの候補を発見: T${c.digits}`, rs[0].stage)
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
    if (items.length > 5) emit({ type: 'textrows', source: 'pdf', rows: groupFullRows(items.map((it) => ({ text: it.str, rect: it.rect }))) })
    log(found.length ? 'success' : 'info', found.length ? `PDFのテキスト層から ${found.length} 件抽出` : `PDFテキスト層(${items.length}要素)にT番号は見当たりません`, 'pdf')
    addReadings(found)
    emit({ type: 'stage', stage: 'pdf', status: 'done' })
    progress('pdf', 1)
  }

  // ---------- Stage 1: 全体レイアウト解析 ----------
  check()
  let layoutRows: Row[] = []
  /** 単語ごとの文字高(シンボル基準) */
  const wordCharH = new Map<OcrWord, number>()
  let charH = 0
  if (confident()) {
    emit({ type: 'stage', stage: 'layout', status: 'skip', note: 'テキスト層で確定' })
  } else {
    emit({ type: 'stage', stage: 'layout', status: 'start' })
    // 大きい画像は縮小、小さい画像(スクショ等)は拡大して、日本語の文字が読める大きさにする
    const long = Math.max(W, H)
    const s = Math.min(plan.layoutMaxSide / long, Math.max(1, Math.min(2.5, 2400 / long)))
    log('info', `全体を ${Math.round(W * s)}×${Math.round(H * s)}px でレイアウト解析`, 'layout')
    progress('layout', 0)
    layoutPool.onRecognizeProgress = (p) => progress('layout', p * 0.95)
    const { res } = await readCrop(layoutPool, { x: 0, y: 0, w: W, h: H }, s, 'gray', { psm: '3' }, 'layout', '全体').finally(() => {
      layoutPool.onRecognizeProgress = null
    })
    const map = (q: Rect): Rect => ({ x: (q.x - 16) / s, y: (q.y - 16) / s, w: q.w / s, h: q.h / s })
    // 単語の枠は結合ミスで大きくなりがちなので、文字(シンボル)単位の高さを文字高として使う
    const words = res.lines.flatMap((l) => l.words).map((w) => {
      const sh = w.symbols.map((sy) => sy.rect.h).filter((h) => h > 0)
      const maxH = Math.max(0, ...sh)
      const ch = median(sh.filter((h) => h > maxH * 0.45)) / s
      return { ...w, rect: map(w.rect), symbols: w.symbols.map((sy) => ({ ...sy, rect: map(sy.rect) })), ch: ch > 0 ? Math.min(ch, w.rect.h / s) : w.rect.h / s }
    })
    for (const w of words) wordCharH.set(w, w.ch)
    layoutRows = groupWordsIntoRows(words)
    emit({ type: 'marks', kind: 'word', rects: words.map((w) => w.rect) })
    if (!input.pdfTextItems || input.pdfTextItems.length <= 5) emit({ type: 'textrows', source: 'ocr', rows: groupFullRows(words) })
    const digitWordHeights = words.filter((w) => /\d/.test(w.text)).map((w) => w.ch)
    charH = median(digitWordHeights) || median(words.map((w) => w.ch)) || H / 80
    log('info', `${words.length} 語を検出。推定文字高 ≒ ${charH.toFixed(1)}px`, 'layout')
    emit({ type: 'stage', stage: 'layout', status: 'done' })
  }
  progress('layout', 1)

  /** 連結成分による文字列検出(アンカー精査と Stage 3 で共用、1回だけ計算) */
  let ccCache: { lines: (TextLine & { charHeight: number })[]; count: number } | null = null
  const detectCcLines = () => {
    if (ccCache) return ccCache
    const { canvas: small, scale: s } = downscale(src, 2000)
    const gray = toGray(small)
    const th = otsuThreshold(gray)
    // 通常(黒文字)と反転(白抜き文字)の両方で連結成分を求める
    const cc = connectedComponents(binarize(gray, th), small.width, small.height)
    const ccInv = connectedComponents(binarize(gray, th, true), small.width, small.height)
    const lineOpts = { minChars: 8, maxChars: 26, minCharHeight: 5, maxCharHeight: small.height / 8 }
    const lines = [...findTextLines(cc, lineOpts), ...findTextLines(ccInv, lineOpts)]
      .sort((a, b) => b.score - a.score)
      .map((l) => ({ ...l, x: l.x / s, y: l.y / s, w: l.w / s, h: l.h / s, charHeight: l.charHeight / s, segments: l.segments.map((g) => ({ ...g, x: g.x / s, w: g.w / s })) }))
    ccCache = { lines, count: cc.length + ccInv.length }
    return ccCache
  }

  // ---------- Stage 2: アンカー周辺精査 ----------
  check()
  const anchorRois: { rect: Rect; h: number; label: string; multi?: boolean }[] = []
  if (layoutRows.length === 0 || confident()) {
    emit({ type: 'stage', stage: 'anchor', status: 'skip', note: layoutRows.length === 0 ? 'アンカーなし' : '確定済み' })
  } else {
    emit({ type: 'stage', stage: 'anchor', status: 'start' })
    const anchorRects: Rect[] = []
    const pushRoi = (rect: Rect, h: number, label: string) => {
      const r = clampRect(rect, W, H)
      if (r.w < 4 || r.h < 4) return
      if (anchorRois.some((a) => iou(a.rect, r) > 0.75)) return
      contextRects.push(r)
      const wide = clampRect({ x: r.x, y: r.y - h * 0.8, w: r.w, h: r.h + h * 1.6 }, W, H)
      const rcy = r.y + r.h / 2
      // 1) 連結成分で見つけた「文字が並ぶ行」が近くにあれば、その位置と文字高を採用(最も正確)
      const line = detectCcLines()
        .lines.filter((l) => Math.abs(l.y + l.h / 2 - rcy) < h * 0.9 && l.x + l.w > r.x && l.x < r.x + r.w)
        .sort((a, b) => Math.abs(a.y + a.h / 2 - rcy) - Math.abs(b.y + b.h / 2 - rcy))[0]
      // 2) なければ水平投影で文字の帯を探す
      const band = line ? null : findTextBand(src, wide, rcy)
      if (line) {
        const ch = line.charHeight
        const y = line.y - line.h * 0.4
        const lh = line.h * 1.8
        // T + 13桁(区切り込みで 12〜20 文字)らしい区間があれば、そこだけを切り出す
        const seg = line.segments.filter((g) => g.count >= 12 && g.count <= 20).sort((a, b) => b.count - a.count)[0]
        if (seg) {
          anchorRois.push({ rect: clampRect({ x: seg.x - ch * 1.2, y, w: seg.w + ch * 2.4, h: lh }, W, H), h: ch, label: `${label}・番号部分` })
        }
        const x0 = Math.min(r.x, line.x) - ch
        const x1 = line.x + line.w + ch * 1.5
        anchorRois.push({ rect: clampRect({ x: x0, y, w: x1 - x0, h: lh }, W, H), h: ch, label: `${label}・文字列` })
      } else if (band && band.h < h * 2.6 && band.h > h * 0.35) {
        const pad = band.h * 0.35
        anchorRois.push({ rect: clampRect({ x: r.x, y: band.y - pad, w: r.w, h: band.h + pad * 2 }, W, H), h: band.h, label })
      } else {
        anchorRois.push({ rect: r, h, label })
      }
      // 複数行のまま読む予備(psm6)
      anchorRois.push({ rect: wide, h, label: `${label}(複数行)`, multi: true })
    }
    for (const row of layoutRows) {
      const rowH = median(row.words.map((w) => wordCharH.get(w) ?? w.rect.h)) || charH
      // 行の中心(枠の結合ミスに強いよう、各単語の中心の中央値)
      const rowCy = median(row.words.map((w) => w.rect.y + w.rect.h / 2))
      // T で始まり数字が続く語
      row.words.forEach((w, i) => {
        const t = toHalfWidth(w.text)
        const next = row.words[i + 1]
        const isT = /^[TtＴ][\d\-OIlSB]/.test(t) || (/^[TtＴ]$/.test(t) && next && /^\d/.test(toHalfWidth(next.text)))
        if (!isT) return
        const h = wordCharH.get(w) || rowH
        const cy = w.rect.y + w.rect.h / 2
        anchorRects.push(w.rect)
        pushRoi({ x: w.rect.x - h * 0.8, y: cy - h * 1.1, w: h * 19, h: h * 2.2 }, h, `「${w.text.slice(0, 6)}」の右側`)
      })
      // キーワード(登録番号など)
      const compact = toHalfWidth(row.words.map((w) => w.text).join('')).replace(/\s/g, '')
      const m = KEYWORD_RE.exec(compact)
      if (m) {
        const endOffset = m.index + m[0].length
        let acc = 0
        let endWord = row.words[row.words.length - 1]
        let inWord = 0
        for (const w of row.words) {
          const len = toHalfWidth(w.text).replace(/\s/g, '').length
          if (acc + len >= endOffset) { endWord = w; inWord = endOffset - acc; break }
          acc += len
        }
        // 日本語では「登録番号T123…」が1語に結合されることがあるため、文字(シンボル)単位でキーワードの終わりを求める
        const wordLen = toHalfWidth(endWord.text).replace(/\s/g, '').length
        const sym = endWord.symbols.filter((sy) => sy.text.trim())[inWord - 1]
        const endX = sym && endWord.symbols.length === wordLen
          ? sym.rect.x + sym.rect.w
          : endWord.rect.x + (endWord.rect.w * inWord) / Math.max(1, wordLen)
        const kwRect = unionRect(row.words.slice(0, row.words.indexOf(endWord) + 1).map((w) => w.rect))
        anchorRects.push(kwRect)
        const h = rowH
        pushRoi({ x: endX, y: rowCy - h * 1.1, w: h * 22, h: h * 2.2 }, h, `「${m[0]}」の右側`)
        pushRoi({ x: kwRect.x - h * 2, y: rowCy + h * 0.5, w: h * 24, h: h * 2.4 }, h, `「${m[0]}」の下側`)
        // 念のためキーワードの少し手前から行全体も(位置推定がずれていても番号を含むように)
        pushRoi({ x: endX - h * 3, y: rowCy - h * 1.1, w: h * 26, h: h * 2.2 }, h, `「${m[0]}」の行`)
      }
    }
    emit({ type: 'marks', kind: 'anchor', rects: anchorRects })
    const rois = anchorRois.slice(0, plan.maxAnchorRois * 2)
    log('info', `アンカー ${anchorRects.length} 個 → 精査領域 ${rois.length} 個`, 'anchor')
    // 1行モード(psm7)。倍率と前処理を変えて複数回読み、投票する
    const jobs = rois.flatMap((roi) =>
      roi.multi
        ? [() => readCrop(digitPool, roi.rect, Math.max(0.5, Math.min(6, plan.targetHeights[0] / roi.h)), 'contrast', { psm: '6', whitelist: DIGIT_WHITELIST }, 'anchor', roi.label)]
        : plan.targetHeights.flatMap((th) =>
        plan.variants.map((v) => () =>
          readCrop(digitPool, roi.rect, Math.max(0.5, Math.min(6, th / roi.h)), v, { psm: '7', whitelist: DIGIT_WHITELIST }, 'anchor', roi.label)),
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
    const cc = detectCcLines()
    const lines = cc.lines.filter((l) => l.count >= 11 && !anchorRois.some((a) => overlapRatio(a.rect, l) > 0.85))
    const picked = lines.filter((l) => l.score > 0.3).slice(0, plan.maxTextlines)
    emit({ type: 'marks', kind: 'textline', rects: picked })
    log('info', `連結成分 ${cc.count} 個から、文字が並ぶ領域を ${lines.length} 個検出 → 上位 ${picked.length} 個を精査`, 'textline')
    const jobs = picked.flatMap((l) =>
      plan.variants.slice(0, 2).map((v) => () => {
        const h = l.charHeight
        const rect = { x: l.x - h * 1.5, y: l.y - h * 0.5, w: l.w + h * 2.5, h: l.h + h }
        return readCrop(digitPool, rect, Math.max(0.5, Math.min(6, 52 / h)), v, { psm: '7', whitelist: DIGIT_WHITELIST }, 'textline', `${l.count}文字の並び`)
      }),
    )
    await runAll('textline', jobs)
    emit({ type: 'stage', stage: 'textline', status: 'done' })
  }
  progress('textline', 1)

  // ---------- Stage 4: タイル走査 ----------
  check()
  let levels = plan.tileLevels
  if (levels.length === 0 && !candidates.some(isPrimary)) levels = [2]
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

  const valid = candidates.filter(isPrimary)
  if (valid.length) log('success', `完了: T番号の候補 ${valid.length} 件(最有力 T${valid[0].digits})`)
  else if (candidates.length) log('warn', '完了: 検算OKの候補はありませんでした。画像の向き・解像度をご確認ください')
  else log('warn', '完了: T番号らしい文字列は見つかりませんでした')
  emit({ type: 'progress', value: 1, label: '完了' })
  return candidates
}
