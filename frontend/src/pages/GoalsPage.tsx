import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { useLocalTasks } from '../app/SyncContext'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { EmptyState, ErrorState, Spinner } from '../components/States'
import { useToast } from '../components/Toast'
import { errorMessage, request } from '../lib/api'
import { formatDayKey } from '../lib/time'
import type { Goal } from '../lib/types'

interface GoalForm {
  title: string
  description: string
  target_date: string
  target_value: string
  current_value: string
  unit: string
}

const empty: GoalForm = { title: '', description: '', target_date: '', target_value: '', current_value: '0', unit: '' }

function toPayload(f: GoalForm): { payload?: Record<string, unknown>; error?: string } {
  if (!f.title.trim()) return { error: 'Please give the goal a title.' }
  const target = f.target_value ? Number(f.target_value) : null
  const current = f.current_value ? Number(f.current_value) : 0
  if (target !== null && (!Number.isFinite(target) || target <= 0)) return { error: 'Target must be a positive number.' }
  if (!Number.isFinite(current) || current < 0) return { error: 'Progress cannot be negative.' }
  return {
    payload: {
      title: f.title.trim(),
      description: f.description,
      target_date: f.target_date || null,
      target_value: target,
      current_value: current,
      unit: f.unit.trim(),
    },
  }
}

function GoalEditor({ open, goal, onClose }: { open: boolean; goal: Goal | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const id = useId()
  const [form, setForm] = useState<GoalForm>(empty)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setError(null)
    setForm(
      goal
        ? {
            title: goal.title,
            description: goal.description,
            target_date: goal.target_date ?? '',
            target_value: goal.target_value?.toString() ?? '',
            current_value: goal.current_value.toString(),
            unit: goal.unit,
          }
        : empty,
    )
  }, [open, goal])

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      goal ? request<Goal>(`/goals/${goal.id}`, { method: 'PATCH', body: payload }) : request<Goal>('/goals', { method: 'POST', body: payload }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['goals'] })
      toast.show(goal ? 'Goal updated' : 'Goal created', 'success')
      onClose()
    },
    onError: (err) => setError(errorMessage(err)),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const { payload, error: err } = toPayload(form)
    if (!payload) return setError(err ?? 'Invalid input')
    save.mutate(payload)
  }
  const set = (k: keyof GoalForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={goal ? 'Edit goal' : 'New goal'}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} className="btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save goal'}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
        {error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`${id}-t`}>
            Goal
          </label>
          <input id={`${id}-t`} className="input" maxLength={200} value={form.title} onChange={set('title')} placeholder="e.g. Run a half marathon" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`${id}-d`}>
            Why it matters (optional)
          </label>
          <textarea id={`${id}-d`} className="input min-h-16 py-2" maxLength={5000} value={form.description} onChange={set('description')} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-date`}>
            Target date
          </label>
          <input id={`${id}-date`} type="date" className="input" value={form.target_date} onChange={set('target_date')} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-unit`}>
            Unit (optional)
          </label>
          <input id={`${id}-unit`} className="input" maxLength={30} value={form.unit} onChange={set('unit')} placeholder="km, books, $" />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-target`}>
            Target amount
          </label>
          <input id={`${id}-target`} type="number" min={0} step="any" className="input" value={form.target_value} onChange={set('target_value')} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-current`}>
            Current amount
          </label>
          <input id={`${id}-current`} type="number" min={0} step="any" className="input" value={form.current_value} onChange={set('current_value')} />
        </div>
        <p className="text-xs text-ink-3 sm:col-span-2">
          Without a target amount, progress is measured by the tasks you link to this goal (choose the goal when editing a task).
        </p>
      </form>
    </Dialog>
  )
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100)
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-ink-3">
        <span>{label}</span>
        <span className="font-medium text-ink">{pct}%</span>
      </div>
      <div className="h-2 rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-2 rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function GoalsPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const { state } = useLocalTasks()
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Goal | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleting, setDeleting] = useState<Goal | null>(null)
  const goals = useQuery({
    queryKey: ['goals', showArchived],
    queryFn: () => request<Goal[]>('/goals', { query: { include_archived: showArchived } }),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => request<Goal>(`/goals/${id}`, { method: 'PATCH', body }),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: ['goals'] })
      if (g.status === 'completed') toast.show(`Goal reached: ${g.title} 🎉`, 'success')
    },
    onError: (err) => toast.show(errorMessage(err), 'error'),
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Goals</h1>
        <div className="flex items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" className="size-4" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={!state.online}
            onClick={() => {
              setEditing(null)
              setEditorOpen(true)
            }}
          >
            <Icon name="plus" /> New goal
          </button>
        </div>
      </div>
      {!state.online ? <p className="text-sm text-warn">Goals can be edited when you're back online.</p> : null}

      {goals.isPending ? <Spinner label="Loading goals" /> : null}
      {goals.isError ? <ErrorState message={errorMessage(goals.error)} onRetry={() => void goals.refetch()} /> : null}
      {goals.data?.length === 0 ? (
        <EmptyState icon="target" title="No goals yet">
          Goals turn tasks into progress. Try “Read 12 books this year” or “Launch my portfolio site”.
        </EmptyState>
      ) : null}

      <ul className="grid gap-4 md:grid-cols-2">
        {goals.data?.map((g) => (
          <li key={g.id} className={`card flex flex-col gap-3 p-4 ${g.status === 'archived' ? 'opacity-70' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="font-semibold break-words">{g.title}</h2>
                <p className="text-xs text-ink-3">
                  {g.status === 'completed' ? 'Completed' : g.status === 'archived' ? 'Archived' : 'Active'}
                  {g.target_date ? ` · by ${formatDayKey(g.target_date, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                </p>
              </div>
              <div className="flex shrink-0">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Edit ${g.title}`}
                  disabled={!state.online}
                  onClick={() => {
                    setEditing(g)
                    setEditorOpen(true)
                  }}
                >
                  <Icon name="edit" className="size-4" />
                </button>
                <button type="button" className="icon-btn hover:text-danger" aria-label={`Delete ${g.title}`} disabled={!state.online} onClick={() => setDeleting(g)}>
                  <Icon name="trash" className="size-4" />
                </button>
              </div>
            </div>
            {g.description ? <p className="text-sm text-ink-2 break-words">{g.description}</p> : null}
            <ProgressBar
              value={g.progress}
              label={
                g.target_value
                  ? `${g.current_value} / ${g.target_value} ${g.unit}`.trim()
                  : g.tasks_total
                    ? `${g.tasks_done} of ${g.tasks_total} linked tasks done`
                    : 'Link tasks to track progress'
              }
            />
            <div className="mt-auto flex flex-wrap gap-2">
              {g.target_value && g.status === 'active' ? (
                <button
                  type="button"
                  className="btn-secondary min-h-9"
                  disabled={!state.online || patch.isPending}
                  onClick={() => patch.mutate({ id: g.id, body: { current_value: Math.min(g.current_value + 1, 1e9) } })}
                >
                  +1 {g.unit}
                </button>
              ) : null}
              {g.status === 'active' ? (
                <button type="button" className="btn-ghost min-h-9" disabled={!state.online} onClick={() => patch.mutate({ id: g.id, body: { status: 'completed' } })}>
                  Mark achieved
                </button>
              ) : null}
              <button
                type="button"
                className="btn-ghost min-h-9"
                disabled={!state.online}
                onClick={() => patch.mutate({ id: g.id, body: { status: g.status === 'archived' ? 'active' : 'archived' } })}
              >
                {g.status === 'archived' ? 'Restore' : 'Archive'}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <GoalEditor open={editorOpen} goal={editing} onClose={() => setEditorOpen(false)} />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete goal?"
        message={<>“{deleting?.title}” will be deleted. Linked tasks are kept but unlinked.</>}
        confirmLabel="Delete goal"
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await request(`/goals/${deleting.id}`, { method: 'DELETE' })
            void qc.invalidateQueries({ queryKey: ['goals'] })
            toast.show('Goal deleted')
          } catch (err) {
            toast.show(errorMessage(err), 'error')
          }
          setDeleting(null)
        }}
      />
    </div>
  )
}
