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
import { clampRect, cropForOcr, downscale, findTextBand, iou, rotateCanvas, otsuThreshold, overlapRatio, toGray } from '../image'
import type { PdfTextItem } from '../pdf'
import { normalizeRow, repairKeywords, type TextRow } from '../requirements'
import { groupFullRows } from '../rows'
import { binarize, connectedComponents, findTextLines, type TextLine } from '../textlines'
import { extractTNumbers, toHalfWidth } from '../tnumber'
import type { Settings } from '../../store/settings'
import { aggregate, isConfident, isPrimary, type Candidate, type Reading, type StageId, STAGE_LABEL } from './aggregate'
import { AbortError, getPool, type OcrParams, type OcrResult, type OcrWord } from './pool'
import type { EngineId, OcrBackend } from './engine'
import { getPaddle } from './paddle'

export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export type MarkKind = 'word' | 'anchor' | 'textline' | 'tile' | 'detail'

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
  | { type: 'textrows'; source: 'pdf' | 'ocr'; rows: TextRow[]; refined?: number }
  | { type: 'engine'; engine: EngineId; label: string }
  /** 向きを補正した画像(以降の座標はこの画像基準) */
  | { type: 'image'; canvas: HTMLCanvasElement; rotation: 90 | 180 | 270 }

export interface ScanInput {
  canvas: HTMLCanvasElement
  pdfTextItems?: PdfTextItem[]
}

export const STAGES: StageId[] = ['pdf', 'layout', 'anchor', 'textline', 'tile', 'detail']

const DIGIT_WHITELIST = 'T0123456789-'
const KEYWORD_RE = /(登録番号|登録No|登録NO|登録N0|適格請求書|インボイス|事業者番号|登録)/

interface Plan {
  /** 記載事項精査で読み直す行数の上限 */
  maxDetailRows: number
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
  quick: { maxDetailRows: 6, layoutMaxSide: 2000, maxAnchorRois: 6, targetHeights: [52], variants: ['contrast'], maxTextlines: 6, tileLevels: [], tileVariants: ['contrast'] },
  standard: { maxDetailRows: 16, layoutMaxSide: 2800, maxAnchorRois: 12, targetHeights: [48, 64], variants: ['contrast', 'adaptive'], maxTextlines: 12, tileLevels: [2, 3], tileVariants: ['contrast'] },
  thorough: { maxDetailRows: 32, layoutMaxSide: 3600, maxAnchorRois: 24, targetHeights: [36, 52, 72], variants: ['contrast', 'adaptive', 'binary'], maxTextlines: 30, tileLevels: [2, 3, 4], tileVariants: ['contrast', 'adaptive'] },
}

/**
 * PaddleOCR 用: 認識器は行画像を高さ48pxに正規化するので倍率違いは不要、
 * 全体解析で行をほぼ取りこぼさないため、タイル走査は徹底時のみ。
 */
const PADDLE_PLANS: Record<Settings['strength'], Plan> = {
  quick: { maxDetailRows: 6, layoutMaxSide: 1600, maxAnchorRois: 6, targetHeights: [48], variants: ['contrast'], maxTextlines: 4, tileLevels: [], tileVariants: ['contrast'] },
  standard: { maxDetailRows: 16, layoutMaxSide: 2400, maxAnchorRois: 12, targetHeights: [48], variants: ['contrast', 'gray'], maxTextlines: 8, tileLevels: [], tileVariants: ['contrast'] },
  thorough: { maxDetailRows: 32, layoutMaxSide: 3200, maxAnchorRois: 24, targetHeights: [40, 64], variants: ['contrast', 'gray'], maxTextlines: 20, tileLevels: [2], tileVariants: ['contrast'] },
}

const STAGE_SPAN: Record<StageId, [number, number]> = {
  pdf: [0.02, 0.05],
  layout: [0.05, 0.3],
  anchor: [0.3, 0.55],
  textline: [0.55, 0.72],
  tile: [0.72, 0.86],
  detail: [0.86, 1],
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 次の描画フレームまで待つ(画面を固めないため) */
const nextFrame = () =>
  new Promise<void>((r) => {
    // 非表示タブでは requestAnimationFrame が止まるので、タイムアウトでも進める
    const t = setTimeout(r, 100)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(() => (clearTimeout(t), r()), 0))
  })
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

/** 記載事項精査の対象として、その行がどれだけ有望か(2以上で対象) */
export function detailRowScore(raw: string, index: number, regIdx: number): number {
  const n = repairKeywords(normalizeRow(raw))
  let s = 0
  if (/[¥]\s?[\d,]+|[\d,]{3,}\s?円/.test(n)) s += 3
  if (/(10|8)\s?%/.test(n)) s += 2
  if (/\d{1,4}\s?[年/.\-]\s?\d{1,2}\s?[月/.\-]\s?\d{1,2}/.test(n)) s += 3
  if (/(合計|小計|対象|消費税|税額|内税|外税|税込|税抜|請求金額|領収|但し|品名|摘要|明細|軽減|※)/.test(n)) s += 2
  if (/(御中|様|殿)/.test(n)) s += 3
  if (/(株式会社|有限会社|合同会社|\(株\)|㈱|店|事務所)/.test(n)) s += 2
  if (regIdx >= 0 && Math.abs(index - regIdx) <= 2) s += 2
  if (index < 3) s += 1
  return s
}

/** a の文字が順番どおり b に含まれるか(b は a から文字を取りこぼしていない) */
function isSubsequence(a: string, b: string): boolean {
  let i = 0
  for (let j = 0; j < b.length && i < a.length; j++) if (a[i] === b[j]) i++
  return i === a.length
}

/**
 * 同じ箇所の複数の読みから1つを選ぶ。
 * 軽量OCRの誤りは「文字の取りこぼし」が多いので、他の読みを部分列として含む(=取りこぼしが少ない)読みを高く評価する。
 * あわせて完全一致の票数、数字列(金額・日付)の一致、信頼度を加味する。
 */
export function voteRowText(readings: { text: string; conf: number; weight?: number }[]): string {
  // 表の罫線が「|」として読まれることがあるので投票では無視する
  const norm = (t: string) => repairKeywords(normalizeRow(t)).replace(/[\s|｜]/g, '')
  const items = readings.map((r) => ({ ...r, w: r.weight ?? 1, key: norm(r.text) })).filter((r) => r.key)
  if (items.length === 0) return readings[0]?.text ?? ''
  const digitKey = (k: string) => k.replace(/[^\d]/g, '')
  let best: { text: string; score: number } | null = null
  for (const c of items) {
    let score = c.conf / 100 + (c.w - 1) * 2
    for (const o of items) {
      if (o === c) continue
      if (o.key === c.key) score += 2 * o.w
      else if (isSubsequence(o.key, c.key)) score += 1 * o.w
      if (digitKey(o.key) === digitKey(c.key)) score += 0.5 * o.w
    }
    score += c.key.length / 1000
    if (!best || score > best.score) best = { text: c.text, score }
  }
  return best!.text.replace(/^[|｜\s]+|[|｜\s]+$/g, '')
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

/**
 * 画像の向きを推定する。文字行の検出枠が縦長ばかりなら横倒し、
 * 横長の行を 0°/180° で読み比べて信頼度が大きく違えば上下逆、と判断する。
 * 返り値は時計回りに回すべき角度(不要なら null)。
 */
async function detectRotation(src: HTMLCanvasElement, backend: OcrBackend, signal: AbortSignal): Promise<90 | 180 | 270 | null> {
  const { canvas: small, scale } = downscale(src, 1280)
  const det = await backend.recognize(small, { psm: '11', detectOnly: true }, signal)
  const boxes = det.lines.map((l) => l.rect).filter((r) => r.w * r.h > 60)
  if (boxes.length < 4) return null
  const tall = boxes.filter((r) => r.h > r.w * 1.5)
  const wide = boxes.filter((r) => r.w > r.h * 2)
  /** 候補の角度ごとに、行画像を回して読んだときの平均信頼度 */
  const score = async (rects: Rect[], degs: (0 | 90 | 180 | 270)[]) => {
    const out = new Map<number, number>()
    for (const d of degs) {
      let s = 0
      for (const r of rects) {
        const crop = cropForOcr(src, { x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale }, 1, 'gray', 4)
        const img = d === 0 ? crop : rotateCanvas(crop, d)
        const res = await backend.recognize(img, { psm: '7' }, signal)
        s += res.text.replace(/\s/g, '').length >= 2 ? res.conf : 0
      }
      out.set(d, s / rects.length)
    }
    return out
  }
  const biggest = (rs: Rect[]) => [...rs].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 4)
  if (tall.length >= boxes.length * 0.6 && tall.length >= 4) {
    // 横倒し: 縦長の行を 90°/270° 回して読み比べ
    const s = await score(biggest(tall), [90, 270])
    return (s.get(90) ?? 0) >= (s.get(270) ?? 0) ? 90 : 270
  }
  if (wide.length >= 3) {
    const s = await score(biggest(wide), [0, 180])
    if ((s.get(180) ?? 0) > (s.get(0) ?? 0) + 15) return 180
  }
  return null
}

export async function runScan(
  input: ScanInput,
  settings: Settings,
  emit: (e: ScanEvent) => void,
  signal: AbortSignal,
): Promise<Candidate[]> {
  // 向き補正で差し替わることがあるので let
  let src = input.canvas
  let W = src.width
  let H = src.height
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
  /** ページ内の「登録番号」の数(1枚に複数のインボイスがあるとき、その数だけ番号を見つけるまで続ける) */
  let expectedNumbers = 1
  const confident = () =>
    settings.earlyExit && isConfident(candidates) && new Set(candidates.filter(isPrimary).map((c) => c.digits)).size >= expectedNumbers

  // ---------- モデル準備 ----------
  emit({ type: 'progress', value: 0.01, label: 'OCRモデル準備' })
  // 画像の表示を先に描画させる(重い処理の前にブラウザへ制御を返す)
  await nextFrame()
  const onModel = (status: string, p: number) => emit({ type: 'model', status, progress: p })
  let engine: EngineId = settings.engine
  let layoutPool!: OcrBackend
  let digitPool!: OcrBackend
  if (engine === 'paddle') {
    const paddle = getPaddle(settings.paddleBackend)
    log('info', 'PaddleOCR(PP-OCRv5)を準備中…初回はモデル(約50MB)のダウンロードに時間がかかります')
    try {
      await paddle.init(onModel)
      layoutPool = digitPool = paddle
    } catch (e) {
      console.error(e)
      log('warn', `PaddleOCR を起動できなかったため Tesseract に切り替えます: ${(e as Error).message}`)
      engine = 'tesseract'
    }
  }
  if (engine === 'tesseract') {
    const layoutLang = settings.useJapanese ? 'jpn+eng' : 'eng'
    layoutPool = getPool(layoutLang, 1)
    digitPool = getPool('eng', settings.workers)
    log('info', `Tesseract を準備中(${layoutLang} / 数字用 eng ×${settings.workers})…初回はダウンロードに時間がかかります`)
    await Promise.all([layoutPool.init(onModel), digitPool.init()])
  }
  check()
  emit({ type: 'model', status: 'ready', progress: 1 })
  emit({ type: 'engine', engine, label: layoutPool.label })
  log('info', `OCRエンジン: ${layoutPool.label}`)
  const plan = (engine === 'paddle' ? PADDLE_PLANS : PLANS)[settings.strength]

  /** 切り出し → 前処理 → OCR → 読み取り登録 */
  const readCrop = async (pool: OcrBackend, rect: Rect, scale: number, mode: Preprocess, params: OcrParams, stage: StageId, label: string) => {
    check()
    await sleep(0)
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

  // ---------- 向きの自動補正(PaddleOCR・画像のみ) ----------
  if (engine === 'paddle' && settings.autoRotate && !confident() && !(input.pdfTextItems && input.pdfTextItems.length > 5)) {
    const rot = await detectRotation(src, layoutPool, signal)
    if (rot) {
      src = rotateCanvas(src, rot)
      W = src.width
      H = src.height
      emit({ type: 'image', canvas: src, rotation: rot })
      log('info', `画像の向きを自動補正しました(${rot === 180 ? '上下反転' : rot === 90 ? '右に90°回転' : '左に90°回転'})`, 'layout')
    }
  }

  // ---------- Stage 1: 全体レイアウト解析 ----------
  check()
  let layoutRows: Row[] = []
  /** 記載事項チェック用の全文(行単位、OCR のとき) */
  let fullRows: TextRow[] | null = null
  /** 単語ごとの文字高(シンボル基準) */
  const wordCharH = new Map<OcrWord, number>()
  let charH = 0
  if (confident()) {
    emit({ type: 'stage', stage: 'layout', status: 'skip', note: 'テキスト層で確定' })
  } else {
    emit({ type: 'stage', stage: 'layout', status: 'start' })
    // 大きい画像は縮小、小さい画像(スクショ等)は拡大して、日本語の文字が読める大きさにする
    const long = Math.max(W, H)
    // (PaddleOCR は検出時に内部で縮小するので拡大しない)
    const s = engine === 'paddle' ? Math.min(1, plan.layoutMaxSide / long) : Math.min(plan.layoutMaxSide / long, Math.max(1, Math.min(2.5, 2400 / long)))
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
      // PaddleOCR の枠は検出時に上下へ広げてある(unclip)ので、文字の高さは枠の約6割
      const boxH = (w.rect.h / s) * (engine === 'paddle' ? 0.62 : 1)
      return { ...w, rect: map(w.rect), symbols: w.symbols.map((sy) => ({ ...sy, rect: map(sy.rect) })), ch: ch > 0 && engine !== 'paddle' ? Math.min(ch, boxH) : boxH }
    })
    for (const w of words) wordCharH.set(w, w.ch)
    layoutRows = groupWordsIntoRows(words)
    expectedNumbers = Math.max(1, Math.min(8, words.filter((w) => /登録番号|登録No|登録NO/.test(repairKeywords(normalizeRow(w.text)))).length))
    if (expectedNumbers > 1) log('info', `「登録番号」が ${expectedNumbers} か所あります(複数のインボイス)。すべて見つかるまで捜査します`, 'layout')
    emit({ type: 'marks', kind: 'word', rects: words.map((w) => w.rect) })
    if (!input.pdfTextItems || input.pdfTextItems.length <= 5) {
      fullRows = groupFullRows(words)
      emit({ type: 'textrows', source: 'ocr', rows: fullRows })
    }
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
      // 横に並んだ別のインボイスの行を拾わないよう、領域の左端(キーワードの直後)に近い行を優先
      const xDist = (l: { x: number; w: number }) => (l.x <= r.x && l.x + l.w >= r.x ? 0 : Math.abs(l.x - r.x))
      const line = detectCcLines()
        .lines.filter((l) => Math.abs(l.y + l.h / 2 - rcy) < h * 0.9 && l.x + l.w > r.x && l.x < r.x + r.w && xDist(l) < h * 6)
        .sort((a, b) => Math.abs(a.y + a.h / 2 - rcy) / h + xDist(a) / (h * 2) - (Math.abs(b.y + b.h / 2 - rcy) / h + xDist(b) / (h * 2)))[0]
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
    // PaddleOCR: 横に引き伸ばした読みも加える(同じ数字の連続を取りこぼしにくい)
    const stretchJobs = engine === 'paddle'
      ? rois.filter((r) => !r.multi).map((roi) => () => readCrop(digitPool, roi.rect, Math.max(0.5, Math.min(6, 48 / roi.h)), 'contrast', { psm: '7', recStretch: 1.8 }, 'anchor', `${roi.label}(横に拡大)`))
      : []
    const jobs = [...stretchJobs, ...rois.flatMap((roi) =>
      roi.multi
        ? [() => readCrop(digitPool, roi.rect, Math.max(0.5, Math.min(6, plan.targetHeights[0] / roi.h)), 'contrast', { psm: '6', whitelist: DIGIT_WHITELIST }, 'anchor', roi.label)]
        : plan.targetHeights.flatMap((th) =>
        plan.variants.map((v) => () =>
          readCrop(digitPool, roi.rect, Math.max(0.5, Math.min(6, th / roi.h)), v, { psm: '7', whitelist: DIGIT_WHITELIST }, 'anchor', roi.label)),
      ),
    )]
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
        return readCrop(digitPool, rect, Math.max(0.5, Math.min(6, 52 / h)), v, { psm: '7', whitelist: DIGIT_WHITELIST, recStretch: engine === 'paddle' && v !== plan.variants[0] ? 1.8 : 1 }, 'textline', `${l.count}文字の並び`)
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

  // ---------- Stage 5: 記載事項精査 ----------
  // T番号と同じ考え方で、記載事項に関係しそうな行を拡大し、前処理を変えて何度も読み、多数決で確定する
  check()
  const japaneseCapable = engine === 'paddle' || settings.useJapanese
  if (!settings.refineRequirements || !fullRows || fullRows.length === 0 || !japaneseCapable) {
    emit({ type: 'stage', stage: 'detail', status: 'skip', note: !fullRows ? 'PDFテキスト層を使用' : '対象なし' })
  } else {
    emit({ type: 'stage', stage: 'detail', status: 'start' })
    const rows = fullRows
    const best = candidates.find(isPrimary)
    const regIdx = best ? rows.findIndex((r) => r.text.replace(/\D/g, '').includes(best.digits.slice(-8))) : -1
    const targets = rows
      .map((r, i) => ({ r, i, s: detailRowScore(r.text, i, regIdx) }))
      .filter((t) => t.s >= 2)
      .sort((a, b) => b.s - a.s)
      .slice(0, plan.maxDetailRows)
    emit({ type: 'marks', kind: 'detail', rects: targets.map((t) => t.r.rect) })
    log('info', `記載事項に関係しそうな ${targets.length} 行を拡大して読み直します`, 'detail')
    // 読み直しの切り出し方(余白の取り方 × 前処理)。余白で取りこぼす文字が変わるので複数で投票する
    const variants: { py: number; px: number; mode: Preprocess }[] =
      engine === 'paddle'
        ? [
            // 横の余白は控えめに(表の縦罫線を巻き込まない)
            { py: 0.5, px: 0.35, mode: 'gray' },
            { py: 0.15, px: 0.3, mode: 'contrast' },
            { py: 0.35, px: 0.6, mode: 'contrast' },
          ]
        : [
            { py: 0.25, px: 0.6, mode: 'contrast' },
            { py: 0.25, px: 0.6, mode: 'adaptive' },
          ]
    /** key: 行番号/部分番号 */
    const readings = new Map<string, { text: string; conf: number }[]>()
    const jobs = targets.flatMap((t) => {
      // PaddleOCR は検出した文字行ごと、Tesseract は行全体を読み直す
      const parts = engine === 'paddle' && t.r.parts?.length ? t.r.parts : [{ text: t.r.text, rect: t.r.rect, conf: undefined }]
      return parts.flatMap((part, pi) =>
        variants.map((v) => async () => {
          const h = part.rect.h
          const rect = { x: part.rect.x - h * v.px, y: part.rect.y - h * v.py, w: part.rect.w + h * v.px * 2, h: h * (1 + v.py * 2) }
          // Paddle は認識器が高さを揃えるので、小さい行だけ拡大。Tesseract は文字高 ≒ 48px に
          const scale = engine === 'paddle' ? Math.max(1, Math.min(4, 32 / h)) : Math.max(0.6, Math.min(5, 48 / h))
          const { res } = await readCrop(layoutPool, rect, scale, v.mode, { psm: '7' }, 'detail', `行${t.i + 1}`)
          const text = res.lines.map((l) => l.text).join(' ').trim()
          const key = `${t.i}/${pi}`
          if (text) (readings.get(key) ?? readings.set(key, []).get(key)!).push({ text, conf: res.conf })
        }),
      )
    })
    await runAll('detail', jobs, false)
    let changed = 0
    const refined = rows.map((r, i) => {
      const parts = engine === 'paddle' && r.parts?.length ? r.parts : [{ text: r.text, rect: r.rect, conf: undefined }]
      if (!parts.some((_, pi) => readings.has(`${i}/${pi}`))) return r
      const newParts = parts.map((p, pi) => {
        const rs = readings.get(`${i}/${pi}`)
        // 元の読み(全体の文脈で読んだもの)は 1.5 票分として扱う
        return rs ? { ...p, text: voteRowText([{ text: p.text, conf: p.conf ?? 60, weight: 1.5 }, ...rs]) } : p
      })
      const text = newParts.map((p) => p.text).join(' ')
      if (normalizeRow(text) !== normalizeRow(r.text)) changed++
      return { ...r, text, parts: newParts }
    })
    fullRows = refined
    emit({ type: 'textrows', source: 'ocr', rows: refined, refined: targets.length })
    log(changed ? 'success' : 'info', `記載事項精査: ${targets.length} 行を読み直し、${changed} 行をより確かな読みに更新`, 'detail')
    emit({ type: 'stage', stage: 'detail', status: 'done' })
  }
  progress('detail', 1)

  const valid = candidates.filter(isPrimary)
  if (valid.length) log('success', `完了: T番号の候補 ${valid.length} 件(最有力 T${valid[0].digits})`)
  else if (candidates.length) log('warn', '完了: 検算OKの候補はありませんでした。画像の向き・解像度をご確認ください')
  else log('warn', '完了: T番号らしい文字列は見つかりませんでした')
  emit({ type: 'progress', value: 1, label: '完了' })
  return candidates
}
