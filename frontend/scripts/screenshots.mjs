// Generates the README screenshots against a running dev stack (web :5173, API :8000).
// Usage: PW_CHANNEL=msedge node scripts/screenshots.mjs
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
// fileURLToPath decodes %20 etc., so paths with spaces work on every OS.
const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined })
const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'light', locale: 'en-GB' })
const page = await context.newPage()
const api = context.request
const email = `showcase-${Date.now()}@example.com`

const reg = await api.post(`${BASE}/api/v1/auth/register`, {
  data: { email, password: 'showcase-password-1', display_name: 'Alex Rivera', timezone: 'Europe/London' },
})
const { csrf_token: csrf } = await reg.json()
const headers = { 'X-CSRF-Token': csrf }

const goal = await (await api.post(`${BASE}/api/v1/goals`, { headers, data: { title: 'Launch portfolio site', target_date: '2026-12-15' } })).json()
await api.post(`${BASE}/api/v1/goals`, { headers, data: { title: 'Read 12 books', target_value: 12, current_value: 7, unit: 'books' } })
await api.post(`${BASE}/api/v1/ai/tasks/from-text`, {
  headers,
  data: {
    request_id: crypto.randomUUID(),
    text: [
      'Finish quarterly report tomorrow 10am #work urgent',
      'Call Mom tonight #family',
      'Book dentist next tuesday #health',
      'Renew passport by friday !high #admin',
      'Plan sprint retro monday 2pm #work',
      'Buy groceries #home',
    ].join('\n'),
  },
})
for (const title of ['Design hero section', 'Write case studies', 'Deploy to production']) {
  await api.post(`${BASE}/api/v1/tasks`, { headers, data: { title, goal_id: goal.id, category: 'portfolio' } })
}
const tasks = (await (await api.get(`${BASE}/api/v1/tasks`, { params: { page_size: 50 } })).json()).items
for (const t of tasks.filter((t) => ['Design hero section', 'Buy groceries'].includes(t.title))) {
  await api.patch(`${BASE}/api/v1/tasks/${t.id}`, { headers, data: { status: 'done' } })
}

async function shot(path, name) {
  await page.goto(`${BASE}${path}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(OUT, name) })
}

await shot('/', 'today-light.png')
await shot('/planner?view=week', 'planner-week.png')
await shot('/insights', 'insights.png')
await shot('/goals', 'goals.png')

await page.emulateMedia({ colorScheme: 'dark' })
await shot('/', 'today-dark.png')

await page.setViewportSize({ width: 390, height: 844 })
await shot('/', 'mobile-today.png')
await shot('/planner?view=month', 'mobile-planner.png')

await browser.close()
console.log('Screenshots written to docs/screenshots')
