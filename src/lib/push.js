import { VAPID_PUBLIC_KEY, WORKER_URL } from '../config'

const b64ToU8 = s => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

// Coarse device kind (no identifying detail) so the worker can tell "this phone
// reinstalled the app" from "a second device signed up" and retire only the former.
const deviceKind = () => {
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  return 'other'
}

// A stable, unguessable id for this browser install — the only thing the worker can use
// to tell "this phone re-registering with a fresh endpoint" from "someone else claiming
// the same team". Team ids are public and prove nothing, so they used to let anyone
// delete anyone's registrations. Treat it as a bearer credential: it is sent to the
// worker below and stored there, so same-origin script access is its trust boundary.
const INSTALL_ID_KEY = 'fpl:installId'
const installId = () => {
  try {
    let id = localStorage.getItem(INSTALL_ID_KEY)
    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(INSTALL_ID_KEY, id)
    }
    return id
  } catch {
    // Storage blocked (private window, some embedded webviews). Send none: the worker
    // then retires nothing, which is the safe direction — a duplicate notification is
    // recoverable, a wrongly deleted registration is silent.
    return null
  }
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
  const existing = await reg.pushManager.getSubscription()
  const sub =
    existing ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY),
    }))
  let res = null
  try {
    res = await fetch(`${WORKER_URL}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        teamId: teamId || null,
        device: deviceKind(),
        installId: installId(),
      }),
    })
  } catch {
    res = null
  }
  if (!res || !res.ok) {
    // a brand-new subscription the server never learned about must not linger —
    // the UI would read it as "alerts on" while no push could ever arrive
    if (!existing) await sub.unsubscribe().catch(() => {})
    throw new Error('Could not register with the alert service — try again shortly.')
  }
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
