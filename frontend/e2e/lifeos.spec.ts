import { type Page, expect, test } from '@playwright/test'

const PASSWORD = 'e2e-password-123'

async function register(page: Page): Promise<string> {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  await page.goto('/register')
  await page.getByLabel('Name').fill('E2E Tester')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel('Confirm password').fill(PASSWORD)
  await page.getByLabel('Time zone').selectOption('Europe/London')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)|Working late/ })).toBeVisible()
  return email
}

async function quickAdd(page: Page, text: string) {
  const input = page.getByLabel('Add a task in plain language').first()
  await input.fill(text)
  await input.press('Enter')
}

async function waitForSynced(page: Page) {
  await expect(page.getByRole('button', { name: /Synced|Up to date/ }).first()).toBeVisible({ timeout: 20_000 })
}

test('register, capture in natural language, complete, and persist across reload', async ({ page }) => {
  await register(page)

  await quickAdd(page, 'Pay rent tomorrow 9am #home !high')
  await expect(page.getByText('Understood with built-in rules')).toBeVisible()
  // Time format follows the browser locale (09:00 vs 9:00 am).
  await expect(page.getByText(/^Tomorrow, 0?9:00( am| AM)? · High · #home$/)).toBeVisible()
  await page.getByRole('button', { name: 'Add 1 task' }).click()
  await expect(page.getByRole('button', { name: 'Pay rent', exact: true }).first()).toBeVisible()

  // Same task again is flagged as a duplicate and not added by default.
  await quickAdd(page, 'pay rent')
  await expect(page.getByText(/You already have an open task “Pay rent”/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add 0 tasks' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('checkbox', { name: 'Mark as done: Pay rent' }).first().click()
  await expect(page.getByText('Completed “Pay rent”')).toBeVisible()
  await waitForSynced(page)

  await page.reload()
  await page.goto('/tasks')
  await page.getByLabel('Status').selectOption('done')
  await expect(page.getByRole('checkbox', { name: 'Mark as not done: Pay rent' })).toBeVisible()
})

test('offline changes are kept locally and synchronised when the connection returns', async ({ page, context }) => {
  await register(page)
  await waitForSynced(page)

  await context.setOffline(true)
  await expect(page.getByText(/You're offline/)).toBeVisible()
  await quickAdd(page, 'Captured on the train')
  await expect(page.getByText(/Smart parsing of dates needs a connection/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Captured on the train', exact: true }).first()).toBeVisible()

  await context.setOffline(false)
  await waitForSynced(page)

  const res = await page.request.get('/api/v1/tasks', { params: { q: 'Captured on the train' } })
  expect(res.ok()).toBeTruthy()
  expect((await res.json()).total).toBe(1)
})

test('planner, goals, insights and history pages work', async ({ page }) => {
  await register(page)
  await quickAdd(page, 'Plan sprint friday #work')
  await page.getByRole('button', { name: 'Add 1 task' }).click()
  await waitForSynced(page)

  await page.goto('/planner?view=week')
  await expect(page.getByRole('heading', { name: 'Planner' })).toBeVisible()
  await page.getByRole('tab', { name: 'month' }).click()
  await expect(page.getByRole('grid')).toBeVisible()

  await page.goto('/goals')
  await page.getByRole('button', { name: 'New goal' }).click()
  await page.getByLabel('Goal', { exact: true }).fill('Read 12 books')
  await page.getByLabel('Target amount').fill('12')
  await page.getByRole('button', { name: 'Save goal' }).click()
  await expect(page.getByRole('heading', { name: 'Read 12 books' })).toBeVisible()
  await page.getByRole('button', { name: '+1' }).click()
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '8')

  await page.goto('/insights')
  await expect(page.getByRole('heading', { name: 'Productivity summary' })).toBeVisible()
  await expect(page.getByText(/You completed|No task activity/)).toBeVisible()

  await page.goto('/history')
  await page.getByLabel('Search history').fill('Read 12')
  await expect(page.getByText('Created goal “Read 12 books”')).toBeVisible()
})

test('export data and delete the account', async ({ page }) => {
  await register(page)
  await page.goto('/settings')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export all data (JSON)' }).click()
  expect((await download).suggestedFilename()).toMatch(/^lifeos-export-.*\.json$/)

  await page.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete your account' })
  await dialog.getByLabel('Password').fill(PASSWORD)
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE')
  await dialog.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401)
})
