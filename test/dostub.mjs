// Shared stubs for the Durable Object that owns the write budget.
import { createECDH, randomBytes, randomUUID } from 'node:crypto'

export const IDX = 'meta:subindex'
export const SECRET = 's3cret'
export const IP = '203.0.113.9'
export const BUDGET = 500, PER_SOURCE = 60, PER_REG = 3
export const today = () => new Date().toISOString().slice(0, 10)

// `serial: false` disables blockConcurrencyWhile's guarantee, so the same class can
// be run WITHOUT serialization — which is what a KV read-modify-write gave us.
export const mkState = (serial = true) => {
  const store = new Map()
  let chain = Promise.resolve()
  return { _store: store,
    storage: {
      get: async k => { await Promise.resolve(); return structuredClone(store.get(k)) },
      put: async (k, v) => { await Promise.resolve(); store.set(k, structuredClone(v)) },
    },
    blockConcurrencyWhile: fn => {
      if (!serial) return fn()
      const run = chain.then(fn)
      chain = run.then(() => {}, () => {})
      return run
    } }
}

export const mkNamespace = (WriteBudget, { serial = true, broken = false, failPut = false } = {}) => {
  const state = mkState(serial)
  if (failPut) state.storage.put = async () => { throw new Error('storage full') }
  const inst = new WriteBudget(state)
  return { _state: state, _inst: inst,
    idFromName: n => n,
    get: () => ({ fetch: (url, init) => {
      if (broken) throw new Error('DO unreachable')
      return inst.fetch(new Request(url, init))
    } }) }
}

export const usedIn = ns => (ns._state._store.get('b') || { used: 0 }).used || 0
export const srcIn = (ns, k) => ((ns._state._store.get('b') || { src: {} }).src || {})[k] || 0

export const mkKV = (opts = {}) => {
  const m = new Map(), meta = new Map(); const n = { get: 0, put: 0, del: 0, list: 0 }
  return { ops: n, _m: m, _meta: meta,
    get: async k => { n.get++; return m.get(k) ?? null },
    put: async (k, v, o) => { n.put++
      if (opts.failPutOn && opts.failPutOn === k) throw new Error('KV PUT failed: 429')
      if (opts.failRecordPut && k.startsWith('sub:')) throw new Error('KV PUT failed')
      m.set(k, v); if (o && o.metadata !== undefined) meta.set(k, o.metadata); else meta.delete(k) },
    delete: async k => { n.del++; m.delete(k); meta.delete(k) },
    list: async ({ prefix = '', limit = 1000 } = {}) => { n.list++
      const all = [...m.keys()].filter(k => k.startsWith(prefix))
      return { keys: all.slice(0, limit).map(name => ({ name, ...(meta.has(name) ? { metadata: meta.get(name) } : {}) })),
               list_complete: all.length <= limit } } }
}

const b64 = x => x.toString('base64url')
export const mkKeys = () => { const e = createECDH('prime256v1'); e.generateKeys()
  return { p256dh: b64(e.getPublicKey()), auth: b64(randomBytes(16)) } }
export const EP = n => 'https://fcm.googleapis.com/fcm/send/' + n

export const mkEnv = (WriteBudget, { kv = {}, ns, noBudget = false } = {}) => ({
  SUBS: mkKV(kv),
  SUBS_SECRET: SECRET,
  SUBSCRIBE_LIMIT: { limit: async () => ({ success: true }) },
  ...(noBudget ? {} : { BUDGET: ns || mkNamespace(WriteBudget) }),
})

export const reg = (w, env, nm, ip) => w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || IP },
  body: JSON.stringify({ subscription: { endpoint: EP(nm), keys: mkKeys() }, teamId: 7, device: 'ios', installId: randomUUID() }) }), env)

export const unreg = (w, env, nm) => w.fetch(new Request('https://x/unsubscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
  body: JSON.stringify({ endpoint: EP(nm) }) }), env)

export const idxOf = env => JSON.parse(env.SUBS._m.get(IDX))
export const setIdx = (env, f) => { const i = idxOf(env); f(i); env.SUBS._m.set(IDX, JSON.stringify(i)) }
export const nSubs = env => [...env.SUBS._m.keys()].filter(k => k.startsWith('sub:')).length
