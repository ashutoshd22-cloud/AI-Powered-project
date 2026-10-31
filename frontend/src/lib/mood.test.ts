import { describe, expect, it } from 'vitest'
import { computeMood, focusMood, MOOD_COLORS } from './mood'
import type { Task } from './types'

const NOW = new Date('2026-10-30T12:00:00Z')
function task(p: Partial<Task>): Task {
  return {
    id: crypto.randomUUID(), title: 't', description: '', priority: 'medium', category: null, status: 'todo', due_at: null,
    due_has_time: false, scheduled_for: null, remind_at: null, reminder_sent_at: null, completed_at: null, estimated_minutes: null,
    goal_id: null, source: 'manual', version: 1, deleted_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...p,
  } as Task
}

describe('ambient mood', () => {
  it('defaults to calm cyan', () => {
    expect(computeMood([], 'UTC', NOW)).toBe('calm')
    expect(MOOD_COLORS.calm[0]).toBe('#22d3ee')
  })
  it('turns to overdue when any open task is late (done tasks ignored)', () => {
    expect(computeMood([task({ due_at: '2026-10-29T10:00:00Z' })], 'UTC', NOW)).toBe('overdue')
    expect(computeMood([task({ due_at: '2026-10-29T10:00:00Z', status: 'done' })], 'UTC', NOW)).toBe('calm')
  })
  it('signals urgent/high work due within 24 hours', () => {
    expect(computeMood([task({ priority: 'urgent', due_at: '2026-10-31T08:00:00Z' })], 'UTC', NOW)).toBe('urgent')
    expect(computeMood([task({ priority: 'low', due_at: '2026-10-31T08:00:00Z' })], 'UTC', NOW)).toBe('calm')
  })
  it('is "clear" when nothing is due today and something was completed today', () => {
    const done = task({ status: 'done', completed_at: '2026-10-30T09:00:00Z' })
    expect(computeMood([done], 'UTC', NOW)).toBe('clear')
    expect(computeMood([done, task({ scheduled_for: '2026-10-30' })], 'UTC', NOW)).toBe('calm')
  })
  it('maps priorities to focus moods', () => {
    expect(focusMood('urgent')).toBe('focus-urgent')
    expect(MOOD_COLORS[focusMood('low')]).toHaveLength(3)
  })
})
