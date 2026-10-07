import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** 「ホーム画面に追加」(Chrome/Edge/Android)。iOS は共有メニューから追加する */
export function useInstallPrompt() {
  const [ev, setEv] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches)
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setEv(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])
  const isIos = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent)
  return {
    canInstall: !!ev && !installed,
    installed,
    isIos,
    install: async () => {
      if (!ev) return
      await ev.prompt()
      await ev.userChoice
      setEv(null)
    },
  }
}
