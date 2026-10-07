import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Cpu, Loader2, RotateCcw as RotateLeft, RotateCw as RotateRight, RotateCcw, ScrollText, Square, Upload } from 'lucide-react'
import { CandidateCard } from '../components/CandidateCard'
import { ImageInput } from '../components/ImageInput'
import { ManualCheck } from '../components/ManualCheck'
import { PeekPanel } from '../components/PeekPanel'
import { Legend, ScanViewer } from '../components/ScanViewer'
import { ScanLog } from '../components/ScanLog'
import { StageStepper } from '../components/StageStepper'
import { useScan, type ScanState } from '../hooks/useScan'
import { analyzeScan, type InvoiceResult } from '../lib/analyze'
import { BatchPanel, type Batch } from '../components/BatchPanel'
import { blobToCanvas, rotateCanvas } from '../lib/image'
import { isPdf, openPdf, type OpenedPdf, type PdfTextItem } from '../lib/pdf'
import { makeSampleInvoice } from '../lib/sample'
import { useSettings } from '../store/settings'
import { isPrimary } from '../lib/ocr/aggregate'
import { useSession } from '../store/session'
import { makeThumb, useHistory } from '../store/history'
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

/** 一括読み取りでの PDF ページの解像度(選択時に同じ座標で再描画するため固定) */
const BATCH_SIDE = 2400
const MAX_BATCH_PAGES = 50

function cropCanvas(src: HTMLCanvasElement, r: Rect): HTMLCanvasElement {
  const m = Math.max(8, Math.min(r.w, r.h) * 0.05)
  const x = Math.max(0, r.x - m)
  const y = Math.max(0, r.y - m)
  const w = Math.min(src.width - x, r.w + m * 2)
  const h = Math.min(src.height - y, r.h + m * 2)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  c.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, c.width, c.height)
  return c
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
  const batchPdf = useSettings((s) => s.batchPdf)
  const [hlRects, setHlRects] = useState<Rect[] | null>(null)
  const clearToken = useSession((s) => s.clearToken)
  const setSessionDoc = useSession((s) => s.setDoc)
  const setSessionResult = useSession((s) => s.setResult)
  const addHistory = useHistory((s) => s.add)

  // 一括読み取り
  const [batch, setBatch] = useState<Batch | null>(null)
  const pdfRef = useRef<OpenedPdf | null>(null)
  const stopRef = useRef(false)
  /** 一括読み取りで選んだページの結果(null なら現在のスキャン) */
  const [selected, setSelected] = useState<{ page: number; state: ScanState } | null>(null)
  /** 表示中のインボイス(1枚に複数あるとき) */
  const [invIdx, setInvIdx] = useState(0)

  /** 終わったスキャンの結果を、インボイスごとに履歴へ保存 */
  const saveResults = useCallback((name: string, canvas: HTMLCanvasElement, final: ScanState, invoices: InvoiceResult[]) => {
    if (!useSettings.getState().saveHistory || final.status !== 'done') return
    const img = final.image ?? canvas
    for (const inv of invoices) {
      addHistory({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: new Date().toISOString(),
        name: invoices.length > 1 ? `${name} #${inv.index + 1}` : name,
        thumb: makeThumb(invoices.length > 1 ? cropCanvas(img, inv.rect) : img),
        digits: inv.digits,
        others: [],
        requirements: inv.report ? { summary: inv.report.summary, text: inv.report.summaryText, simplified: inv.report.simplified } : null,
        engine: final.engine?.label ?? '',
        seconds: (final.finishedAt - final.startedAt) / 1000,
      })
    }
  }, [addHistory])

  const runScan = useCallback(async (d: Doc) => {
    setDoc(d)
    setSelected(null)
    setInvIdx(0)
    const final = await start({ canvas: d.canvas, pdfTextItems: d.pdf?.textItems })
    if (!final) return null
    const img = final.image ?? d.canvas
    const invoices = analyzeScan(final.candidates, final.textRows?.rows ?? null, img.width, img.height)
    return { final, invoices }
  }, [start])

  const scanDoc = useCallback((d: Doc, label = d.name) => {
    void runScan(d).then((r) => r && saveResults(label, d.canvas, r.final, r.invoices))
  }, [runScan, saveResults])

  const stopBatch = useCallback(() => {
    stopRef.current = true
    abort()
  }, [abort])

  const closePdf = () => {
    stopRef.current = true
    pdfRef.current?.destroy()
    pdfRef.current = null
    setBatch(null)
    setSelected(null)
  }

  /** 複数ページの PDF を1ページずつ読み取る */
  const runBatch = useCallback(async (file: File, pdf: OpenedPdf) => {
    const total = Math.min(pdf.numPages, MAX_BATCH_PAGES)
    stopRef.current = false
    let b: Batch = { name: file.name, total, items: [], running: true, current: 1 }
    setBatch(b)
    for (let p = 1; p <= total && !stopRef.current; p++) {
      b = { ...b, current: p }
      setBatch(b)
      const pg = await pdf.render(p, BATCH_SIDE)
      if (stopRef.current) break
      const d: Doc = { name: file.name, canvas: pg.canvas, pdf: { file, page: p, numPages: pdf.numPages, textItems: pg.textItems } }
      const r = await runScan(d)
      if (!r || r.final.status !== 'done') break
      saveResults(`${file.name} p.${p}`, d.canvas, r.final, r.invoices)
      b = { ...b, items: [...b.items, { page: p, state: r.final, invoices: r.invoices }] }
      setBatch(b)
    }
    setBatch({ ...b, running: false })
  }, [runScan, saveResults])

  /** 一括読み取りの結果から、ページ・インボイスを選んで表示 */
  const selectBatchItem = useCallback(async (page: number, inv: number) => {
    const item = batch?.items.find((it) => it.page === page)
    const pdf = pdfRef.current
    if (!item || !pdf || !doc?.pdf) return
    const pg = await pdf.render(page, BATCH_SIDE)
    setDoc({ name: doc.name, canvas: pg.canvas, pdf: { ...doc.pdf, page, textItems: pg.textItems } })
    setSelected({ page, state: item.state })
    setInvIdx(inv)
  }, [batch, doc])

  const openFile = useCallback(async (file: File, page = 1) => {
    setLoadError(null)
    setLoading(isPdf(file) ? 'PDFを読み込み中…' : '画像を読み込み中…')
    try {
      if (isPdf(file)) {
        closePdf()
        const pdf = await openPdf(file)
        pdfRef.current = pdf
        if (pdf.numPages > 1 && batchPdf) {
          setLoading(null)
          await runBatch(file, pdf)
          return
        }
        const p = await pdf.render(page)
        scanDoc({ name: file.name, canvas: p.canvas, pdf: { file, page: p.pageNumber, numPages: p.numPages, textItems: p.textItems } })
      } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic)$/i.test(file.name)) {
        closePdf()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanDoc, runBatch, batchPdf])

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
    closePdf()
    reset()
    setDoc(null)
    setLoadError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearToken])

  useEffect(() => {
    setSessionDoc(!!doc || !!loading)
  }, [doc, loading, setSessionDoc])

  const onSample = () => {
    closePdf()
    scanDoc({ name: 'サンプル請求書(架空)', canvas: makeSampleInvoice() })
  }

  /** 表示する結果: 一括読み取りで選んだページ、または現在のスキャン */
  const view = selected?.state ?? state
  const scanning = state.status === 'scanning'
  const busy = scanning || !!batch?.running
  /** 表示・再スキャンに使う画像(自動で向きを補正した場合はその画像) */
  const viewImage = view.image ?? doc?.canvas ?? null
  const rotate = (deg: 90 | 270) => {
    if (!doc || !viewImage) return
    // 回転すると PDF のテキスト層の座標が合わなくなるので画像として扱う
    scanDoc({ name: doc.name, canvas: rotateCanvas(viewImage, deg) })
  }
  const elapsed = ((view.finishedAt || (scanning ? performance.now() : view.startedAt)) - view.startedAt) / 1000
  const cands = view.candidates.filter((c) => showCorrections || c.kind !== 'corrected')
  // 主候補(T付き/登録番号付近・検算OK)は最大3件(1枚に複数インボイスがあればその数まで)、それ以外は折りたたみ
  const textRows = view.textRows
  const invoices = useMemo(
    () => (viewImage ? analyzeScan(view.candidates, textRows?.rows ?? null, viewImage.width, viewImage.height) : []),
    [view.candidates, textRows, viewImage],
  )
  const inv = invoices[Math.min(invIdx, Math.max(0, invoices.length - 1))]
  const valid = cands.filter(isPrimary).slice(0, Math.max(3, invoices.length))
  const invalid = cands.filter((c) => !valid.includes(c)).slice(0, 6)
  const headerBest = (inv?.digits && valid.find((c) => c.digits === inv.digits)) || valid[0] || null
  // 選んでいるインボイスの番号を先頭に
  if (headerBest && valid[0] !== headerBest) {
    valid.splice(valid.indexOf(headerBest), 1)
    valid.unshift(headerBest)
  }
  const report = inv?.report ?? null

  // ヘッダーの「公表サイト」ボタン用に最有力候補を共有
  useEffect(() => {
    setSessionResult(headerBest, busy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerBest?.digits, busy, setSessionResult])
  useEffect(() => () => setSessionResult(null, false), [setSessionResult])

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
                {view.rotation !== 0 && <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">向きを自動補正</span>}
                <span className="ml-auto flex shrink-0 gap-1">
                  <button type="button" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800" title="左に回転して読み直す" disabled={busy} onClick={() => rotate(270)}>
                    <RotateLeft size={16} />
                  </button>
                  <button type="button" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800" title="右に回転して読み直す" disabled={busy} onClick={() => rotate(90)}>
                    <RotateRight size={16} />
                  </button>
                </span>
                {doc.pdf && doc.pdf.numPages > 1 && (
                  <select
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                    value={doc.pdf.page}
                    disabled={busy}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (batch?.items.some((it) => it.page === n)) void selectBatchItem(n, 0)
                      else void openFile(doc.pdf!.file, n)
                    }}
                  >
                    {Array.from({ length: doc.pdf.numPages }, (_, i) => (
                      <option key={i} value={i + 1}>{i + 1} / {doc.pdf!.numPages} ページ</option>
                    ))}
                  </select>
                )}
              </div>
              <ScanViewer
                image={viewImage ?? doc.canvas}
                state={view}
                highlight={hl}
                highlightRects={hlRects}
                overlay={selected ? null : <ScanOverlay state={state} />}
                segments={invoices.map((v, i) => ({ rect: v.rect, label: `インボイス ${i + 1}`, active: i === invIdx }))}
              />
              <div className="mt-2"><Legend /></div>
            </div>
            <ImageInput onFile={openFile} onSample={onSample} compact />
          </div>

          {/* 右: 進捗・結果 */}
          <div className="min-w-0 space-y-3">
            <div className="card p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-sm font-semibold">
                  {scanning ? '捜査中…' : view.status === 'done' ? '捜査完了' : view.status === 'aborted' ? '中止しました' : view.status === 'error' ? 'エラー' : '待機中'}
                </span>
                <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Clock size={12} />{elapsed > 0 ? `${elapsed.toFixed(1)}秒` : ''}</span>
                <div className="ml-auto flex gap-2">
                  {busy ? (
                    <button className="btn-danger px-3 py-1.5" onClick={batch?.running ? stopBatch : abort}><Square size={14} /> 中止</button>
                  ) : (
                    <button className="btn-ghost px-3 py-1.5" onClick={() => scanDoc(view.image ? { name: doc.name, canvas: view.image } : doc)}><RotateCcw size={14} /> 再スキャン</button>
                  )}
                  <button className="btn-ghost px-3 py-1.5" onClick={() => { closePdf(); reset(); setDoc(null) }} disabled={busy}>閉じる</button>
                </div>
              </div>
              <StageStepper state={state} />
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div className={`h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-400 transition-[width] duration-300 ${scanning ? 'animate-pulse' : ''}`} style={{ width: `${Math.round(view.progress * 100)}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                <span>{view.progressLabel}</span>
                <span>{Math.round(view.progress * 100)}%</span>
              </div>
              {view.engine && (
                <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <Cpu size={12} /> {view.engine.label}
                </p>
              )}
              {view.model && view.model.status !== 'ready' && scanning && (
                <div className="mt-2">
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>OCRモデル準備中: {view.model.status}</span>
                    <span>{Math.round(view.model.progress * 100)}%</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${Math.round(view.model.progress * 100)}%` }} />
                  </div>
                </div>
              )}
              {view.error && <p className="mt-2 text-sm text-rose-600">{view.error}</p>}
            </div>

            {batch && (
              <BatchPanel
                batch={batch}
                selected={selected ? { page: selected.page, inv: invIdx } : null}
                onSelect={(pg, i) => void selectBatchItem(pg, i)}
                onStop={stopBatch}
              />
            )}

            {/* 1枚に複数のインボイス */}
            {invoices.length > 1 && (
              <div className="card p-3">
                <div className="mb-2 text-sm font-semibold">この{doc.pdf ? 'ページ' : '画像'}に {invoices.length} 件のインボイスを検出</div>
                <div className="flex flex-wrap gap-2">
                  {invoices.map((v, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setInvIdx(i)}
                      onMouseEnter={() => setHlRects([v.rect])}
                      onMouseLeave={() => setHlRects(null)}
                      className={`rounded-xl border px-3 py-2 text-left text-xs transition ${i === invIdx ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950/40' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}
                    >
                      <div className="font-semibold">インボイス {i + 1}</div>
                      <div className="font-mono">{v.digits ? `T${v.digits}` : '登録番号なし'}</div>
                      {v.report && <div className="text-slate-500">{v.report.summary === 'ok' ? '記載事項OK' : v.report.summary === 'warn' ? '一部未確認' : '不足あり'}</div>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 結果 */}
            <section className="space-y-3">
              {valid.map((c, i) => <CandidateCard key={c.digits} c={c} rank={i} onHover={setHl} />)}
              {valid.length === 0 && !busy && view.status === 'done' && (
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

            <RequirementsPanel report={report} title={invoices.length > 1 ? `インボイス ${invIdx + 1}` : undefined} scanning={scanning} japaneseOff={view.engine?.id === 'tesseract' && !useJapanese && textRows?.source !== 'pdf'} rows={textRows?.rows} refined={textRows?.refined} onHover={setHlRects} />

            <PeekPanel peek={view.peek} />

            <div className="card p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ScrollText size={16} className="text-teal-600" /> 捜査ログ
                <span className="ml-auto text-xs font-normal text-slate-500">読み取り {view.readings.length} 回</span>
              </div>
              <ScanLog logs={view.logs} />
            </div>

            <ManualCheck />
          </div>
        </div>
      )}
    </div>
  )
}
