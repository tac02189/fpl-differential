import { pathToFileURL } from 'node:url'
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
const w = (await import(pathToFileURL(process.env.WORKER_FILE).href)).default
const { WriteBudget: _WB } = await import(pathToFileURL(process.env.WORKER_FILE).href)
// A Durable Object stub: real serialization, in-memory storage. Each env gets its
// own instance, so suites cannot spend each other's budget.
// Rebuild admission is gated by the object, so a test that simulates five minutes
// passing — or wipes the index — has to move that clock too, or no rebuild is
// granted and the assertion measures the gate instead of the rebuild.
const clearCooldown = e => { const b = e.BUDGET._state._store.get("b"); if (b) e.BUDGET._state._store.set("b", { ...b, lastRebuild: 0 }) }
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
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }

const mkKV = (opts = {}) => {
  const m = new Map(), meta = new Map(); const n = { get: 0, put: 0, del: 0, list: 0 }
  return { ops: n, _m: m, _meta: meta,
    get: async k => { n.get++; return m.get(k) ?? null },
    put: async (k, v, o) => { n.put++
      if (opts.failPutOn && opts.failPutOn === k) throw new Error('rate limited')
      m.set(k, v); if (o && o.metadata !== undefined) meta.set(k, o.metadata); else meta.delete(k) },
    delete: async k => { n.del++; m.delete(k); meta.delete(k) },
    list: async ({ prefix = '', limit = 1000 } = {}) => { n.list++
      const all = [...m.keys()].filter(k => k.startsWith(prefix))
      return { keys: all.slice(0, limit).map(name => ({ name, ...(meta.has(name) ? { metadata: meta.get(name) } : {}) })),
               list_complete: all.length <= limit } } }
}
const mkLimiter = max => { const seen = {}; return { limit: async ({ key }) => { seen[key] = (seen[key] || 0) + 1; return { success: seen[key] <= max } } } }
const b64 = x => x.toString('base64url')
const mkKeys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64(e.getPublicKey()), auth: b64(randomBytes(16)) } }
const SECRET = 's3cret', IP = '203.0.113.9', IDX = 'meta:subindex'
const fresh = (o = {}) => ({ SUBS: mkKV(o), SUBS_SECRET: SECRET, BUDGET: mkBudget(), SUBSCRIBE_LIMIT: mkLimiter(100000) })
const reg = (env, n, ip, inst) => w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || IP },
  body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + n, keys: mkKeys() },
    teamId: 7, device: 'ios', installId: inst || randomUUID() }) }), env)
const age = (env, ms) => { const i = JSON.parse(env.SUBS._m.get(IDX)); i.t = Date.now() - ms; env.SUBS._m.set(IDX, JSON.stringify(i)); clearCooldown(env) }
const idxOf = env => JSON.parse(env.SUBS._m.get(IDX))

console.log('--- the list leaves the hot path ---')
let env = fresh()
for (let i = 0; i < 12; i++) await reg(env, 'a' + i, IP, randomUUID())
ok(env.SUBS.ops.list === 1, '12 registrations in one window -> 1 list, not 12  [got ' + env.SUBS.ops.list + ']')
let b = { ...env.SUBS.ops }
await reg(env, 'a99', IP, randomUUID())
ok(env.SUBS.ops.list - b.list === 0, '  a 13th spends no list at all')
ok(env.SUBS.ops.get - b.get === 2, '  it reads 2 keys: the index and the existing-key probe  [got ' + (env.SUBS.ops.get - b.get) + ']')

env = fresh()
for (let i = 0; i < 50; i++) await reg(env, 'q' + i, '198.51.100.' + i, randomUUID())
ok(env.SUBS.ops.list === 1, '50 registrations from 50 addresses -> still 1 list  [got ' + env.SUBS.ops.list + ']')
console.log('      (before this change that was 50 lists, against a budget of 1000/day)')

console.log('--- the rebuild floor ---')
env = fresh()
await reg(env, 'r0', IP, randomUUID())
age(env, 6 * 60 * 1000)
b = { ...env.SUBS.ops }
await reg(env, 'r1', IP, randomUUID())
ok(env.SUBS.ops.list - b.list === 1, 'an index older than five minutes is rebuilt')
b = { ...env.SUBS.ops }
await reg(env, 'r2', IP, randomUUID())
ok(env.SUBS.ops.list - b.list === 0, '  and the refreshed one is reused')

env = fresh()
for (let i = 0; i < 12; i++) await reg(env, 'c' + i, IP, randomUUID())
age(env, 6 * 60 * 1000)
let r = await reg(env, 'c99', IP, randomUUID())
ok(r.status === 429, 'the 13th from one source is refused (per-source cap)')
b = { ...env.SUBS.ops }
for (let i = 0; i < 10; i++) await reg(env, 'c9' + i, IP, randomUUID())
ok(env.SUBS.ops.list - b.list === 0, '  ten more refusals spend ZERO further lists — the rebuild was saved  [got ' + (env.SUBS.ops.list - b.list) + ']')

console.log('--- every cap still behaves exactly as before ---')
env = fresh()
const inst = randomUUID()
await reg(env, 's1', IP, inst)
r = await reg(env, 's2', IP, inst)
ok((await r.json()).replaced === 1, 'an install still retires its own earlier record, off the index')
ok(Object.keys(idxOf(env).e).length === 1, '  and the index holds one entry, not two')
b = { ...env.SUBS.ops }
r = await reg(env, 's3', IP, inst)
ok((await r.json()).replaced === 1, 'retiring again retires only the one live record')
ok(env.SUBS.ops.del - b.del === 1, '  exactly one delete — the retired key left the index, so it is not re-deleted  [got ' + (env.SUBS.ops.del - b.del) + ']')

env = fresh()
for (let i = 0; i < 12; i++) await reg(env, 'p' + i, IP, randomUUID())
r = await reg(env, 'p99', IP, randomUUID())
ok(r.status === 429 && (await r.json()).error === 'too many subscriptions from this network', 'per-source cap of 12 still enforced')

env = fresh()
for (let i = 0; i < 50; i++) await reg(env, 'o' + i, '198.51.100.' + i, randomUUID())
r = await reg(env, 'o99', '198.51.100.200', randomUUID())
ok(r.status === 429 && (await r.json()).error === 'subscription limit reached', 'the 50-record cap still enforced')

console.log('--- the index is never trusted blindly ---')
env = fresh(); await reg(env, 'v1', IP, randomUUID())
const bad = [['missing', 'DELETE'], ['not JSON', '{oops'], ['null', 'null'], ['a bare string', '"x"'],
             ['without an entries map', '{"t":' + Date.now() + '}'], ['holding an array', '{"t":' + Date.now() + ',"e":[]}'],
             ['without a timestamp', '{"e":{}}'], ['timestamped in the future', '{"t":' + (Date.now() + 99999999) + ',"e":{}}']]
let n = 0
for (const [label, val] of bad) {
  if (val === 'DELETE') env.SUBS._m.delete(IDX); else env.SUBS._m.set(IDX, val)
  clearCooldown(env)
  b = { ...env.SUBS.ops }
  r = await reg(env, 'v' + (n++), IP, randomUUID())
  ok(r.status === 200 && env.SUBS.ops.list - b.list === 1, 'an index ' + label + ' forces a rebuild')
}

console.log('--- the index key stays out of the subscriber store ---')
env = fresh(); await reg(env, 'k1', IP, randomUUID())
ok(env.SUBS._m.has(IDX), 'the index is stored')
r = await w.fetch(new Request('https://x/subs', { headers: { Authorization: 'Bearer ' + SECRET } }), env)
const subs = await r.json()
ok(subs.length === 1, 'GET /subs returns 1 subscriber, not 2 — subindex is outside the sub: prefix  [got ' + subs.length + ']')
ok(Object.keys(idxOf(env).e).every(k => k.startsWith('sub:')), '  and the index itself holds only sub: keys')

console.log('--- rebuilds pick up what happened outside /subscribe ---')
env = fresh()
const i1 = randomUUID()
await reg(env, 'x1', IP, i1)
const legacyKey = [...env.SUBS._m.keys()].find(k => k.startsWith('sub:'))
env.SUBS._meta.delete(legacyKey)
env.SUBS._m.delete(IDX)
clearCooldown(env)
r = await reg(env, 'x2', IP, i1)
ok((await r.json()).replaced === 1, 'buildIndex falls back to a get for a record carrying no metadata')

env = fresh()
await reg(env, 'y1', IP, randomUUID())
await reg(env, 'y2', IP, randomUUID())
await w.fetch(new Request('https://x/unsubscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
  body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/y1' }) }), env)
ok(Object.keys(idxOf(env).e).length === 1, 'an /unsubscribe delete IS written back — over-counting is not safe when an attacker can drive it')
age(env, 6 * 60 * 1000)
await reg(env, 'y3', IP, randomUUID())
ok(Object.keys(idxOf(env).e).length === 2, '  and a later rebuild agrees with KV  [got ' + Object.keys(idxOf(env).e).length + ']')

console.log('--- a failed index write must now REFUSE the registration ---')
env = { SUBS: mkKV({ failPutOn: IDX }), SUBS_SECRET: SECRET, BUDGET: mkBudget(), SUBSCRIBE_LIMIT: mkLimiter(100000) }
r = await reg(env, 'f1', IP, randomUUID())
ok(r.status === 503, 'KV refusing the index write refuses the registration — the charge is written first')
ok(![...env.SUBS._m.keys()].some(k => k.startsWith('sub:')), '  so no record is ever stored uncharged')

console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
