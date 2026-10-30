import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useId, useState } from 'react'
import { useUser } from '../app/AuthContext'
import { ConfirmDialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { EmptyState, ErrorState, Spinner } from '../components/States'
import { useToast } from '../components/Toast'
import { errorMessage, request } from '../lib/api'
import { formatInstant, relativeTime } from '../lib/time'
import type { ActivityItem, Page } from '../lib/types'

const PAGE_SIZE = 25

export function HistoryPage() {
  const user = useUser()
  const qc = useQueryClient()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [entity, setEntity] = useState('')
  const [page, setPage] = useState(1)
  const [confirmClear, setConfirmClear] = useState(false)
  const deferredQ = useDeferredValue(q)
  const id = useId()

  const history = useQuery({
    queryKey: ['activity', deferredQ, entity, page],
    queryFn: () => request<Page<ActivityItem>>('/activity', { query: { q: deferredQ.trim(), entity_type: entity, page, page_size: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  })
  const pages = history.data ? Math.max(1, Math.ceil(history.data.total / PAGE_SIZE)) : 1

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Activity history</h1>
        <button type="button" className="btn-ghost text-danger" onClick={() => setConfirmClear(true)} disabled={!history.data?.total}>
          <Icon name="trash" className="size-4" /> Clear history
        </button>
      </div>

      <div className="card grid gap-3 p-3 sm:grid-cols-3" role="search">
        <div className="relative sm:col-span-2">
          <label htmlFor={`${id}-q`} className="sr-only">
            Search history
          </label>
          <Icon name="search" className="pointer-events-none absolute top-3 left-3 size-5 text-ink-3" />
          <input
            id={`${id}-q`}
            type="search"
            className="input pl-10"
            placeholder="Search what you did, e.g. “report”"
            value={q}
            maxLength={200}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <select
          aria-label="Type"
          className="input"
          value={entity}
          onChange={(e) => {
            setEntity(e.target.value)
            setPage(1)
          }}
        >
          <option value="">Everything</option>
          <option value="task">Tasks</option>
          <option value="goal">Goals</option>
          <option value="calendar">Calendar</option>
          <option value="account">Account</option>
        </select>
      </div>

      {history.isPending ? <Spinner label="Loading history" /> : null}
      {history.isError ? <ErrorState message={errorMessage(history.error)} onRetry={() => void history.refetch()} /> : null}
      {history.data && history.data.items.length === 0 ? (
        <EmptyState icon="history" title={q || entity ? 'Nothing matches your search' : 'No activity yet'}>
          Everything you create, complete or change shows up here.
        </EmptyState>
      ) : null}

      {history.data?.items.length ? (
        <ol className="card divide-y divide-border/60" aria-label="Activity">
          {history.data.items.map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              <time
                dateTime={a.created_at}
                className="shrink-0 text-xs text-ink-3 sm:w-40"
                title={formatInstant(a.created_at, user.timezone, { dateStyle: 'medium', timeStyle: 'short' })}
              >
                {relativeTime(a.created_at)}
              </time>
              <p className="min-w-0 flex-1 text-sm break-words">{a.summary}</p>
              <span className="chip w-fit bg-surface-2 text-ink-3">{a.entity_type}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {history.data && pages > 1 ? (
        <nav aria-label="Pagination" className="flex items-center justify-center gap-3">
          <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span className="text-sm text-ink-3">
            Page {page} of {pages}
          </span>
          <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </nav>
      ) : null}

      <ConfirmDialog
        open={confirmClear}
        title="Clear activity history?"
        message="This permanently deletes your activity log. Tasks and goals are not affected."
        confirmLabel="Clear history"
        destructive
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          try {
            await request('/activity', { method: 'DELETE' })
            setPage(1)
            void qc.invalidateQueries({ queryKey: ['activity'] })
            toast.show('History cleared')
          } catch (err) {
            toast.show(errorMessage(err), 'error')
          }
          setConfirmClear(false)
        }}
      />
    </div>
  )
}
