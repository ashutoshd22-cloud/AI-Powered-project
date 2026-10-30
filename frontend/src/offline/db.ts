import { type DBSchema, type IDBPDatabase, deleteDB, openDB } from 'idb'
import type { SyncConflict, SyncOp, Task } from '../lib/types'

interface LifeOSSchema extends DBSchema {
  tasks: { key: string; value: Task }
  outbox: { key: string; value: SyncOp; indexes: { by_seq: number } }
  conflicts: { key: string; value: SyncConflict }
  meta: { key: string; value: string }
}

export type LocalDB = IDBPDatabase<LifeOSSchema>

/** One database per account so two people sharing a browser never see each other's data. */
export function dbName(userId: string): string {
  return `lifeos-${userId}`
}

export function openLocalDB(userId: string): Promise<LocalDB> {
  return openDB<LifeOSSchema>(dbName(userId), 1, {
    upgrade(db) {
      db.createObjectStore('tasks', { keyPath: 'id' })
      const outbox = db.createObjectStore('outbox', { keyPath: 'op_id' })
      outbox.createIndex('by_seq', 'seq')
      db.createObjectStore('conflicts', { keyPath: 'task_id' })
      db.createObjectStore('meta')
    },
  })
}

export async function deleteLocalDB(userId: string): Promise<void> {
  await deleteDB(dbName(userId))
}
