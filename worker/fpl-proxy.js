// Cloudflare Worker — two jobs:
//  1. CORS proxy for the FPL API (browsers can't call fantasy.premierleague.com directly).
//     GET-only, endpoint-whitelisted, cached 60s at the edge.
//  2. Push-subscription store in Worker KV (binding: SUBS). Public subscribe/unsubscribe;
//     reading the list and the cron state requires the SUBS_SECRET bearer token.

const ALLOW = /^\/(bootstrap-static|fixtures|element-summary|event|entry|leagues-classic)(\/|$)/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

async function subKey(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return 'sub:' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// only real browser push services — rejects junk endpoints outright
// Real endpoints run about 200 characters; 1024 is generous and still bounds what
// GET /subs has to hold in one array. Picking three fields out of the body stopped
// a caller attaching megabytes of EXTRA keys, but never bounded the three it kept.
const MAX_ENDPOINT_CHARS = 1024
// p256dh is 87 characters and auth 22. The ceiling is only there so the decoder is
// never handed something enormous; the byte checks below are what actually validate.
const MAX_PUSHKEY_CHARS = 200

function validPushEndpoint(ep) {
  if (typeof ep !== 'string' || ep.length > MAX_ENDPOINT_CHARS) return false
  try {
    const u = new URL(ep)
    if (u.protocol !== 'https:') return false
    const h = u.hostname
    return (
      h === 'fcm.googleapis.com' ||
      h === 'updates.push.services.mozilla.com' ||
      h === 'web.push.apple.com' ||
      h.endsWith('.push.apple.com') ||
      h.endsWith('.notify.windows.com')
    )
  } catch {
    return false
  }
}

// An endpoint alone cannot be pushed to: web-push encrypts every payload with these
// two keys, so a record missing them fails delivery on every run, forever, and never
// self-heals. Browsers always supply both through PushSubscription.toJSON(). The
// lengths are floors, not exact sizes (p256dh is 87 chars, auth 22), so a future
// encoding change cannot lock subscribers out.
// Decoded bytes of a base64url string, or null if it is not base64url at all.
function b64urlDecode(s) {
  // Accept the standard alphabet as well as base64url: browsers emit base64url, but
  // being strict here would lock out a client for an encoding choice, which is the one
  // failure this validator must not cause.
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null
  const b = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  try {
    return atob(b + '='.repeat((4 - (b.length % 4)) % 4))
  } catch {
    return null
  }
}

// A team id is stored here and later interpolated into a URL and coerced to a string by
// the cron. String({toString: null}) throws, and that coercion happens outside the
// cron's try block, so one such value stored through this public endpoint would abort
// every notification run before a single push went out. Only plain positive integers.
function validTeamId(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,12}$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n > 0 && n <= 1e12
}

async function validPushKeys(k) {
  // Byte lengths, not character counts: web-push needs p256dh to decode to a 65-byte
  // uncompressed P-256 point and auth to at least 16 bytes.
  if (!k) return false
  if (typeof k.p256dh !== 'string' || k.p256dh.length > MAX_PUSHKEY_CHARS) return false
  if (typeof k.auth !== 'string' || k.auth.length > MAX_PUSHKEY_CHARS) return false
  const pub = b64urlDecode(k.p256dh)
  const auth = b64urlDecode(k.auth)
  // auth is 16 bytes in RFC 8291. The upper bound matters as much as the lower one:
  // without it the decoder's tolerance for trailing '=' padding let an arbitrarily
  // long string through, and the ORIGINAL string is what gets stored.
  if (!pub || pub.length !== 65) return false
  if (!auth || auth.length < 16 || auth.length > 64) return false
  // Length and the leading 0x04 are still not enough. A 65-byte blob that is not
  // actually a point on P-256 passes both, and then throws inside web-push with NO
  // status code — so sendOne can only read it as transient, no 404/410 ever arrives to
  // retire it, and the record reddens every run and holds one of the 20 slots for ever.
  // importKey performs the real curve check, so such a record is never stored at all.
  // That is deterministic, unlike inferring permanence from repeated delivery failures,
  // which cannot tell a broken record from a push service having a bad afternoon.
  try {
    await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(pub, ch => ch.charCodeAt(0)),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    return true
  } catch {
    return false
  }
}

// A browser install's own identifier. Shape-checked only — the worker cannot tell a
// random value from a chosen one, so the security rests entirely on the client picking
// a good one. The shipped client sends crypto.randomUUID (122 random bits) or 16 random
// bytes as hex (128). A caller is free to send "aaaaaaaaaaaaaaaa" instead, which only
// weakens that caller: guessing someone else's still means guessing their value.
function validInstallId(v) {
  return typeof v === 'string' && v.length >= 16 && v.length <= 100 && /^[A-Za-z0-9_-]+$/.test(v)
}

// Registering is a rare, human act — somebody toggling alerts, not a loop. Throttling
// it per IP is what keeps a single source from burning the KV read quota: a rejected
// /subscribe still costs a list plus a get for every stored record, so a few thousand
// requests could exhaust a day's reads and take the CORS proxy down with the alerts.
// Checked before any KV work, so a throttled request costs nothing at all.
//
// Fails OPEN when the binding or the IP header is missing — a local run, or a deploy
// whose config lost the binding. Losing throttling is better than losing registration:
// this is a safeguard around the store, not the thing that keeps the store correct.
// How many stored records one source may hold. Throttling bounds how FAST a source can
// register; it barely touches how MANY slots it ends up with, since filling twenty at
// five a minute takes four minutes. This is the part that stops one origin owning the
// store.
//
// Twelve, raised from six, so that a shared network — a hospital or an office behind
// one NAT, where everyone appears as a single address — can sign up without the
// seventh person being refused. The honest trade: an attacker now needs two networks
// instead of four, which is barely a barrier. What this still buys is that a single
// source cannot take the store on its own, and a client stuck in a loop cannot either.
// Any value meaningfully below the global cap of 20 buys that; values near it buy
// nothing, which is the real reason not to raise this much further without raising the
// global cap too.
const MAX_PER_IP = 12

// Salted with SUBS_SECRET because an unsalted hash of an IPv4 address is reversible by
// brute force in seconds — the whole space is 2^32. The salt never leaves the worker,
// and the digest is withheld from GET /subs, so this identifies a source to the cap
// check without storing anywhere who that source is. Null (no header, no secret) means
// the check is skipped.
// What counts as "one source". An IPv6 client is routed a whole /64 — 2^64 addresses —
// so keying on the full address lets a single machine present as billions of distinct
// clients and walk straight through both the throttle and the occupancy cap. Collapse
// IPv6 to its /64 so a prefix counts once; IPv4 is already one address per client.
function clientSource(req) {
  const ip = req.headers.get('CF-Connecting-IP')
  if (!ip) return null
  if (!ip.includes(':')) return ip
  const [head, tail] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill('0'), ...t] : ip.split(':')
  return (
    groups
      .slice(0, 4)
      .map(g => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''))
      .join(':') + '::/64'
  )
}

async function sourceKey(req, env) {
  const ip = clientSource(req)
  if (!ip || !env.SUBS_SECRET) return null
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SUBS_SECRET}:ip:${ip}`))
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

async function rateLimited(req, env, bucket) {
  const ip = clientSource(req)
  if (!env.SUBSCRIBE_LIMIT || !ip) return false
  try {
    const { success } = await env.SUBSCRIBE_LIMIT.limit({ key: `${bucket}:${ip}` })
    // `!success` would turn an unexpected shape (no boolean at all) into "throttled",
    // i.e. 429 for everybody — the exact opposite of the fail-open this is supposed to
    // be. Only an explicit false throttles.
    return success === false
  } catch {
    return false
  }
}

// --- the subscriber index ---------------------------------------------------
// list() spends a KV *list* operation, and the free plan allows 1000 a day against
// 100,000 reads. /subscribe listed on every changed registration, which at the
// throttle's 5 per 60s is 7200 a day from a single address — seven times the budget,
// gone in about three hours. And GET /subs lists too, so exhausting it stopped the
// cron as well: notifications went dark, not just registration.
//
// No rate this limiter can express fits inside 1000 a day, so the list had to go
// rather than be throttled. The sweep needs exactly two fields per record, so the
// whole roster lives in one key and is read with a get.
// Deliberately outside the sub: namespace AND outside the bare prefix 'sub', so a
// future list({ prefix: 'sub' }) written without the colon cannot sweep the index
// up as a subscriber — GET /subs would slice(4, 20) it into nonsense.
const INDEX_KEY = 'meta:subindex'
// Rebuilding reconciles the index against KV, which is what repairs a lost update
// when two registrations race. The floor is what stops a caller forcing a list per
// request: at five minutes that is at most 288 a day, and a stale index corrects
// itself within five minutes without anyone having to maintain it.
const INDEX_REBUILD_MS = 5 * 60 * 1000

// --- the daily write budget ---------------------------------------------------
// Rate limits are per minute; KV quotas are per day, and no useful per-minute rate
// fits inside one. The throttle's 5 per 60s is 7200 requests a day against 1000
// writes. A caller alternating /subscribe and /unsubscribe slips under every
// occupancy cap — it deletes each record before making the next, so it never holds
// more than one — while spending about three writes a cycle, so a single address
// could exhaust the day's writes in roughly an hour.
//
// What breaks first is not registration. It is the cron's PUT /state, which then
// cannot record what it has already sent, so every subscriber gets the same push
// again on the next run and the one after. That is why there is a GLOBAL ceiling
// as well as a per-source one: its job is not to beat the attacker, it is to keep
// writes available for the cron no matter what the public endpoints are doing.
// Refusing new registrations for a day is a far better failure than re-notifying
// every existing subscriber every half hour.
// 500, not a round half of the quota, because two write sources sit OUTSIDE this
// budget and the sum has to fit inside 1000:
//   - a forced index rebuild saves the index without being charged, since no
//     registration happened to charge it to. The five-minute floor caps that at
//     86400/300 = 288 a day.
//   - the cron's PUT /state, about 48 a day at one run per half hour, plus retries.
// 500 + 288 + 48 = 836, leaving real headroom. At 600 it was 936 of 1000, which
// left nothing for a retry and would have put the thing this budget exists to
// protect back at risk.
const DAILY_WRITE_BUDGET = 500
// A real device spends 3 on enabling push and a few more if it re-registers; 60 is
// twenty registrations in a day. Tight enough that one address can take only an
// eighth of the global ceiling, loose enough that no genuine user will meet it.
const PER_SOURCE_WRITE_BUDGET = 60
// The record, the index update beside it, and the index update that this record's
// eventual /unsubscribe will spend. Charging the delete's write up front is what
// lets /unsubscribe stay uninstrumented: you cannot delete what you could not
// create, so bounding registrations bounds the whole cycle.
const WRITES_PER_REGISTRATION = 3
// KV quotas reset at 00:00 UTC, so the budget's day must be the UTC one.
const utcDay = () => new Date().toISOString().slice(0, 10)

// Rolls the counters over at the UTC boundary and repairs anything non-numeric,
// so a malformed index can never read as 'budget already spent' and lock
// registration out for the rest of the day.
// Called exactly once per request, straight after the index is loaded, so the
// admission check and the charge cannot land on different UTC days — a request that
// passed at 23:59:59 would otherwise roll the counters itself and charge the new
// day without ever being admitted against it.
function rollBudget(idx) {
  const day = utcDay()
  if (idx.day !== day) {
    idx.day = day
    idx.used = 0
    idx.src = {}
  }
  // Clamped, not merely type-checked. A stored `used` of 1e100 is finite and
  // non-negative, so a type check passes it and every registration is refused for
  // the rest of the day. Nothing legitimate can exceed the ceiling by more than one
  // registration, so anything above that is corruption, and capping it there keeps
  // a genuinely spent budget spent.
  idx.used = clampSpend(idx.used, DAILY_WRITE_BUDGET)
  if (!idx.src || typeof idx.src !== 'object' || Array.isArray(idx.src)) idx.src = {}
  for (const k of Object.keys(idx.src)) {
    // A negative source counter would hand that source unlimited registrations.
    idx.src[k] = clampSpend(idx.src[k], PER_SOURCE_WRITE_BUDGET)
  }
}

// Separates a spent budget from a corrupt one, which is the whole difficulty: both
// look like a big number. chargeRegistration stops charging once the ceiling is
// passed, so the largest value it can ever produce is ceiling + one registration.
// A value inside that range is real spend and is kept EXACTLY — a spent budget must
// stay spent. A value outside it cannot have been written by this code, so it is
// discarded rather than clamped down to 'spent', which would refuse every
// registration for the rest of the UTC day on the strength of a corrupt number.
// Nothing a request can send reaches these fields, so discarding is not a bypass.
function clampSpend(v, ceiling) {
  if (!Number.isFinite(v) || v < 0 || v > ceiling + WRITES_PER_REGISTRATION) return 0
  return v
}

// Both of these read counters that rollBudget has already normalised this request.
function budgetAllows(idx, ipHash) {
  if (idx.used + WRITES_PER_REGISTRATION > DAILY_WRITE_BUDGET) return false
  if (!ipHash) return true
  return (idx.src[ipHash] || 0) + WRITES_PER_REGISTRATION <= PER_SOURCE_WRITE_BUDGET
}

// The charge is applied to the index BEFORE it is saved, and the record is only
// written once that save has succeeded — see the ordering in /subscribe. An earlier
// version wrote the record first and charged after, and claimed the throttle made
// a collision impossible because it 'only permits two registrations inside one
// second from different sources'. That was simply wrong: 5 per 60s is a count per
// window, not a spacing rule, so one source can burst five. Five record writes then
// landed against a single surviving charge of 3, and at that ratio the real quota
// ran out at about the same moment as the budget meant to protect it.
function chargeRegistration(idx, ipHash) {
  idx.used += WRITES_PER_REGISTRATION
  if (ipHash) idx.src[ipHash] = (idx.src[ipHash] || 0) + WRITES_PER_REGISTRATION
  // src cannot grow without bound: an entry only appears for a source that actually
  // spent writes, and the global ceiling caps that at DAILY_WRITE_BUDGET /
  // WRITES_PER_REGISTRATION entries before everything is refused anyway.
}

// Entries are [installId, ipHash]. A tuple rather than an object because 20 of them
// share one value and KV caps a value well above that, but short keys cost nothing.
async function readIndex(env) {
  const raw = await env.SUBS.get(INDEX_KEY)
  if (!raw) return null
  try {
    const i = JSON.parse(raw)
    if (!i || typeof i !== 'object') return null
    // A bad roster or timestamp forces a rebuild but must NOT discard the budget.
    // Returning null here threw the counters away too, so corrupting the roster was
    // a way to reset the day's spend. t = 0 guarantees the staleness check fires.
    if (!i.e || typeof i.e !== 'object' || Array.isArray(i.e)) {
      i.e = {}
      i.t = 0
    }
    if (!Number.isFinite(i.t) || i.t > Date.now() + 60000) i.t = 0
    return i
  } catch {
    return null
  }
}

async function buildIndex(env, prev) {
  const list = await env.SUBS.list({ prefix: 'sub:', limit: 100 })
  const e = {}
  for (const k of list.keys) {
    // EVERY listed key gets an entry, including one whose value is missing or
    // unreadable. Its two fields may be unknown, but the key still occupies a slot,
    // and dropping it here would quietly under-count the store against the cap —
    // which the occupancy check reads as room. The old loop counted list.keys
    // directly, so it never had that gap; the index has to preserve it deliberately.
    let meta = k.metadata && typeof k.metadata === 'object' ? k.metadata : null
    if (!meta) {
      // Records written before metadata existed carry none. Bounded and shrinking:
      // every write attaches metadata, and nothing can create a new one. It costs a
      // get per legacy record, but only on a rebuild, not on every registration.
      const raw = await env.SUBS.get(k.name)
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          // JSON.parse('null') succeeds, as do a bare string or number, and any of
          // them would throw on the field reads below.
          if (parsed && typeof parsed === 'object') meta = parsed
        } catch {
          /* unreadable value — the key still counts, with both fields unknown */
        }
      }
    }
    e[k.name] = [meta?.installId ?? null, meta?.ipHash ?? null]
  }
  // The budget belongs to the day, not to what list() returned. Rebuilding it from
  // scratch every five minutes would reset the counters 288 times a day and make
  // the whole ceiling decorative.
  return {
    t: Date.now(),
    complete: list.list_complete !== false,
    e,
    day: typeof prev?.day === 'string' ? prev.day : utcDay(),
    used: Number.isFinite(prev?.used) ? prev.used : 0,
    src: prev?.src && typeof prev.src === 'object' && !Array.isArray(prev.src) ? prev.src : {},
  }
}

// Reports whether the write landed. KV caps writes to one key at one per second and
// throws 429 above that, which is reachable from a single source: the throttle
// permits a burst of five inside one window. /subscribe treats a false here as a
// reason to refuse the registration outright rather than proceed uncharged; the
// best-effort callers ignore it.
async function saveIndex(env, idx) {
  try {
    await env.SUBS.put(INDEX_KEY, JSON.stringify(idx))
    return true
  } catch {
    return false
  }
}

// Keep the index honest when a record leaves outside /subscribe. Only ever updates
// an index that already exists and already lists the key: a missing one is rebuilt
// by the next registration, and listing here would put a list operation back on the
// prune path, which is the cost this whole index exists to remove.
async function dropFromIndex(env, name) {
  const idx = await readIndex(env)
  if (!idx || !(name in idx.e)) return
  delete idx.e[name]
  await saveIndex(env, idx)
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
    }

    const authed = env.SUBS_SECRET && req.headers.get('Authorization') === `Bearer ${env.SUBS_SECRET}`

    if (url.pathname === '/subscribe' && req.method === 'POST') {
      if (await rateLimited(req, env, 'subscribe')) return json({ error: 'too many requests' }, 429)
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      const body = await req.json().catch(() => null)
      if (!validPushEndpoint(body?.subscription?.endpoint)) return json({ error: 'bad subscription' }, 400)
      if (!(await validPushKeys(body.subscription.keys))) return json({ error: 'bad subscription keys' }, 400)
      const key = await subKey(body.subscription.endpoint)
      const teamId = validTeamId(body.teamId) ? Number(body.teamId) : null
      const device = typeof body.device === 'string' ? body.device.slice(0, 32) : null
      // Which browser install this is: random, client-generated, and shared only between
      // that browser and this worker — never published, and withheld from GET /subs
      // below. It is a bearer credential, so anyone who obtains one can retire that
      // install's records; what it buys is that a PUBLIC value no longer can.
      // Retirement below keys off it and nothing else.
      const installId = validInstallId(body.installId) ? body.installId : null
      // Only the three fields a push actually needs. Storing body.subscription verbatim
      // let a caller attach megabytes of their own, and GET /subs loads every record
      // into one array — enough of that and the cron's own fetch runs the worker out of
      // memory, breaking notifications for everyone with no way to self-heal. Built
      // once here so the comparison below and the write further down agree; comparing a
      // trimmed stored record against an untrimmed body would never match, and every
      // re-registration would spend a KV write.
      const subscription = {
        endpoint: body.subscription.endpoint,
        keys: { p256dh: body.subscription.keys.p256dh, auth: body.subscription.keys.auth },
      }
      const existing = await env.SUBS.get(key)
      const core = JSON.stringify({ subscription, teamId, device, installId })
      if (existing) {
        // identical re-registration: skip the KV write (KV writes are the scarce quota)
        try {
          const prev = JSON.parse(existing)
          const prevCore = {
            subscription: prev.subscription,
            teamId: prev.teamId,
            device: prev.device ?? null,
            installId: prev.installId ?? null,
          }
          if (JSON.stringify(prevCore) === core) {
            return json({ ok: true })
          }
        } catch {
          /* unreadable previous value — overwrite it */
        }
      }

      // Reinstalling a PWA mints a brand-new push endpoint while the old one keeps
      // accepting pushes for weeks, so the same phone ends up notified twice. Retire
      // this installation's own earlier registrations.
      //
      // Matching used to be teamId plus device kind, which was not authorization at all.
      // FPL team ids are public and the caller supplies its own, so posting a victim's
      // team id with no `device` matched every registration that team had and deleted
      // all of them — anyone could silence anyone. It also evicted real second devices,
      // since two iPhones both report "ios". An installId is a secret only the owning
      // browser holds, so a caller can only ever retire records it actually placed.
      //
      // The cost: a true reinstall clears storage and mints a new installId, so the old
      // record is no longer recognised as this install's and lingers until its endpoint
      // starts returning 404/410 and the cron unsubscribes it. That is unavoidable — to
      // the worker a reinstalled app is indistinguishable from a different device
      // claiming the same team, which is precisely the ambiguity the attack exploited.
      // Temporary duplicates for one user beat letting anyone delete anyone.
      //
      // Identified here, but not deleted until the cap check below has passed.
      // Both the sweep and the per-source count need only two fields per record, and
      // the index holds exactly those — so this reads one key instead of listing the
      // store. See INDEX_KEY above for why the list could not simply be throttled.
      let idx = await readIndex(env)
      let rebuilt = false
      if (!idx || Date.now() - idx.t > INDEX_REBUILD_MS) {
        // The old index is passed in so the rebuild inherits today's spend. It is
        // null only when the index is absent or unreadable, which no request can
        // cause; staleness alone still carries the counters forward.
        idx = await buildIndex(env, idx)
        rebuilt = true
      }
      // Once per request, before the admission check, so check and charge agree on
      // which UTC day they are spending.
      rollBudget(idx)
      // A rebuild must still be saved on the paths that reject below, or a caller
      // held at a cap rebuilds on every request and the five-minute floor never
      // engages. It must NOT be saved here, though: KV throws 429 on a second write
      // to one key inside a second, saveIndex swallows that, and the surviving value
      // would be this snapshot — which predates the record about to be written —
      // carrying a fresh timestamp. The new record would then go unindexed for five
      // minutes, under-counting the store, which is the direction that admits past
      // the cap. So: exactly one saveIndex per request, on whichever path exits.

      const names = Object.keys(idx.e)
      const ipHash = await sourceKey(req, env)
      const stale = []
      let sameSource = 0
      let sameSourceStale = 0
      for (const name of names) {
        if (name === key) continue
        const [eInstallId, eIpHash] = idx.e[name] || []
        const isStale = !!installId && eInstallId === installId
        if (isStale) stale.push(name)
        if (ipHash && eIpHash === ipHash) {
          sameSource++
          if (isStale) sameSourceStale++
        }
      }

      // Records this install is about to retire do not count against its own source, so
      // re-registering a device never blocks itself. Skipped when the record already
      // exists: updating a registration in place adds nothing to the store.
      if (!existing && ipHash && sameSource - sameSourceStale >= MAX_PER_IP) {
        if (rebuilt) await saveIndex(env, idx)
        return json({ error: 'too many subscriptions from this network' }, 429)
      }

      // Cap stored subscriptions so junk POSTs can't flood KV or the push cron — but
      // count what the retirement above will free first. A phone reinstalling at the cap
      // replaces its own prior registration and does not grow the store; checking before
      // the sweep turned that into a 429, locking a returning device out of a store its
      // own stale entries were filling. Nothing is deleted until this passes, so a
      // rejected request leaves the store exactly as it found it.
      // A truncated page undercounts the store, and subtracting retirements from an
      // undercount can admit past the cap. With limit 100 against a cap of 20 that only
      // happens to a store already far over it, where rejecting is the right answer.
      // Absence of the field counts as complete, so a KV response without it can never
      // lock registration out.
      const truncated = idx.complete === false
      if (!existing && (truncated || names.length - stale.length >= 20)) {
        if (rebuilt) await saveIndex(env, idx)
        return json({ error: 'subscription limit reached' }, 429)
      }

      // Last gate before anything is written. Deliberately after the occupancy caps,
      // which are about what the store holds; this one is about what today has cost.
      if (!budgetAllows(idx, ipHash)) {
        if (rebuilt) await saveIndex(env, idx)
        return json({ error: 'registration budget exhausted for today' }, 429)
      }

      // Never downgrade a stored installId to null. A client whose storage is blocked,
      // or an older one that sends none, would otherwise strip that install's ability to
      // retire its own record later — silently, and permanently.
      let keepInstallId = installId
      if (!keepInstallId && existing) {
        try {
          const prev = JSON.parse(existing)
          if (prev && typeof prev === 'object' && validInstallId(prev.installId)) keepInstallId = prev.installId
        } catch {
          /* unreadable previous value — nothing to carry over */
        }
      }

      // RESERVE BEFORE SPENDING. The index write carries the charge, and it goes
      // first: nothing else is written until it has landed.
      //
      // The other order — record first, charge after — looked safer, because a
      // half-done registration then left an unindexed record rather than an index
      // entry for a record that does not exist. But it made the budget unenforceable.
      // One source may burst five requests inside a window; all five read the same
      // counters, all five pass, all five write their own record key, and then their
      // five index writes collide on KV's one-per-second limit so a single charge of
      // 3 survives against six real writes. At that ratio the quota this budget
      // defends ran out at about the same moment the budget did.
      //
      // Reserving first inverts the failure: the losers of that race write NOTHING
      // and are told to retry, so a charge can never be smaller than what was spent.
      // The cost is the opposite error — a charge with no record behind it, and an
      // index entry for a record that was never written if the put below fails. Both
      // over-count, which refuses a registration rather than admitting one, and the
      // rebuild clears them within five minutes.
      for (const name of stale) delete idx.e[name]
      idx.e[key] = [keepInstallId ?? null, ipHash ?? null]
      chargeRegistration(idx, ipHash)
      if (!(await saveIndex(env, idx))) {
        return json({ error: 'busy, retry shortly' }, 503)
      }

      for (const name of stale) await env.SUBS.delete(name)
      await env.SUBS.put(
        key,
        JSON.stringify({
          subscription,
          teamId,
          device,
          installId: keepInstallId,
          ipHash,
          t: Date.now(),
        }),
        // Mirrored into metadata so a rebuild can read it straight off list() without
        // fetching values. Both are short; KV allows 1024 bytes of metadata per key.
        { metadata: { installId: keepInstallId, ipHash } },
      )

      // The index was written above, before any of this. Deletions are reflected in
      // it here and from /unsubscribe: an earlier version left them to the rebuild,
      // reasoning that an index listing a deleted record only over-counts and
      // over-counting merely rejects. That was wrong, because an attacker can DRIVE
      // the over-count — alternating /subscribe and /unsubscribe packs the index with
      // entries whose records are gone, and at twenty of them every registration is
      // refused, for everyone, while the store itself is empty.
      return json({ ok: true, replaced: stale.length })
    }

    if (url.pathname === '/unsubscribe' && req.method === 'POST') {
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      const body = await req.json().catch(() => null)
      if (!body?.endpoint) return json({ error: 'bad request' }, 400)

      // The cron prunes endpoints the push services have declared dead, and it holds
      // the secret, so it skips every guard below. Each one would break it: a run
      // pruning more than the throttle allows would stall, narrowing the host list
      // later would strand older records as permanently un-prunable, and the existence
      // check can read stale (see there) and silently skip a prune that was wanted.
      // Authentication here is a BYPASS, never a requirement — the PWA's own disable
      // button sends no Authorization header, and demanding one would break it.
      if (authed) {
        const pruned = await subKey(body.endpoint)
        await env.SUBS.delete(pruned)
        await dropFromIndex(env, pruned)
        return json({ ok: true })
      }

      // Everything below is quota defence. On the KV free plan deletes have their own
      // allowance of 1000 a day, counted separately from the 1000 writes and the
      // 100,000 reads, all resetting at 00:00 UTC. Unauthenticated, unthrottled and
      // unconditional, this endpoint let anyone exhaust the delete allowance in
      // seconds. Puts run on their own budget, so registration does not stop outright;
      // what stops is every deletion the app depends on. The cron can no longer prune
      // dead endpoints, and /subscribe can no longer retire a device's stale records,
      // so once those fill the 20-record cap a returning device is locked out.
      //
      // 1. Shape first, because it costs nothing at all. /subscribe applies this exact
      //    check at write time, so an endpoint that fails it cannot be in the store,
      //    and rejecting it here spends no KV operation.
      if (!validPushEndpoint(body.endpoint)) return json({ error: 'bad request' }, 400)
      // 2. Then throttle, in its own bucket so unsubscribing cannot eat the
      //    registration allowance or the reverse. A real user does this roughly once.
      if (await rateLimited(req, env, 'unsubscribe')) return json({ error: 'too many requests' }, 429)
      // 3. Then look before deleting. This moves the cheap attack onto a budget a
      //    hundred times larger: a call naming an endpoint that was never stored now
      //    spends a READ, and reads allow 100,000 a day against deletes' 1000.
      //    It is a mitigation, not a bound, and two gaps are worth naming. The check
      //    is not atomic with the delete, so concurrent calls naming an endpoint that
      //    DOES exist can each read non-null and each spend one. And a host here is
      //    only proof of shape, not of registration, so enough distinct sources can
      //    still exhaust the read allowance. Both are narrowed by the throttle above,
      //    which itself fails open. The reply is {ok:true} either way, so this does
      //    not become an oracle for whether an endpoint is registered.
      //    KV reads are eventually consistent, so this can also miss a record written
      //    moments ago and skip a delete that was wanted, orphaning it. Recovery is
      //    likely but not guaranteed, and it is not immediate: disablePush() calls
      //    sub.unsubscribe() only AFTER this request returns, so the subscription is
      //    still live at the moment of the check. The record clears only if that local
      //    unsubscribe succeeds, a later push is attempted, the service answers
      //    404/410, and the cron's own prune then lands.
      const key = await subKey(body.endpoint)
      if ((await env.SUBS.get(key)) !== null) {
        await env.SUBS.delete(key)
        await dropFromIndex(env, key)
      }
      return json({ ok: true })
    }

    if (url.pathname === '/subs' && req.method === 'GET') {
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      if (!authed) return json({ error: 'unauthorized' }, 401)
      // This list stays, deliberately. It is the cron's read of who exists, and the
      // index is a cache that can lag — serving it from there would let a subscriber
      // the index has not caught up with silently stop receiving notifications. One
      // list per cron run is about 48 a day against 1000; the registration path was
      // the one that could not afford it.
      const list = await env.SUBS.list({ prefix: 'sub:' })
      const out = []
      for (const k of list.keys) {
        const v = await env.SUBS.get(k.name)
        if (!v) continue
        // The KV key is sub:<sha256(endpoint)> and the cron's subscriber id is its first
        // 16 hex chars. Returning it lets the cron tell "a record I cannot use" apart
        // from "a subscriber who unsubscribed": without it an unusable record looks
        // departed, and pruning its injury baseline makes the next status change read
        // as first sight and record silently.
        const id = k.name.slice(4, 20)
        try {
          const parsed = JSON.parse(v)
          // JSON.parse can hand back null or a primitive, which a rest pattern throws on.
          if (!parsed || typeof parsed !== 'object') {
            out.push({ key: id })
          } else {
            // installId stays inside the worker: holding one is the capability to retire
            // a registration, and the cron has no use for it. This narrows what a leaked
            // SUBS_SECRET yields — it does NOT contain one. The response still carries
            // every subscription.endpoint, because the cron must have it to send, and
            // /unsubscribe deletes by bare endpoint, so a leaked secret still permits
            // mass deletion — more directly since the bearer became /unsubscribe's
            // bypass for the throttle and the existence check. Withholding fields here
            // cannot fix that, and neither can authenticating /unsubscribe, which is
            // what grants the unguarded path. Only rotating the secret does.
            // ipHash is withheld alongside installId: it is derived from a user's IP
            // address, and the cron has no use for it either.
            const { installId: _withheld, ipHash: _alsoWithheld, ...rest } = parsed
            out.push({ ...rest, key: id })
          }
        } catch {
          // Unparseable value — still a subscriber that exists. Report the id alone
          // rather than throwing, which would 5xx the entire list.
          out.push({ key: id })
        }
      }
      return json(out)
    }

    if (url.pathname === '/state') {
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      if (!authed) return json({ error: 'unauthorized' }, 401)
      if (req.method === 'GET') return json(JSON.parse((await env.SUBS.get('state')) || '{}'))
      if (req.method === 'PUT') {
        await env.SUBS.put('state', await req.text())
        return json({ ok: true })
      }
    }

    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    if (!ALLOW.test(url.pathname)) return new Response('Not found', { status: 404 })

    // live-scoring endpoints get a much shorter cache so goals don't lag minutes behind
    const isLive =
      url.pathname.startsWith('/event/') || (url.pathname.startsWith('/fixtures') && url.searchParams.has('event'))
    const upstream = `https://fantasy.premierleague.com/api${url.pathname}${url.search}`
    const res = await fetch(upstream, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; fpl-differential personal app)',
        Accept: 'application/json',
      },
      cf: { cacheTtl: isLive ? 20 : 60, cacheEverything: true },
    })
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cache-Control', `public, max-age=${isLive ? 10 : 60}`)
    return new Response(res.body, { status: res.status, headers })
  },
}
