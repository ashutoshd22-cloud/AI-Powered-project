import { describe, expect, it } from 'vitest'
import { toFields } from '../components/TaskEditor'
import { choiceFor, describeRule, ruleFor, weekdayCode } from './recurrence'

const custom = { interval: 1, unit: 'DAILY' as const, days: [] }

describe('repeat rules', () => {
  it('maps editor choices to rules anchored on the due date', () => {
    expect(weekdayCode('2026-10-30')).toBe('FR')
    expect(ruleFor('weekly', '2026-10-30', custom)).toBe('FREQ=WEEKLY;BYDAY=FR')
    expect(ruleFor('monthly', '2026-10-30', custom)).toBe('FREQ=MONTHLY;BYMONTHDAY=30')
    expect(ruleFor('custom', '2026-10-30', { interval: 3, unit: 'WEEKLY', days: ['TH', 'MO'] })).toBe('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH')
    expect(ruleFor('none', '2026-10-30', custom)).toBeNull()
  })

  it('round-trips presets and describes rules like the server', () => {
    expect(choiceFor('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-10-30')).toBe('weekdays')
    expect(choiceFor('FREQ=DAILY;INTERVAL=3', '2026-10-30')).toBe('custom')
    expect(describeRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH')).toBe('Every 2 weeks on Mon, Thu')
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every weekday')
    expect(describeRule('FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('Every month on the last day')
  })

  it('editor requires a due date for repeats', () => {
    const base = {
      title: 'Gym', description: '', priority: 'medium' as const, category: '', status: 'todo' as const, dueDate: '', dueTime: '',
      scheduledFor: '', reminder: 'none' as const, customReminder: '', estimate: '', goalId: '', repeat: 'daily' as const,
      repeatInterval: '1', repeatUnit: 'WEEKLY' as const, repeatDays: [] as string[],
    }
    expect(toFields(base, 'UTC').error).toMatch(/due date/)
    expect(toFields({ ...base, dueDate: '2026-11-02' }, 'UTC').fields?.recurrence).toBe('FREQ=DAILY')
    expect(toFields({ ...base, dueDate: '2026-11-02', repeat: 'custom' }, 'UTC').error).toMatch(/weekday/)
  })
})
