import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useAuth, useUser } from '../app/AuthContext'
import { useLocalTasks, useSyncEngine } from '../app/SyncContext'
import { applyTheme } from '../app/theme'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { download, errorMessage, request } from '../lib/api'
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
    <Section title="Appearance">
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
    </Section>
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
    </Section>
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

export function SettingsPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <ProfileSettings />
      <AppearanceSettings />
      <NotificationSettings />
      <CalendarSettings />
      <SecuritySettings />
      <DataSettings />
    </div>
  )
}
