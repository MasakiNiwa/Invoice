import { ExternalLink, Scale } from 'lucide-react'
import { GithubIcon as Github } from '../components/GithubIcon'
import { PAGES_URL, REPO_URL } from '../lib/links'

const LIBS: [string, string, string][] = [
  ['React', 'MIT', 'https://react.dev/'],
  ['React Router', 'MIT', 'https://reactrouter.com/'],
  ['Vite', 'MIT', 'https://vite.dev/'],
  ['Tailwind CSS', 'MIT', 'https://tailwindcss.com/'],
  ['PaddleOCR (PP-OCRv5 モデル)', 'Apache-2.0', 'https://github.com/PaddlePaddle/PaddleOCR'],
  ['ONNX Runtime Web', 'MIT', 'https://onnxruntime.ai/'],
  ['tesseract.js', 'Apache-2.0', 'https://github.com/naptha/tesseract.js'],
  ['pdf.js (pdfjs-dist)', 'Apache-2.0', 'https://mozilla.github.io/pdf.js/'],
  ['zustand', 'MIT', 'https://github.com/pmndrs/zustand'],
  ['Lucide', 'ISC', 'https://lucide.dev/'],
]

export default function AboutPage() {
  const buildDate = new Date(__BUILD_DATE__)
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-bold">このアプリについて</h1>

      <section className="card flex flex-col items-center gap-3 p-6 text-center">
        <img src="./favicon.svg" alt="" className="h-16 w-16" />
        <div>
          <div className="text-lg font-bold">インボイス確認ツール</div>
          <div className="mt-1 font-mono text-sm text-slate-500">v{__APP_VERSION__}</div>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-left text-xs text-slate-500">
          <dt>ビルド</dt>
          <dd className="font-mono">{buildDate.toLocaleString('ja-JP')}</dd>
          <dt>コミット</dt>
          <dd className="font-mono">
            {/^[0-9a-f]{7}$/.test(__COMMIT__) ? (
              <a className="text-teal-600 underline" href={`${REPO_URL}/commit/${__COMMIT__}`} target="_blank" rel="noreferrer">{__COMMIT__}</a>
            ) : __COMMIT__}
          </dd>
        </dl>
        <div className="flex flex-wrap justify-center gap-2">
          <a className="btn-primary" href={REPO_URL} target="_blank" rel="noreferrer"><Github size={16} /> GitHub リポジトリ</a>
          <a className="btn-ghost" href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 更新履歴</a>
          <a className="btn-ghost" href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer"><ExternalLink size={16} /> 不具合・要望</a>
        </div>
        <p className="text-xs text-slate-400">公開URL: <a className="underline" href={PAGES_URL}>{PAGES_URL}</a></p>
      </section>

      <section className="card p-5 text-sm">
        <h2 className="mb-2 flex items-center gap-2 font-bold"><Scale size={16} /> ライセンス</h2>
        <p className="text-slate-600 dark:text-slate-300">本ソフトウェアは <a className="text-teal-600 underline" href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT License</a> で公開されています。</p>
        <h3 className="mt-4 mb-2 font-semibold">使用しているオープンソース</h3>
        <ul className="grid gap-1 sm:grid-cols-2">
          {LIBS.map(([name, lic, url]) => (
            <li key={name} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 dark:bg-slate-800/60">
              <a href={url} target="_blank" rel="noreferrer" className="hover:underline">{name}</a>
              <span className="text-xs text-slate-500">{lic}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-5 text-xs leading-relaxed text-slate-500">
        <h2 className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">免責事項</h2>
        <p>本ツールの読み取り結果・検算結果の正確性は保証されません。取引の判断にあたっては、必ず国税庁「適格請求書発行事業者公表サイト」で登録状況をご確認ください。本ツールは国税庁とは関係のない非公式ツールです。</p>
      </section>
    </div>
  )
}
