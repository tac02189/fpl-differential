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

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...CORS, 'Access-Control-Max-Age': '86400' } })
    }

    if (url.pathname === '/subscribe' && req.method === 'POST') {
      if (!env.SUBS) return json({ error: 'KV not configured' }, 503)
      const body = await req.json().catch(() => null)
      if (!body?.subscription?.endpoint) return json({ error: 'bad subscription' }, 400)
      await env.SUBS.put(
        await subKey(body.subscription.endpoint),
        JSON.stringify({ subscription: body.subscription, teamId: body.teamId || null, t: Date.now() }),
      )
      return json({ ok: true })
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
        if (v) out.push(JSON.parse(v))
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

    const upstream = `https://fantasy.premierleague.com/api${url.pathname}${url.search}`
    const res = await fetch(upstream, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; fpl-differential personal app)',
        Accept: 'application/json',
      },
      cf: { cacheTtl: 60, cacheEverything: true },
    })
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cache-Control', 'public, max-age=60')
    return new Response(res.body, { status: res.status, headers })
  },
}
