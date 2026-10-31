import { useState } from 'react'
import { useSyncEngine } from '../app/SyncContext'
import { useToast } from './Toast'
import { describeDue, isOverdue } from '../lib/time'
import { describeRule } from '../lib/recurrence'
import { PRIORITY_LABEL } from '../lib/tasks'
import type { Task } from '../lib/types'
import { Icon } from './Icon'
import { ConfirmDialog } from './Dialog'

interface Props {
  task: Task
  tz: string
  onEdit: (task: Task) => void
  reasons?: string[]
  conflicted?: boolean
  pending?: boolean
  /** Narrow columns (week planner): hide row actions; editing stays available via the title. */
  compact?: boolean
}

const PRIORITY_CHIP: Record<string, string> = {
  urgent: 'bg-danger-soft text-danger',
  high: 'bg-warn-soft text-warn',
  medium: 'bg-surface-2 text-ink-2',
  low: 'bg-surface-2 text-ink-3',
}

export function TaskItem({ task, tz, onEdit, reasons, conflicted, pending, compact }: Props) {
  const engine = useSyncEngine()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const done = task.status === 'done'
  const overdue = isOverdue(task)

  const toggle = async () => {
    await engine.updateTask(task.id, { status: done ? 'todo' : 'done' })
    if (!done) {
      const repeat = task.recurrence ? ' The next one is scheduled.' : ''
      toast.show(`Completed “${task.title}”.${repeat}`, 'success', {
        label: 'Undo',
        run: () => void engine.updateTask(task.id, { status: 'todo' }),
      })
    }
  }

  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-surface-2/60 sm:gap-3">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`${done ? 'Mark as not done' : 'Mark as done'}: ${task.title}`}
        onClick={toggle}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg sm:size-9"
      >
        <span
          className={`flex size-5 items-center justify-center rounded-full border-2 transition-colors ${
            done ? 'border-accent bg-accent text-on-accent' : overdue ? 'border-danger' : 'border-ink-3 group-hover:border-accent'
          }`}
        >
          {done ? <Icon name="check" className="size-3.5" /> : null}
        </span>
      </button>

      <div className="min-w-0 flex-1 py-1.5 sm:py-1">
        <button
          type="button"
          onClick={() => onEdit(task)}
          className={`block min-h-6 w-full text-left text-[15px] leading-snug break-words hover:text-accent ${done ? 'text-ink-3 line-through' : ''}`}
        >
          {task.title}
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          {task.due_at ? (
            <span className={`inline-flex items-center gap-1 ${overdue ? 'font-medium text-danger' : ''}`}>
              <Icon name="clock" className="size-3.5" />
              {overdue ? 'Overdue · ' : ''}
              {describeDue(task.due_at, task.due_has_time, tz)}
            </span>
          ) : null}
          {task.priority === 'urgent' || task.priority === 'high' ? (
            <span className={`chip ${PRIORITY_CHIP[task.priority]}`}>
              <Icon name="flag" className="size-3" />
              {PRIORITY_LABEL[task.priority]}
            </span>
          ) : null}
          {task.category ? <span className="chip bg-accent-soft text-accent-strong">#{task.category}</span> : null}
          {task.recurrence ? (
            <span className="chip bg-info-soft text-ink-2" title={describeRule(task.recurrence)}>
              <span aria-hidden>↻</span> {describeRule(task.recurrence)}
            </span>
          ) : null}
          {task.status === 'in_progress' ? <span className="chip bg-info-soft text-ink-2">In progress</span> : null}
          {task.remind_at && !task.reminder_sent_at && !done ? (
            <span className="inline-flex items-center" title="Reminder set">
              <Icon name="bell" className="size-3.5" title="Reminder set" />
            </span>
          ) : null}
          {conflicted ? <span className="chip bg-warn-soft text-warn">Needs review</span> : null}
          {pending && !conflicted ? (
            <span className="inline-flex items-center gap-1" title="Waiting to sync">
              <span className="size-1.5 rounded-full bg-warn" aria-hidden />
              <span className="sr-only sm:not-sr-only">Not synced</span>
            </span>
          ) : null}
        </div>
        {reasons?.length ? <p className="mt-1 text-xs text-ink-3">{reasons.join(' · ')}</p> : null}
      </div>

      <div
        className={`shrink-0 items-center opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 ${compact ? 'hidden' : 'flex'}`}
      >
        <button type="button" className="icon-btn" onClick={() => onEdit(task)} aria-label={`Edit ${task.title}`}>
          <Icon name="edit" className="size-4" />
        </button>
        <button type="button" className="icon-btn hover:text-danger" onClick={() => setConfirming(true)} aria-label={`Delete ${task.title}`}>
          <Icon name="trash" className="size-4" />
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Delete task?"
        message={<>“{task.title}” will be removed from all your devices.</>}
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await engine.deleteTask(task.id)
          setConfirming(false)
          toast.show('Task deleted')
        }}
      />
    </li>
  )
}

export function TaskList({
  tasks,
  tz,
  onEdit,
  reasons,
  label,
  compact,
}: {
  tasks: Task[]
  tz: string
  onEdit: (t: Task) => void
  reasons?: Map<string, string[]>
  label: string
  compact?: boolean
}) {
  const engine = useSyncEngine()
  const conflicts = new Set(engine.getSnapshot().state.conflicts.map((c) => c.task_id))
  return (
    <ul aria-label={label} className="-mx-2 divide-y divide-border/60">
      {tasks.map((t) => (
        <TaskItem
          key={t.id}
          task={t}
          tz={tz}
          onEdit={onEdit}
          reasons={reasons?.get(t.id)}
          conflicted={conflicts.has(t.id)}
          pending={engine.hasPending(t.id)}
          compact={compact}
        />
      ))}
    </ul>
  )
}
