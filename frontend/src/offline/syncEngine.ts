/**
 * Local-first task store with an outbox that synchronises with the server.
 *
 * - Every change is applied locally (memory + IndexedDB) first, so the UI works offline.
 * - Changes are queued as operations carrying the server `version` they were based on.
 * - The server never applies a stale operation; it reports a conflict and the user decides
 *   ("keep mine" / "use server"). Nothing is silently overwritten or dropped.
 * - Operations have ids, so re-sending after a dropped connection is safe.
 */
import { ApiError, NetworkError, request } from '../lib/api'
import type { SyncConflict, SyncOp, SyncOpResult, Task, TaskFields } from '../lib/types'
import { type LocalDB, openLocalDB } from './db'

export interface PullPage {
  tasks: Task[]
  has_more: boolean
  next: string | null
  cursor: string
  reset_required: boolean
}

export interface Transport {
  push(ops: Omit<SyncOp, 'seq'>[]): Promise<SyncOpResult[]>
  pull(since: string | null, after: string | null): Promise<PullPage>
}

export const httpTransport: Transport = {
  async push(ops) {
    const res = await request<{ results: SyncOpResult[] }>('/sync/push', { method: 'POST', body: { ops } })
    return res.results
  },
  pull(since, after) {
    return request<PullPage>('/sync/pull', { query: { since, after } })
  },
}

export interface SyncState {
  ready: boolean
  online: boolean
  syncing: boolean
  pending: number
  conflicts: SyncConflict[]
  lastSyncedAt: string | null
  lastError: string | null
}

export interface Snapshot {
  tasks: Task[]
  state: SyncState
}

const PUSH_BATCH = 100
const CURSOR_KEY = 'cursor'
const LAST_SYNC_KEY = 'lastSyncedAt'

function uuid(): string {
  return crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

function applyFields(task: Task, fields: TaskFields): Task {
  const next: Task = { ...task, ...fields, updated_at: nowIso() }
  if ('status' in fields) {
    next.completed_at = next.status === 'done' ? (task.completed_at ?? nowIso()) : null
  }
  if (next.due_at === null) next.due_has_time = false
  if ('title' in fields && typeof fields.title === 'string') next.title = fields.title.trim()
  return next
}

export class SyncEngine {
  private db: LocalDB | null = null
  private tasks = new Map<string, Task>()
  private outbox: SyncOp[] = []
  private conflicts = new Map<string, SyncConflict>()
  private inflight = new Set<string>()
  private seq = 0
  private listeners = new Set<() => void>()
  private snapshot: Snapshot
  private timer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private backoffMs = 0
  private stopped = false
  private running: Promise<void> | null = null
  private state: SyncState = {
    ready: false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing: false,
    pending: 0,
    conflicts: [],
    lastSyncedAt: null,
    lastError: null,
  }

  readonly userId: string
  private readonly transport: Transport
  private readonly openDb: (userId: string) => Promise<LocalDB>

  constructor(userId: string, transport: Transport = httpTransport, openDb: (userId: string) => Promise<LocalDB> = openLocalDB) {
    this.userId = userId
    this.transport = transport
    this.openDb = openDb
    this.snapshot = { tasks: [], state: this.state }
  }

  // ------------------------------------------------------------------ lifecycle
  async init(): Promise<void> {
    this.db = await this.openDb(this.userId)
    const [tasks, ops, conflicts, lastSync] = await Promise.all([
      this.db.getAll('tasks'),
      this.db.getAllFromIndex('outbox', 'by_seq'),
      this.db.getAll('conflicts'),
      this.db.get('meta', LAST_SYNC_KEY),
    ])
    for (const t of tasks) this.tasks.set(t.id, t)
    this.outbox = ops
    this.seq = ops.reduce((max, op) => Math.max(max, op.seq), 0)
    for (const c of conflicts) this.conflicts.set(c.task_id, c)
    this.state = { ...this.state, ready: true, lastSyncedAt: lastSync ?? null }
    this.emit()
  }

  start(): void {
    this.stopped = false
    window.addEventListener('online', this.handleOnline)
    window.addEventListener('offline', this.handleOffline)
    document.addEventListener('visibilitychange', this.handleVisible)
    this.interval = setInterval(() => void this.sync(), 60_000)
    void this.sync()
  }

  stop(): void {
    this.stopped = true
    window.removeEventListener('online', this.handleOnline)
    window.removeEventListener('offline', this.handleOffline)
    document.removeEventListener('visibilitychange', this.handleVisible)
    if (this.interval) clearInterval(this.interval)
    if (this.timer) clearTimeout(this.timer)
    this.db?.close()
  }

  private handleOnline = () => {
    this.backoffMs = 0
    this.setState({ online: true })
    void this.sync()
  }

  private handleOffline = () => this.setState({ online: false })

  private handleVisible = () => {
    if (document.visibilityState === 'visible') void this.sync()
  }

  // ------------------------------------------------------------------ subscription
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): Snapshot => this.snapshot

  private emit(): void {
    const tasks = [...this.tasks.values()].filter((t) => t.deleted_at === null)
    this.state = { ...this.state, pending: this.outbox.length, conflicts: [...this.conflicts.values()] }
    this.snapshot = { tasks, state: this.state }
    for (const l of this.listeners) l()
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  hasPending(taskId: string): boolean {
    return this.outbox.some((op) => op.task_id === taskId)
  }

  // ------------------------------------------------------------------ local mutations
  async createTask(fields: TaskFields & { title: string }, source = 'manual'): Promise<Task> {
    const id = uuid()
    const now = nowIso()
    const base: Task = {
      id,
      title: '',
      description: '',
      priority: 'medium',
      category: null,
      status: 'todo',
      due_at: null,
      due_has_time: false,
      scheduled_for: null,
      remind_at: null,
      reminder_sent_at: null,
      completed_at: null,
      estimated_minutes: null,
      goal_id: null,
      recurrence: null,
      series_id: null,
      source,
      version: 0, // 0 = not yet known to the server
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }
    const task = applyFields(base, fields)
    await this.putTask(task)
    await this.enqueue({ kind: 'upsert', task_id: id, base_version: null, data: { ...fields } })
    return task
  }

  async updateTask(id: string, fields: TaskFields): Promise<Task> {
    const current = this.tasks.get(id)
    if (!current) throw new Error('Task not found')
    const next = applyFields(current, fields)
    await this.putTask(next)
    await this.enqueue({
      kind: 'upsert',
      task_id: id,
      base_version: current.version === 0 ? null : current.version,
      data: { ...fields },
    })
    return next
  }

  async deleteTask(id: string): Promise<void> {
    const current = this.tasks.get(id)
    if (!current) return
    const hasInflight = this.outbox.some((op) => op.task_id === id && this.inflight.has(op.op_id))
    // Drop queued (not yet sent) edits for this task: the delete supersedes them.
    const dropped = this.outbox.filter((op) => op.task_id === id && !this.inflight.has(op.op_id))
    this.outbox = this.outbox.filter((op) => !dropped.includes(op))
    await Promise.all(dropped.map((op) => this.db?.delete('outbox', op.op_id)))

    if (current.version === 0 && !hasInflight) {
      // Never reached the server: forget it entirely.
      this.tasks.delete(id)
      await this.db?.delete('tasks', id)
      this.emit()
      return
    }
    await this.putTask({ ...current, deleted_at: nowIso() })
    await this.enqueue({ kind: 'delete', task_id: id, base_version: current.version === 0 ? null : current.version, data: {} })
  }

  private async putTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task)
    await this.db?.put('tasks', task)
    this.emit()
  }

  private async enqueue(op: Omit<SyncOp, 'op_id' | 'seq'>): Promise<void> {
    if (op.kind === 'upsert') {
      // Coalesce with the latest queued upsert for the same task that has not been sent yet.
      for (let i = this.outbox.length - 1; i >= 0; i--) {
        const existing = this.outbox[i]
        if (existing.task_id !== op.task_id) continue
        if (existing.kind === 'upsert' && !this.inflight.has(existing.op_id)) {
          existing.data = { ...existing.data, ...op.data }
          await this.db?.put('outbox', existing)
          this.emit()
          this.scheduleSync()
          return
        }
        break
      }
    }
    const full: SyncOp = { ...op, op_id: uuid(), seq: ++this.seq }
    this.outbox.push(full)
    await this.db?.put('outbox', full)
    this.emit()
    this.scheduleSync()
  }

  // ------------------------------------------------------------------ conflicts
  async resolveConflict(taskId: string, choice: 'mine' | 'server'): Promise<void> {
    const conflict = this.conflicts.get(taskId)
    if (!conflict) return
    this.conflicts.delete(taskId)
    await this.db?.delete('conflicts', taskId)
    const server = conflict.server
    if (choice === 'server') {
      if (!server || server.deleted_at) {
        this.tasks.delete(taskId)
        await this.db?.delete('tasks', taskId)
      } else {
        await this.putTask(server)
      }
      this.emit()
      return
    }
    // Keep mine: re-base the local change on the server's current version.
    const local = this.tasks.get(taskId)
    if (conflict.kind === 'delete') {
      if (server && !server.deleted_at) {
        await this.enqueue({ kind: 'delete', task_id: taskId, base_version: server.version, data: {} })
      } else if (local) {
        this.tasks.delete(taskId)
        await this.db?.delete('tasks', taskId)
        this.emit()
      }
      return
    }
    if (local) await this.putTask({ ...local, version: server?.version ?? 0, deleted_at: null })
    const data = { ...conflict.local, ...(server?.deleted_at ? { deleted: false } : {}) }
    if (!server && local) Object.assign(data, { title: local.title })
    await this.enqueue({ kind: 'upsert', task_id: taskId, base_version: server?.version ?? null, data })
  }

  // ------------------------------------------------------------------ synchronisation
  scheduleSync(delay = 300): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync(), delay)
  }

  /** Push queued operations, then pull remote changes. Concurrent calls share one run. */
  sync(): Promise<void> {
    if (this.running) return this.running
    this.running = this.runSync().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runSync(): Promise<void> {
    if (!this.db || this.stopped) return
    this.setState({ syncing: true })
    try {
      while (this.outbox.length) {
        const sentCount = await this.pushBatch()
        if (sentCount === 0) break
      }
      await this.pull()
      const stamp = nowIso()
      await this.db?.put('meta', stamp, LAST_SYNC_KEY)
      this.backoffMs = 0
      this.setState({ online: true, lastSyncedAt: stamp, lastError: null })
    } catch (err) {
      if (err instanceof NetworkError) {
        this.setState({ online: false })
        this.backoffMs = Math.min(60_000, this.backoffMs ? this.backoffMs * 2 : 5_000)
        this.scheduleSync(this.backoffMs)
      } else if (err instanceof ApiError && err.status === 401) {
        this.setState({ lastError: 'Signed out — sign in again to sync your changes.' })
      } else {
        this.setState({ lastError: err instanceof Error ? err.message : 'Sync failed' })
      }
    } finally {
      this.setState({ syncing: false })
    }
  }

  private async pushBatch(): Promise<number> {
    const batch = this.outbox.slice(0, PUSH_BATCH)
    batch.forEach((op) => this.inflight.add(op.op_id))
    let results: SyncOpResult[]
    try {
      results = await this.transport.push(batch.map(({ seq: _seq, ...rest }) => rest))
    } finally {
      batch.forEach((op) => this.inflight.delete(op.op_id))
    }
    const byId = new Map(results.map((r) => [r.op_id, r]))
    for (const op of batch) {
      const result = byId.get(op.op_id)
      if (!result) continue
      await this.removeOp(op.op_id)
      await this.handleResult(op, result)
    }
    this.emit()
    return batch.length
  }

  private async removeOp(opId: string): Promise<void> {
    this.outbox = this.outbox.filter((o) => o.op_id !== opId)
    await this.db?.delete('outbox', opId)
  }

  private async handleResult(op: SyncOp, result: SyncOpResult): Promise<void> {
    const server = result.task
    if (result.status === 'applied' || result.status === 'duplicate') {
      if (!server) {
        if (op.kind === 'delete') {
          this.tasks.delete(op.task_id)
          await this.db?.delete('tasks', op.task_id)
        }
        return
      }
      // Later queued edits of ours were based on the version this op replaced: re-base them.
      for (const pending of this.outbox) {
        if (pending.task_id === op.task_id && pending.base_version === op.base_version) {
          pending.base_version = server.version
          await this.db?.put('outbox', pending)
        }
      }
      if (this.hasPending(op.task_id)) {
        const local = this.tasks.get(op.task_id)
        if (local) await this.putTask({ ...local, version: server.version })
      } else if (server.deleted_at) {
        this.tasks.delete(server.id)
        await this.db?.delete('tasks', server.id)
      } else {
        await this.putTask(server)
      }
      return
    }

    if (result.status === 'conflict') {
      // Fold any other queued edits for this task into the conflict so they are not lost.
      const related = this.outbox.filter((o) => o.task_id === op.task_id)
      const local = related.reduce((acc, o) => ({ ...acc, ...o.data }), { ...op.data })
      for (const o of related) await this.removeOp(o.op_id)
      const previous = this.conflicts.get(op.task_id)
      const conflict: SyncConflict = {
        task_id: op.task_id,
        kind: related.some((o) => o.kind === 'delete') ? 'delete' : op.kind,
        local: { ...(previous?.local ?? {}), ...local },
        server,
        message: result.error ?? 'This task was changed somewhere else.',
        detected_at: nowIso(),
      }
      this.conflicts.set(op.task_id, conflict)
      await this.db?.put('conflicts', conflict)
      return
    }

    // rejected: the server will never accept this op; restore the server's copy if there is one.
    if (server) {
      await this.putTask(server)
    } else if (this.tasks.get(op.task_id)?.version === 0 && !this.hasPending(op.task_id)) {
      this.tasks.delete(op.task_id)
      await this.db?.delete('tasks', op.task_id)
    }
    this.state = { ...this.state, lastError: result.error ?? 'A change was rejected by the server.' }
  }

  private async pull(): Promise<void> {
    if (!this.db) return
    let since = (await this.db.get('meta', CURSOR_KEY)) ?? null
    let full = since === null
    let after: string | null = null
    let cursor: string | null = null
    const seen = new Set<string>()

    for (;;) {
      const page = await this.transport.pull(since, after)
      if (page.reset_required) {
        since = null
        after = null
        full = true
        cursor = null
        continue
      }
      cursor ??= page.cursor
      for (const incoming of page.tasks) {
        seen.add(incoming.id)
        await this.applyRemote(incoming)
      }
      if (!page.has_more) break
      after = page.next
    }

    if (full) {
      // A full listing is authoritative: drop synced tasks the server no longer has.
      for (const [id, task] of this.tasks) {
        if (!seen.has(id) && task.version > 0 && !this.hasPending(id) && !this.conflicts.has(id)) {
          this.tasks.delete(id)
          await this.db.delete('tasks', id)
        }
      }
    }
    if (cursor) await this.db.put('meta', cursor, CURSOR_KEY)
    this.emit()
  }

  private async applyRemote(incoming: Task): Promise<void> {
    if (this.hasPending(incoming.id) || this.conflicts.has(incoming.id)) return // local change wins until pushed
    const local = this.tasks.get(incoming.id)
    if (incoming.deleted_at) {
      if (local) {
        this.tasks.delete(incoming.id)
        await this.db?.delete('tasks', incoming.id)
      }
      return
    }
    if (!local || incoming.version >= local.version) {
      this.tasks.set(incoming.id, incoming)
      await this.db?.put('tasks', incoming)
    }
  }
}
