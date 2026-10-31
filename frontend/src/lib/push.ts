import { request } from './api'

export interface PushConfig {
  enabled: boolean
  public_key: string | null
  subscriptions: number
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) throw new Error('Background notifications need the installed app (production build). Reload and try again.')
  return navigator.serviceWorker.ready
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

export async function enablePush(config: PushConfig): Promise<void> {
  if (!config.public_key) throw new Error('Push notifications are not configured on this server.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings.')
  const reg = await registration()
  const existing = await reg.pushManager.getSubscription()
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.public_key) }))
  const json = sub.toJSON()
  await request('/push/subscriptions', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } })
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await request('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => undefined)
  await sub.unsubscribe()
}
