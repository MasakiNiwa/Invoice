import { NavLink } from 'react-router'
import { HelpCircle, Info, ScanSearch, Settings } from 'lucide-react'
import { GithubIcon as Github } from '../components/GithubIcon'
import { REPO_URL } from '../lib/links'

const items = [
  { to: '/', label: '読み取り', icon: ScanSearch, end: true },
  { to: '/settings', label: '設定', icon: Settings },
  { to: '/help', label: 'ヘルプ', icon: HelpCircle },
  { to: '/about', label: 'バージョン', icon: Info },
]

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <NavLink to="/" className="flex items-center gap-2 font-bold">
          <img src="./favicon.svg" alt="" className="h-7 w-7" />
          <span>インボイス確認ツール</span>
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
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="ml-1 rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="GitHub リポジトリ">
            <Github size={18} />
          </a>
        </nav>
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="ml-auto rounded-lg p-2 text-slate-500 md:hidden" title="GitHub リポジトリ">
          <Github size={20} />
        </a>
      </div>
    </header>
  )
}

/** スマホ用の下部タブバー */
export function BottomBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden dark:border-slate-800 dark:bg-slate-950/95">
      <div className="grid grid-cols-4">
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
