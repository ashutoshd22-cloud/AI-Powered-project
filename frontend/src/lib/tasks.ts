import type { Priority, Task } from './types'
import { addDays, dateKey, isOverdue } from './time'

export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low']
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' }
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

export function compareTasks(a: Task, b: Task): number {
  if ((a.status === 'done') !== (b.status === 'done')) return a.status === 'done' ? 1 : -1
  if (a.due_at && b.due_at && a.due_at !== b.due_at) return a.due_at < b.due_at ? -1 : 1
  if (Boolean(a.due_at) !== Boolean(b.due_at)) return a.due_at ? -1 : 1
  if (a.priority !== b.priority) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  return a.created_at < b.created_at ? -1 : 1
}

export function comparePriority(a: Task, b: Task): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || compareTasks(a, b)
}

/** The local day a task belongs to in planning views: its due date, else its planned date. */
export function planningDay(task: Task, tz: string): string | null {
  if (task.due_at) return dateKey(task.due_at, tz)
  return task.scheduled_for
}

export interface DayBuckets {
  overdue: Task[]
  byDay: Map<string, Task[]>
}

/** Groups tasks into local days within [start, end] (inclusive), matching the server's /planning. */
export function bucketByDay(tasks: Task[], start: string, end: string, tz: string, today: string, now = new Date()): DayBuckets {
  const byDay = new Map<string, Task[]>()
  for (let d = start; d <= end; d = addDays(d, 1)) byDay.set(d, [])
  const overdue: Task[] = []
  for (const t of tasks) {
    const dueDay = t.due_at ? dateKey(t.due_at, tz) : null
    const key = dueDay && dueDay >= start && dueDay <= end ? dueDay : t.scheduled_for
    if (key && byDay.has(key)) byDay.get(key)!.push(t)
    else if (start <= today && today <= end && isOverdue(t, now) && dueDay !== null && dueDay < start) overdue.push(t)
  }
  for (const list of byDay.values()) list.sort(compareTasks)
  overdue.sort(compareTasks)
  return { overdue, byDay }
}

export interface TaskFilter {
  q: string
  status: 'open' | 'all' | 'done' | 'in_progress'
  priority: Priority | ''
  category: string
}

export function filterTasks(tasks: Task[], f: TaskFilter): Task[] {
  const q = f.q.trim().toLowerCase()
  return tasks.filter((t) => {
    if (f.status === 'open' && t.status === 'done') return false
    if (f.status === 'done' && t.status !== 'done') return false
    if (f.status === 'in_progress' && t.status !== 'in_progress') return false
    if (f.priority && t.priority !== f.priority) return false
    if (f.category && t.category !== f.category) return false
    if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q)) return false
    return true
  })
}

/** Offline fallback ordering for the focus list (the server's /ai/prioritize is preferred). */
export function localFocus(tasks: Task[], now = new Date()): Task[] {
  const score = (t: Task) => {
    let s = { urgent: 40, high: 28, medium: 16, low: 6 }[t.priority]
    if (t.due_at) {
      const hours = (new Date(t.due_at).getTime() - now.getTime()) / 3_600_000
      if (hours < 0) s += 35
      else if (hours <= 24) s += 30
      else if (hours <= 72) s += 20
      else if (hours <= 168) s += 10
    }
    return s
  }
  return tasks.filter((t) => t.status !== 'done').sort((a, b) => score(b) - score(a) || compareTasks(a, b))
}

export function categoriesOf(tasks: Task[]): string[] {
  return [...new Set(tasks.map((t) => t.category).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b))
}
