import type { PdfDiagnostics } from '../lib/pdf'

/** PDF の表示・読み取りがうまくいかないときの手がかり */
export function PdfInfo({ diag }: { diag: PdfDiagnostics }) {
  const missing = diag.fonts.filter((f) => !f.embedded)
  const blank = diag.inkRatio < 0.002
  const warn = blank || (diag.textChars > 0 && missing.length > 0)
  return (
    <details className="mt-2 rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-700" open={blank}>
      <summary className={`cursor-pointer select-none ${warn ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'}`}>
        PDFの情報{blank ? '(ページがほぼ真っ白に描画されました)' : ''}
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-slate-600 dark:text-slate-300">
        <dt className="text-slate-400">テキスト層</dt>
        <dd>{diag.textItems ? `${diag.textItems} 個 / ${diag.textChars} 文字` : 'なし(画像のPDF → 文字認識で読み取り)'}</dd>
        <dt className="text-slate-400">描画量</dt>
        <dd>{(diag.inkRatio * 100).toFixed(1)}%</dd>
        <dt className="text-slate-400">フォント</dt>
        <dd className="space-y-0.5">
          {diag.fonts.length === 0 && <div>なし</div>}
          {diag.fonts.map((f, i) => (
            <div key={i} className="break-all">
              {f.name}{' '}
              <span className={f.embedded ? 'text-emerald-600' : 'text-amber-600'}>{f.embedded ? '埋め込み' : `埋め込みなし${f.fallback ? ` → ${f.fallback}` : ''}`}</span>
            </div>
          ))}
        </dd>
      </dl>
      {warn && (
        <p className="mt-2 text-slate-500">
          文字が表示されないときは、設定またはバージョンのページでアプリを最新に更新してから再度お試しください。直らない場合は、この欄のスクリーンショットをお送りいただくと原因の特定に役立ちます。
        </p>
      )}
    </details>
  )
}
