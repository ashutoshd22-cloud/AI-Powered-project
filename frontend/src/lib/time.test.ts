import { describe, expect, it } from 'vitest'
import { addDays, dateKey, describeDue, endOfLocalDay, isOverdue, monthEnd, timeKey, weekStart, zonedToUtc } from './time'

describe('time helpers', () => {
  it('converts local wall time to UTC in different zones', () => {
    expect(zonedToUtc('2026-10-31', '18:00', 'Asia/Kolkata')).toBe('2026-10-31T12:30:00.000Z')
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York')).toBe('2026-07-01T13:00:00.000Z')
    expect(zonedToUtc('2026-01-01', '09:00', 'America/New_York')).toBe('2026-01-01T14:00:00.000Z')
    expect(zonedToUtc('2026-03-01', '00:00', 'UTC')).toBe('2026-03-01T00:00:00.000Z')
  })

  it('handles DST gaps (shift forward) and overlaps (first occurrence) like the server', () => {
    // 02:30 does not exist on 2027-03-14 in New York → 03:30 EDT = 07:30Z
    expect(zonedToUtc('2027-03-14', '02:30', 'America/New_York')).toBe('2027-03-14T07:30:00.000Z')
    // 01:30 happens twice on 2026-11-01 in New York → first (EDT) = 05:30Z
    expect(zonedToUtc('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
  })

  it('derives local dates and times', () => {
    expect(dateKey('2026-03-10T23:30:00Z', 'Asia/Tokyo')).toBe('2026-03-11')
    expect(timeKey('2026-03-10T23:30:00Z', 'Asia/Tokyo')).toBe('08:30')
    expect(endOfLocalDay('2026-03-11', 'Asia/Tokyo')).toBe('2026-03-11T14:59:59.000Z')
  })

  it('does calendar arithmetic on date keys', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(weekStart('2026-10-30')).toBe('2026-10-26') // Friday → Monday
    expect(weekStart('2026-10-26')).toBe('2026-10-26')
    expect(monthEnd('2026-02-10')).toBe('2026-02-28')
  })

  it('describes due dates relative to the profile time zone', () => {
    const now = new Date('2026-10-30T14:00:00Z')
    expect(describeDue('2026-10-30T23:59:59Z', false, 'UTC', now)).toBe('Today')
    expect(describeDue('2026-10-31T10:00:00Z', false, 'UTC', now)).toBe('Tomorrow')
    // 20:00Z on the 30th is already the 31st in Tokyo.
    expect(describeDue('2026-10-30T20:00:00Z', false, 'Asia/Tokyo', now)).toBe('Tomorrow')
    expect(describeDue('2026-10-29T10:00:00Z', false, 'UTC', now)).toBe('Yesterday')
  })

  it('detects overdue tasks', () => {
    const now = new Date('2026-10-30T14:00:00Z')
    expect(isOverdue({ due_at: '2026-10-30T13:00:00Z', status: 'todo' }, now)).toBe(true)
    expect(isOverdue({ due_at: '2026-10-30T13:00:00Z', status: 'done' }, now)).toBe(false)
    expect(isOverdue({ due_at: null, status: 'todo' }, now)).toBe(false)
  })
})
