import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { ConflictCenter } from '../components/ConflictCenter'
import { NotificationBell, SyncStatus, VoiceCommand } from '../components/Header'
import { Icon, type IconName } from '../components/Icon'
import { useLocalTasks } from './SyncContext'
import { useUser } from './AuthContext'

const NAV: { to: string; label: string; icon: IconName; mobile: boolean }[] = [
  { to: '/', label: 'Today', icon: 'sun', mobile: true },
  { to: '/tasks', label: 'Tasks', icon: 'list', mobile: true },
  { to: '/planner', label: 'Planner', icon: 'calendar', mobile: true },
  { to: '/goals', label: 'Goals', icon: 'target', mobile: true },
  { to: '/insights', label: 'Insights', icon: 'chart', mobile: true },
  { to: '/history', label: 'History', icon: 'history', mobile: false },
  { to: '/settings', label: 'Settings', icon: 'settings', mobile: false },
]

function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <img src="/favicon.svg" alt="" className="size-7" />
      LifeOS
    </span>
  )
}

function MoreMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const location = useLocation()
  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative lg:hidden" ref={ref}>
      <button type="button" className="icon-btn" aria-label="More pages" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="menu" />
      </button>
      {open ? (
        <nav aria-label="More" className="absolute right-0 z-40 mt-2 w-48 rounded-xl border border-border bg-surface p-1 shadow-lg">
          {NAV.filter((n) => !n.mobile).map((n) => (
            <NavLink key={n.to} to={n.to} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm hover:bg-surface-2">
              <Icon name={n.icon} className="size-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
    </div>
  )
}

export function Layout() {
  const user = useUser()
  const { state } = useLocalTasks()
  const location = useLocation()
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    // Move focus to the new page's content for screen-reader and keyboard users.
    main.current?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [location.pathname])

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a href="#main" className="sr-only z-50 rounded bg-accent px-3 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface px-3 py-4 lg:flex">
        <div className="px-2 pb-6">
          <Logo />
        </div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
                  isActive ? 'bg-accent-soft text-accent-strong' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                }`
              }
            >
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border pt-3">
          <SyncStatus />
          <p className="truncate px-2 text-xs text-ink-3" title={user.email}>
            {user.display_name} · {user.timezone}
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-1 border-b border-border bg-canvas/90 px-3 py-1 backdrop-blur sm:px-6">
          <div className="lg:hidden">
            <Logo />
          </div>
          <div className="flex-1" />
          <div className="lg:hidden">
            <SyncStatus compact />
          </div>
          <VoiceCommand />
          <NotificationBell />
          <MoreMenu />
        </header>

        {!state.online ? (
          <div role="status" className="bg-warn-soft px-4 py-2 text-center text-xs text-ink sm:text-sm">
            You're offline. Tasks keep working and will sync automatically when you reconnect.
          </div>
        ) : null}

        <main id="main" ref={main} tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-28 outline-none sm:px-6 lg:pb-10">
          <ConflictCenter tz={user.timezone} />
          <Outlet />
        </main>
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {NAV.filter((n) => n.mobile).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${isActive ? 'text-accent' : 'text-ink-3'}`
            }
          >
            <Icon name={n.icon} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
