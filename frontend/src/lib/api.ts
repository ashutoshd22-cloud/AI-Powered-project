/** Thin fetch wrapper: same-origin cookies, CSRF header, typed errors. */

const BASE = '/api/v1'
const CSRF_COOKIE = 'lifeos_csrf'

export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/** The request never reached the server (offline, DNS, server down). */
export class NetworkError extends Error {
  constructor() {
    super('You appear to be offline. Changes will sync when the connection returns.')
    this.name = 'NetworkError'
  }
}

export const AUTH_EXPIRED_EVENT = 'lifeos:auth-expired'
const GATEWAY_ERRORS = new Set([502, 503, 504])

export function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

function messageFrom(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') {
      const errors = (body as { errors?: { loc: string[]; msg: string }[] }).errors
      if (errors?.length) {
        const first = errors[0]
        const field = first.loc.filter((p) => p !== 'body').join('.')
        return field ? `${field}: ${first.msg}` : first.msg
      }
      return detail
    }
    if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message)
  }
  if (status === 429) return 'Too many requests — please wait a moment and try again.'
  if (status >= 500) return 'The server had a problem. Please try again.'
  return `Request failed (${status})`
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  signal?: AbortSignal
  /** Raw body (e.g. FormData); skips JSON encoding. */
  raw?: BodyInit
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const url = new URL(BASE + path, window.location.origin)
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE)
    if (csrf) headers['X-CSRF-Token'] = csrf
  }
  let body: BodyInit | undefined = opts.raw
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  let response: Response
  try {
    response = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: opts.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new NetworkError()
  }

  // A reverse proxy answering for a stopped/unreachable API is equivalent to being offline.
  if (GATEWAY_ERRORS.has(response.status)) throw new NetworkError()
  if (response.status === 204) return undefined as T
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const payload: unknown = isJson ? await response.json().catch(() => null) : null
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/register')) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
    }
    throw new ApiError(response.status, messageFrom(response.status, payload), payload)
  }
  return payload as T
}

/** Downloads a server-generated file (export) via a temporary object URL. */
export async function download(path: string, query: Record<string, string>, fallbackName: string): Promise<void> {
  const url = new URL(BASE + path, window.location.origin)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin' })
  } catch {
    throw new NetworkError()
  }
  if (!response.ok) throw new ApiError(response.status, messageFrom(response.status, null))
  const disposition = response.headers.get('content-disposition') ?? ''
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName
  const blobUrl = URL.createObjectURL(await response.blob())
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message
  return 'Something went wrong. Please try again.'
}
