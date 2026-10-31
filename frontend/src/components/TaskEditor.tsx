import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'
import { useLocalTasks, useSyncEngine } from '../app/SyncContext'
import { useAmbient } from '../app/backdrop'
import { focusMood } from '../lib/mood'
import { request } from '../lib/api'
import { PRIORITIES, PRIORITY_LABEL, categoriesOf } from '../lib/tasks'
import { type RepeatChoice, type RepeatUnit, WEEKDAY_CODES, choiceFor, parseRule, ruleFor, weekdayCode } from '../lib/recurrence'
import { dateKey, endOfLocalDay, formatDayKey, timeKey, zonedToUtc } from '../lib/time'
import type { Goal, Priority, Task, TaskFields, TaskStatus } from '../lib/types'
import { Dialog } from './Dialog'
import { useToast } from './Toast'

type ReminderChoice = 'none' | 'at' | '10' | '30' | '60' | '1440' | 'custom'

interface Props {
  open: boolean
  task: Task | null
  tz: string
  defaults?: Partial<TaskFields>
  onClose: () => void
}

interface FormState {
  title: string
  description: string
  priority: Priority
  category: string
  status: TaskStatus
  dueDate: string
  dueTime: string
  scheduledFor: string
  reminder: ReminderChoice
  customReminder: string
  estimate: string
  goalId: string
  repeat: RepeatChoice
  repeatInterval: string
  repeatUnit: RepeatUnit
  repeatDays: string[]
}

function initialState(task: Task | null, tz: string, defaults?: Partial<TaskFields>): FormState {
  const src = { ...defaults, ...(task ?? {}) }
  const due = src.due_at ?? null
  let reminder: ReminderChoice = 'none'
  let customReminder = ''
  if (src.remind_at && due) {
    const diff = Math.round((new Date(due).getTime() - new Date(src.remind_at).getTime()) / 60000)
    const preset = ({ 0: 'at', 10: '10', 30: '30', 60: '60', 1440: '1440' } as Record<number, ReminderChoice>)[diff]
    reminder = preset ?? 'custom'
  } else if (src.remind_at) {
    reminder = 'custom'
  }
  if (reminder === 'custom' && src.remind_at) customReminder = `${dateKey(src.remind_at, tz)}T${timeKey(src.remind_at, tz)}`
  return {
    title: src.title ?? '',
    description: src.description ?? '',
    priority: src.priority ?? 'medium',
    category: src.category ?? '',
    status: src.status ?? 'todo',
    dueDate: due ? dateKey(due, tz) : '',
    dueTime: due && src.due_has_time ? timeKey(due, tz) : '',
    scheduledFor: src.scheduled_for ?? '',
    reminder,
    customReminder,
    estimate: src.estimated_minutes ? String(src.estimated_minutes) : '',
    goalId: src.goal_id ?? '',
    ...repeatState(src.recurrence ?? null, due ? dateKey(due, tz) : ''),
  }
}

/** Converts form state into API fields; returns an error message when invalid. */
export function toFields(f: FormState, tz: string): { fields?: TaskFields; error?: string } {
  const title = f.title.trim()
  if (!title) return { error: 'Please enter a title.' }
  if (title.length > 200) return { error: 'Title must be 200 characters or fewer.' }
  if (f.description.length > 5000) return { error: 'Description must be 5000 characters or fewer.' }
  if (f.category.trim().length > 50) return { error: 'Category must be 50 characters or fewer.' }
  if (f.dueTime && !f.dueDate) return { error: 'Choose a due date for the due time.' }
  const estimate = f.estimate ? Number(f.estimate) : null
  if (f.repeat !== 'none' && !f.dueDate) return { error: 'Choose a due date for a repeating task.' }
  if (f.repeat === 'custom' && f.repeatUnit === 'WEEKLY' && f.repeatDays.length === 0)
    return { error: 'Pick at least one weekday to repeat on.' }
  if (estimate !== null && (!Number.isInteger(estimate) || estimate < 1 || estimate > 1440))
    return { error: 'Estimate must be a whole number of minutes between 1 and 1440.' }

  const dueAt = f.dueDate ? (f.dueTime ? zonedToUtc(f.dueDate, f.dueTime, tz) : endOfLocalDay(f.dueDate, tz)) : null
  let remindAt: string | null = null
  if (f.reminder === 'custom') {
    if (!f.customReminder) return { error: 'Pick a date and time for the reminder.' }
    const [d, t] = f.customReminder.split('T')
    remindAt = zonedToUtc(d, t, tz)
  } else if (f.reminder !== 'none') {
    if (!dueAt || !f.dueTime) return { error: 'Relative reminders need a due date and time.' }
    const minutes = f.reminder === 'at' ? 0 : Number(f.reminder)
    remindAt = new Date(new Date(dueAt).getTime() - minutes * 60000).toISOString()
  }
  return {
    fields: {
      title,
      description: f.description,
      priority: f.priority,
      category: f.category.trim() || null,
      status: f.status,
      due_at: dueAt,
      due_has_time: Boolean(dueAt && f.dueTime),
      scheduled_for: f.scheduledFor || null,
      remind_at: remindAt,
      estimated_minutes: estimate,
      goal_id: f.goalId || null,
      recurrence: ruleFor(f.repeat, f.dueDate, {
        interval: Number(f.repeatInterval) || 1,
        unit: f.repeatUnit,
        days: f.repeatDays,
      }),
    },
  }
}

export function TaskEditor({ open, task, tz, defaults, onClose }: Props) {
  const engine = useSyncEngine()
  const { tasks } = useLocalTasks()
  const toast = useToast()
  const [form, setForm] = useState<FormState>(() => initialState(task, tz, defaults))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const id = useId()
  const goals = useQuery({ queryKey: ['goals'], queryFn: () => request<Goal[]>('/goals'), enabled: open })
  const categories = useMemo(() => categoriesOf(tasks), [tasks])
  const { setFocus } = useAmbient()

  // The ambient light follows the priority of the task being edited.
  useEffect(() => {
    setFocus(open ? focusMood(form.priority) : null)
  }, [open, form.priority, setFocus])
  useEffect(() => () => setFocus(null), [setFocus])

  useEffect(() => {
    if (open) {
      setForm(initialState(task, tz, defaults))
      setError(null)
    }
  }, [open, task, tz, defaults])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const { fields, error: err } = toFields(form, tz)
    if (!fields) {
      setError(err ?? 'Invalid input')
      return
    }
    setSaving(true)
    try {
      if (task) {
        // Only send what changed, so concurrent edits to other fields merge cleanly.
        const changed: TaskFields = {}
        for (const [k, v] of Object.entries(fields) as [keyof TaskFields, unknown][]) {
          if (task[k] !== v) (changed as Record<string, unknown>)[k] = v
        }
        if (Object.keys(changed).length) await engine.updateTask(task.id, changed)
        toast.show('Task saved', 'success')
      } else {
        await engine.createTask({ ...fields, title: fields.title! })
        toast.show('Task added', 'success')
      }
      onClose()
    } catch {
      setError('Could not save the task. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const f = (name: string) => `${id}-${name}`
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={task ? 'Edit task' : 'New task'}
      size="lg"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={f('form')} className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : task ? 'Save changes' : 'Add task'}
          </button>
        </>
      }
    >
      <form id={f('form')} onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-2">
            {error}
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <label className="label" htmlFor={f('title')}>
            Title
          </label>
          <input id={f('title')} className="input" value={form.title} maxLength={200} required autoFocus onChange={(e) => set('title', e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={f('desc')}>
            Notes
          </label>
          <textarea
            id={f('desc')}
            className="input min-h-20 py-2"
            value={form.description}
            maxLength={5000}
            onChange={(e) => set('description', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor={f('priority')}>
            Priority
          </label>
          <select id={f('priority')} className="input" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={f('status')}>
            Status
          </label>
          <select id={f('status')} className="input" value={form.status} onChange={(e) => set('status', e.target.value as TaskStatus)}>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={f('category')}>
            Category
          </label>
          <input
            id={f('category')}
            className="input"
            list={f('categories')}
            value={form.category}
            maxLength={50}
            placeholder="e.g. work"
            onChange={(e) => set('category', e.target.value)}
          />
          <datalist id={f('categories')}>
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor={f('goal')}>
            Goal
          </label>
          <select id={f('goal')} className="input" value={form.goalId} onChange={(e) => set('goalId', e.target.value)}>
            <option value="">No goal</option>
            {(goals.data ?? [])
              .filter((g) => g.status !== 'archived' || g.id === form.goalId)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
          </select>
        </div>
        <fieldset className="grid grid-cols-2 gap-2 sm:col-span-2">
          <legend className="label">Due ({tz})</legend>
          <input aria-label="Due date" type="date" className="input" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
          <input aria-label="Due time (optional)" type="time" className="input" value={form.dueTime} onChange={(e) => set('dueTime', e.target.value)} />
        </fieldset>
        <div>
          <label className="label" htmlFor={f('planned')}>
            Plan to work on
          </label>
          <input id={f('planned')} type="date" className="input" value={form.scheduledFor} onChange={(e) => set('scheduledFor', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={f('estimate')}>
            Estimate (minutes)
          </label>
          <input
            id={f('estimate')}
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            className="input"
            value={form.estimate}
            onChange={(e) => set('estimate', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor={f('reminder')}>
            Reminder
          </label>
          <select id={f('reminder')} className="input" value={form.reminder} onChange={(e) => set('reminder', e.target.value as ReminderChoice)}>
            <option value="none">No reminder</option>
            <option value="at">At due time</option>
            <option value="10">10 minutes before</option>
            <option value="30">30 minutes before</option>
            <option value="60">1 hour before</option>
            <option value="1440">1 day before</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={f('repeat')}>
            Repeat
          </label>
          <select id={f('repeat')} className="input" value={form.repeat} onChange={(e) => set('repeat', e.target.value as RepeatChoice)}>
            <option value="none">Doesn't repeat</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Every weekday (Mon–Fri)</option>
            <option value="weekly">Every week{form.dueDate ? ` on ${formatDayKey(form.dueDate, { weekday: 'long' })}` : ''}</option>
            <option value="biweekly">Every 2 weeks{form.dueDate ? ` on ${formatDayKey(form.dueDate, { weekday: 'long' })}` : ''}</option>
            <option value="monthly">Every month{form.dueDate ? ` on day ${Number(form.dueDate.slice(8))}` : ''}</option>
            <option value="yearly">Every year</option>
            <option value="custom">Custom…</option>
          </select>
          {form.repeat === 'custom' ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink-2">Every</span>
              <input
                aria-label="Repeat interval"
                type="number"
                min={1}
                max={365}
                className="input w-20"
                value={form.repeatInterval}
                onChange={(e) => set('repeatInterval', e.target.value)}
              />
              <select aria-label="Repeat unit" className="input w-auto" value={form.repeatUnit} onChange={(e) => set('repeatUnit', e.target.value as RepeatUnit)}>
                <option value="DAILY">day(s)</option>
                <option value="WEEKLY">week(s)</option>
                <option value="MONTHLY">month(s)</option>
              </select>
              {form.repeatUnit === 'WEEKLY' ? (
                <div role="group" aria-label="Repeat on" className="flex flex-wrap gap-1">
                  {WEEKDAY_CODES.map((code) => (
                    <button
                      key={code}
                      type="button"
                      aria-pressed={form.repeatDays.includes(code)}
                      onClick={() =>
                        set('repeatDays', form.repeatDays.includes(code) ? form.repeatDays.filter((d) => d !== code) : [...form.repeatDays, code])
                      }
                      className={`size-10 rounded-full text-xs font-medium ${form.repeatDays.includes(code) ? 'bg-accent text-on-accent' : 'border border-border text-ink-2'}`}
                    >
                      {code.charAt(0) + code.charAt(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {form.repeat !== 'none' ? (
            <p className="mt-1 text-xs text-ink-3">When you complete it, the next one is created automatically.</p>
          ) : null}
        </div>
        {form.reminder === 'custom' ? (
          <div>
            <label className="label" htmlFor={f('custom')}>
              Remind me at
            </label>
            <input
              id={f('custom')}
              type="datetime-local"
              className="input"
              value={form.customReminder}
              onChange={(e) => set('customReminder', e.target.value)}
            />
          </div>
        ) : null}
      </form>
    </Dialog>
  )
}

function repeatState(rule: string | null, dueDate: string): Pick<FormState, 'repeat' | 'repeatInterval' | 'repeatUnit' | 'repeatDays'> {
  const parsed = rule ? parseRule(rule) : {}
  const unit = (['DAILY', 'WEEKLY', 'MONTHLY'] as RepeatUnit[]).includes(parsed.FREQ as RepeatUnit) ? (parsed.FREQ as RepeatUnit) : 'WEEKLY'
  return {
    repeat: choiceFor(rule, dueDate),
    repeatInterval: parsed.INTERVAL ?? '1',
    repeatUnit: unit,
    repeatDays: parsed.BYDAY ? parsed.BYDAY.split(',').map((d) => d.slice(-2)) : dueDate ? [weekdayCode(dueDate)] : [],
  }
}
