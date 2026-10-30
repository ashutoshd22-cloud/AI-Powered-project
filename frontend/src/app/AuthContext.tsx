import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AUTH_EXPIRED_EVENT, ApiError, NetworkError, request } from '../lib/api'
import type { User } from '../lib/types'
import { deleteLocalDB } from '../offline/db'

const USER_CACHE_KEY = 'lifeos:user'

type Status = 'loading' | 'authenticated' | 'anonymous'

interface AuthApi {
  status: Status
  user: User | null
  /** True when the session could not be verified because the server is unreachable. */
  offlineSession: boolean
  login: (email: string, password: string) => Promise<void>
  register: (data: { email: string; password: string; display_name: string; timezone: string }) => Promise<void>
  logout: (opts: { discardLocalData: boolean }) => Promise<void>
  updateUser: (patch: Partial<User>) => Promise<User>
  setUser: (user: User) => void
}

const AuthContext = createContext<AuthApi | null>(null)

function cacheUser(user: User | null): void {
  try {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user))
    else localStorage.removeItem(USER_CACHE_KEY)
  } catch {
    /* storage unavailable */
  }
}

function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUserState] = useState<User | null>(null)
  const [offlineSession, setOfflineSession] = useState(false)

  const setUser = useCallback((u: User) => {
    setUserState(u)
    cacheUser(u)
  }, [])

  useEffect(() => {
    let cancelled = false
    request<User>('/auth/me')
      .then((u) => {
        if (cancelled) return
        setUser(u)
        setStatus('authenticated')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const cached = cachedUser()
        if (err instanceof NetworkError && cached) {
          // Offline start: keep working from local data; the session is re-checked on reconnect.
          setUserState(cached)
          setOfflineSession(true)
          setStatus('authenticated')
        } else {
          setStatus('anonymous')
        }
      })
    return () => {
      cancelled = true
    }
  }, [setUser])

  useEffect(() => {
    const onExpired = () => {
      // Local data and the outbox are kept so nothing is lost; they sync after the next sign-in.
      setStatus('anonymous')
      setUserState(null)
    }
    const onOnline = () => {
      if (!offlineSession) return
      request<User>('/auth/me')
        .then((u) => {
          setUser(u)
          setOfflineSession(false)
        })
        .catch(() => undefined)
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
      window.removeEventListener('online', onOnline)
    }
  }, [offlineSession, setUser])

  const login = useCallback<AuthApi['login']>(
    async (email, password) => {
      const res = await request<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } })
      setUser(res.user)
      setOfflineSession(false)
      setStatus('authenticated')
    },
    [setUser],
  )

  const register = useCallback<AuthApi['register']>(
    async (data) => {
      const res = await request<{ user: User }>('/auth/register', { method: 'POST', body: data })
      setUser(res.user)
      setStatus('authenticated')
    },
    [setUser],
  )

  const logout = useCallback<AuthApi['logout']>(
    async ({ discardLocalData }) => {
      const current = user
      try {
        await request('/auth/logout', { method: 'POST' })
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) throw err
      }
      if (current && discardLocalData) await deleteLocalDB(current.id)
      cacheUser(null)
      setUserState(null)
      setStatus('anonymous')
    },
    [user],
  )

  const updateUser = useCallback<AuthApi['updateUser']>(
    async (patch) => {
      const updated = await request<User>('/auth/me', { method: 'PATCH', body: patch })
      setUser(updated)
      return updated
    },
    [setUser],
  )

  const value = useMemo(
    () => ({ status, user, offlineSession, login, register, logout, updateUser, setUser }),
    [status, user, offlineSession, login, register, logout, updateUser, setUser],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export function useUser(): User {
  const { user } = useAuth()
  if (!user) throw new Error('useUser requires an authenticated user')
  return user
}
