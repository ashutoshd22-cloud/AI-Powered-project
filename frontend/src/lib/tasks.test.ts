import { describe, expect, it } from 'vitest'
import { toFields } from '../components/TaskEditor'
import { bucketByDay, filterTasks, localFocus } from './tasks'
import type { Task } from './types'

function task(partial: Partial<Task>): Task {
  return {
    id: crypto.randomUUID(), title: 't', description: '', priority: 'medium', category: null, status: 'todo', due_at: null,
    due_has_time: false, scheduled_for: null, remind_at: null, reminder_sent_at: null, completed_at: null,
    estimated_minutes: null, goal_id: null, source: 'manual', version: 1, deleted_at: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...partial,
  }
}

describe('planning buckets', () => {
  it('places tasks on their local due day, else their planned day, and collects overdue', () => {
    const now = new Date('2026-10-30T12:00:00Z')
    const tasks = [
      task({ title: 'tokyo', due_at: '2026-10-29T20:00:00Z' }), // 30th in Tokyo
      task({ title: 'planned', scheduled_for: '2026-11-01' }),
      task({ title: 'late', due_at: '2026-10-20T00:00:00Z' }),
      task({ title: 'late but done', due_at: '2026-10-20T00:00:00Z', status: 'done' }),
    ]
    const { byDay, overdue } = bucketByDay(tasks, '2026-10-26', '2026-11-01', 'Asia/Tokyo', '2026-10-30', now)
    expect(byDay.get('2026-10-30')!.map((t) => t.title)).toEqual(['tokyo'])
    expect(byDay.get('2026-11-01')!.map((t) => t.title)).toEqual(['planned'])
    expect(overdue.map((t) => t.title)).toEqual(['late'])
  })

  it('filters by status, priority, category and text', () => {
    const tasks = [
      task({ title: 'Write report', category: 'work', priority: 'high' }),
      task({ title: 'Groceries', description: 'milk, eggs' }),
      task({ title: 'Old', status: 'done' }),
    ]
    expect(filterTasks(tasks, { q: 'EGGS', status: 'open', priority: '', category: '' }).map((t) => t.title)).toEqual(['Groceries'])
    expect(filterTasks(tasks, { q: '', status: 'done', priority: '', category: '' }).map((t) => t.title)).toEqual(['Old'])
    expect(filterTasks(tasks, { q: '', status: 'all', priority: 'high', category: 'work' })).toHaveLength(1)
  })

  it('orders the offline focus list by urgency and deadline', () => {
    const now = new Date('2026-10-30T12:00:00Z')
    const list = localFocus(
      [task({ title: 'low' , priority: 'low' }), task({ title: 'overdue', due_at: '2026-10-29T00:00:00Z' }), task({ title: 'urgent', priority: 'urgent' })],
      now,
    )
    expect(list.map((t) => t.title)).toEqual(['overdue', 'urgent', 'low'])
  })
})

describe('task editor validation', () => {
  const base = {
    title: 'Ship it', description: '', priority: 'medium' as const, category: '', status: 'todo' as const, dueDate: '', dueTime: '',
    scheduledFor: '', reminder: 'none' as const, customReminder: '', estimate: '', goalId: '',
  }

  it('rejects invalid input with a helpful message', () => {
    expect(toFields({ ...base, title: '  ' }, 'UTC').error).toMatch(/title/)
    expect(toFields({ ...base, dueTime: '10:00' }, 'UTC').error).toMatch(/due date/)
    expect(toFields({ ...base, estimate: '0' }, 'UTC').error).toMatch(/Estimate/)
    expect(toFields({ ...base, reminder: '30', dueDate: '2026-11-01' }, 'UTC').error).toMatch(/due date and time/)
    expect(toFields({ ...base, category: 'x'.repeat(51) }, 'UTC').error).toMatch(/Category/)
  })

  it('converts local due times and relative reminders using the profile time zone', () => {
    const { fields } = toFields({ ...base, dueDate: '2026-11-01', dueTime: '18:00', reminder: '30' }, 'Asia/Kolkata')
    expect(fields?.due_at).toBe('2026-11-01T12:30:00.000Z')
    expect(fields?.remind_at).toBe('2026-11-01T12:00:00.000Z')
    expect(fields?.due_has_time).toBe(true)
    const dateOnly = toFields({ ...base, dueDate: '2026-11-01' }, 'UTC').fields
    expect(dateOnly?.due_at).toBe('2026-11-01T23:59:59.000Z')
    expect(dateOnly?.due_has_time).toBe(false)
  })
})
