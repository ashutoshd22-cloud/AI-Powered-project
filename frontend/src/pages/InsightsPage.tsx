import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useUser } from '../app/AuthContext'
import { useLocalTasks } from '../app/SyncContext'
import { GroupedBars, HBars } from '../components/Charts'
import { Icon } from '../components/Icon'
import { ErrorState, SectionHeader, Spinner } from '../components/States'
import { TaskEditor } from '../components/TaskEditor'
import { TaskList } from '../components/TaskItem'
import { errorMessage, request } from '../lib/api'
import { formatDayKey } from '../lib/time'
import type { AIStatus, InsightsResult, Overview, SummaryResult, Task } from '../lib/types'

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  )
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

function AiBadge({ by }: { by: 'llm' | 'rules' }) {
  return (
    <span className="chip bg-surface-2 text-ink-3" title={by === 'llm' ? 'Written by your local model (Ollama)' : 'Generated from built-in rules'}>
      <Icon name="sparkles" className="size-3" />
      {by === 'llm' ? 'Local AI' : 'Rules'}
    </span>
  )
}

export function InsightsPage() {
  const user = useUser()
  const { state, tasks } = useLocalTasks()
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('week')
  const [days, setDays] = useState(30)
  const [editing, setEditing] = useState<Task | null>(null)
  const online = state.online

  const overview = useQuery({
    queryKey: ['overview', days, tasks.length],
    queryFn: () => request<Overview>('/analytics/overview', { query: { days } }),
    enabled: online,
  })
  const summary = useQuery({
    queryKey: ['summary', period],
    queryFn: () => request<SummaryResult>('/ai/summary', { query: { period } }),
    enabled: online,
    staleTime: 5 * 60_000,
  })
  const insights = useQuery({
    queryKey: ['insights'],
    queryFn: () => request<InsightsResult>('/ai/insights'),
    enabled: online,
    staleTime: 10 * 60_000,
  })
  const attention = useQuery({
    queryKey: ['attention', tasks.length],
    queryFn: () => request<{ overdue: Task[]; neglected: Task[]; neglect_days: number }>('/ai/attention'),
    enabled: online,
  })
  const aiStatus = useQuery({ queryKey: ['ai-status'], queryFn: () => request<AIStatus>('/ai/status'), enabled: online, staleTime: 60_000 })

  if (!online) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Insights</h1>
        <ErrorState message="Insights are calculated on the server. Reconnect to see your analytics — your tasks remain available offline." />
      </div>
    )
  }

  const localById = new Map(tasks.map((t) => [t.id, t]))
  const neglected = (attention.data?.neglected ?? []).map((t) => localById.get(t.id) ?? t)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Insights</h1>
        {aiStatus.data ? (
          <p className="text-xs text-ink-3">
            {aiStatus.data.available && aiStatus.data.model_installed
              ? `Local AI: ${aiStatus.data.model} (on this server)`
              : aiStatus.data.enabled
                ? 'Local AI offline — using built-in rules'
                : 'Local AI disabled — using built-in rules'}
          </p>
        ) : null}
      </div>

      <section className="card p-4 sm:p-5" aria-labelledby="summary-h">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="summary-h" className="text-base font-semibold">
            Productivity summary
          </h2>
          <div role="tablist" aria-label="Summary period" className="inline-flex rounded-lg border border-border p-1">
            {(['day', 'week', 'month'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                onClick={() => setPeriod(p)}
                className={`min-h-9 rounded-md px-3 text-sm capitalize ${period === p ? 'bg-accent text-on-accent' : 'text-ink-2 hover:bg-surface-2'}`}
              >
                {p === 'day' ? 'Today' : `This ${p}`}
              </button>
            ))}
          </div>
        </div>
        {summary.isPending ? <Spinner label="Writing your summary" /> : null}
        {summary.isError ? <ErrorState message={errorMessage(summary.error)} onRetry={() => void summary.refetch()} /> : null}
        {summary.data ? (
          <div className="space-y-3">
            <p className="text-xs text-ink-3">
              {formatDayKey(summary.data.start, { month: 'short', day: 'numeric' })}
              {summary.data.start !== summary.data.end ? ` – ${formatDayKey(summary.data.end, { month: 'short', day: 'numeric' })}` : ''}{' '}
              <AiBadge by={summary.data.generated_by} />
            </p>
            <p className="leading-relaxed">{summary.data.narrative}</p>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ['Completed', summary.data.stats.completed],
                ['Added', summary.data.stats.created],
                ['Missed deadlines', summary.data.stats.missed_deadlines],
                ['Due & done', summary.data.stats.completion_rate === null ? '—' : pct(Number(summary.data.stats.completion_rate))],
              ].map(([k, v]) => (
                <div key={String(k)} className="rounded-lg bg-surface-2 p-3">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{v ?? '—'}</dd>
                </div>
              ))}
            </dl>
            {summary.data.highlights.length ? (
              <p className="text-sm text-ink-2">
                <span className="font-medium">Highlights:</span> {summary.data.highlights.join(' · ')}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="card p-4 sm:p-5" aria-labelledby="insights-h">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="insights-h" className="text-base font-semibold">
            Personal insights
          </h2>
          {insights.data ? <AiBadge by={insights.data.generated_by} /> : null}
        </div>
        {insights.isPending ? <Spinner label="Looking for patterns" /> : null}
        {insights.isError ? <ErrorState message={errorMessage(insights.error)} onRetry={() => void insights.refetch()} /> : null}
        <ul className="space-y-2">
          {insights.data?.insights.map((i) => (
            <li key={i} className="flex gap-2 text-sm">
              <Icon name="sparkles" className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>{i}</span>
            </li>
          ))}
        </ul>
      </section>

      {neglected.length ? (
        <section aria-labelledby="neglected-h">
          <SectionHeader title={`Neglected — untouched for ${attention.data?.neglect_days}+ days`} />
          <div className="card p-3 sm:p-4">
            <TaskList label="Neglected tasks" tasks={neglected} tz={user.timezone} onEdit={setEditing} />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="analytics-h" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="analytics-h" className="text-base font-semibold">
            Progress analytics
          </h2>
          <select aria-label="Time range" className="input min-h-9 w-auto py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        {overview.isPending ? <Spinner label="Crunching numbers" /> : null}
        {overview.isError ? <ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} /> : null}
        {overview.data ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Completed" value={String(overview.data.completed_total)} hint={`${overview.data.created_total} added`} />
              <Stat label="On-time rate" value={pct(overview.data.on_time_rate)} hint="of tasks with a deadline" />
              <Stat label="Streak" value={`${overview.data.streak_days} day${overview.data.streak_days === 1 ? '' : 's'}`} hint="with a completion" />
              <Stat label="Overdue now" value={String(overview.data.overdue_total)} hint={`${overview.data.open_total} open`} />
            </div>
            <div className="card p-4">
              <h3 className="mb-3 text-sm font-semibold">Added vs completed</h3>
              <GroupedBars
                title={`Tasks added and completed per day, last ${days} days`}
                labels={overview.data.series.map((s) => s.date.slice(8))}
                series={[
                  { label: 'Added', values: overview.data.series.map((s) => s.created), className: 'fill-ink-3/40' },
                  { label: 'Completed', values: overview.data.series.map((s) => s.completed), className: 'fill-accent' },
                ]}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="card p-4">
                <h3 className="mb-3 text-sm font-semibold">By category</h3>
                {overview.data.by_category.length ? (
                  <HBars
                    title="Tasks by category"
                    rows={overview.data.by_category.map((c) => ({ label: c.category, value: c.done, secondary: c.open }))}
                  />
                ) : (
                  <p className="text-sm text-ink-3">Add #categories to tasks to see this breakdown.</p>
                )}
              </div>
              <div className="card p-4">
                <h3 className="mb-3 text-sm font-semibold">Completions by weekday</h3>
                <GroupedBars
                  title="Completed tasks by weekday"
                  height={120}
                  labels={overview.data.completions_by_weekday.map((w) => w.weekday.slice(0, 3))}
                  series={[{ label: 'Completed', values: overview.data.completions_by_weekday.map((w) => w.count), className: 'fill-accent' }]}
                />
              </div>
            </div>
          </>
        ) : null}
      </section>

      <TaskEditor open={editing !== null} task={editing} tz={user.timezone} onClose={() => setEditing(null)} />
    </div>
  )
}
