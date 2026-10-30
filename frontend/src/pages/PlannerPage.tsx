import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useUser } from '../app/AuthContext'
import { useLocalTasks } from '../app/SyncContext'
import { Icon } from '../components/Icon'
import { QuickAdd } from '../components/QuickAdd'
import { TaskEditor } from '../components/TaskEditor'
import { TaskList } from '../components/TaskItem'
import { bucketByDay } from '../lib/tasks'
import { addDays, formatDayKey, monthEnd, monthStart, todayKey, weekStart } from '../lib/time'
import type { Task } from '../lib/types'

type View = 'day' | 'week' | 'month'

function rangeFor(view: View, anchor: string): [string, string] {
  if (view === 'day') return [anchor, anchor]
  if (view === 'week') {
    const s = weekStart(anchor)
    return [s, addDays(s, 6)]
  }
  return [monthStart(anchor), monthEnd(anchor)]
}

function shift(view: View, anchor: string, dir: 1 | -1): string {
  if (view === 'day') return addDays(anchor, dir)
  if (view === 'week') return addDays(anchor, 7 * dir)
  const [y, m] = anchor.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + dir, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export function PlannerPage() {
  const user = useUser()
  const tz = user.timezone
  const { tasks } = useLocalTasks()
  const today = todayKey(tz)
  const [params, setParams] = useSearchParams()
  const view = (['day', 'week', 'month'].includes(params.get('view') ?? '') ? params.get('view') : 'week') as View
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today
  const [selected, setSelected] = useState<string>(anchor)
  const [editing, setEditing] = useState<Task | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  const [start, end] = rangeFor(view, anchor)
  const buckets = useMemo(() => bucketByDay(tasks, start, end, tz, today), [tasks, start, end, tz, today])
  const go = (v: View, d: string) => {
    setParams({ view: v, date: d })
    setSelected(d)
  }
  const edit = (t: Task) => {
    setEditing(t)
    setEditorOpen(true)
  }

  const title =
    view === 'day'
      ? formatDayKey(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : view === 'week'
        ? `${formatDayKey(start, { month: 'short', day: 'numeric' })} – ${formatDayKey(end, { month: 'short', day: 'numeric', year: 'numeric' })}`
        : formatDayKey(anchor, { month: 'long', year: 'numeric' })

  const dayDefaults = useMemo(() => ({ scheduled_for: view === 'month' ? selected : anchor }), [view, selected, anchor])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Planner</h1>
        <div role="tablist" aria-label="Planner view" className="inline-flex rounded-lg border border-border bg-surface p-1">
          {(['day', 'week', 'month'] as View[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              type="button"
              onClick={() => go(v, anchor)}
              className={`min-h-9 rounded-md px-3 text-sm font-medium capitalize ${view === v ? 'bg-accent text-on-accent' : 'text-ink-2 hover:bg-surface-2'}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="icon-btn border border-border" onClick={() => go(view, shift(view, anchor, -1))} aria-label={`Previous ${view}`}>
          <Icon name="chevronLeft" />
        </button>
        <button type="button" className="icon-btn border border-border" onClick={() => go(view, shift(view, anchor, 1))} aria-label={`Next ${view}`}>
          <Icon name="chevronRight" />
        </button>
        <button type="button" className="btn-secondary min-h-11" onClick={() => go(view, today)}>
          Today
        </button>
        <h2 className="ml-1 text-lg font-semibold" aria-live="polite">
          {title}
        </h2>
      </div>

      {buckets.overdue.length ? (
        <section className="card border-danger/30 p-3 sm:p-4">
          <h3 className="mb-1 text-sm font-semibold text-danger">Overdue — reschedule or finish</h3>
          <TaskList label="Overdue" tasks={buckets.overdue} tz={tz} onEdit={edit} />
        </section>
      ) : null}

      {view === 'day' ? (
        <section className="space-y-3">
          <QuickAdd tz={tz} defaults={dayDefaults} />
          <div className="card p-3 sm:p-4">
            {buckets.byDay.get(anchor)?.length ? (
              <TaskList label={`Tasks for ${anchor}`} tasks={buckets.byDay.get(anchor)!} tz={tz} onEdit={edit} />
            ) : (
              <p className="py-6 text-center text-sm text-ink-3">Nothing planned. Tasks you add here are planned for this day.</p>
            )}
          </div>
        </section>
      ) : null}

      {view === 'week' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[...buckets.byDay.entries()].map(([day, list]) => (
            <section
              key={day}
              aria-label={formatDayKey(day, { weekday: 'long', month: 'long', day: 'numeric' })}
              className={`card min-w-0 p-3 ${day === today ? 'border-accent ring-1 ring-accent/40' : ''}`}
            >
              <button type="button" className="mb-1 w-full text-left" onClick={() => go('day', day)}>
                <span className="block text-xs text-ink-3 uppercase">{formatDayKey(day, { weekday: 'short' })}</span>
                <span className={`text-lg font-semibold ${day === today ? 'text-accent' : ''}`}>{Number(day.slice(8))}</span>
              </button>
              {list.length ? (
                <TaskList label={`Tasks for ${day}`} tasks={list} tz={tz} onEdit={edit} compact />
              ) : (
                <p className="py-2 text-xs text-ink-3">Free</p>
              )}
            </section>
          ))}
        </div>
      ) : null}

      {view === 'month' ? (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="grid grid-cols-7 border-b border-border text-center text-xs font-medium text-ink-3" aria-hidden>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} className="py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7" role="grid" aria-label={title}>
              {Array.from({ length: (new Date(`${start}T12:00:00Z`).getUTCDay() + 6) % 7 }).map((_, i) => (
                <div key={`pad-${i}`} className="border-r border-b border-border/60 bg-surface-2/40" />
              ))}
              {[...buckets.byDay.entries()].map(([day, list]) => {
                const open = list.filter((t) => t.status !== 'done').length
                return (
                  <button
                    key={day}
                    type="button"
                    role="gridcell"
                    aria-selected={selected === day}
                    aria-label={`${formatDayKey(day, { weekday: 'long', month: 'long', day: 'numeric' })}: ${list.length} task${list.length === 1 ? '' : 's'}`}
                    onClick={() => setSelected(day)}
                    className={`flex min-h-14 flex-col items-start gap-1 border-r border-b border-border/60 p-1.5 text-left hover:bg-surface-2 sm:min-h-20 ${
                      selected === day ? 'bg-accent-soft/50' : ''
                    }`}
                  >
                    <span className={`text-xs font-semibold sm:text-sm ${day === today ? 'rounded-full bg-accent px-1.5 text-on-accent' : ''}`}>
                      {Number(day.slice(8))}
                    </span>
                    {list.length ? (
                      <span className="text-[10px] text-ink-3 sm:text-xs">
                        <span className="sm:hidden">{list.length}</span>
                        <span className="hidden sm:inline">
                          {open} open{list.length - open ? ` · ${list.length - open} done` : ''}
                        </span>
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
          <section className="space-y-3">
            <h3 className="font-semibold">{formatDayKey(selected, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
            <QuickAdd tz={tz} defaults={dayDefaults} />
            <div className="card p-3 sm:p-4">
              {buckets.byDay.get(selected)?.length ? (
                <TaskList label={`Tasks for ${selected}`} tasks={buckets.byDay.get(selected)!} tz={tz} onEdit={edit} />
              ) : (
                <p className="py-4 text-center text-sm text-ink-3">Nothing on this day.</p>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <TaskEditor open={editorOpen} task={editing} tz={tz} onClose={() => setEditorOpen(false)} />
    </div>
  )
}
