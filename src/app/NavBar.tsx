import { NavLink, useNavigate } from 'react-router'
import { ExternalLink, HelpCircle, History, Info, Loader2, ScanSearch, Settings, X } from 'lucide-react'
import { invoiceKohyoUrl } from '../lib/links'
import { useSession } from '../store/session'

const items = [
  { to: '/', label: '読み取り', icon: ScanSearch, end: true },
  { to: '/history', label: '履歴', icon: History },
  { to: '/settings', label: '設定', icon: Settings },
  { to: '/help', label: 'ヘルプ', icon: HelpCircle },
  { to: '/about', label: 'バージョン', icon: Info },
]

/** ヘッダー右上のアクション: クリア / 公表サイトを開く(読み取り成功時のみ有効) */
function HeaderActions() {
  const { hasDoc, best, scanning, requestClear } = useSession()
  const navigate = useNavigate()
  return (
    <div className="flex items-center gap-1.5">
      {hasDoc && (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          onClick={() => {
            requestClear()
            navigate('/')
          }}
          title="読み込んだ画像と結果をクリア"
        >
          <X size={14} /> クリア
        </button>
      )}
      {best ? (
        <a
          href={invoiceKohyoUrl(best.digits)}
          target="_blank"
          rel="noreferrer"
          className="relative inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-teal-700"
          title={`T${best.digits} を国税庁 公表サイトで確認`}
        >
          {!scanning && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400" />}
          <ExternalLink size={14} /> 公表サイト
        </a>
      ) : (
        <span
          className="inline-flex shrink-0 cursor-not-allowed items-center gap-1 whitespace-nowrap rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-400 dark:bg-slate-800"
          title="T番号を読み取ると押せるようになります"
          aria-disabled="true"
        >
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />} 公表サイト
        </span>
      )}
    </div>
  )
}

/** GitHub Pages の開発版(dev ブランチのプレビュー、/Invoice/dev/)で開いている */
const IS_DEV_PREVIEW = typeof location !== 'undefined' && /\/dev\/?$/.test(location.pathname.replace(/index\.html$/, ''))

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-3 sm:px-4">
        <NavLink to="/" className="flex min-w-0 items-center gap-2 font-bold">
          <img src="./favicon.svg" alt="" className="h-7 w-7 shrink-0" />
          <span className="truncate text-sm sm:text-base"><span className="hidden min-[400px]:inline">インボイス</span>確認ツール</span>
          {IS_DEV_PREVIEW && <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">開発版</span>}
        </NavLink>
        <nav className="ml-auto hidden items-center gap-1 md:flex">
          {items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-teal-50 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto shrink-0 md:ml-2">
          <HeaderActions />
        </div>
      </div>
    </header>
  )
}

/** スマホ用の下部タブバー */
export function BottomBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-950/95">
      <div className="grid grid-cols-5">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-teal-600 dark:text-teal-400' : 'text-slate-500'}`}
          >
            <Icon size={22} />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
