import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { useSettings, type Engine, type PaddleBackendPref, type ScanStrength, type Theme } from '../store/settings'
import { webGpuAvailable } from '../lib/ocr/paddle'

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-slate-100 py-4 last:border-0 sm:flex-row sm:items-center dark:border-slate-800">
      <div className="flex-1">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-slate-500">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 rounded-full transition ${checked ? 'bg-teal-600' : 'bg-slate-300 dark:bg-slate-700'}`}
    >
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-6' : 'left-1'}`} />
    </button>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-lg px-3 py-1.5 text-sm transition ${value === v ? 'bg-white font-semibold text-teal-700 shadow-sm dark:bg-slate-950 dark:text-teal-300' : 'text-slate-500'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export default function SettingsPage() {
  const s = useSettings()
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-bold">設定</h1>
      <p className="text-xs text-slate-500">設定はこの端末のブラウザに保存されます。</p>

      <section className="card px-4">
        <h2 className="pt-4 text-xs font-semibold uppercase tracking-wider text-teal-600">OCRエンジン</h2>
        <Row
          title="エンジン"
          desc="PaddleOCR(PP-OCRv5): 日本語に強く高精度。WebGPU対応の端末ではGPUで高速に動きます(初回 約50MB)。Tesseract: 従来のエンジン(初回 約16MB)。"
        >
          <Segmented<Engine> value={s.engine} onChange={(v) => s.set({ engine: v })} options={[['paddle', 'PaddleOCR'], ['tesseract', 'Tesseract']]} />
        </Row>
        {s.engine === 'paddle' && (
          <Row
            title="PaddleOCR の実行環境"
            desc={`自動: WebGPU が使えればGPU、だめならCPU(WebAssembly)。この端末の WebGPU: ${webGpuAvailable() ? '対応' : '非対応'}`}
          >
            <Segmented<PaddleBackendPref> value={s.paddleBackend} onChange={(v) => s.set({ paddleBackend: v })} options={[['auto', '自動'], ['webgpu', 'GPU'], ['wasm', 'CPU']]} />
          </Row>
        )}
        {s.engine === 'paddle' && (
          <Row title="書類の分割と傾き補正" desc="1枚の写真・スキャンに写った複数の領収書を見つけて分け、それぞれ90°単位の向きと細かな傾き(0.2°単位)を直してから読み取ります">
            <Toggle checked={s.splitDocuments} onChange={(v) => s.set({ splitDocuments: v })} />
          </Row>
        )}
        {s.engine === 'paddle' && (
          <Row title="向きの自動補正" desc="横向き・上下逆の写真を自動で回転してから読み取ります">
            <Toggle checked={s.autoRotate} onChange={(v) => s.set({ autoRotate: v })} />
          </Row>
        )}
        {s.engine === 'paddle' && (
          <Row title="モデルを先読み" desc="アプリを開いたら、画像を選んでいる間に PaddleOCR のモデルを準備しておきます(データセーバー有効時は行いません)">
            <Toggle checked={s.preloadModels} onChange={(v) => s.set({ preloadModels: v })} />
          </Row>
        )}
      </section>

      <section className="card px-4">
        <h2 className="pt-4 text-xs font-semibold uppercase tracking-wider text-teal-600">読み取り</h2>
        <Row title="スキャン強度" desc="徹底にすると、拡大倍率・前処理・タイル分割を増やして粘り強く探します(時間がかかります)">
          <Segmented<ScanStrength> value={s.strength} onChange={(v) => s.set({ strength: v })} options={[['quick', '速い'], ['standard', '標準'], ['thorough', '徹底']]} />
        </Row>
        <Row title="早期終了" desc="T付き・検算OK・複数回一致の候補が得られたら、残りの走査を省略します">
          <Toggle checked={s.earlyExit} onChange={(v) => s.set({ earlyExit: v })} />
        </Row>
        <Row title="日本語レイアウト解析(Tesseract)" desc="Tesseract 使用時、「登録番号」等の日本語キーワードを手がかりにします。オフにすると初回ダウンロードが軽くなります(日本語モデル 約2MB)">
          <Toggle checked={s.useJapanese} onChange={(v) => s.set({ useJapanese: v })} />
        </Row>
        <Row title="並列OCR数(Tesseract)" desc="Tesseract の数字読み取り用ワーカーの数。多いほど速いですが、メモリを使います">
          <div className="flex items-center gap-3">
            <input type="range" min={1} max={6} value={s.workers} onChange={(e) => s.set({ workers: Number(e.target.value) })} className="accent-teal-600" />
            <span className="w-6 text-center font-mono text-sm">{s.workers}</span>
          </div>
        </Row>
        <Row title="PDFの一括読み取り" desc="複数ページのPDFは全ページ(最大50ページ)を順番に読み取り、結果を一覧にします。1ページに複数のインボイスがあっても分けて判定します">
          <Toggle checked={s.batchPdf} onChange={(v) => s.set({ batchPdf: v })} />
        </Row>
        <Row title="記載事項の精査" desc="日付・金額・税率・宛名などの行を拡大して何度も読み直し、多数決で記載事項チェックの精度を上げます(少し時間がかかります)">
          <Toggle checked={s.refineRequirements} onChange={(v) => s.set({ refineRequirements: v })} />
        </Row>
        <Row title="推定補正候補を表示" desc="検算NGの読み取りを、誤認しやすい数字の1桁置換で補正した候補も表示します">
          <Toggle checked={s.showCorrections} onChange={(v) => s.set({ showCorrections: v })} />
        </Row>
      </section>

      <section className="card px-4">
        <h2 className="pt-4 text-xs font-semibold uppercase tracking-wider text-teal-600">表示</h2>
        <Row title="捜査の様子を表示" desc="画像上の走査アニメーションとルーペ表示">
          <Toggle checked={s.showAnimation} onChange={(v) => s.set({ showAnimation: v })} />
        </Row>
        <Row title="スロー再生" desc="捜査の様子をじっくり見たいときに。1回のOCRごとに待ち時間を入れます">
          <Segmented<string> value={String(s.slowMo)} onChange={(v) => s.set({ slowMo: Number(v) })} options={[['0', 'なし'], ['300', '少し'], ['1000', 'じっくり']]} />
        </Row>
        <Row title="履歴を保存" desc="読み取り結果(サムネイル・T番号・チェック結果)をこの端末に保存します。最大50件">
          <Toggle checked={s.saveHistory} onChange={(v) => s.set({ saveHistory: v })} />
        </Row>
        <Row title="テーマ">
          <Segmented<Theme> value={s.theme} onChange={(v) => s.set({ theme: v })} options={[['system', '自動'], ['light', 'ライト'], ['dark', 'ダーク']]} />
        </Row>
      </section>

      <button className="btn-ghost" onClick={() => s.reset()}>
        <RotateCcw size={16} /> 初期設定に戻す
      </button>
    </div>
  )
}
