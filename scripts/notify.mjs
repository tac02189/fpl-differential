// Notification cron — runs on GitHub Actions every 30 min (see .github/workflows/notify.yml).
// Sends Web Push: deadline reminders (T-24h / T-2h) and injury/status alerts for owned players.
// Subscriptions + dedup state live in the Cloudflare Worker's KV (same worker as the CORS proxy).
import webpush from 'web-push'

const {
  WORKER_URL,
  SUBS_SECRET,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:tac02189@gmail.com',
  TEST_PUSH,
} = process.env

if (!WORKER_URL || !SUBS_SECRET || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.log('Missing configuration (WORKER_URL / SUBS_SECRET / VAPID keys) — nothing to do yet.')
  process.exit(0)
}

const AUTH = { Authorization: `Bearer ${SUBS_SECRET}` }
const fpl = p =>
  fetch(`https://fantasy.premierleague.com/api/${p}`, {
    headers: { 'User-Agent': 'fpl-differential notify bot' },
  }).then(r => {
    if (!r.ok) throw new Error(`FPL ${r.status} on ${p}`)
    return r.json()
  })

const CT = iso =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

const subs = await fetch(`${WORKER_URL}/subs`, { headers: AUTH }).then(r => r.json())
if (!Array.isArray(subs) || subs.length === 0) {
  console.log('No subscribers.')
  process.exit(0)
}

const state = await fetch(`${WORKER_URL}/state`, { headers: AUTH })
  .then(r => r.json())
  .catch(() => ({}))
state.sent ||= {}
state.status ||= {}

const bs = await fpl('bootstrap-static/')
const players = new Map(bs.elements.map(e => [e.id, e]))
const next = bs.events.find(e => e.is_next)
const current = bs.events.find(e => e.is_current)

const queue = []

if (TEST_PUSH === 'true' || TEST_PUSH === '1') {
  for (const sub of subs) {
    queue.push({ sub, payload: { title: 'FPL Differential — test', body: 'Push pipeline is working.', tag: 'test' } })
  }
}

// Squads are public only after each GW deadline; pre-season this returns [].
const picksCache = new Map()
async function ownedPlayers(teamId) {
  if (!teamId || !current) return []
  if (!picksCache.has(teamId)) {
    const d = await fpl(`entry/${teamId}/event/${current.id}/picks/`).catch(() => null)
    picksCache.set(teamId, d ? d.picks.map(p => p.element) : [])
  }
  return picksCache.get(teamId)
}

// --- deadline reminders ---
if (next) {
  const hrs = (new Date(next.deadline_time) - Date.now()) / 3.6e6
  const sent = (state.sent[next.id] ||= {})
  let phase = null
  if (hrs > 0 && hrs <= 2 && !sent.t2) phase = 't2'
  else if (hrs > 2 && hrs <= 24 && !sent.t24) phase = 't24'
  if (phase) {
    sent[phase] = true
    if (phase === 't2') sent.t24 = true // never follow a T-2 with a late T-24
    for (const sub of subs) {
      const owned = await ownedPlayers(sub.teamId)
      const flagged = owned.map(id => players.get(id)).filter(p => p && p.status !== 'a')
      const flagTxt = flagged.length ? ` Flagged: ${flagged.map(p => p.web_name).join(', ')}.` : ''
      queue.push({
        sub,
        payload: {
          title: phase === 't2' ? `GW${next.id} deadline in ~2 hours` : `GW${next.id} deadline approaching`,
          body: `${CT(next.deadline_time)} Central.${flagTxt}`,
          tag: `deadline-${next.id}-${phase}`,
        },
      })
    }
  }
}

// --- injury / status changes on owned players ---
if (current) {
  const ownedUnion = new Set()
  for (const sub of subs) for (const id of await ownedPlayers(sub.teamId)) ownedUnion.add(id)
  const changes = []
  for (const id of ownedUnion) {
    const p = players.get(id)
    if (!p) continue
    const prev = state.status[id]
    const now = `${p.status}|${p.news || ''}`
    // notify on any transition except availability news-text shuffles
    if (prev !== undefined && prev !== now && !(p.status === 'a' && prev.startsWith('a'))) changes.push(p)
    state.status[id] = now
  }
  for (const p of changes) {
    const label =
      p.status === 'a'
        ? 'Available again'
        : p.news ||
          { d: 'Doubtful', i: 'Injured', s: 'Suspended', u: 'Unavailable' }[p.status] ||
          'Status change'
    for (const sub of subs) {
      const owned = await ownedPlayers(sub.teamId)
      if (owned.includes(p.id)) {
        queue.push({ sub, payload: { title: `${p.web_name} — squad alert`, body: label, tag: `news-${p.id}` } })
      }
    }
  }
  // keep the snapshot bounded to currently-owned players
  for (const id of Object.keys(state.status)) if (!ownedUnion.has(Number(id))) delete state.status[id]
}

let sentCount = 0
for (const { sub, payload } of queue) {
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload))
    sentCount++
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await fetch(`${WORKER_URL}/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.subscription.endpoint }),
      }).catch(() => {})
      console.log('Pruned a dead subscription.')
    } else {
      console.error('Push failed:', e.statusCode || e.message)
    }
  }
}

await fetch(`${WORKER_URL}/state`, { method: 'PUT', headers: AUTH, body: JSON.stringify(state) })
console.log(`Done — ${sentCount} push(es) sent to ${subs.length} subscriber(s).`)
