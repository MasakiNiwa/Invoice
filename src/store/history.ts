import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CheckStatus } from '../lib/requirements'

export interface HistoryEntry {
  id: string
  /** ISO 日時 */
  at: string
  name: string
  /** 小さなサムネイル(JPEG data URL) */
  thumb: string
  /** 最有力の T番号(13桁) */
  digits: string | null
  /** その他の候補(検算OK) */
  others: string[]
  requirements: { summary: CheckStatus; text: string; simplified: boolean } | null
  engine: string
  seconds: number
}

const MAX = 50

interface HistoryStore {
  entries: HistoryEntry[]
  add: (e: HistoryEntry) => void
  remove: (id: string) => void
  clear: () => void
}

export const useHistory = create<HistoryStore>()(
  persist(
    (set) => ({
      entries: [],
      add: (e) => set((s) => ({ entries: [e, ...s.entries].slice(0, MAX) })),
      remove: (id) => set((s) => ({ entries: s.entries.filter((x) => x.id !== id) })),
      clear: () => set({ entries: [] }),
    }),
    { name: 'invoice-checker-history', version: 1 },
  ),
)

/** CSV(Excel で文字化けしないよう BOM 付き UTF-8) */
export function historyToCsv(entries: HistoryEntry[]): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`
  const head = ['日時', 'ファイル名', '登録番号', '公表サイト', 'その他の候補', '記載事項チェック', '簡易インボイス', 'エンジン', '所要秒']
  const rows = entries.map((e) => [
    new Date(e.at).toLocaleString('ja-JP'),
    e.name,
    e.digits ? `T${e.digits}` : '',
    e.digits ? `https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=${e.digits}` : '',
    e.others.map((d) => `T${d}`).join(' '),
    e.requirements?.text ?? '',
    e.requirements ? (e.requirements.simplified ? 'はい' : 'いいえ') : '',
    e.engine,
    e.seconds.toFixed(1),
  ])
  return '﻿' + [head, ...rows].map((r) => r.map((v) => q(String(v))).join(',')).join('\r\n') + '\r\n'
}

/** 履歴用の小さなサムネイルを作る */
export function makeThumb(src: HTMLCanvasElement, max = 240): string {
  const s = Math.min(1, max / Math.max(src.width, src.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(src.width * s))
  c.height = Math.max(1, Math.round(src.height * s))
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, c.width, c.height)
  try {
    return c.toDataURL('image/jpeg', 0.7)
  } catch {
    return ''
  }
}
