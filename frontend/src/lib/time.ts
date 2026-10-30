/**
 * Time-zone helpers built on Intl (no extra dependency).
 * The app always renders in the *profile* time zone, not the browser's, so that reminders,
 * plans and the daily digest agree with the server.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsCache.set(tz, fmt)
  }
  return fmt
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function wallClock(instant: Date, tz: string): WallClock {
  const out: Record<string, number> = {}
  for (const p of partsFormatter(tz).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second }
}

function offsetMs(instant: Date, tz: string): number {
  const w = wallClock(instant, tz)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "YYYY-MM-DD" of an instant in a zone. */
export function dateKey(instant: Date | string, tz: string): string {
  const w = wallClock(typeof instant === 'string' ? new Date(instant) : instant, tz)
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`
}

export function todayKey(tz: string, now: Date = new Date()): string {
  return dateKey(now, tz)
}

/** "HH:MM" of an instant in a zone. */
export function timeKey(instant: Date | string, tz: string): string {
  const w = wallClock(typeof instant === 'string' ? new Date(instant) : instant, tz)
  return `${pad(w.hour)}:${pad(w.minute)}`
}

/**
 * Converts a local wall-clock time in `tz` to a UTC ISO string. Mirrors the server: times in a
 * DST gap move forward by the gap; ambiguous times use the first occurrence.
 */
export function zonedToUtc(day: string, time: string, tz: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const [hh, mm, ss = 0] = time.split(':').map(Number)
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss)
  // DST transitions are months apart, so the offsets 12h either side are the only candidates.
  const before = offsetMs(new Date(wall - 12 * 3600_000), tz)
  const after = offsetMs(new Date(wall + 12 * 3600_000), tz)
  const matches = (instant: number) => {
    const w = wallClock(new Date(instant), tz)
    return w.year === y && w.month === m && w.day === d && w.hour === hh && w.minute === mm
  }
  const valid = [wall - before, wall - after].filter(matches)
  // Overlap → earliest valid instant; gap (none valid) → pre-transition offset, i.e. shift forward.
  const instant = valid.length ? Math.min(...valid) : wall - before
  return new Date(instant).toISOString()
}

export function endOfLocalDay(day: string, tz: string): string {
  return zonedToUtc(day, '23:59:59', tz)
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Monday-based week start, matching the server's planning view. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
  return addDays(day, -weekday)
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`
}

export function monthEnd(day: string): string {
  const [y, m] = day.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${day.slice(0, 7)}-${pad(last)}`
}

export function daysBetween(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

function dateFromKey(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12))
}

export function formatDayKey(day: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(dateFromKey(day))
}

export function formatInstant(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(new Date(iso))
}

/** Human description of a task due date relative to today, in the user's zone. */
export function describeDue(dueAt: string, hasTime: boolean, tz: string, now: Date = new Date()): string {
  const today = todayKey(tz, now)
  const key = dateKey(dueAt, tz)
  const time = hasTime ? formatInstant(dueAt, tz, { hour: 'numeric', minute: '2-digit' }) : ''
  let day: string
  if (key === today) day = 'Today'
  else if (key === addDays(today, 1)) day = 'Tomorrow'
  else if (key === addDays(today, -1)) day = 'Yesterday'
  else if (key > today && key <= addDays(today, 6)) day = formatDayKey(key, { weekday: 'long' })
  else day = formatDayKey(key, key.slice(0, 4) === today.slice(0, 4) ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
  return time ? `${day}, ${time}` : day
}

export function isOverdue(task: { due_at: string | null; status: string }, now: Date = new Date()): boolean {
  return task.status !== 'done' && task.due_at !== null && new Date(task.due_at).getTime() < now.getTime()
}

export function supportedTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  const zones = intl.supportedValuesOf?.('timeZone') ?? []
  return zones.includes('UTC') ? zones : ['UTC', ...zones]
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = (new Date(iso).getTime() - now.getTime()) / 1000
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const abs = Math.abs(diff)
  if (abs < 60) return rtf.format(Math.round(diff), 'second')
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  return rtf.format(Math.round(diff / 86400), 'day')
}
