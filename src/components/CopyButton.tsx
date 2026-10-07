import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

export function CopyButton({ text, label = 'コピー' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="btn-ghost px-3 py-2"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          window.prompt('コピーしてください', text)
        }
      }}
    >
      {done ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
      {done ? 'コピーしました' : label}
    </button>
  )
}
