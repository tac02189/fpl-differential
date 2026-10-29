import { pathToFileURL } from 'node:url'
import { createHash, createECDH, randomBytes } from 'node:crypto'
const w = (await import(pathToFileURL(process.env.WORKER_FILE).href)).default
const { WriteBudget: _WB } = await import(pathToFileURL(process.env.WORKER_FILE).href)
// A Durable Object stub: real serialization, in-memory storage. Each env gets its
// own instance, so suites cannot spend each other's budget.
const mkBudget = () => {
  const store = new Map(); let chain = Promise.resolve()
  const state = { _store: store,
    storage: { get: async k => structuredClone(store.get(k)),
               put: async (k, v) => { store.set(k, structuredClone(v)) } },
    blockConcurrencyWhile: fn => { const r = chain.then(fn); chain = r.then(() => {}, () => {}); return r } }
  const inst = new _WB(state)
  return { _state: state, idFromName: n => n,
           get: () => ({ fetch: (u, i) => inst.fetch(new Request(u, i)) }) }
}

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('PASS  ' + m) } else { fail++; console.log('FAIL  ' + m) } }
const _isSub = k => k.startsWith('sub:')
const nSubs = e => [...e.SUBS._m.keys()].filter(_isSub).length
const subKeys = e => [...e.SUBS._m.keys()].filter(_isSub)
const subVals = e => [...e.SUBS._m.entries()].filter(([k]) => _isSub(k)).map(([, v]) => v)

const mkKV = (init = {}) => {
  const m = new Map(Object.entries(init))
  return {
    get: async k => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
    delete: async k => void m.delete(k),
    list: async ({ prefix = '', limit = 1000 } = {}) => ({
      keys: [...m.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })),
    }),
    _m: m,
  }
}
const SECRET = 's3cret'
const EP = 'https://fcm.googleapis.com/fcm/send/abc123'
// A REAL P-256 point. 87 base64url chars of 'B' is the right length but not on the
// curve, and crypto.subtle.importKey has rejected it since the curve check landed.
const _ec = createECDH('prime256v1'); _ec.generateKeys()
const KEYS = { p256dh: _ec.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
const sha = s => createHash('sha256').update(s).digest('hex')
const call = (env, path, init = {}) => w.fetch(new Request('https://x' + path, init), env)
const post = (env, path, body) =>
  call(env, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const getSubs = env => call(env, '/subs', { headers: { Authorization: 'Bearer ' + SECRET } })

// --- /subscribe key validation (NEW) ---
let env = { SUBS: mkKV(), SUBS_SECRET: SECRET, BUDGET: mkBudget() }
let r = await post(env, '/subscribe', { subscription: { endpoint: EP, keys: KEYS }, teamId: 1, device: 'ios' })
ok(r.status === 200, 'subscribe: valid endpoint + valid keys -> 200')

env = { SUBS: mkKV(), SUBS_SECRET: SECRET, BUDGET: mkBudget() }
r = await post(env, '/subscribe', { subscription: { endpoint: EP }, teamId: 1 })
ok(r.status === 400 && (await r.json()).error === 'bad subscription keys', 'subscribe: NO keys -> 400 bad subscription keys')
ok(nSubs(env) === 0, 'subscribe: key-less record was NOT stored')

env = { SUBS: mkKV(), SUBS_SECRET: SECRET, BUDGET: mkBudget() }
r = await post(env, '/subscribe', { subscription: { endpoint: EP, keys: { p256dh: 'short', auth: 'x' } } })
ok(r.status === 400, 'subscribe: too-short keys -> 400')

env = { SUBS: mkKV(), SUBS_SECRET: SECRET, BUDGET: mkBudget() }
r = await post(env, '/subscribe', { subscription: { endpoint: 'https://evil.example.com/x', keys: KEYS } })
ok(r.status === 400 && (await r.json()).error === 'bad subscription', 'subscribe: bad endpoint still -> 400 (regression)')

// --- /subs key exposure (NEW) ---
const kvKey = 'sub:' + sha(EP)
const expectedId = sha(EP).slice(0, 16)
env = { SUBS: mkKV({ [kvKey]: JSON.stringify({ subscription: { endpoint: EP, keys: KEYS }, teamId: 7, device: 'ios' }) }), SUBS_SECRET: SECRET, BUDGET: mkBudget() }
r = await getSubs(env)
let body = await r.json()
ok(r.status === 200 && Array.isArray(body) && body.length === 1, 'subs: returns an array')
ok(body[0].key === expectedId, 'subs: key == first 16 hex of sha256(endpoint)')
ok(body[0].subscription.endpoint === EP && body[0].teamId === 7, 'subs: record fields preserved alongside key')

env = { SUBS: mkKV({ ['sub:' + 'f'.repeat(64)]: 'this is not json{{{' }), SUBS_SECRET: SECRET, BUDGET: mkBudget() }
r = await getSubs(env)
body = await r.json()
ok(r.status === 200, 'subs: unparseable value does NOT 5xx the list')
ok(body.length === 1 && body[0].key === 'f'.repeat(16) && body[0].subscription === undefined,
   'subs: unparseable value yields key-only record')

env = { SUBS: mkKV(), SUBS_SECRET: SECRET, BUDGET: mkBudget() }
r = await call(env, '/subs')
ok(r.status === 401, 'subs: unauthorized still -> 401 (regression)')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
