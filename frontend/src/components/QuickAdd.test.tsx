import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParseResult, Task } from '../lib/types'
import { jsonResponse, makeEngine, renderWithProviders } from '../test/utils'
import { QuickAdd } from './QuickAdd'

const existing = { id: 'x', title: 'Buy milk' } as Task

function parseResult(): ParseResult {
  return {
    parser: 'rules',
    warnings: [],
    tasks: [
      { title: 'Call Ana', priority: 'high', category: 'family', due_at: '2026-11-01T17:00:00Z', due_has_time: true, remind_at: null, duplicate_of: null },
      { title: 'Buy milk', priority: 'medium', category: null, due_at: null, due_has_time: false, remind_at: null, duplicate_of: existing },
    ],
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('QuickAdd', () => {
  it('previews parsed tasks and only adds what the user confirms (duplicates unticked)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(parseResult()))
    vi.stubGlobal('fetch', fetchFn)
    const engine = await makeEngine()
    renderWithProviders(<QuickAdd tz="UTC" />, engine)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Add a task in plain language'), 'call ana sunday 5pm #family !high; buy milk')
    await user.click(screen.getByRole('button', { name: 'Add task' }))

    expect(await screen.findByText('Call Ana')).toBeInTheDocument()
    expect(screen.getByText(/You already have an open task “Buy milk”/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Include “Buy milk”' })).not.toBeChecked()
    expect(engine.getSnapshot().tasks).toHaveLength(0) // preview creates nothing

    await user.click(screen.getByRole('button', { name: 'Add 1 task' }))
    await waitFor(() => expect(engine.getSnapshot().tasks).toHaveLength(1))
    expect(engine.getSnapshot().tasks[0]).toMatchObject({ title: 'Call Ana', priority: 'high', category: 'family', source: 'natural_language' })
    engine.stop()
  })

  it('a double click on confirm cannot add the same tasks twice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(parseResult())))
    const engine = await makeEngine()
    renderWithProviders(<QuickAdd tz="UTC" />, engine)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Add a task in plain language'), 'call ana')
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    const confirm = await screen.findByRole('button', { name: 'Add 1 task' })
    await user.dblClick(confirm)
    await waitFor(() => expect(engine.getSnapshot().tasks).toHaveLength(1))
    engine.stop()
  })

  it('falls back to saving the raw text locally when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'API unavailable' }, 502)))
    const engine = await makeEngine()
    renderWithProviders(<QuickAdd tz="UTC" />, engine)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Add a task in plain language'), 'Offline idea')
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(engine.getSnapshot().tasks.map((t) => t.title)).toEqual(['Offline idea']))
    expect(await screen.findByText(/Smart parsing of dates needs a connection/)).toBeInTheDocument()
    engine.stop()
  })
})

describe('QuickAdd duplicate protection for tasks not yet on the server (regression)', () => {
  it('flags an unsynced local task as a duplicate even when the server does not', async () => {
    const result = parseResult()
    result.tasks = [{ ...result.tasks[1], title: 'Pay rent!', duplicate_of: null }]
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(result)))
    const engine = await makeEngine()
    await engine.createTask({ title: 'pay  RENT' }) // still only on this device
    renderWithProviders(<QuickAdd tz="UTC" />, engine)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Add a task in plain language'), 'Pay rent!')
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    expect(await screen.findByText(/You already have an open task “pay\s+RENT”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add 0 tasks' })).toBeInTheDocument()
    engine.stop()
  })

  it('does not add an offline duplicate unless the user confirms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'API unavailable' }, 502)))
    const engine = await makeEngine()
    await engine.createTask({ title: 'Water plants' })
    renderWithProviders(<QuickAdd tz="UTC" />, engine)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Add a task in plain language'), 'water plants')
    await user.click(screen.getByRole('button', { name: 'Add task' }))
    await user.click(await screen.findByRole('button', { name: 'Add anyway' }))
    await waitFor(() => expect(engine.getSnapshot().tasks).toHaveLength(2))
    engine.stop()
  })
})
