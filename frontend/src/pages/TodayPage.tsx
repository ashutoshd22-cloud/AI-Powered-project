import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useUser } from '../app/AuthContext'
import { useLocalTasks } from '../app/SyncContext'
import { Icon } from '../components/Icon'
import { QuickAdd } from '../components/QuickAdd'
import { EmptyState, SectionHeader } from '../components/States'
import { TaskEditor } from '../components/TaskEditor'
import { TaskList } from '../components/TaskItem'
import { request } from '../lib/api'
import { compareTasks, localFocus } from '../lib/tasks'
import { dateKey, formatInstant, isOverdue, todayKey } from '../lib/time'
import type { PrioritizeResult, Task } from '../lib/types'

function greeting(hour: number): string {
  if (hour < 5) return 'Working late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function TodayPage() {
  const user = useUser()
  const tz = user.timezone
  const { tasks, state } = useLocalTasks()
  const [editing, setEditing] = useState<Task | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const now = new Date()
  const today = todayKey(tz, now)
  const hour = Number(formatInstant(now.toISOString(), tz, { hour: 'numeric', hourCycle: 'h23' }))

  // Re-rank whenever the local task set changes (the key includes versions).
  const rankKey = tasks.map((t) => `${t.id}:${t.version}:${t.status}`).join(',')
  const ranked = useQuery({
    queryKey: ['prioritize', rankKey],
    queryFn: () => request<PrioritizeResult>('/ai/prioritize', { query: { limit: 5 } }),
    enabled: state.online && tasks.length > 0,
    staleTime: 60_000,
  })

  const { overdue, dueToday, planned, doneToday, open } = useMemo(() => {
    const openTasks = tasks.filter((t) => t.status !== 'done')
    return {
      open: openTasks,
      overdue: openTasks.filter((t) => isOverdue(t, now)).sort(compareTasks),
      dueToday: openTasks.filter((t) => t.due_at && !isOverdue(t, now) && dateKey(t.due_at, tz) === today).sort(compareTasks),
      planned: openTasks.filter((t) => t.scheduled_for === today && !(t.due_at && dateKey(t.due_at, tz) <= today)).sort(compareTasks),
      doneToday: tasks.filter((t) => t.completed_at && dateKey(t.completed_at, tz) === today),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, tz, today])

  // Use the server ranking when available (it includes reasons); fall back to local ordering offline.
  const local = new Map(tasks.map((t) => [t.id, t]))
  const focus = ranked.data
    ? ranked.data.items.map((i) => local.get(i.task.id)).filter((t): t is Task => Boolean(t && t.status !== 'done'))
    : localFocus(open).slice(0, 5)
  const reasons = new Map(ranked.data?.items.map((i) => [i.task.id, i.reasons]) ?? [])

  const edit = (t: Task | null) => {
    setEditing(t)
    setEditorOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-ink-3">{formatInstant(now.toISOString(), tz, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 className="text-2xl font-semibold">
            {greeting(hour)}, {user.display_name.split(' ')[0]}
          </h1>
        </div>
        <p className="text-sm text-ink-3">
          <span className="font-semibold text-ink">{doneToday.length}</span> done today ·{' '}
          <span className="font-semibold text-ink">{dueToday.length + overdue.length}</span> due
        </p>
      </div>

      <QuickAdd tz={tz} />

      <section aria-labelledby="focus-heading" className="card p-4 sm:p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="focus-heading" className="flex items-center gap-2 text-base font-semibold">
            <Icon name="sparkles" className="size-4 text-accent" /> Focus next
          </h2>
          <span className="text-xs text-ink-3">{ranked.data ? 'Ranked by urgency, deadlines and goals' : 'Sorted locally'}</span>
        </div>
        {focus.length ? (
          <TaskList label="Focus next" tasks={focus} tz={tz} onEdit={edit} reasons={reasons} />
        ) : (
          <EmptyState icon="check" title="Nothing open — enjoy the calm">
            Add a task above, or plan something for later in the Planner.
          </EmptyState>
        )}
      </section>

      {overdue.length ? (
        <section aria-labelledby="overdue-heading">
          <SectionHeader title={`Overdue (${overdue.length})`} />
          <div className="card border-danger/30 p-3 sm:p-4">
            <TaskList label="Overdue" tasks={overdue} tz={tz} onEdit={edit} />
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <SectionHeader title="Due today" />
          <div className="card p-3 sm:p-4">
            {dueToday.length ? (
              <TaskList label="Due today" tasks={dueToday} tz={tz} onEdit={edit} />
            ) : (
              <p className="py-4 text-center text-sm text-ink-3">Nothing due today.</p>
            )}
          </div>
        </section>
        <section>
          <SectionHeader title="Planned for today" />
          <div className="card p-3 sm:p-4">
            {planned.length ? (
              <TaskList label="Planned for today" tasks={planned} tz={tz} onEdit={edit} />
            ) : (
              <p className="py-4 text-center text-sm text-ink-3">Use “Plan to work on” to schedule tasks for today.</p>
            )}
          </div>
        </section>
      </div>

      <button
        type="button"
        onClick={() => edit(null)}
        className="btn-primary fixed right-4 bottom-20 z-10 size-14 rounded-full p-0 shadow-lg lg:hidden"
        aria-label="New task with details"
      >
        <Icon name="plus" className="size-6" />
      </button>

      <TaskEditor open={editorOpen} task={editing} tz={tz} onClose={() => setEditorOpen(false)} />
    </div>
  )
}
