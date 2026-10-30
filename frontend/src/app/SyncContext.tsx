import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { Spinner } from '../components/States'
import { SyncEngine, type Snapshot } from '../offline/syncEngine'

/** Exported for tests, which inject an engine with a fake transport. */
export const SyncContext = createContext<SyncEngine | null>(null)

export function SyncProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [engine, setEngine] = useState<SyncEngine | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const instance = new SyncEngine(userId)
    let active = true
    instance
      .init()
      .then(() => {
        if (!active) return
        instance.start()
        setEngine(instance)
      })
      .catch(() => setError('Local storage is unavailable (private browsing?). LifeOS needs IndexedDB to work offline.'))
    return () => {
      active = false
      instance.stop()
    }
  }, [userId])

  if (error) return <p className="p-6 text-sm text-danger">{error}</p>
  if (!engine) return <Spinner label="Opening your workspace" />
  return <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>
}

export function useSyncEngine(): SyncEngine {
  const engine = useContext(SyncContext)
  if (!engine) throw new Error('useSyncEngine must be used inside SyncProvider')
  return engine
}

/** Live view of local tasks and sync state (re-renders on every local or synced change). */
export function useLocalTasks(): Snapshot {
  const engine = useSyncEngine()
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}
