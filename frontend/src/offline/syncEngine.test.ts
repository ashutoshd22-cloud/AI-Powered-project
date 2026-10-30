import { beforeEach, describe, expect, it } from 'vitest'
import { NetworkError } from '../lib/api'
import type { SyncOp, SyncOpResult, Task } from '../lib/types'
import { deleteLocalDB } from './db'
import { type PullPage, SyncEngine, type Transport } from './syncEngine'

/** In-memory server implementing the same rules as backend/app/services/sync.py. */
class FakeServer implements Transport {
  tasks = new Map<string, Task>()
  seenOps = new Set<string>()
  offline = false
  clock = Date.parse('2026-10-30T10:00:00Z')

  private tick(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  /** Simulates an edit made on another device. */
  remoteEdit(id: string, fields: Partial<Task>): Task {
    const t = this.tasks.get(id)!
    const next = { ...t, ...fields, version: t.version + 1, updated_at: this.tick() }
    this.tasks.set(id, next)
    return next
  }

  async push(ops: Omit<SyncOp, 'seq'>[]): Promise<SyncOpResult[]> {
    if (this.offline) throw new NetworkError()
    return ops.map((op) => {
      const existing = this.tasks.get(op.task_id) ?? null
      if (this.seenOps.has(op.op_id)) return { op_id: op.op_id, status: 'duplicate', task: existing, error: null }
      if (op.kind === 'delete') {
        if (!existing) return this.ok(op, null)
        if (op.base_version !== null && op.base_version !== existing.version)
          return { op_id: op.op_id, status: 'conflict', task: existing, error: 'changed' }
        const deleted = { ...existing, deleted_at: this.tick(), version: existing.version + 1, updated_at: this.tick() }
        this.tasks.set(op.task_id, deleted)
        return this.ok(op, deleted)
      }
      if (!existing) {
        if (!op.data.title) return { op_id: op.op_id, status: 'rejected', task: null, error: 'title required' }
        const now = this.tick()
        const created: Task = {
          id: op.task_id, title: op.data.title, description: '', priority: 'medium', category: null, status: 'todo',
          due_at: null, due_has_time: false, scheduled_for: null, remind_at: null, reminder_sent_at: null,
          completed_at: null, estimated_minutes: null, goal_id: null, source: 'manual', version: 1, deleted_at: null,
          created_at: now, updated_at: now, ...op.data,
        } as Task
        this.tasks.set(op.task_id, created)
        return this.ok(op, created)
      }
      if (op.base_version === null || op.base_version !== existing.version)
        return { op_id: op.op_id, status: 'conflict', task: existing, error: 'changed' }
      const { deleted, ...fields } = op.data
      const updated = {
        ...existing, ...fields, deleted_at: deleted === false ? null : existing.deleted_at,
        version: existing.version + 1, updated_at: this.tick(),
      }
      this.tasks.set(op.task_id, updated)
      return this.ok(op, updated)
    })
  }

  private ok(op: Omit<SyncOp, 'seq'>, task: Task | null): SyncOpResult {
    this.seenOps.add(op.op_id)
    return { op_id: op.op_id, status: 'applied', task, error: null }
  }

  async pull(since: string | null): Promise<PullPage> {
    if (this.offline) throw new NetworkError()
    const tasks = [...this.tasks.values()].filter((t) => (since ? t.updated_at >= since : !t.deleted_at))
    return { tasks, has_more: false, next: null, cursor: new Date(this.clock - 10_000).toISOString(), reset_required: false }
  }
}

let n = 0
async function makeEngine(server: FakeServer, userId = `u${++n}`) {
  const engine = new SyncEngine(userId, server)
  await engine.init()
  return engine
}

describe('SyncEngine', () => {
  let server: FakeServer
  beforeEach(() => {
    server = new FakeServer()
  })

  it('creates tasks offline and syncs them later without loss', async () => {
    server.offline = true
    const engine = await makeEngine(server)
    const task = await engine.createTask({ title: 'Offline task', priority: 'high' })
    await engine.updateTask(task.id, { status: 'done' })
    await engine.sync()
    expect(engine.getSnapshot().state.online).toBe(false)
    expect(engine.getSnapshot().state.pending).toBe(1) // create + update coalesced
    expect(engine.getSnapshot().tasks[0]).toMatchObject({ title: 'Offline task', status: 'done', version: 0 })

    server.offline = false
    await engine.sync()
    expect(engine.getSnapshot().state.pending).toBe(0)
    expect(server.tasks.get(task.id)).toMatchObject({ title: 'Offline task', status: 'done', priority: 'high', version: 1 })
    expect(engine.getTask(task.id)?.version).toBe(1)
    engine.stop()
  })

  it('persists the outbox across restarts (e.g. tab closed while offline)', async () => {
    server.offline = true
    const first = await makeEngine(server, 'restart-user')
    await first.createTask({ title: 'Survives reload' })
    first.stop()

    server.offline = false
    const second = await makeEngine(server, 'restart-user')
    expect(second.getSnapshot().state.pending).toBe(1)
    await second.sync()
    expect([...server.tasks.values()].map((t) => t.title)).toEqual(['Survives reload'])
    second.stop()
    await deleteLocalDB('restart-user')
  })

  it('surfaces conflicts instead of overwriting, and resolves them either way', async () => {
    const engine = await makeEngine(server)
    const task = await engine.createTask({ title: 'Shared' })
    await engine.sync()

    server.offline = true
    await engine.updateTask(task.id, { title: 'Laptop edit' })
    server.offline = false
    server.remoteEdit(task.id, { title: 'Phone edit' })
    await engine.sync()

    const [conflict] = engine.getSnapshot().state.conflicts
    expect(conflict.server?.title).toBe('Phone edit')
    expect(conflict.local.title).toBe('Laptop edit')
    expect(server.tasks.get(task.id)?.title).toBe('Phone edit') // nothing overwritten
    expect(engine.getTask(task.id)?.title).toBe('Laptop edit') // nothing lost locally

    await engine.resolveConflict(task.id, 'mine')
    await engine.sync()
    expect(server.tasks.get(task.id)?.title).toBe('Laptop edit')
    expect(engine.getSnapshot().state.conflicts).toHaveLength(0)

    // Second round: choose the server version.
    server.offline = true
    await engine.updateTask(task.id, { title: 'Mine again' })
    server.offline = false
    server.remoteEdit(task.id, { title: 'Server wins' })
    await engine.sync()
    await engine.resolveConflict(task.id, 'server')
    expect(engine.getTask(task.id)?.title).toBe('Server wins')
    engine.stop()
  })

  it('rebases successive edits made while an earlier push is in flight', async () => {
    const engine = await makeEngine(server)
    const task = await engine.createTask({ title: 'v1' })
    await engine.sync()
    await engine.updateTask(task.id, { title: 'v2' })
    const pushing = engine.sync()
    await engine.updateTask(task.id, { title: 'v3' }) // queued while v2 is in flight
    await pushing
    await engine.sync()
    expect(engine.getSnapshot().state.conflicts).toHaveLength(0)
    expect(server.tasks.get(task.id)?.title).toBe('v3')
    engine.stop()
  })

  it('pulls remote changes and deletions', async () => {
    const engine = await makeEngine(server)
    const task = await engine.createTask({ title: 'Keep' })
    const gone = await engine.createTask({ title: 'Remove me' })
    await engine.sync()
    server.remoteEdit(task.id, { priority: 'urgent' })
    server.remoteEdit(gone.id, { deleted_at: new Date(server.clock).toISOString() })
    await engine.sync()
    const titles = engine.getSnapshot().tasks.map((t) => t.title)
    expect(titles).toEqual(['Keep'])
    expect(engine.getTask(task.id)?.priority).toBe('urgent')
    engine.stop()
  })

  it('deleting a never-synced task just forgets it; deleting a synced one syncs a tombstone', async () => {
    server.offline = true
    const engine = await makeEngine(server)
    const local = await engine.createTask({ title: 'Typo' })
    await engine.deleteTask(local.id)
    expect(engine.getSnapshot().state.pending).toBe(0)

    server.offline = false
    const synced = await engine.createTask({ title: 'Real' })
    await engine.sync()
    await engine.deleteTask(synced.id)
    expect(engine.getSnapshot().tasks).toHaveLength(0)
    await engine.sync()
    expect(server.tasks.get(synced.id)?.deleted_at).not.toBeNull()
    expect(server.tasks.has(local.id)).toBe(false)
    engine.stop()
  })

  it('retried pushes are idempotent', async () => {
    const engine = await makeEngine(server)
    await engine.createTask({ title: 'Once' })
    // Simulate a lost response: the server applies the op but the client never hears back.
    const realPush = server.push.bind(server)
    let first = true
    server.push = async (ops) => {
      const res = await realPush(ops)
      if (first) {
        first = false
        throw new NetworkError()
      }
      return res
    }
    await engine.sync()
    expect(engine.getSnapshot().state.pending).toBe(1)
    await engine.sync()
    expect(engine.getSnapshot().state.pending).toBe(0)
    expect(server.tasks.size).toBe(1)
    engine.stop()
  })
})
