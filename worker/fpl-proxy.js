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
function validPushEndpoint(ep) {
  if (typeof ep !== 'string') return false
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
// Decoded byte length of a base64url string, or -1 if it is not base64url at all.
function b64urlBytes(s) {
  // Accept the standard alphabet as well as base64url: browsers emit base64url, but
  // being strict here would lock out a client for an encoding choice, which is the one
  // failure this validator must not cause.
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/_-]+=*$/.test(s)) return -1
  const b = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  try {
    return atob(b + '='.repeat((4 - (b.length % 4)) % 4)).length
  } catch {
    return -1
  }
}

function validPushKeys(k) {
  // Byte lengths, not character counts: web-push needs p256dh to decode to a 65-byte
  // uncompressed P-256 point and auth to at least 16 bytes. A record that merely looks
  // long enough still throws on every send, with no status code to mark it gone, so it
  // can never be auto-retired — it just reddens the cron and holds one of the 20 slots.
  return !!k && b64urlBytes(k.p256dh) === 65 && b64urlBytes(k.auth) >= 16
}

// A browser install's own identifier. Shape-checked only: its security comes from being
// 128 bits of randomness that never leaves the owning browser, not from anything the
// worker can verify about it.
function validInstallId(v) {
  return typeof v === 'string' && v.length >= 16 && v.length <= 100 && /^[A-Za-z0-9_-]+$/.test(v)
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
    }

    if (url.pathname === '/subscribe' && req.method === 'POST') {
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      const body = await req.json().catch(() => null)
      if (!validPushEndpoint(body?.subscription?.endpoint)) return json({ error: 'bad subscription' }, 400)
      if (!validPushKeys(body.subscription.keys)) return json({ error: 'bad subscription keys' }, 400)
      const key = await subKey(body.subscription.endpoint)
      const teamId = body.teamId || null
      const device = typeof body.device === 'string' ? body.device.slice(0, 32) : null
      // Which browser install this is. Random, client-generated, kept in that browser's
      // own storage and never shown to anyone else — so it is the one thing a caller can
      // actually prove it owns. Retirement below keys off it and nothing else.
      const installId = validInstallId(body.installId) ? body.installId : null
      const existing = await env.SUBS.get(key)
      const core = JSON.stringify({ subscription: body.subscription, teamId, device, installId })
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
      const list = await env.SUBS.list({ prefix: 'sub:', limit: 100 })
      const stale = []
      if (installId) {
        for (const k of list.keys) {
          if (k.name === key) continue
          const raw = await env.SUBS.get(k.name)
          if (!raw) continue
          let prev
          try {
            prev = JSON.parse(raw)
          } catch {
            continue
          }
          // JSON.parse('null') succeeds, as do a bare string or number, and any of them
          // would throw on the field access below and 500 the whole registration.
          if (!prev || typeof prev !== 'object') continue
          if (prev.installId !== installId) continue
          stale.push(k.name)
        }
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
      const truncated = list.list_complete === false
      if (!existing && (truncated || list.keys.length - stale.length >= 20)) {
        return json({ error: 'subscription limit reached' }, 429)
      }

      for (const name of stale) await env.SUBS.delete(name)
      await env.SUBS.put(key, JSON.stringify({ subscription: body.subscription, teamId, device, installId, t: Date.now() }))
      return json({ ok: true, replaced: stale.length })
    }

    if (url.pathname === '/unsubscribe' && req.method === 'POST') {
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      const body = await req.json().catch(() => null)
      if (!body?.endpoint) return json({ error: 'bad request' }, 400)
      await env.SUBS.delete(await subKey(body.endpoint))
      return json({ ok: true })
    }

    const authed = env.SUBS_SECRET && req.headers.get('Authorization') === `Bearer ${env.SUBS_SECRET}`

    if (url.pathname === '/subs' && req.method === 'GET') {
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      if (!authed) return json({ error: 'unauthorized' }, 401)
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
            // installId stays inside the worker. Holding one is the capability to retire
            // that registration, and the cron has no use for it — so a leaked SUBS_SECRET
            // buys the ability to read subscriptions but still not to evict anybody.
            const { installId: _withheld, ...rest } = parsed
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
