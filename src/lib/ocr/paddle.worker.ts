/// <reference lib="webworker" />
/** PaddleOCR を UI スレッドから切り離して動かす Web Worker */
import { PaddleCore, type PaddleBackendPref } from './paddle-core'
import type { OcrParams } from './pool'

type InMsg =
  | { type: 'init'; pref: PaddleBackendPref; base: string }
  | { type: 'recognize'; id: number; image: ImageData; params: OcrParams }
  | { type: 'cancel'; ids: number[] }

const core = new PaddleCore()
let ready: Promise<void> | null = null
/** ONNX セッションは同時実行できないので1件ずつ処理する */
let chain: Promise<unknown> = Promise.resolve()
const cancelled = new Set<number>()
const post = (m: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer)

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const m = ev.data
  if (m.type === 'init') {
    ready ??= core.load(m.pref, m.base, (status, progress) => post({ type: 'progress', status, progress }))
    try {
      await ready
      post({ type: 'ready', provider: core.provider })
    } catch (e) {
      ready = null
      post({ type: 'init-error', message: String((e as Error)?.message ?? e) })
    }
    return
  }
  if (m.type === 'cancel') {
    for (const id of m.ids) cancelled.add(id)
    return
  }
  if (m.type === 'recognize') {
    chain = chain.then(async () => {
      if (cancelled.delete(m.id)) return post({ type: 'error', id: m.id, message: 'aborted', aborted: true })
      try {
        await ready
        const result = await core.recognize(m.image, m.params, (p) => post({ type: 'rec-progress', id: m.id, progress: p }))
        post({ type: 'result', id: m.id, result })
      } catch (e) {
        post({ type: 'error', id: m.id, message: String((e as Error)?.message ?? e) })
      }
    })
  }
}
