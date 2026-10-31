import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useAuth, useUser } from '../app/AuthContext'
import { useLocalTasks, useSyncEngine } from '../app/SyncContext'
import { type Backdrop, type Intensity, SCENES, useBackdropPrefs } from '../app/backdrop'
import { applyTheme } from '../app/theme'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { download, errorMessage, request } from '../lib/api'
import { type PushConfig, currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push'
import { relativeTime, supportedTimeZones } from '../lib/time'
import type { Theme, User } from '../lib/types'
import { deleteLocalDB } from '../offline/db'

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="mt-0.5 mb-4 text-sm text-ink-3">{description}</p> : <div className="mb-4" />}
      {children}
    </section>
  )
}

function ProfileSettings() {
  const user = useUser()
  const { updateUser } = useAuth()
  const toast = useToast()
  const id = useId()
  const [form, setForm] = useState({
    display_name: user.display_name,
    timezone: user.timezone,
    default_reminder_minutes: String(user.default_reminder_minutes),
    daily_digest_enabled: user.daily_digest_enabled,
    daily_digest_hour: String(user.daily_digest_hour),
  })
  const [busy, setBusy] = useState(false)
  const zones = supportedTimeZones()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.display_name.trim()) return toast.show('Name cannot be empty.', 'error')
    const minutes = Number(form.default_reminder_minutes)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) return toast.show('Reminder lead time must be 0–10080 minutes.', 'error')
    setBusy(true)
    try {
      await updateUser({
        display_name: form.display_name.trim(),
        timezone: form.timezone,
        default_reminder_minutes: minutes,
        daily_digest_enabled: form.daily_digest_enabled,
        daily_digest_hour: Number(form.daily_digest_hour),
      } as Partial<User>)
      toast.show('Settings saved', 'success')
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Profile & reminders" description="Your time zone controls due dates, reminders and the daily digest.">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input id={`${id}-name`} className="input" maxLength={80} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-tz`}>
            Time zone
          </label>
          <select id={`${id}-tz`} className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {(zones.includes(form.timezone) ? zones : [form.timezone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-lead`}>
            Default reminder (minutes before a timed due date)
          </label>
          <input
            id={`${id}-lead`}
            type="number"
            min={0}
            max={10080}
            className="input"
            value={form.default_reminder_minutes}
            onChange={(e) => setForm({ ...form, default_reminder_minutes: e.target.value })}
            aria-describedby={`${id}-lead-hint`}
          />
          <p id={`${id}-lead-hint`} className="mt-1 text-xs text-ink-3">
            0 turns automatic reminders off.
          </p>
        </div>
        <div>
          <span className="label">Daily digest</span>
          <div className="flex items-center gap-2">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={form.daily_digest_enabled}
                onChange={(e) => setForm({ ...form, daily_digest_enabled: e.target.checked })}
              />
              Send at
            </label>
            <select
              aria-label="Digest hour"
              className="input w-28"
              disabled={!form.daily_digest_enabled}
              value={form.daily_digest_hour}
              onChange={(e) => setForm({ ...form, daily_digest_hour: e.target.value })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="sm:col-span-2">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </Section>
  )
}

function AppearanceSettings() {
  const user = useUser()
  const { updateUser } = useAuth()
  const toast = useToast()
  const choose = async (theme: Theme) => {
    applyTheme(theme)
    try {
      await updateUser({ theme })
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    }
  }
  return (
    <Section title="Appearance" description="Theme and background are saved on this device.">
      <h3 className="mb-2 text-sm font-medium text-ink-2">Theme</h3>
      <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border border-border p-1">
        {(['system', 'light', 'dark'] as Theme[]).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={user.theme === t}
            onClick={() => void choose(t)}
            className={`min-h-9 rounded-md px-4 text-sm capitalize ${user.theme === t ? 'bg-accent text-on-accent' : 'text-ink-2 hover:bg-surface-2'}`}
          >
            {t}
          </button>
        ))}
      </div>
      <BackdropPicker />
    </Section>
  )
}

const TILE_PREVIEW: Record<Backdrop, string> = {
  ambient: 'radial-gradient(circle at 25% 30%, #22d3ee 0, transparent 55%), radial-gradient(circle at 80% 80%, #38bdf8 0, transparent 50%), var(--color-canvas)',
  minimal: 'var(--color-canvas)',
  aurora: 'url(/scenes/aurora.svg) center/cover',
  dusk: 'url(/scenes/dusk.svg) center/cover',
  ocean: 'url(/scenes/ocean.svg) center/cover',
  nebula: 'url(/scenes/nebula.svg) center/cover',
}

function BackdropPicker() {
  const [prefs, update] = useBackdropPrefs()
  const options: { id: Backdrop; label: string; hint: string }[] = [
    { id: 'ambient', label: 'Ambient light', hint: 'Colour follows your tasks' },
    ...SCENES.map((s) => ({ id: s.id, label: s.label, hint: 'Scene' })),
    { id: 'minimal', label: 'Minimal', hint: 'Plain background' },
  ]
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-sm font-medium text-ink-2">Background</h3>
      <div role="radiogroup" aria-label="Background" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={prefs.backdrop === o.id}
            aria-label={`${o.label} — ${o.hint}`}
            onClick={() => update({ backdrop: o.id })}
            className={`overflow-hidden rounded-xl border text-left transition-shadow ${
              prefs.backdrop === o.id ? 'border-accent ring-2 ring-accent/40' : 'border-border hover:border-ink-3'
            }`}
          >
            <span className="block h-16 border-b border-border" style={{ background: TILE_PREVIEW[o.id] }} aria-hidden />
            <span className="block px-3 py-2">
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-ink-3">{o.hint}</span>
            </span>
          </button>
        ))}
      </div>
      {prefs.backdrop !== 'minimal' ? (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span className="text-ink-2">Intensity</span>
          <div role="radiogroup" aria-label="Background intensity" className="inline-flex rounded-lg border border-border p-1">
            {(['subtle', 'vivid'] as Intensity[]).map((i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={prefs.intensity === i}
                onClick={() => update({ intensity: i })}
                className={`min-h-9 rounded-md px-4 capitalize ${prefs.intensity === i ? 'bg-accent text-on-accent' : 'text-ink-2 hover:bg-surface-2'}`}
              >
                {i}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {prefs.backdrop === 'ambient' ? (
        <p className="mt-2 text-xs text-ink-3">
          Cyan when things are calm · amber when something urgent is due soon · rose when tasks are overdue · green when you're all clear. While
          you edit a task, the light takes on its priority colour.
        </p>
      ) : null}
    </div>
  )
}

function NotificationSettings() {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const [permission, setPermission] = useState(supported ? Notification.permission : 'denied')
  return (
    <Section title="Browser notifications" description="Reminders always appear in the bell. Allow browser notifications to see them while LifeOS is in the background.">
      {!supported ? (
        <p className="text-sm text-ink-3">This browser doesn't support notifications.</p>
      ) : permission === 'granted' ? (
        <p className="flex items-center gap-2 text-sm text-ok">
          <Icon name="check" className="size-4" /> Enabled
        </p>
      ) : permission === 'denied' ? (
        <p className="text-sm text-ink-3">Blocked. Enable notifications for this site in your browser settings.</p>
      ) : (
        <button type="button" className="btn-secondary" onClick={async () => setPermission(await Notification.requestPermission())}>
          <Icon name="bell" className="size-4" /> Allow notifications
        </button>
      )}
      <BackgroundPush />
    </Section>
  )
}

function BackgroundPush() {
  const toast = useToast()
  const { state } = useLocalTasks()
  const config = useQuery({ queryKey: ['push-config'], queryFn: () => request<PushConfig>('/push/config'), enabled: state.online })
  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(Boolean(s)))
  }, [])

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    try {
      await action()
      setSubscribed(Boolean(await currentSubscription()))
      void config.refetch()
      toast.show(success, 'success')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="text-sm font-medium">When LifeOS is closed</h3>
      {!pushSupported() ? (
        <p className="mt-1 text-sm text-ink-3">This browser can't receive notifications while the app is closed.</p>
      ) : config.data && !config.data.enabled ? (
        <p className="mt-1 text-sm text-ink-3">
          Not set up on this server yet. An administrator can enable it by adding VAPID keys (see the README).
        </p>
      ) : (
        <>
          <p className="mt-1 mb-3 text-sm text-ink-3">
            Get reminders and your daily plan on this device even when no LifeOS tab is open.
          </p>
          <div className="flex flex-wrap gap-2">
            {subscribed ? (
              <>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => request('/push/test', { method: 'POST' }), 'Test notification sent')}>
                  <Icon name="bell" className="size-4" /> Send a test
                </button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => run(disablePush, 'Background notifications turned off on this device')}>
                  Turn off on this device
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !config.data || !state.online}
                onClick={() => run(() => enablePush(config.data!), 'Background notifications are on for this device')}
              >
                <Icon name="bell" className="size-4" /> Turn on for this device
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function CalendarSettings() {
  const user = useUser()
  const { setUser } = useAuth()
  const engine = useSyncEngine()
  const toast = useToast()
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const id = useId()

  const createLink = async () => {
    setBusy(true)
    try {
      const res = await request<{ url: string }>('/calendar/token', { method: 'POST' })
      setUrl(res.url)
      setUser({ ...user, has_calendar_feed: true })
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const importFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.ics')) return toast.show('Please choose an .ics calendar file.', 'error')
    if (file.size > 1_000_000) return toast.show('That file is larger than 1 MB.', 'error')
    const body = new FormData()
    body.append('file', file)
    setBusy(true)
    try {
      const res = await request<{ created: number; skipped: number; errors: string[] }>('/calendar/import', { method: 'POST', raw: body })
      toast.show(`Imported ${res.created} item(s)${res.skipped ? `, skipped ${res.skipped} already imported or untitled` : ''}.`, 'success')
      void engine.sync()
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Section title="Calendar" description="Subscribe from Google Calendar, Apple Calendar or Outlook, or import an .ics file.">
      <div className="space-y-4">
        {url ? (
          <div className="space-y-2">
            <label className="label" htmlFor={`${id}-url`}>
              Your private subscription link (shown once — keep it secret)
            </label>
            <div className="flex gap-2">
              <input id={`${id}-url`} className="input font-mono text-xs" readOnly value={url} onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="btn-secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url)
                    toast.show('Link copied', 'success')
                  } catch {
                    toast.show('Copy failed — select the link and copy it manually.', 'error')
                  }
                }}
              >
                Copy
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={createLink} disabled={busy}>
            <Icon name="link" className="size-4" /> {user.has_calendar_feed ? 'Create a new link' : 'Create subscription link'}
          </button>
          {user.has_calendar_feed ? (
            <button type="button" className="btn-ghost text-danger" onClick={() => setConfirmRevoke(true)} disabled={busy}>
              Revoke link
            </button>
          ) : null}
          <input ref={fileRef} id={`${id}-file`} type="file" accept=".ics,text/calendar" className="sr-only" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          <label htmlFor={`${id}-file`} className="btn-secondary cursor-pointer">
            <Icon name="upload" className="size-4" /> Import .ics file
          </label>
        </div>
        {user.has_calendar_feed && !url ? <p className="text-xs text-ink-3">A link is active. Creating a new one disables the old link.</p> : null}
      </div>
      <ConfirmDialog
        open={confirmRevoke}
        title="Revoke calendar link?"
        message="Calendar apps subscribed to the current link will stop updating."
        confirmLabel="Revoke"
        destructive
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={async () => {
          try {
            await request('/calendar/token', { method: 'DELETE' })
            setUser({ ...user, has_calendar_feed: false })
            setUrl(null)
            toast.show('Calendar link revoked')
          } catch (err) {
            toast.show(errorMessage(err), 'error')
          }
          setConfirmRevoke(false)
        }}
      />
    </Section>
  )
}

function SecuritySettings() {
  const toast = useToast()
  const id = useId()
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (form.next.length < 10) return toast.show('New password must be at least 10 characters.', 'error')
    if (form.next !== form.confirm) return toast.show('New passwords do not match.', 'error')
    setBusy(true)
    try {
      await request('/auth/change-password', { method: 'POST', body: { current_password: form.current, new_password: form.next } })
      setForm({ current: '', next: '', confirm: '' })
      toast.show('Password changed. Other devices were signed out.', 'success')
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Password">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor={`${id}-c`}>
            Current password
          </label>
          <input id={`${id}-c`} type="password" autoComplete="current-password" className="input" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-n`}>
            New password
          </label>
          <input id={`${id}-n`} type="password" autoComplete="new-password" className="input" maxLength={128} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-r`}>
            Repeat new password
          </label>
          <input id={`${id}-r`} type="password" autoComplete="new-password" className="input" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </div>
        <div className="sm:col-span-3">
          <button type="submit" className="btn-secondary" disabled={busy || !form.current}>
            Change password
          </button>
        </div>
      </form>
    </Section>
  )
}

function DataSettings() {
  const user = useUser()
  const { logout } = useAuth()
  const engine = useSyncEngine()
  const { state } = useLocalTasks()
  const qc = useQueryClient()
  const toast = useToast()
  const id = useId()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!deleteOpen) {
      setPassword('')
      setConfirmText('')
    }
  }, [deleteOpen])

  const exportAs = async (format: 'json' | 'csv') => {
    try {
      await download('/account/export', { format }, `lifeos-export.${format}`)
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    }
  }

  const deleteAccount = async () => {
    setBusy(true)
    try {
      await request('/account', { method: 'DELETE', body: { password, confirm: confirmText } })
      engine.stop()
      await deleteLocalDB(user.id)
      qc.clear()
      await logout({ discardLocalData: true }).catch(() => undefined)
      window.location.assign('/login')
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Your data" description="Export everything at any time. LifeOS never sends your data to third parties.">
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => void exportAs('json')} disabled={!state.online}>
            <Icon name="download" className="size-4" /> Export all data (JSON)
          </button>
          <button type="button" className="btn-secondary" onClick={() => void exportAs('csv')} disabled={!state.online}>
            <Icon name="download" className="size-4" /> Export tasks (CSV)
          </button>
        </div>
        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <p>
            Offline storage on this device: {state.pending ? `${state.pending} change(s) waiting to sync` : 'everything synced'}
            {state.lastSyncedAt ? ` · last sync ${relativeTime(state.lastSyncedAt)}` : ''}.
          </p>
          <button type="button" className="btn-ghost mt-2 min-h-9 px-2" onClick={() => void engine.sync()}>
            <Icon name="refresh" className="size-4" /> Sync now
          </button>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <button type="button" className="btn-secondary" onClick={() => setLogoutOpen(true)}>
            <Icon name="logout" className="size-4" /> Sign out
          </button>
          <button type="button" className="btn-danger" onClick={() => setDeleteOpen(true)} disabled={!state.online}>
            <Icon name="trash" className="size-4" /> Delete account
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={logoutOpen}
        title="Sign out?"
        message={
          state.pending
            ? `${state.pending} change(s) haven't synced yet. If you sign out now they stay on this device and sync next time you sign in here.`
            : 'Your tasks will be removed from this device. They remain safe on the server.'
        }
        confirmLabel="Sign out"
        onCancel={() => setLogoutOpen(false)}
        onConfirm={async () => {
          try {
            engine.stop()
            qc.clear()
            await logout({ discardLocalData: state.pending === 0 && state.conflicts.length === 0 })
          } catch (err) {
            toast.show(errorMessage(err), 'error')
            setLogoutOpen(false)
          }
        }}
      />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete your account"
        size="sm"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-danger" disabled={busy || !password || confirmText !== 'DELETE'} onClick={deleteAccount}>
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-ink-2">
            This permanently deletes your account, tasks, goals, notifications and history from the server and this device. It cannot be undone. Consider
            exporting your data first.
          </p>
          <div>
            <label className="label" htmlFor={`${id}-pw`}>
              Password
            </label>
            <input id={`${id}-pw`} type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-confirm`}>
              Type DELETE to confirm
            </label>
            <input id={`${id}-confirm`} className="input" autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
        </div>
      </Dialog>
    </Section>
  )
}

interface GoogleStatus {
  configured: boolean
  connected: boolean
  status: 'active' | 'error' | null
  last_synced_at: string | null
  last_error: string | null
}

function GoogleCalendarSettings() {
  const toast = useToast()
  const engine = useSyncEngine()
  const { state } = useLocalTasks()
  const [params, setParams] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const google = useQuery({
    queryKey: ['google'],
    queryFn: () => request<GoogleStatus>('/integrations/google'),
    enabled: state.online,
  })

  // Result of the Google sign-in redirect (?google=connected|error|cancelled).
  useEffect(() => {
    const result = params.get('google')
    if (!result) return
    const messages: Record<string, [string, 'success' | 'error' | 'info']> = {
      connected: ['Google Calendar connected. Your tasks with due dates are now in a "LifeOS" calendar.', 'success'],
      error: ['Google Calendar could not be connected. Please try again.', 'error'],
      cancelled: ['Google Calendar connection was cancelled.', 'info'],
    }
    const [text, tone] = messages[result] ?? messages.error
    toast.show(text, tone)
    if (result === 'connected') void engine.sync()
    params.delete('google')
    setParams(params, { replace: true })
  }, [params, setParams, toast, engine])

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    try {
      await fn()
      if (success) toast.show(success, 'success')
      void google.refetch()
      void engine.sync()
    } catch (err) {
      toast.show(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const data = google.data
  return (
    <Section
      title="Google Calendar (two-way)"
      description="Tasks with due dates appear in a separate “LifeOS” calendar. Changes made there — moving, renaming, deleting or adding events — come back to LifeOS. LifeOS can't see your other calendars."
    >
      {!state.online ? <p className="text-sm text-ink-3">Available when you're online.</p> : null}
      {google.isError ? <p className="text-sm text-danger">Couldn't load the Google Calendar status: {errorMessage(google.error)}</p> : null}
      {data && !data.configured ? (
        <p className="text-sm text-ink-3">Not set up on this server yet. An administrator can enable it with Google OAuth credentials (see the README).</p>
      ) : null}
      {data?.configured && !data.connected ? (
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const { url } = await request<{ url: string }>('/integrations/google/connect', { method: 'POST' })
              window.location.assign(url)
            })
          }
        >
          <Icon name="calendar" className="size-4" /> Connect Google Calendar
        </button>
      ) : null}
      {data?.connected ? (
        <div className="space-y-3">
          <p className={`flex items-center gap-2 text-sm ${data.status === 'error' ? 'text-danger' : 'text-ok'}`}>
            <Icon name={data.status === 'error' ? 'alert' : 'check'} className="size-4" />
            {data.status === 'error' ? data.last_error ?? 'Sync problem' : 'Connected'}
            {data.last_synced_at ? <span className="text-ink-3">· last synced {relativeTime(data.last_synced_at)}</span> : null}
          </p>
          {data.status !== 'error' && data.last_error ? <p className="text-xs text-warn">Last attempt: {data.last_error}</p> : null}
          <div className="flex flex-wrap gap-2">
            {data.status === 'error' ? (
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const { url } = await request<{ url: string }>('/integrations/google/connect', { method: 'POST' })
                    window.location.assign(url)
                  })
                }
              >
                Reconnect
              </button>
            ) : (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => request('/integrations/google/sync', { method: 'POST' }), 'Synced with Google Calendar')}>
                <Icon name="refresh" className="size-4" /> Sync now
              </button>
            )}
            <button type="button" className="btn-ghost text-danger" disabled={busy} onClick={() => setConfirmDisconnect(true)}>
              Disconnect
            </button>
          </div>
          <p className="text-xs text-ink-3">Syncs automatically every few minutes.</p>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Google Calendar?"
        message="LifeOS stops syncing and its access to Google is revoked. The “LifeOS” calendar stays in your Google account — delete it there if you no longer want it."
        confirmLabel="Disconnect"
        destructive
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={async () => {
          await act(() => request('/integrations/google', { method: 'DELETE' }), 'Google Calendar disconnected')
          setConfirmDisconnect(false)
        }}
      />
    </Section>
  )
}

export function SettingsPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <ProfileSettings />
      <AppearanceSettings />
      <NotificationSettings />
      <CalendarSettings />
      <GoogleCalendarSettings />
      <SecuritySettings />
      <DataSettings />
    </div>
  )
}
