import { useRef } from 'react'
import { Camera, ClipboardPaste, FileUp, FlaskConical } from 'lucide-react'

interface Props {
  onFile: (file: File) => void
  onSample: () => void
  compact?: boolean
}

/** ファイル選択・撮影・貼り付け・サンプルの入口(ドラッグ&ドロップと Ctrl+V はページ全体で受け付け) */
export function ImageInput({ onFile, onSample, compact }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)

  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read()
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'))
        if (type) {
          const blob = await it.getType(type)
          onFile(new File([blob], 'clipboard.png', { type }))
          return
        }
      }
      alert('クリップボードに画像がありません。スクリーンショットをコピーしてから押してください。')
    } catch {
      alert('このブラウザではボタンからの貼り付けができません。Ctrl+V(⌘+V)で貼り付けてください。')
    }
  }

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) onFile(f)
    e.target.value = ''
  }

  const buttons = (
    <div className={`grid gap-2 ${compact ? 'grid-cols-4 [&>button]:flex-col [&>button]:gap-0.5 [&>button]:px-1 [&>button]:py-2 [&>button]:text-xs [&>button]:whitespace-nowrap sm:[&>button]:flex-row sm:[&>button]:text-sm' : 'grid-cols-2 sm:grid-cols-4'}`}>
      <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()}>
        <FileUp size={18} /> {compact ? 'ファイル' : 'ファイルを選択'}
      </button>
      <button type="button" className="btn-ghost" onClick={() => camRef.current?.click()}>
        <Camera size={18} /> {compact ? '撮影' : 'カメラで撮影'}
      </button>
      <button type="button" className="btn-ghost" onClick={pasteFromClipboard}>
        <ClipboardPaste size={18} /> {compact ? '貼付' : '貼り付け'}
      </button>
      <button type="button" className="btn-ghost" onClick={onSample}>
        <FlaskConical size={18} /> {compact ? 'サンプル' : 'サンプルで試す'}
      </button>
      <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" className="hidden" onChange={pick} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={pick} />
    </div>
  )

  if (compact) return buttons

  return (
    <div className="card border-2 border-dashed border-slate-300 p-6 text-center dark:border-slate-700 sm:p-10">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-50 text-teal-600 dark:bg-teal-900/40">
        <FileUp size={32} />
      </div>
      <h2 className="text-lg font-bold">請求書の画像・PDFを読み込む</h2>
      <p className="mt-1 text-sm text-slate-500">
        ここにドラッグ&ドロップ、<kbd className="rounded border px-1 text-xs">Ctrl</kbd>+<kbd className="rounded border px-1 text-xs">V</kbd> でスクショ貼り付け、またはボタンから選択
      </p>
      <p className="mb-5 text-xs text-slate-400">画像は端末内だけで処理され、外部に送信されません</p>
      {buttons}
    </div>
  )
}
