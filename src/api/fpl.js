// All FPL API access goes through here.
// Dev: Vite proxy at /fpl-api → fantasy.premierleague.com/api
// Prod: VITE_FPL_PROXY → Cloudflare Worker passthrough
const BASE = import.meta.env.VITE_FPL_PROXY || '/fpl-api'

const MIN = 60 * 1000
const mem = new Map()
const inflight = new Map()

async function get(path) {
  const res = await fetch(`${BASE}/${path}`)
  if (!res.ok) {
    const err = new Error(`FPL API ${res.status} for ${path}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

function cached(key, path, ttl, persist = false) {
  const now = Date.now()
  const m = mem.get(key)
  if (m && now - m.t < ttl) return Promise.resolve(m.data)
  if (inflight.has(key)) return inflight.get(key)
  if (persist) {
    try {
      const raw = localStorage.getItem(key)
      if (raw) {
        const { t, data } = JSON.parse(raw)
        if (now - t < ttl) {
          mem.set(key, { t, data })
          return Promise.resolve(data)
        }
      }
    } catch {
      /* corrupted cache — fall through to network */
    }
  }
  const p = get(path).then(
    data => {
      mem.set(key, { t: Date.now(), data })
      if (persist) {
        try {
          localStorage.setItem(key, JSON.stringify({ t: Date.now(), data }))
        } catch {
          /* storage full — memory cache still works */
        }
      }
      inflight.delete(key)
      return data
    },
    e => {
      inflight.delete(key)
      throw e
    },
  )
  inflight.set(key, p)
  return p
}

export const getBootstrap = () => cached('fpl.bootstrap.v1', 'bootstrap-static/', 30 * MIN, true)
export const getFixtures = () => cached('fpl.fixtures.v1', 'fixtures/', 30 * MIN, true)
export const getEntry = id => cached(`fpl.entry.${id}`, `entry/${id}/`, 5 * MIN)
export const getHistory = id => cached(`fpl.history.${id}`, `entry/${id}/history/`, 5 * MIN)
export const getPicks = (id, gw) => cached(`fpl.picks.${id}.${gw}`, `entry/${id}/event/${gw}/picks/`, 5 * MIN)
export const getLive = gw => cached(`fpl.live.${gw}`, `event/${gw}/live/`, MIN)
export const getLiveFixtures = gw => cached(`fpl.fx.${gw}`, `fixtures/?event=${gw}`, MIN)
export const getLeague = (id, page = 1) =>
  cached(`fpl.league.${id}.${page}`, `leagues-classic/${id}/standings/?page_standings=${page}`, 5 * MIN)
export const getElementSummary = id => cached(`fpl.el.${id}`, `element-summary/${id}/`, 30 * MIN)

// One derived context object most pages consume alongside the raw bootstrap.
export function ctxFrom(bs) {
  return {
    bs,
    players: new Map(bs.elements.map(e => [e.id, e])),
    teams: new Map(bs.teams.map(t => [t.id, t])),
    current: bs.events.find(e => e.is_current) || null,
    next: bs.events.find(e => e.is_next) || null,
  }
}
