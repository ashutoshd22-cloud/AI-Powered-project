import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-ink-3">
      <span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />
      <span>{label}…</span>
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <span className="rounded-full bg-surface-2 p-3 text-ink-3">
        <Icon name={icon} className="size-6" />
      </span>
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-sm text-sm text-ink-3">{children}</div> : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm">
      <Icon name="alert" className="size-5 text-danger" />
      <p className="flex-1">{message}</p>
      {onRetry ? (
        <button type="button" className="btn-secondary min-h-9" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}

export function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </div>
  )
}
