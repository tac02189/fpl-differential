// The three defects Gemini's review of the index change turned up.
import { pathToFileURL } from 'node:url'
import { createECDH, randomBytes, randomUUID, createHash } from 'node:crypto'
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

const IDX = 'meta:subindex'
// Models the real KV rule: a second put to the SAME key inside one second throws 429.
const mkKV = (opts = {}) => {
  const m = new Map(), meta = new Map(), lastPut = new Map()
  const n = { get: 0, put: 0, del: 0, list: 0 }; const putLog = []
  return { ops: n, _m: m, _meta: meta, putLog,
    get: async k => { n.get++; return m.get(k) ?? null },
    put: async (k, v, o) => {
      n.put++; putLog.push(k)
      if (opts.sameKeyPerSecond && lastPut.has(k) && Date.now() - lastPut.get(k) < 1000) {
        throw new Error('KV PUT failed: 429 Too Many Requests')
      }
      lastPut.set(k, Date.now())
      m.set(k, v); if (o && o.metadata !== undefined) meta.set(k, o.metadata); else meta.delete(k)
    },
    delete: async k => { n.del++; m.delete(k); meta.delete(k) },
    list: async ({ prefix = '', limit = 1000 } = {}) => { n.list++
      const all = [...m.keys()].filter(k => k.startsWith(prefix))
      return { keys: all.slice(0, limit).map(name => ({ name, ...(meta.has(name) ? { metadata: meta.get(name) } : {}) })),
               list_complete: all.length <= limit } } }
}
const mkLimiter = max => { const seen = {}; return { limit: async ({ key }) => { seen[key] = (seen[key] || 0) + 1; return { success: seen[key] <= max } } } }
const b64 = x => x.toString('base64url')
const mkKeys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: b64(e.getPublicKey()), auth: b64(randomBytes(16)) } }
const SECRET = 's3cret', IP = '203.0.113.9'
const fresh = (o = {}) => ({ SUBS: mkKV(o), SUBS_SECRET: SECRET, BUDGET: mkBudget(), SUBSCRIBE_LIMIT: mkLimiter(100000) })
const EP = n => 'https://fcm.googleapis.com/fcm/send/' + n
const subKeyOf = n => 'sub:' + createHash('sha256').update(EP(n)).digest('hex')
const reg = (env, n, ip, inst) => w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || IP },
  body: JSON.stringify({ subscription: { endpoint: EP(n), keys: mkKeys() }, teamId: 7, device: 'ios', installId: inst || randomUUID() }) }), env)
const unreg = (env, n, bearer) => w.fetch(new Request('https://x/unsubscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
  body: JSON.stringify({ endpoint: EP(n) }) }), env)
const idxOf = env => JSON.parse(env.SUBS._m.get(IDX))
const age = (env, ms) => { const i = idxOf(env); i.t = Date.now() - ms; env.SUBS._m.set(IDX, JSON.stringify(i)); clearCooldown(env) }
const idxPuts = env => env.SUBS.putLog.filter(k => k === IDX).length

console.log('--- GEMINI 1 (Critical): one index write per request ---')
let env = fresh()
let before = idxPuts(env)
await reg(env, 'w1', IP, randomUUID())
ok(idxPuts(env) - before === 1, 'a registration that triggers a rebuild writes the index ONCE  [got ' + (idxPuts(env) - before) + ']')
ok(subKeyOf('w1') in idxOf(env).e, '  and the saved index CONTAINS the record just written')

// the real failure: KV rejects a second same-key put inside a second
env = fresh({ sameKeyPerSecond: true })
let r = await reg(env, 'w2', IP, randomUUID())
ok(r.status === 200, 'with KV enforcing 1 write/s per key, the registration still succeeds')
ok(subKeyOf('w2') in idxOf(env).e, '  and the record is STILL indexed — two writes would have lost it')
ok(env.SUBS._m.has(subKeyOf('w2')), '  and the subscription itself is stored')

// KV permits one write per second per key, and a source may burst five requests
// inside a throttle window. Because the index write now comes FIRST and carries the
// charge, the losers of that race write nothing at all — rather than each storing a
// record that no surviving charge accounts for.
env = fresh({ sameKeyPerSecond: true })
const burst = []
for (let i = 0; i < 6; i++) burst.push((await reg(env, 'u' + i, IP, randomUUID())).status)
const stored = [...env.SUBS._m.keys()].filter(k => k.startsWith('sub:')).length
ok(burst[0] === 200, 'first of six registrations inside one second succeeds  [' + burst.join(',') + ']')
ok(burst.slice(1).every(c => c === 503), '  the other five are refused outright, not left half-done')
ok(stored === 1, '  exactly one record stored: no record outruns its charge  [got ' + stored + ']')
ok(Object.keys(idxOf(env).e).length === 1, '  and the index agrees with the store')
await new Promise(r => setTimeout(r, 1100))
age(env, 6 * 60 * 1000)
await reg(env, 'u6', IP, randomUUID())
ok(Object.keys(idxOf(env).e).length === 2,
  '  a later registration proceeds normally once the second has passed  [got ' + Object.keys(idxOf(env).e).length + ']')

console.log('--- the rebuild is still saved on the paths that reject ---')
env = fresh()
for (let i = 0; i < 12; i++) await reg(env, 'c' + i, IP, randomUUID())
age(env, 6 * 60 * 1000)
r = await reg(env, 'c99', IP, randomUUID())
ok(r.status === 429, 'the 13th from one source is refused')
ok(Date.now() - idxOf(env).t < 60000, '  and the rebuild it forced was persisted (fresh timestamp)')
let b = { ...env.SUBS.ops }
for (let i = 0; i < 10; i++) await reg(env, 'c9' + i, IP, randomUUID())
ok(env.SUBS.ops.list - b.list === 0, '  so ten more refusals spend zero further lists  [got ' + (env.SUBS.ops.list - b.list) + ']')

console.log('--- GEMINI 3 (High): deletions are reflected, so phantoms cannot be driven ---')
env = fresh()
await reg(env, 'd1', IP, randomUUID())
await reg(env, 'd2', IP, randomUUID())
ok(Object.keys(idxOf(env).e).length === 2, 'two records, two index entries')
await unreg(env, 'd1')
ok(!(subKeyOf('d1') in idxOf(env).e), 'an anonymous /unsubscribe removes its entry from the index')
ok(Object.keys(idxOf(env).e).length === 1, '  leaving one')
await unreg(env, 'd2', SECRET)
ok(!(subKeyOf('d2') in idxOf(env).e), "the cron's authenticated prune removes its entry too")
ok(Object.keys(idxOf(env).e).length === 0, '  leaving none')

// the attack: alternate subscribe/unsubscribe to pack the index with dead entries
env = fresh()
for (let i = 0; i < 25; i++) { await reg(env, 'ph' + i, IP, randomUUID()); await unreg(env, 'ph' + i) }
ok(Object.keys(idxOf(env).e).length === 0,
  '25 subscribe/unsubscribe cycles leave the index EMPTY, not full  [got ' + Object.keys(idxOf(env).e).length + ']')
r = await reg(env, 'legit', '198.51.100.7', randomUUID())
ok(r.status === 200, '  so a legitimate device can still register afterwards')

// the PWA toggle: disable then immediately re-enable, with the store at the cap
env = fresh()
for (let i = 0; i < 19; i++) await reg(env, 'f' + i, '198.51.100.' + i, randomUUID())
const mine = randomUUID()
await reg(env, 'mine', '198.51.100.99', mine)
ok(Object.keys(idxOf(env).e).length === 20, 'precondition: the store is at the 20 cap')
await unreg(env, 'mine')
r = await reg(env, 'mine2', '198.51.100.99', mine)
ok(r.status === 200, 'disabling then re-enabling push at the cap succeeds — no phantom slot held')

console.log('--- a delete never has to list, and never fails the request ---')
env = fresh()
await reg(env, 'n1', IP, randomUUID())
b = { ...env.SUBS.ops }
await unreg(env, 'n1')
ok(env.SUBS.ops.list - b.list === 0, 'an /unsubscribe spends no list operation  [got ' + (env.SUBS.ops.list - b.list) + ']')
env = fresh()
await reg(env, 'n2', IP, randomUUID())
env.SUBS._m.delete(IDX)
clearCooldown(env)
r = await unreg(env, 'n2')
ok(r.status === 200, 'unsubscribing with no index present still returns 200')
ok(env.SUBS.ops.list === 1, '  and does not list to rebuild one (the 1 list was the registration)  [got ' + env.SUBS.ops.list + ']')
env = fresh()
await reg(env, 'n3', IP, randomUUID())
env.SUBS._m.set(IDX, '{corrupt')
r = await unreg(env, 'n3')
ok(r.status === 200 && !env.SUBS._m.has(subKeyOf('n3')), 'a corrupt index does not stop the record being deleted')

console.log('--- GEMINI 5: the index key is out of the subscriber namespace ---')
ok(!IDX.startsWith('sub'), "the key does not start with 'sub', so list({prefix:'sub'}) cannot sweep it  [" + IDX + ']')
ok(!IDX.startsWith('sub:'), "  nor with 'sub:'")
env = fresh(); await reg(env, 'ns1', IP, randomUUID())
const asSub = [...env.SUBS._m.keys()].filter(k => k.startsWith('sub'))
ok(asSub.length === 1, "a bare 'sub' prefix now matches only the subscription  [" + asSub.length + ']')
r = await w.fetch(new Request('https://x/subs', { headers: { Authorization: 'Bearer ' + SECRET } }), env)
ok((await r.json()).length === 1, 'GET /subs still returns exactly the one subscriber')

console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
