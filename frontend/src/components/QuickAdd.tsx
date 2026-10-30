import { type FormEvent, useId, useState } from 'react'
import { useLocalTasks, useSyncEngine } from '../app/SyncContext'
import { NetworkError, errorMessage, request } from '../lib/api'
import { useSpeech } from '../lib/speech'
import { PRIORITY_LABEL } from '../lib/tasks'
import { describeDue } from '../lib/time'
import type { ParseResult, ParsedTask, TaskFields } from '../lib/types'
import { Icon } from './Icon'
import { useToast } from './Toast'

interface Props {
  tz: string
  /** Extra fields applied to every task (e.g. the planner's selected day). */
  defaults?: Partial<TaskFields>
}

interface PreviewItem extends ParsedTask {
  include: boolean
}

/**
 * Natural-language capture. Text is parsed into a *preview* the user confirms, so AI never
 * creates tasks on its own; likely duplicates of open tasks are unticked by default.
 */
export function QuickAdd({ tz, defaults }: Props) {
  const engine = useSyncEngine()
  const { state } = useLocalTasks()
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ items: PreviewItem[]; parser: string; warnings: string[] } | null>(null)
  const inputId = useId()
  const speech = useSpeech((spoken) => setText((t) => (t ? `${t} ${spoken}` : spoken)))

  const addPlain = async (title: string) => {
    await engine.createTask({ title: title.slice(0, 200), ...defaults })
    toast.show('Added. Smart parsing of dates needs a connection — edit the task to add details.', 'info')
    setText('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    if (!value || busy) return
    if (value.length > 2000) {
      toast.show('That is too long — keep it under 2000 characters.', 'error')
      return
    }
    if (!state.online) {
      await addPlain(value)
      return
    }
    setBusy(true)
    try {
      const res = await request<ParseResult>('/ai/parse', { method: 'POST', body: { text: value } })
      setPreview({
        items: res.tasks.map((t) => ({ ...t, include: !t.duplicate_of })),
        parser: res.parser,
        warnings: res.warnings,
      })
    } catch (err) {
      if (err instanceof NetworkError) await addPlain(value)
      else toast.show(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!preview) return
    const chosen = preview.items.filter((i) => i.include)
    // Clear the preview first so a double click cannot add the same tasks twice.
    setPreview(null)
    setText('')
    for (const item of chosen) {
      const fields: TaskFields & { title: string } = {
        ...defaults,
        title: item.title,
        priority: item.priority,
        category: item.category,
        due_at: item.due_at,
        due_has_time: item.due_has_time,
      }
      // Leaving remind_at out lets the server apply the user's default reminder.
      if (item.remind_at) fields.remind_at = item.remind_at
      await engine.createTask(fields, 'natural_language')
    }
    toast.show(chosen.length ? `Added ${chosen.length} task${chosen.length === 1 ? '' : 's'}` : 'Nothing added', chosen.length ? 'success' : 'info')
  }

  return (
    <div className="card p-3 sm:p-4">
      <form onSubmit={submit} className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Add a task in plain language
        </label>
        <input
          id={inputId}
          className="input flex-1"
          placeholder="Add a task… e.g. “Call Mom tomorrow 6pm #family !high”"
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          enterKeyHint="done"
        />
        {speech.supported ? (
          <button
            type="button"
            className={`icon-btn border border-border ${speech.listening ? 'animate-pulse bg-danger-soft text-danger' : ''}`}
            onClick={speech.listening ? speech.stop : speech.start}
            aria-pressed={speech.listening}
            aria-label={speech.listening ? 'Stop dictation' : 'Dictate a task'}
          >
            <Icon name="mic" />
          </button>
        ) : null}
        <button type="submit" className="btn-primary px-3 sm:px-4" disabled={!text.trim() || busy} aria-label="Add task">
          <Icon name="plus" />
          <span className="hidden sm:inline">{busy ? 'Reading…' : 'Add'}</span>
        </button>
      </form>
      {speech.error ? <p className="mt-2 text-xs text-danger">{speech.error}</p> : null}

      {preview ? (
        <div className="mt-3 rounded-lg border border-border bg-surface-2/50 p-3" aria-live="polite">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-3">
            <Icon name="sparkles" className="size-3.5" />
            {preview.parser === 'llm' ? 'Understood by your local AI' : 'Understood with built-in rules'} — review before adding
          </p>
          <ul className="space-y-2">
            {preview.items.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-accent)]"
                  checked={item.include}
                  aria-label={`Include “${item.title}”`}
                  onChange={(e) =>
                    setPreview((p) =>
                      p ? { ...p, items: p.items.map((it, i) => (i === idx ? { ...it, include: e.target.checked } : it)) } : p,
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-words">{item.title}</p>
                  <p className="text-xs text-ink-3">
                    {[
                      item.due_at ? describeDue(item.due_at, item.due_has_time, tz) : 'No due date',
                      item.priority !== 'medium' ? PRIORITY_LABEL[item.priority] : null,
                      item.category ? `#${item.category}` : null,
                      item.remind_at ? 'Reminder' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {item.duplicate_of ? (
                    <p className="mt-0.5 text-xs text-warn">You already have an open task “{item.duplicate_of.title}”. Tick to add anyway.</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {preview.warnings.map((w) => (
            <p key={w} className="mt-2 text-xs text-warn">
              {w}
            </p>
          ))}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={confirm}>
              Add {preview.items.filter((i) => i.include).length} task{preview.items.filter((i) => i.include).length === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
