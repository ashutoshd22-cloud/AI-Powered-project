import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useLocalTasks, useSyncEngine } from '../app/SyncContext'
import { errorMessage, request } from '../lib/api'
import { useSpeech } from '../lib/speech'
import { relativeTime } from '../lib/time'
import type { CommandResult, NotificationItem } from '../lib/types'
import { Icon } from './Icon'
import { useToast } from './Toast'

export function SyncStatus({ compact = false }: { compact?: boolean }) {
  const engine = useSyncEngine()
  const { state } = useLocalTasks()
  let label: string
  let tone: string
  if (!state.online) {
    label = state.pending ? `Offline · ${state.pending} change${state.pending === 1 ? '' : 's'} saved locally` : 'Offline'
    tone = 'text-warn'
  } else if (state.syncing) {
    label = 'Syncing…'
    tone = 'text-ink-3'
  } else if (state.pending) {
    label = `${state.pending} change${state.pending === 1 ? '' : 's'} waiting to sync`
    tone = 'text-warn'
  } else {
    label = state.lastSyncedAt ? `Synced ${relativeTime(state.lastSyncedAt)}` : 'Up to date'
    tone = 'text-ink-3'
  }
  return (
    <button
      type="button"
      onClick={() => void engine.sync()}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs hover:bg-surface-2 ${tone}`}
      title={`${label}. Click to sync now.`}
      aria-label={`${label}. Sync now`}
    >
      <Icon name={state.online ? (state.syncing ? 'refresh' : 'cloud') : 'cloudOff'} className={`size-4 ${state.syncing ? 'animate-spin' : ''}`} />
      <span className={compact ? 'sr-only' : ''}>{label}</span>
    </button>
  )
}

export function VoiceCommand() {
  const navigate = useNavigate()
  const engine = useSyncEngine()
  const toast = useToast()
  const [result, setResult] = useState<CommandResult | null>(null)
  const speech = useSpeech(async (text) => {
    try {
      const res = await request<CommandResult>('/ai/command', { method: 'POST', body: { text, request_id: crypto.randomUUID() } })
      toast.show(`“${text}” — ${res.message}`, res.intent === 'unknown' ? 'error' : 'success')
      if (res.navigate_to) navigate(res.navigate_to)
      if (res.candidates.length) setResult(res)
      if (res.intent === 'create_task' || res.intent === 'complete_task') void engine.sync()
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    }
  })

  useEffect(() => {
    if (speech.error) toast.show(speech.error, 'error')
  }, [speech.error, toast])

  if (!speech.supported) return null
  return (
    <div className="relative">
      <button
        type="button"
        className={`icon-btn ${speech.listening ? 'animate-pulse bg-danger-soft text-danger' : ''}`}
        onClick={speech.listening ? speech.stop : speech.start}
        aria-pressed={speech.listening}
        aria-label={speech.listening ? 'Stop listening' : 'Voice command (e.g. “add call Alex tomorrow”, “show goals”)'}
        title="Voice command"
      >
        <Icon name="mic" />
      </button>
      {result ? (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-border bg-surface p-3 shadow-lg">
          <p className="mb-2 text-sm font-medium">Which one did you mean?</p>
          <ul className="space-y-1">
            {result.candidates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-surface-2"
                  onClick={async () => {
                    await engine.updateTask(t.id, { status: 'done' })
                    toast.show(`Marked “${t.title}” as done`, 'success')
                    setResult(null)
                  }}
                >
                  {t.title}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn-ghost mt-2 w-full" onClick={() => setResult(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  )
}

function useBrowserNotifications(items: NotificationItem[] | undefined) {
  const shown = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!items) return
    if (shown.current === null) {
      // Don't replay everything that was already unread when the app opened.
      shown.current = new Set(items.map((n) => n.id))
      return
    }
    for (const n of items) {
      if (shown.current.has(n.id) || n.read_at) continue
      shown.current.add(n.id)
      if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try {
          new Notification(n.title, { body: n.body, tag: n.id })
        } catch {
          /* some mobile browsers only allow notifications from a service worker */
        }
      }
    }
  }, [items])
}

export function NotificationBell() {
  const { state } = useLocalTasks()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const list = useQuery({
    queryKey: ['notifications'],
    queryFn: () => request<NotificationItem[]>('/notifications', { query: { limit: 20 } }),
    refetchInterval: 60_000,
    enabled: state.online,
  })
  useBrowserNotifications(list.data)
  const unread = (list.data ?? []).filter((n) => !n.read_at).length

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const markAll = async () => {
    await request('/notifications/read-all', { method: 'POST' })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        className="icon-btn relative"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" />
        {unread ? (
          <span className="absolute top-1.5 right-1.5 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="fixed inset-x-3 top-16 z-40 rounded-xl border border-border bg-surface shadow-xl sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-96">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unread ? (
              <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={markAll}>
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {!state.online ? <li className="px-4 py-6 text-center text-sm text-ink-3">Notifications load when you're back online.</li> : null}
            {state.online && list.data?.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-ink-3">No notifications yet. Reminders and daily digests appear here.</li>
            ) : null}
            {list.data?.map((n) => (
              <li key={n.id} className={`border-b border-border/60 px-4 py-3 last:border-0 ${n.read_at ? '' : 'bg-accent-soft/30'}`}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={async () => {
                    if (!n.read_at) await request(`/notifications/${n.id}/read`, { method: 'POST' })
                    void qc.invalidateQueries({ queryKey: ['notifications'] })
                  }}
                >
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-sm text-ink-2">{n.body}</p>
                  <p className="mt-1 text-xs text-ink-3">{relativeTime(n.created_at)}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
