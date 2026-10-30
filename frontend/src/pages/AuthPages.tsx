import { type FormEvent, useId, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../app/AuthContext'
import { errorMessage } from '../lib/api'
import { browserTimeZone, supportedTimeZones } from '../lib/time'

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-9" />
          <span className="text-xl font-semibold tracking-tight">LifeOS</span>
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 mb-6 text-sm text-ink-3">{subtitle}</p>
        <div className="card p-5">{children}</div>
      </div>
    </main>
  )
}

export function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await login(email.trim(), password)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Welcome back" subtitle="Sign in to your personal operating system.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div>
          <label className="label" htmlFor={`${id}-email`}>
            Email
          </label>
          <input id={`${id}-email`} type="email" autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-password`}>
            Password
          </label>
          <input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-ink-3">
        New here?{' '}
        <Link to="/register" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </AuthCard>
  )
}

export function RegisterPage() {
  const { register } = useAuth()
  const zones = supportedTimeZones()
  const [form, setForm] = useState({ display_name: '', email: '', password: '', confirm: '', timezone: browserTimeZone() })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.display_name.trim()) return setError('Please tell us your name.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return setError('Enter a valid email address.')
    if (form.password.length < 10) return setError('Use at least 10 characters for your password.')
    if (form.password !== form.confirm) return setError('The passwords do not match.')
    setBusy(true)
    setError(null)
    try {
      await register({ display_name: form.display_name.trim(), email: form.email.trim(), password: form.password, timezone: form.timezone })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Create your account" subtitle="Tasks, plans, goals and a private local AI — in one place.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div>
          <label className="label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input id={`${id}-name`} autoComplete="name" className="input" maxLength={80} value={form.display_name} onChange={set('display_name')} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-email`}>
            Email
          </label>
          <input id={`${id}-email`} type="email" autoComplete="email" className="input" value={form.email} onChange={set('email')} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-password`}>
            Password
          </label>
          <input
            id={`${id}-password`}
            type="password"
            autoComplete="new-password"
            className="input"
            maxLength={128}
            value={form.password}
            onChange={set('password')}
            aria-describedby={`${id}-pw-hint`}
          />
          <p id={`${id}-pw-hint`} className="mt-1 text-xs text-ink-3">
            At least 10 characters. A passphrase works well.
          </p>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-confirm`}>
            Confirm password
          </label>
          <input id={`${id}-confirm`} type="password" autoComplete="new-password" className="input" value={form.confirm} onChange={set('confirm')} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-tz`}>
            Time zone
          </label>
          <select id={`${id}-tz`} className="input" value={form.timezone} onChange={set('timezone')}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-3">Reminders and daily plans use this zone.</p>
        </div>
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-ink-3">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthCard>
  )
}
