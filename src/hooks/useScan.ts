import { useCallback, useEffect, useRef, useState } from 'react'
import type { Rect } from '../lib/image'
import type { Candidate, Reading, StageId } from '../lib/ocr/aggregate'
import { runScan, type LogLevel, type MarkKind, type ScanEvent, type ScanInput } from '../lib/ocr/pipeline'
import { AbortError } from '../lib/ocr/pool'
import { pickSettings, useSettings } from '../store/settings'
import type { TextRow } from '../lib/requirements'
import type { EngineId } from '../lib/ocr/engine'

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'error' | 'aborted'
export type StageStatus = 'pending' | 'running' | 'done' | 'skip'

export interface LogEntry { id: number; t: number; level: LogLevel; message: string; stage?: StageId }
export interface Focus { id: number; stage: StageId; rect: Rect; label: string; since: number }
export interface Peek { stage: StageId; image: HTMLCanvasElement; text: string; label: string; n: number }

export interface ScanState {
  status: ScanStatus
  stages: Record<StageId, { status: StageStatus; note?: string }>
  focus: Focus[]
  marks: Record<MarkKind, Rect[]>
  peek: Peek | null
  readings: Reading[]
  candidates: Candidate[]
  logs: LogEntry[]
  progress: number
  progressLabel: string
  model: { status: string; progress: number } | null
  /** 記載事項チェック用の全文(行) */
  textRows: { source: 'pdf' | 'ocr'; rows: TextRow[] } | null
  /** 実際に使われた OCR エンジン(フォールバック後) */
  engine: { id: EngineId; label: string } | null
  /** 向き補正後の画像(補正したときのみ) */
  image: HTMLCanvasElement | null
  rotation: 0 | 90 | 180 | 270
  startedAt: number
  finishedAt: number
  error?: string
}

const initialStages = (): ScanState['stages'] => ({
  pdf: { status: 'pending' },
  layout: { status: 'pending' },
  anchor: { status: 'pending' },
  textline: { status: 'pending' },
  tile: { status: 'pending' },
})

const initial = (): ScanState => ({
  status: 'idle',
  stages: initialStages(),
  focus: [],
  marks: { word: [], anchor: [], textline: [], tile: [] },
  peek: null,
  readings: [],
  candidates: [],
  logs: [],
  progress: 0,
  progressLabel: '',
  model: null,
  textRows: null,
  engine: null,
  image: null,
  rotation: 0,
  startedAt: 0,
  finishedAt: 0,
})

/** スキャン実行とイベントの状態化。描画は requestAnimationFrame で間引く。 */
export function useScan() {
  const stateRef = useRef<ScanState>(initial())
  const [, setTick] = useState(0)
  const raf = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const logId = useRef(0)

  const flush = useCallback(() => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      setTick((t) => t + 1)
    })
  }, [])

  useEffect(() => () => {
    abortRef.current?.abort()
    cancelAnimationFrame(raf.current)
  }, [])

  const onEvent = useCallback((e: ScanEvent) => {
    const s = stateRef.current
    switch (e.type) {
      case 'stage':
        s.stages = { ...s.stages, [e.stage]: { status: e.status === 'start' ? 'running' : e.status, note: e.note } }
        break
      case 'focus':
        s.focus = [...s.focus, { id: e.id, stage: e.stage, rect: e.rect, label: e.label, since: performance.now() }]
        break
      case 'unfocus':
        s.focus = s.focus.filter((f) => f.id !== e.id)
        break
      case 'peek':
        s.peek = { stage: e.stage, image: e.image, text: e.text, label: e.label, n: (s.peek?.n ?? 0) + 1 }
        {
          // デバッグ用に直近のルーペ画像を保持(メモリを食わないよう上限あり)
          const w = window as unknown as { __invoicePeeks?: Peek[] }
          w.__invoicePeeks = [...(w.__invoicePeeks ?? []).slice(-59), s.peek]
        }
        break
      case 'marks':
        s.marks = { ...s.marks, [e.kind]: e.rects }
        break
      case 'reading':
        s.readings = [...s.readings, e.reading]
        break
      case 'candidates':
        s.candidates = e.candidates
        break
      case 'progress':
        s.progress = Math.max(s.progress, e.value)
        s.progressLabel = e.label
        break
      case 'log':
        s.logs = [...s.logs.slice(-199), { id: ++logId.current, t: performance.now() - s.startedAt, level: e.level, message: e.message, stage: e.stage }]
        break
      case 'image':
        s.image = e.canvas
        s.rotation = e.rotation
        break
      case 'engine':
        s.engine = { id: e.engine, label: e.label }
        break
      case 'textrows':
        s.textRows = { source: e.source, rows: e.rows }
        break
      case 'model':
        s.model = { status: e.status, progress: e.progress }
        break
    }
    // デバッグ用(開発者ツールから window.__invoiceScan で参照可能)
    ;(window as unknown as { __invoiceScan?: ScanState }).__invoiceScan = s
    flush()
  }, [flush])

  const start = useCallback(async (input: ScanInput) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    stateRef.current = { ...initial(), status: 'scanning', startedAt: performance.now() }
    ;(window as unknown as { __invoicePeeks?: Peek[] }).__invoicePeeks = []
    flush()
    try {
      const settings = pickSettings(useSettings.getState())
      const candidates = await runScan(input, settings, onEvent, ac.signal)
      if (abortRef.current !== ac) return
      stateRef.current = { ...stateRef.current, status: 'done', candidates, focus: [], finishedAt: performance.now() }
    } catch (err) {
      if (abortRef.current !== ac) return
      const aborted = err instanceof AbortError || ac.signal.aborted
      stateRef.current = {
        ...stateRef.current,
        status: aborted ? 'aborted' : 'error',
        focus: [],
        finishedAt: performance.now(),
        error: aborted ? undefined : String((err as Error)?.message ?? err),
      }
      if (!aborted) console.error(err)
    }
    flush()
  }, [flush, onEvent])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    stateRef.current = initial()
    flush()
  }, [flush])

  return { state: stateRef.current, start, abort, reset }
}
