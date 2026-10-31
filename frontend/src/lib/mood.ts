import { dateKey, isOverdue, todayKey } from './time'
import type { Priority, Task } from './types'

/** What the ambient light expresses about the user's current situation. */
export type Mood = 'calm' | 'focus-low' | 'focus-medium' | 'focus-high' | 'focus-urgent' | 'urgent' | 'overdue' | 'clear'

/** Three glow colours per mood. Default (calm) is cyan / light blue, as requested. */
export const MOOD_COLORS: Record<Mood, [string, string, string]> = {
  calm: ['#22d3ee', '#38bdf8', '#2dd4bf'],
  clear: ['#34d399', '#2dd4bf', '#a3e635'],
  urgent: ['#fb923c', '#f59e0b', '#22d3ee'],
  overdue: ['#fb7185', '#f97316', '#c084fc'],
  'focus-low': ['#818cf8', '#38bdf8', '#a5b4fc'],
  'focus-medium': ['#22d3ee', '#38bdf8', '#2dd4bf'],
  'focus-high': ['#f59e0b', '#fb923c', '#fde047'],
  'focus-urgent': ['#f43f5e', '#fb7185', '#f97316'],
}

export const MOOD_LABEL: Record<Mood, string> = {
  calm: 'Calm',
  clear: 'All clear',
  urgent: 'Something urgent is due soon',
  overdue: 'Overdue tasks need attention',
  'focus-low': 'Focusing on a low-priority task',
  'focus-medium': 'Focusing on a task',
  'focus-high': 'Focusing on a high-priority task',
  'focus-urgent': 'Focusing on an urgent task',
}

export function focusMood(priority: Priority): Mood {
  return `focus-${priority}` as Mood
}

/** Derives the ambient mood from the task list (in the user's time zone). */
export function computeMood(tasks: Task[], tz: string, now: Date = new Date()): Mood {
  const open = tasks.filter((t) => t.status !== 'done' && t.deleted_at === null)
  if (open.some((t) => isOverdue(t, now))) return 'overdue'
  const soon = now.getTime() + 24 * 3600_000
  if (open.some((t) => (t.priority === 'urgent' || t.priority === 'high') && t.due_at && new Date(t.due_at).getTime() <= soon)) {
    return 'urgent'
  }
  const today = todayKey(tz, now)
  const dueToday = open.some((t) => (t.due_at && dateKey(t.due_at, tz) === today) || t.scheduled_for === today)
  const doneToday = tasks.some((t) => t.completed_at && dateKey(t.completed_at, tz) === today)
  if (!dueToday && doneToday) return 'clear'
  return 'calm'
}
