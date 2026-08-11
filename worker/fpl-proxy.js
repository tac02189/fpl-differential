// Cloudflare Worker — CORS proxy for the FPL API.
// The browser can't call fantasy.premierleague.com directly (no CORS headers),
// so the app hits this worker instead: <worker-url>/<endpoint> → /api/<endpoint>.
// GET-only, endpoint-whitelisted, cached 60s at the edge.

const ALLOW = /^\/(bootstrap-static|fixtures|element-summary|event|entry|leagues-classic)(\/|$)/

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      })
    }
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })

    const url = new URL(req.url)
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
