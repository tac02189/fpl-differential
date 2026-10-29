import { VAPID_PUBLIC_KEY, WORKER_URL } from '../config'

const b64ToU8 = s => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

// Coarse device kind, carried for display only. It used to be half of how the
// worker decided what to retire — teamId plus device kind — which is precisely the
// scheme that let anyone delete anyone, since team ids are public and two iPhones
// both report "ios". installId replaced it for that job; this is no longer any
// part of identification.
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

// Every failure used to surface as 'try again shortly', which is true of a network
// blip and false of everything else. A device refused by a cap would be told to
// retry, and retrying would never work — the worst case being a reinstalled phone
// locked out of a store its own unrecognisable old record is filling.
//
// The worker's own strings are developer-facing, so they are mapped rather than
// shown. Anything unrecognised keeps the retry wording, since an unknown failure is
// more likely transient than not.
// Each line says only what the response actually establishes. The first version
// told a refused user their own previous registration was holding a place and
// would be released — the response proves neither, and a dead endpoint can keep
// being accepted for a long time, so 'will be released' was a promise this code
// cannot keep. Likewise a source cap counts STORED registrations, abandoned ones
// included, not devices that currently have alerts on.
const FAILURE_TEXT = {
  'subscription limit reached':
    'The alert list is full. Registrations from devices that no longer use the app can' +
    ' still be taking up places. Try again later.',
  'too many subscriptions from this network':
    'This network has reached its limit of alert registrations. Old ones may still be' +
    ' counting toward it.',
  'registration budget exhausted for today':
    'The alert service has reached a daily limit. It resets at midnight UTC.',
  'read budget exhausted for today':
    'The alert service has reached a daily limit. It resets at midnight UTC.',
  'too many requests': 'Too many attempts just now — wait a minute and try again.',
  'bad subscription': 'This browser gave an alert registration the service could not accept.',
  'bad subscription keys': 'This browser gave an alert registration the service could not accept.',
}
const RETRY_TEXT = 'Could not register with the alert service — try again shortly.'

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
    // The request failed in transit. That does NOT prove the worker did not store
    // it — the response could have been lost after a successful write — so the
    // local cleanup below could otherwise strand a record nobody will claim.
    res = null
    await fetch(`${WORKER_URL}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {})
  }
  if (!res || !res.ok) {
    // a brand-new subscription the server never learned about must not linger —
    // the UI would read it as "alerts on" while no push could ever arrive
    if (!existing) await sub.unsubscribe().catch(() => {})
    let reason = null
    // Only 4xx carries a reason worth repeating: a 5xx really is 'try shortly', and
    // a thrown fetch has no body at all.
    if (res && res.status >= 400 && res.status < 500) {
      reason = FAILURE_TEXT[(await res.json().catch(() => null))?.error] || null
    }
    throw new Error(reason || RETRY_TEXT)
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
