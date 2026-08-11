// Notification cron — runs on GitHub Actions every 30 min (see .github/workflows/notify.yml).
// Sends Web Push: deadline reminders (T-24h / T-2h) and injury/status alerts for owned players.
// Subscriptions + dedup state live in the Cloudflare Worker's KV (same worker as the CORS proxy).
//
// Reliability rules (adversarially reviewed before go-live):
// - If subs/state/bootstrap can't be read, abort — the next cron retries with intact state.
// - Deadline delivery is tracked per subscriber; only successful sends are recorded.
// - Injury baselines advance only after their alerts deliver (permanent endpoint failures
//   count as delivered), and are never pruned on a run where any picks fetch failed.
// - The final state PUT is verified and retried; on failure the run exits nonzero so the
//   red Actions run is visible (bias: a rare duplicate beats a silent miss).
import { createHash } from 'node:crypto'
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
const die = msg => {
  console.error(msg)
  process.exit(1)
}

async function getJson(url, opts) {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error(`${r.status} on ${url}`)
  return r.json()
}

const fpl = p =>
  getJson(`https://fantasy.premierleague.com/api/${p}`, {
    headers: { 'User-Agent': 'fpl-differential notify bot' },
  })

const CT = iso =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })

const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 16)

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

// Abort (never "treat as empty") when subs or state can't be read — running with
// amnesia duplicates reminders and erases injury baselines.
const rawSubs = await getJson(`${WORKER_URL}/subs`, { headers: AUTH }).catch(e =>
  die(`GET /subs failed (${e.message}) — aborting; next run retries.`),
)
const subs = (Array.isArray(rawSubs) ? rawSubs : []).filter(s => s?.subscription?.endpoint)
if (subs.length === 0) {
  console.log('No subscribers.')
  process.exit(0)
}
const state = await getJson(`${WORKER_URL}/state`, { headers: AUTH }).catch(e =>
  die(`GET /state failed (${e.message}) — aborting; next run retries.`),
)
state.sent ||= {}
state.status ||= {}

const bs = await fpl('bootstrap-static/').catch(e => die(`FPL bootstrap failed (${e.message}) — aborting.`))
const players = new Map(bs.elements.map(e => [e.id, e]))
const next = bs.events.find(e => e.is_next)
const current = bs.events.find(e => e.is_current)

// Deadline dedup keys embed the deadline timestamp, so they can never collide across
// seasons (FPL reuses event ids 1–38 every year). Entries self-prune after a week.
for (const key of Object.keys(state.sent)) {
  const t = Date.parse(key.split('|')[1] || '')
  if (!Number.isFinite(t) || Date.now() - t > 7 * 86_400_000) delete state.sent[key]
}

const subKeyOf = sub => hash(sub.subscription.endpoint)
const queue = [] // { sub, payload, onDelivered? }

if (TEST_PUSH === 'true' || TEST_PUSH === '1') {
  for (const sub of subs) {
    queue.push({ sub, payload: { title: 'FPL Differential — test', body: 'Push pipeline is working.', tag: 'test' } })
  }
}

// Squad picks: array = known squad, [] = known empty, null = FETCH FAILED (unknown).
// The distinction matters: a failed fetch must not be read as "owns nothing", or the
// injury baseline gets wiped (this includes the post-deadline window where the new
// GW's picks aren't published yet).
const picksCache = new Map()
async function ownedPlayers(teamId) {
  if (!teamId || !current) return []
  const key = String(teamId)
  if (!picksCache.has(key)) {
    try {
      const d = await fpl(`entry/${teamId}/event/${current.id}/picks/`)
      picksCache.set(key, d.picks.map(p => p.element))
    } catch {
      picksCache.set(key, null)
    }
  }
  return picksCache.get(key)
}

// --- deadline reminders (T-24h and T-2h), delivery tracked per subscriber ---
if (next) {
  const dlKey = `${next.id}|${next.deadline_time}`
  const hrs = (new Date(next.deadline_time) - Date.now()) / 3.6e6
  const sent = (state.sent[dlKey] ||= {})
  const phase = hrs > 0 && hrs <= 2 ? 't2' : hrs > 2 && hrs <= 24 ? 't24' : null
  if (phase) {
    const delivered = new Set(sent[phase] || [])
    for (const sub of subs) {
      const k = subKeyOf(sub)
      if (delivered.has(k)) continue
      const owned = (await ownedPlayers(sub.teamId)) || []
      const flagged = owned.map(id => players.get(id)).filter(p => p && p.status !== 'a')
      const flagTxt = flagged.length ? ` Flagged: ${flagged.map(p => p.web_name).join(', ')}.` : ''
      queue.push({
        sub,
        payload: {
          title: phase === 't2' ? `GW${next.id} deadline in ~2 hours` : `GW${next.id} deadline approaching`,
          body: `${CT(next.deadline_time)} Central.${flagTxt}`,
          tag: `deadline-${next.id}-${phase}`,
        },
        onDelivered: () => {
          delivered.add(k)
          sent[phase] = [...delivered]
        },
      })
    }
  }
}

// --- injury / status changes on owned players ---
if (current) {
  let allPicksOk = true
  const ownedBy = new Map() // subscriber key → Set(elementIds)
  for (const sub of subs) {
    const owned = await ownedPlayers(sub.teamId)
    if (owned === null) {
      allPicksOk = false
      continue
    }
    ownedBy.set(subKeyOf(sub), new Set(owned))
  }
  const ownedUnion = new Set()
  for (const s of ownedBy.values()) for (const id of s) ownedUnion.add(id)

  for (const id of ownedUnion) {
    const p = players.get(id)
    if (!p) continue
    const prev = state.status[id]
    const now = `${p.status}|${p.news || ''}`
    if (prev === now) continue
    const notifiable = prev !== undefined && !(p.status === 'a' && prev.startsWith('a'))
    if (!notifiable) {
      // first sight, or a benign news-text shuffle while available — just advance
      state.status[id] = now
      continue
    }
    const label =
      p.status === 'a'
        ? 'Available again'
        : p.news || { d: 'Doubtful', i: 'Injured', s: 'Suspended', u: 'Unavailable' }[p.status] || 'Status change'
    const targets = subs.filter(sub => ownedBy.get(subKeyOf(sub))?.has(p.id))
    if (targets.length === 0) {
      state.status[id] = now
      continue
    }
    // baseline advances only once every owner's alert has delivered
    let remaining = targets.length
    for (const sub of targets) {
      queue.push({
        sub,
        // tag is unique per transition so an escalation re-alerts instead of silently
        // replacing the earlier notification
        payload: { title: `${p.web_name} — squad alert`, body: label, tag: `news-${p.id}-${hash(now).slice(0, 6)}` },
        onDelivered: () => {
          if (--remaining === 0) state.status[id] = now
        },
      })
    }
  }

  // prune baselines only when current ownership is known for every subscriber
  if (allPicksOk) {
    for (const id of Object.keys(state.status)) if (!ownedUnion.has(Number(id))) delete state.status[id]
  }
}

// --- send, with one retry for transient failures ---
async function sendOne(sub, payload) {
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload))
    return 'ok'
  } catch (e) {
    return e.statusCode === 404 || e.statusCode === 410 ? 'gone' : 'transient'
  }
}

let okCount = 0
let deferred = 0
for (const item of queue) {
  let r = await sendOne(item.sub, item.payload)
  if (r === 'transient') r = await sendOne(item.sub, item.payload)
  if (r === 'gone') {
    await fetch(`${WORKER_URL}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: item.sub.subscription.endpoint }),
    }).catch(() => {})
    console.log('Pruned a dead subscription.')
  }
  if (r === 'ok' || r === 'gone') {
    item.onDelivered?.()
    if (r === 'ok') okCount++
  } else {
    deferred++
    console.error(`Push failed twice (${item.payload.tag}) — will retry next run.`)
  }
}

// --- verified persist, one retry; failure exits nonzero for visibility ---
async function putState() {
  const r = await fetch(`${WORKER_URL}/state`, {
    method: 'PUT',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!r.ok) throw new Error(`PUT /state ${r.status}`)
}
try {
  await putState()
} catch {
  try {
    await putState()
  } catch (e) {
    die(`State persist failed twice (${e.message}) — some notifications may repeat next run.`)
  }
}

console.log(`Done — ${okCount} push(es) delivered, ${deferred} deferred, ${subs.length} subscriber(s).`)
if (deferred > 0) process.exit(1)
