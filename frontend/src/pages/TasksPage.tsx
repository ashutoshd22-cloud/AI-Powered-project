import { useDeferredValue, useId, useMemo, useState } from 'react'
import { useUser } from '../app/AuthContext'
import { useLocalTasks } from '../app/SyncContext'
import { Icon } from '../components/Icon'
import { QuickAdd } from '../components/QuickAdd'
import { EmptyState } from '../components/States'
import { TaskEditor } from '../components/TaskEditor'
import { TaskList } from '../components/TaskItem'
import { PRIORITIES, PRIORITY_LABEL, type TaskFilter, categoriesOf, comparePriority, compareTasks, filterTasks } from '../lib/tasks'
import type { Priority, Task } from '../lib/types'

const PAGE = 50

export function TasksPage() {
  const user = useUser()
  const { tasks } = useLocalTasks()
  const [filter, setFilter] = useState<TaskFilter>({ q: '', status: 'open', priority: '', category: '' })
  const [sort, setSort] = useState<'due' | 'priority' | 'created'>('due')
  const [limit, setLimit] = useState(PAGE)
  const [editing, setEditing] = useState<Task | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const q = useDeferredValue(filter.q)
  const id = useId()

  const categories = useMemo(() => categoriesOf(tasks), [tasks])
  const visible = useMemo(() => {
    const list = filterTasks(tasks, { ...filter, q })
    const cmp = sort === 'priority' ? comparePriority : sort === 'created' ? (a: Task, b: Task) => (a.created_at < b.created_at ? 1 : -1) : compareTasks
    return list.sort(cmp)
  }, [tasks, filter, q, sort])

  const update = <K extends keyof TaskFilter>(key: K, value: TaskFilter[K]) => {
    setFilter((f) => ({ ...f, [key]: value }))
    setLimit(PAGE)
  }
  const filtered = filter.q || filter.priority || filter.category || filter.status !== 'open'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setEditing(null)
            setEditorOpen(true)
          }}
        >
          <Icon name="plus" /> New task
        </button>
      </div>

      <QuickAdd tz={user.timezone} />

      <div className="card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5" role="search">
        <div className="relative sm:col-span-2 lg:col-span-2">
          <label htmlFor={`${id}-q`} className="sr-only">
            Search tasks
          </label>
          <Icon name="search" className="pointer-events-none absolute top-3 left-3 size-5 text-ink-3" />
          <input
            id={`${id}-q`}
            type="search"
            className="input pl-10"
            placeholder="Search title or notes"
            value={filter.q}
            maxLength={200}
            onChange={(e) => update('q', e.target.value)}
          />
        </div>
        <select aria-label="Status" className="input" value={filter.status} onChange={(e) => update('status', e.target.value as TaskFilter['status'])}>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="done">Completed</option>
          <option value="all">All</option>
        </select>
        <select aria-label="Priority" className="input" value={filter.priority} onChange={(e) => update('priority', e.target.value as Priority | '')}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <select aria-label="Category" className="input" value={filter.category} onChange={(e) => update('category', e.target.value)}>
          <option value="">Any category</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              #{c}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-3">
        <p aria-live="polite">
          {visible.length} task{visible.length === 1 ? '' : 's'}
        </p>
        <label className="flex items-center gap-2">
          Sort
          <select className="input min-h-9 w-auto py-1" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="due">Due date</option>
            <option value="priority">Priority</option>
            <option value="created">Newest</option>
          </select>
        </label>
      </div>

      <div className="card p-3 sm:p-4">
        {visible.length ? (
          <>
            <TaskList
              label="Tasks"
              tasks={visible.slice(0, limit)}
              tz={user.timezone}
              onEdit={(t) => {
                setEditing(t)
                setEditorOpen(true)
              }}
            />
            {visible.length > limit ? (
              <div className="pt-3 text-center">
                <button type="button" className="btn-secondary" onClick={() => setLimit((l) => l + PAGE)}>
                  Show {Math.min(PAGE, visible.length - limit)} more
                </button>
              </div>
            ) : null}
          </>
        ) : filtered ? (
          <EmptyState icon="search" title="No tasks match these filters">
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => setFilter({ q: '', status: 'open', priority: '', category: '' })}>
              Clear filters
            </button>
          </EmptyState>
        ) : (
          <EmptyState icon="list" title="No open tasks">
            Capture everything on your mind — type naturally, like “Book dentist next Tuesday 3pm”.
          </EmptyState>
        )}
      </div>

      <TaskEditor open={editorOpen} task={editing} tz={user.timezone} onClose={() => setEditorOpen(false)} />
    </div>
  )
}
