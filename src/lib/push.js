import { VAPID_PUBLIC_KEY, WORKER_URL } from '../config'

const b64ToU8 = s => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

export const pushSupported = () =>
  !!WORKER_URL && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export async function getSubscription() {
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

export async function enablePush(teamId) {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notifications are blocked — allow them in your browser settings.')
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY),
  })
  const res = await fetch(`${WORKER_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), teamId: teamId || null }),
  })
  if (!res.ok) throw new Error('Could not register with the alert service — try again shortly.')
  return sub
}

export async function disablePush() {
  const sub = await getSubscription()
  if (!sub) return
  await fetch(`${WORKER_URL}/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {
    /* worker unreachable — still unsubscribe locally */
  })
  await sub.unsubscribe()
}
