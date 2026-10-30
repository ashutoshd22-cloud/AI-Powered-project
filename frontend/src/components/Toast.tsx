import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'

type Tone = 'info' | 'success' | 'error'
interface ToastItem {
  id: number
  message: string
  tone: Tone
  action?: { label: string; run: () => void }
}

interface ToastApi {
  show: (message: string, tone?: Tone, action?: ToastItem['action']) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(1)

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), [])

  const show = useCallback<ToastApi['show']>(
    (message, tone = 'info', action) => {
      const id = next.current++
      setItems((all) => [...all.slice(-3), { id, message, tone, action }])
      setTimeout(() => dismiss(id), action ? 8000 : 5000)
    },
    [dismiss],
  )

  const api = useMemo(() => ({ show }), [show])
  const toneClass: Record<Tone, string> = {
    info: 'border-border bg-surface text-ink',
    success: 'border-ok/40 bg-ok-soft text-ink',
    error: 'border-danger/40 bg-danger-soft text-ink',
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:pr-6"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border p-3 text-sm shadow-lg ${toneClass[t.tone]}`}
          >
            <p className="flex-1 break-words">{t.message}</p>
            {t.action ? (
              <button
                type="button"
                className="font-semibold text-accent underline-offset-2 hover:underline"
                onClick={() => {
                  t.action?.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button type="button" className="-m-1 p-1 text-ink-3 hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              <Icon name="x" className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
