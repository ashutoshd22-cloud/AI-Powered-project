import { useState } from 'react'
import { useLocalTasks, useSyncEngine } from '../app/SyncContext'
import { describeDue } from '../lib/time'
import type { SyncConflict, Task } from '../lib/types'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Notes',
  priority: 'Priority',
  category: 'Category',
  status: 'Status',
  due_at: 'Due',
  scheduled_for: 'Planned for',
  remind_at: 'Reminder',
  estimated_minutes: 'Estimate',
  goal_id: 'Goal',
  deleted: 'Deleted',
}

function show(field: string, value: unknown, tz: string): string {
  if (value === null || value === undefined || value === '') return '—'
  if ((field === 'due_at' || field === 'remind_at') && typeof value === 'string') return describeDue(value, true, tz)
  return String(value)
}

function ConflictRow({ conflict, tz }: { conflict: SyncConflict; tz: string }) {
  const engine = useSyncEngine()
  const server = conflict.server
  const local = engine.getTask(conflict.task_id)
  const fields = Object.keys(conflict.local).filter((k) => k !== 'due_has_time')
  return (
    <li className="rounded-lg border border-border p-3">
      <p className="font-medium">{local?.title ?? server?.title ?? 'Task'}</p>
      <p className="mb-2 text-xs text-ink-3">
        {conflict.kind === 'delete'
          ? server?.deleted_at
            ? 'You deleted this here; it was also deleted elsewhere.'
            : 'You deleted this here, but it was edited on another device.'
          : server?.deleted_at
            ? 'You edited this here, but it was deleted on another device.'
            : conflict.message}
      </p>
      {conflict.kind === 'upsert' && fields.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-3">
              <tr>
                <th className="py-1 pr-3 font-medium">Field</th>
                <th className="py-1 pr-3 font-medium">This device</th>
                <th className="py-1 font-medium">Other device</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f} className="border-t border-border/60 align-top">
                  <td className="py-1 pr-3 text-ink-3">{FIELD_LABELS[f] ?? f}</td>
                  <td className="py-1 pr-3 break-words">{show(f, (conflict.local as Record<string, unknown>)[f], tz)}</td>
                  <td className="py-1 break-words">{server ? show(f, (server as unknown as Record<string, unknown>)[f as keyof Task], tz) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={() => void engine.resolveConflict(conflict.task_id, 'mine')}>
          Keep this device's version
        </button>
        <button type="button" className="btn-secondary" onClick={() => void engine.resolveConflict(conflict.task_id, 'server')}>
          Use the other version
        </button>
      </div>
    </li>
  )
}

export function ConflictCenter({ tz }: { tz: string }) {
  const { state } = useLocalTasks()
  const [open, setOpen] = useState(false)
  const count = state.conflicts.length
  if (!count) return null
  return (
    <>
      <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
        <Icon name="alert" className="size-5 text-warn" />
        <p className="flex-1">
          {count} offline change{count === 1 ? '' : 's'} conflict{count === 1 ? 's' : ''} with edits made elsewhere. Nothing was overwritten — choose
          which version to keep.
        </p>
        <button type="button" className="btn-secondary min-h-9" onClick={() => setOpen(true)}>
          Review
        </button>
      </div>
      <Dialog open={open && count > 0} onClose={() => setOpen(false)} title="Resolve sync conflicts" size="lg">
        <ul className="space-y-3">
          {state.conflicts.map((c) => (
            <ConflictRow key={c.task_id} conflict={c} tz={tz} />
          ))}
        </ul>
      </Dialog>
    </>
  )
}
