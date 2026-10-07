import { RefreshCw, X } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/** 新しいバージョンが公開されたときのお知らせ(読み取り中に勝手に再読み込みしないよう、押したときだけ更新) */
export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true })
  if (!needRefresh && !offlineReady) return null
  return (
    <div className="fixed inset-x-0 bottom-20 z-40 flex justify-center px-3 md:bottom-6">
      <div className="pop-in flex max-w-md items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl dark:bg-slate-800">
        {needRefresh ? (
          <>
            <span>新しいバージョンがあります</span>
            <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void updateServiceWorker(true)}>
              <RefreshCw size={14} /> 更新
            </button>
          </>
        ) : (
          <span>オフラインでも使えるようになりました</span>
        )}
        <button className="rounded p-1 text-slate-400 hover:text-white" aria-label="閉じる" onClick={() => { setNeedRefresh(false); setOfflineReady(false) }}>
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
