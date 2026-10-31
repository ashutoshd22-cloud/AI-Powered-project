/** Repeat rules (RFC 5545 RRULE subset, validated by the server). */

export type RepeatChoice = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom'
export type RepeatUnit = 'DAILY' | 'WEEKLY' | 'MONTHLY'

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const DAY_NAMES: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }

export function parseRule(rule: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of rule.replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=')
    if (k && v) out[k.toUpperCase()] = v.toUpperCase()
  }
  return out
}

/** "MO".."SU" for a YYYY-MM-DD date. */
export function weekdayCode(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return WEEKDAY_CODES[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]
}

export function describeRule(rule: string | null): string {
  if (!rule) return ''
  const p = parseRule(rule)
  const n = Number(p.INTERVAL ?? '1')
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[p.FREQ] ?? 'time'
  if (p.FREQ === 'WEEKLY' && n === 1 && p.BYDAY === 'MO,TU,WE,TH,FR') return 'Every weekday'
  let text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`
  if (p.BYDAY) text += ` on ${p.BYDAY.split(',').map((d) => DAY_NAMES[d.slice(-2)] ?? d).join(', ')}`
  if (p.BYMONTHDAY) text += p.BYMONTHDAY === '-1' ? ' on the last day' : ` on day ${p.BYMONTHDAY}`
  return text
}

/** Maps an editor choice (anchored to the due date) to a rule. */
export function ruleFor(
  choice: RepeatChoice,
  dueDate: string,
  custom: { interval: number; unit: RepeatUnit; days: string[] },
): string | null {
  const day = dueDate ? weekdayCode(dueDate) : 'MO'
  switch (choice) {
    case 'none':
      return null
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${day}`
    case 'biweekly':
      return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${day}`
    case 'monthly':
      return dueDate ? `FREQ=MONTHLY;BYMONTHDAY=${Number(dueDate.slice(8))}` : 'FREQ=MONTHLY'
    case 'yearly':
      return 'FREQ=YEARLY'
    case 'custom': {
      const interval = Math.max(1, Math.min(365, Math.round(custom.interval) || 1))
      let rule = `FREQ=${custom.unit}${interval > 1 ? `;INTERVAL=${interval}` : ''}`
      if (custom.unit === 'WEEKLY' && custom.days.length) {
        rule += `;BYDAY=${WEEKDAY_CODES.filter((d) => custom.days.includes(d)).join(',')}`
      }
      return rule
    }
  }
}

/** Best-effort reverse mapping so an existing rule opens on the matching choice. */
export function choiceFor(rule: string | null, dueDate: string): RepeatChoice {
  if (!rule) return 'none'
  for (const c of ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'] as RepeatChoice[]) {
    if (ruleFor(c, dueDate, { interval: 1, unit: 'DAILY', days: [] }) === rule) return c
  }
  return 'custom'
}
