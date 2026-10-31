import { createContext, type ReactNode, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import type { Mood } from '../lib/mood'

export type Backdrop = 'ambient' | 'aurora' | 'dusk' | 'ocean' | 'nebula' | 'minimal'
export type Intensity = 'subtle' | 'vivid'

export const SCENES: { id: Exclude<Backdrop, 'ambient' | 'minimal'>; label: string }[] = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'nebula', label: 'Nebula' },
]

const KEY = 'lifeos:backdrop'
const VALID: Backdrop[] = ['ambient', 'aurora', 'dusk', 'ocean', 'nebula', 'minimal']

interface Prefs {
  backdrop: Backdrop
  intensity: Intensity
}

const DEFAULTS: Prefs = { backdrop: 'ambient', intensity: 'subtle' }
const listeners = new Set<() => void>()
let cached: Prefs | null = null

function read(): Prefs {
  if (cached) return cached
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null
    cached = {
      backdrop: raw?.backdrop && VALID.includes(raw.backdrop) ? raw.backdrop : DEFAULTS.backdrop,
      intensity: raw?.intensity === 'vivid' ? 'vivid' : 'subtle',
    }
  } catch {
    cached = DEFAULTS
  }
  return cached
}

/** Background preference is per device (a phone and a desktop may want different looks). */
export function useBackdropPrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const prefs = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    read,
    () => DEFAULTS,
  )
  const update = useCallback((patch: Partial<Prefs>) => {
    cached = { ...read(), ...patch }
    try {
      localStorage.setItem(KEY, JSON.stringify(cached))
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
    listeners.forEach((l) => l())
  }, [])
  return [prefs, update]
}

interface AmbientApi {
  /** Temporary mood while something specific is in focus (e.g. the task being edited). */
  focus: Mood | null
  setFocus: (mood: Mood | null) => void
}

const AmbientContext = createContext<AmbientApi>({ focus: null, setFocus: () => {} })

export function AmbientProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<Mood | null>(null)
  const value = useMemo(() => ({ focus, setFocus }), [focus])
  return <AmbientContext.Provider value={value}>{children}</AmbientContext.Provider>
}

export function useAmbient(): AmbientApi {
  return useContext(AmbientContext)
}
