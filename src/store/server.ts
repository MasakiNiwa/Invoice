import { useEffect } from 'react'
import { create } from 'zustand'
import { setServerEngine } from '../lib/ocr/paddle'
import { detectServer, ServerEngine, type ServerInfo } from '../lib/ocr/server'
import { useSettings } from './settings'

/** Colab 版サーバーの状態(GitHub Pages 版では info は null のまま) */
export const useServer = create<{ info: ServerInfo | null; checked: boolean; active: boolean }>(() => ({ info: null, checked: false, active: false }))

/** 文字認識の実行先を切り替える(購読側が新しい実行先を拾えるよう、状態の更新より先に差し替える) */
function apply(info: ServerInfo | null) {
  const active = !!info && useSettings.getState().useServer
  setServerEngine(active ? new ServerEngine(info!) : null)
  useServer.setState({ info, checked: true, active })
}

let started = false
/** 起動時に一度だけサーバーを探し、設定の切り替えにも追従する */
export function useServerMode() {
  useEffect(() => {
    if (started) return
    started = true
    void detectServer().then(apply)
    useSettings.subscribe((s, prev) => {
      if (s.useServer !== prev.useServer) apply(useServer.getState().info)
    })
  }, [])
}
