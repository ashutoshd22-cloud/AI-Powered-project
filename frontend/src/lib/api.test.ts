import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_EXPIRED_EVENT, ApiError, NetworkError, request } from './api'

function mockFetch(status: number, body: unknown = null, contentType = 'application/json') {
  const fn = vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': contentType } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lifeos_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
})

describe('request()', () => {
  it('sends the CSRF cookie as a header on unsafe methods only', async () => {
    document.cookie = 'lifeos_csrf=abc123'
    const fetchFn = mockFetch(200, { ok: true })
    await request('/tasks', { method: 'POST', body: { title: 'x' } })
    await request('/tasks')
    const [, postInit] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit]
    const [, getInit] = fetchFn.mock.calls[1] as unknown as [URL, RequestInit]
    expect((postInit.headers as Record<string, string>)['X-CSRF-Token']).toBe('abc123')
    expect((getInit.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined()
    expect(postInit.credentials).toBe('same-origin')
  })

  it.each([502, 503, 504])('treats gateway error %i as being offline (regression)', async (status) => {
    mockFetch(status, { detail: 'API unavailable' })
    await expect(request('/ai/parse', { method: 'POST', body: {} })).rejects.toBeInstanceOf(NetworkError)
  })

  it('treats fetch failures as offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(request('/tasks')).rejects.toBeInstanceOf(NetworkError)
  })

  it('surfaces validation messages from the API', async () => {
    mockFetch(422, { detail: 'Validation failed', errors: [{ loc: ['body', 'title'], msg: 'String should have at least 1 character' }] })
    await expect(request('/tasks', { method: 'POST', body: {} })).rejects.toThrow('title: String should have at least 1 character')
  })

  it('emits an auth-expired event on 401 (except for login)', async () => {
    const listener = vi.fn()
    window.addEventListener(AUTH_EXPIRED_EVENT, listener)
    mockFetch(401, { detail: 'Session expired' })
    await expect(request('/tasks')).rejects.toBeInstanceOf(ApiError)
    await expect(request('/auth/login', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener)
  })

  it('returns undefined for 204 and drops empty query params', async () => {
    const fetchFn = mockFetch(204)
    await expect(request('/activity', { method: 'DELETE', query: { q: '', page: 2, x: null } })).resolves.toBeUndefined()
    const [url] = fetchFn.mock.calls[0] as unknown as [URL]
    expect(url.search).toBe('?page=2')
  })
})
