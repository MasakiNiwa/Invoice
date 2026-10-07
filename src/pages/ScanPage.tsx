import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Cpu, Loader2, RotateCcw as RotateLeft, RotateCw as RotateRight, RotateCcw, ScrollText, Square, Upload } from 'lucide-react'
import { CandidateCard } from '../components/CandidateCard'
import { ImageInput } from '../components/ImageInput'
import { ManualCheck } from '../components/ManualCheck'
import { PeekPanel } from '../components/PeekPanel'
import { Legend, ScanViewer } from '../components/ScanViewer'
import { ScanLog } from '../components/ScanLog'
import { StageStepper } from '../components/StageStepper'
import { useScan } from '../hooks/useScan'
import { blobToCanvas, rotateCanvas } from '../lib/image'
import { isPdf, loadPdfPage, type PdfTextItem } from '../lib/pdf'
import { makeSampleInvoice } from '../lib/sample'
import { useSettings } from '../store/settings'
import { isPrimary } from '../lib/ocr/aggregate'
import { useSession } from '../store/session'
import { makeThumb, useHistory } from '../store/history'
import { checkRequirements } from '../lib/requirements'
import { RequirementsPanel } from '../components/RequirementsPanel'
import { ScanOverlay } from '../components/ScanOverlay'
import { EngineBadge } from '../components/EngineBadge'
import { usePreloadModels } from '../hooks/usePaddleStatus'
import type { Rect } from '../lib/image'

interface Doc {
  name: string
  canvas: HTMLCanvasElement
  pdf?: { file: File; page: number; numPages: number; textItems: PdfTextItem[] }
}

export default function ScanPage() {
  const { state, start, abort, reset } = useScan()
  usePreloadModels()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [hl, setHl] = useState<string | null>(null)
  const showCorrections = useSettings((s) => s.showCorrections)
  const useJapanese = useSettings((s) => s.useJapanese)
  const [hlRects, setHlRects] = useState<Rect[] | null>(null)
  const clearToken = useSession((s) => s.clearToken)
  const setSessionDoc = useSession((s) => s.setDoc)
  const setSessionResult = useSession((s) => s.setResult)

  const scanDoc = useCallback((d: Doc) => {
    setDoc(d)
    void start({ canvas: d.canvas, pdfTextItems: d.pdf?.textItems })
  }, [start])

  const openFile = useCallback(async (file: File, page = 1) => {
    setLoadError(null)
    setLoading(isPdf(file) ? 'PDFを読み込み中…' : '画像を読み込み中…')
    try {
      if (isPdf(file)) {
        const p = await loadPdfPage(file, page)
        scanDoc({ name: file.name, canvas: p.canvas, pdf: { file, page: p.pageNumber, numPages: p.numPages, textItems: p.textItems } })
      } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic)$/i.test(file.name)) {
        const canvas = await blobToCanvas(file)
        scanDoc({ name: file.name, canvas })
      } else {
        setLoadError('対応していないファイル形式です(画像またはPDFを選んでください)')
      }
    } catch (e) {
      console.error(e)
      setLoadError(`読み込みに失敗しました: ${(e as Error).message}`)
    } finally {
      setLoading(null)
    }
  }, [scanDoc])

  // ページ全体でドラッグ&ドロップ・貼り付けを受け付ける
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true) } }
    const onLeave = (e: DragEvent) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false) } }
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const f = e.dataTransfer?.files?.[0]
      if (f) void openFile(f)
    }
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file')
      const f = item?.getAsFile()
      if (f) {
        e.preventDefault()
        void openFile(f)
      }
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [openFile])

  // ヘッダーの「クリア」
  useEffect(() => {
    if (clearToken === 0) return
    reset()
    setDoc(null)
    setLoadError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearToken])

  useEffect(() => {
    setSessionDoc(!!doc || !!loading)
  }, [doc, loading, setSessionDoc])

  const onSample = () => scanDoc({ name: 'サンプル請求書(架空)', canvas: makeSampleInvoice() })

  const scanning = state.status === 'scanning'
  /** 表示・再スキャンに使う画像(自動で向きを補正した場合はその画像) */
  const viewImage = state.image ?? doc?.canvas ?? null
  const rotate = (deg: 90 | 270) => {
    if (!doc || !viewImage) return
    // 回転すると PDF のテキスト層の座標が合わなくなるので画像として扱う
    scanDoc({ name: doc.name, canvas: rotateCanvas(viewImage, deg) })
  }
  const elapsed = ((state.finishedAt || (scanning ? performance.now() : state.startedAt)) - state.startedAt) / 1000
  const cands = state.candidates.filter((c) => showCorrections || c.kind !== 'corrected')
  // 主候補(T付き/登録番号付近・検算OK)は最大3件、それ以外は折りたたみ
  const valid = cands.filter(isPrimary).slice(0, 3)
  const invalid = cands.filter((c) => !valid.includes(c)).slice(0, 6)
  const bestDigits = valid[0]?.digits ?? null

  // ヘッダーの「公表サイト」ボタン用に最有力候補を共有
  useEffect(() => {
    setSessionResult(valid[0] ?? null, scanning)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bestDigits, scanning, setSessionResult])
  useEffect(() => () => setSessionResult(null, false), [setSessionResult])

  // 完了したら履歴に保存(1スキャンにつき1回)
  const addHistory = useHistory((s) => s.add)
  const saveHistory = useSettings((s) => s.saveHistory)
  const savedFor = useRef(0)
  const textRows = state.textRows
  const report = useMemo(() => {
    if (!textRows) return null
    const weak = state.candidates.find((c) => c.valid && c.context && !c.hasT)
    const regNo = bestDigits ?? weak?.digits ?? null
    return checkRequirements(textRows.rows, { regNo, regNoWeak: !bestDigits && !!weak })
  }, [textRows, bestDigits, state.candidates])

  useEffect(() => {
    if (state.status !== 'done' || !doc || !saveHistory || savedFor.current === state.startedAt) return
    savedFor.current = state.startedAt
    const primary = state.candidates.filter(isPrimary)
    addHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      name: doc.name,
      thumb: makeThumb(state.image ?? doc.canvas),
      digits: primary[0]?.digits ?? null,
      others: primary.slice(1, 3).map((c) => c.digits),
      requirements: report ? { summary: report.summary, text: report.summaryText, simplified: report.simplified } : null,
      engine: state.engine?.label ?? '',
      seconds: (state.finishedAt - state.startedAt) / 1000,
    })
  }, [state.status, state.startedAt, state.finishedAt, state.candidates, state.image, state.engine, doc, saveHistory, report, addHistory])

  return (
    <div className="space-y-4">
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-teal-600/20 backdrop-blur-sm">
          <div className="rounded-3xl border-4 border-dashed border-teal-500 bg-white/90 px-10 py-8 text-center text-lg font-bold text-teal-700 shadow-xl dark:bg-slate-900/90 dark:text-teal-300">
            <Upload className="mx-auto mb-2" size={40} />
            ここにドロップして読み取り
          </div>
        </div>
      )}

      {!doc && !loading && (
        <>
          <section className="pt-2 text-center sm:pt-6">
            <h1 className="text-2xl font-bold sm:text-3xl">インボイス要件と登録番号を<span className="text-teal-600">チェック</span></h1>
            <p className="mt-2 text-sm text-slate-500">適格請求書の「T + 13桁」を画像から探し出してチェックディジットで検算し、記載事項がそろっているかも確認。国税庁の公表サイトへすぐ飛べます。</p>
          </section>
          <ImageInput onFile={openFile} onSample={onSample} />
          <div className="flex justify-center"><EngineBadge /></div>
          <ManualCheck />
        </>
      )}

      {loading && (
        <div className="card flex items-center justify-center gap-3 p-10 text-slate-500">
          <Loader2 className="animate-spin" /> {loading}
        </div>
      )}
      {loadError && <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{loadError}</div>}

      {doc && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* 左: 画像とオーバーレイ */}
          <div className="min-w-0 space-y-3 lg:sticky lg:top-18 lg:self-start">
            <div className="card p-3">
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="truncate font-medium">{doc.name}</span>
                <span className="shrink-0 text-xs text-slate-400">{(viewImage ?? doc.canvas).width}×{(viewImage ?? doc.canvas).height}</span>
                {state.rotation !== 0 && <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">向きを自動補正</span>}
                <span className="ml-auto flex shrink-0 gap-1">
                  <button type="button" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800" title="左に回転して読み直す" disabled={scanning} onClick={() => rotate(270)}>
                    <RotateLeft size={16} />
                  </button>
                  <button type="button" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800" title="右に回転して読み直す" disabled={scanning} onClick={() => rotate(90)}>
                    <RotateRight size={16} />
                  </button>
                </span>
                {doc.pdf && doc.pdf.numPages > 1 && (
                  <select
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                    value={doc.pdf.page}
                    disabled={scanning}
                    onChange={(e) => void openFile(doc.pdf!.file, Number(e.target.value))}
                  >
                    {Array.from({ length: doc.pdf.numPages }, (_, i) => (
                      <option key={i} value={i + 1}>{i + 1} / {doc.pdf!.numPages} ページ</option>
                    ))}
                  </select>
                )}
              </div>
              <ScanViewer image={viewImage ?? doc.canvas} state={state} highlight={hl} highlightRects={hlRects} overlay={<ScanOverlay state={state} />} />
              <div className="mt-2"><Legend /></div>
            </div>
            <ImageInput onFile={openFile} onSample={onSample} compact />
          </div>

          {/* 右: 進捗・結果 */}
          <div className="min-w-0 space-y-3">
            <div className="card p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold">
                  {scanning ? '捜査中…' : state.status === 'done' ? '捜査完了' : state.status === 'aborted' ? '中止しました' : state.status === 'error' ? 'エラー' : '待機中'}
                </span>
                <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Clock size={12} />{elapsed > 0 ? `${elapsed.toFixed(1)}秒` : ''}</span>
                <div className="ml-auto flex gap-2">
                  {scanning ? (
                    <button className="btn-danger px-3 py-1.5" onClick={abort}><Square size={14} /> 中止</button>
                  ) : (
                    <button className="btn-ghost px-3 py-1.5" onClick={() => scanDoc(state.image ? { name: doc.name, canvas: state.image } : doc)}><RotateCcw size={14} /> 再スキャン</button>
                  )}
                  <button className="btn-ghost px-3 py-1.5" onClick={() => { reset(); setDoc(null) }} disabled={scanning}>閉じる</button>
                </div>
              </div>
              <StageStepper state={state} />
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div className={`h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-400 transition-[width] duration-300 ${scanning ? 'animate-pulse' : ''}`} style={{ width: `${Math.round(state.progress * 100)}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                <span>{state.progressLabel}</span>
                <span>{Math.round(state.progress * 100)}%</span>
              </div>
              {state.engine && (
                <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <Cpu size={12} /> {state.engine.label}
                </p>
              )}
              {state.model && state.model.status !== 'ready' && scanning && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>OCRモデル準備中: {state.model.status}</span>
                    <span>{Math.round(state.model.progress * 100)}%</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${Math.round(state.model.progress * 100)}%` }} />
                  </div>
                </div>
              )}
              {state.error && <p className="mt-2 text-sm text-rose-600">{state.error}</p>}
            </div>

            {/* 結果 */}
            <section className="space-y-3">
              {valid.map((c, i) => <CandidateCard key={c.digits} c={c} rank={i} onHover={setHl} />)}
              {valid.length === 0 && !scanning && state.status === 'done' && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  T番号として有力な候補が見つかりませんでした。設定で「スキャン強度: 徹底」にする、明るく正面から撮り直す、番号部分を拡大したスクショを貼る、などをお試しください。
                </div>
              )}
              {invalid.length > 0 && (
                <details className="group" open={valid.length === 0}>
                  <summary className="cursor-pointer text-xs text-slate-500">その他の候補 {invalid.length} 件(検算NG・T未検出・商品コードの可能性など)</summary>
                  <div className="mt-2 space-y-2">
                    {invalid.map((c, i) => <CandidateCard key={c.digits} c={c} rank={i + valid.length} onHover={setHl} />)}
                  </div>
                </details>
              )}
            </section>

            <RequirementsPanel report={report} scanning={scanning} japaneseOff={state.engine?.id === 'tesseract' && !useJapanese && textRows?.source !== 'pdf'} rows={textRows?.rows} refined={textRows?.refined} onHover={setHlRects} />

            <PeekPanel peek={state.peek} />

            <div className="card p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ScrollText size={16} className="text-teal-600" /> 捜査ログ
                <span className="ml-auto text-xs font-normal text-slate-500">読み取り {state.readings.length} 回</span>
              </div>
              <ScanLog logs={state.logs} />
            </div>

            <ManualCheck />
          </div>
        </div>
      )}
    </div>
  )
}
