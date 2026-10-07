import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { STAGE_LABEL } from '../lib/ocr/aggregate'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="mb-3 text-base font-bold">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{children}</div>
    </section>
  )
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <summary className="cursor-pointer font-medium text-slate-800 dark:text-slate-100">{q}</summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-bold">ヘルプ</h1>

      <Section title="使い方">
        <ol className="list-decimal space-y-1 pl-5">
          <li>請求書の画像・PDFを読み込みます。方法は4つ:
            <ul className="mt-1 list-disc pl-5">
              <li><b>ドラッグ&ドロップ</b>: 画面のどこにでもファイルを落とせます</li>
              <li><b>ファイル選択</b>: PNG / JPEG / WebP / PDF など</li>
              <li><b>貼り付け</b>: スクリーンショットをコピーして <kbd>Ctrl</kbd>+<kbd>V</kbd>(Macは <kbd>⌘</kbd>+<kbd>V</kbd>)</li>
              <li><b>カメラで撮影</b>: スマホではその場でカメラが起動します</li>
            </ul>
          </li>
          <li>自動で捜査が始まります。画像上の枠やルーペで、どこを調べているか見られます。</li>
          <li>見つかった番号は「検算OK / NG」で表示されます。<b>公表サイトで確認</b> を押すと、国税庁の適格請求書発行事業者公表サイトの該当ページが開きます。</li>
        </ol>
        <p>どうしても読めないときは、<Link to="/" className="text-teal-600 underline">読み取り画面</Link>の「手入力で検算」に番号を入れて確認できます。</p>
      </Section>

      <Section title="T番号(登録番号)とは">
        <p>適格請求書発行事業者の登録番号は <b>「T」+ 13桁の数字</b> です。法人は「T + 法人番号」、個人事業者などは「T + 固有の13桁」(マイナンバーは使われません)。</p>
        <p>13桁の<b>先頭1桁はチェックディジット</b>で、残り12桁から計算できます。このツールはこれを使って誤読を見抜きます。</p>
        <pre className="overflow-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">{`検査用数字 = 9 − ( Σ Pn × Qn  を 9 で割った余り )
  Pn : 下12桁を右から数えて n 桁目の数字
  Qn : n が奇数なら 1、偶数なら 2`}</pre>
        <p className="text-xs text-slate-500">※ 検算OKでも、実際に登録されているかは公表サイトで必ず確認してください。</p>
      </Section>

      <Section title="読み取りのしくみ(多段捜査)">
        <p>画像全体を1回OCRするだけでなく、T番号が「ありそうな場所」を推定して段階的に絞り込みます。</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li><b>{STAGE_LABEL.pdf}</b>: PDFに文字情報があれば直接読み取り(最も確実)</li>
          <li><b>{STAGE_LABEL.layout}</b>: 全体を日本語でOCRし、「T」や「登録番号」の位置と文字の大きさを推定</li>
          <li><b>{STAGE_LABEL.anchor}</b>: その右側・下側を切り出し、文字が読みやすい大きさに拡大して数字専用モードで何度も読む</li>
          <li><b>{STAGE_LABEL.textline}</b>: 「同じ大きさの文字が横に13〜20個並ぶ」場所を画像処理で探して読む</li>
          <li><b>{STAGE_LABEL.tile}</b>: 画像をタイルに分け、ズームを変えながら全体を走査(見落とし対策)</li>
        </ol>
        <p>得られた読み取りは投票で集計し、同じ場所の読み取りは桁ごとに多数決します。検算NGのものは、取り違えやすい数字(3と8、1と7など)の1桁置換で補正した候補も提示します。</p>
      </Section>

      <Section title="うまく読めないときのコツ">
        <ul className="list-disc space-y-1 pl-5">
          <li>明るい場所で、正面から、ピントを合わせて撮影する</li>
          <li>番号部分が小さい場合は、その部分を拡大したスクショを貼り付ける</li>
          <li>画像が横向き・逆さの場合は、回転してから読み込む</li>
          <li><Link to="/settings" className="text-teal-600 underline">設定</Link>で「スキャン強度: 徹底」にする</li>
        </ul>
      </Section>

      <Section title="よくある質問">
        <div className="space-y-2">
          <Faq q="画像はどこかに送信されますか?">いいえ。読み取りはすべてお使いのブラウザ内で行われます。初回のみ、OCRの学習データ(モデル)をCDNからダウンロードします。</Faq>
          <Faq q="初回が遅いのはなぜ?">OCRモデル(英語・日本語)をダウンロードしているためです。2回目以降はブラウザにキャッシュされ速くなります。</Faq>
          <Faq q="「T未検出」とは?">数字13桁は読めたものの、その直前に「T」が確認できなかった候補です。「登録番号」の近くにあれば、T番号である可能性は高いです。</Faq>
          <Faq q="検算OKなら本物ですか?">チェックディジットが合っているだけで、登録されているとは限りません。必ず公表サイトで名称・登録日などを確認してください。</Faq>
          <Faq q="公表サイトのリンク先が表示されない">国税庁サイトのメンテナンス中や、URL仕様の変更の可能性があります。番号をコピーして公表サイトのトップから検索してください。</Faq>
        </div>
      </Section>
    </div>
  )
}
