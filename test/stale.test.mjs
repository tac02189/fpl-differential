// A stale-delete list is permission to delete a key, computed from a roster read
// several KV operations earlier. By the time the delete runs, that key can belong to
// a NEWER registration. Two overlapping calls for one installId — one moving to Y,
// one re-registering X — each saw the other's record as stale and deleted it, leaving
// the device with no registration at all while both calls returned 200.
//
// The guard re-reads the roster immediately before acting on that list and skips any
// key present again. What this suite has to keep true is BOTH halves:
//   - the guard holds, and
//   - the guard is not vacuous: ordinary sweeps still retire records.
// A guard that simply never deleted anything would pass the first half alone.
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { IP, EP, mkKeys, mkKV, mkNamespace, nSubs, idxOf, SECRET, IDX } from './dostub.mjs'

const mod = await import(pathToFileURL(process.env.WORKER_FILE).href)
const w = mod.default
const { WriteBudget } = mod
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Uniform latency alone never reproduces the race: a request's delete follows its own
// record write by one KV op, while the other request needs three ops between its
// roster read and its write. The window only opens when the losing DELETE stalls,
// which is what stallFirstDelete models.
const kvWith = ({ latency = 3, stallFirstDelete = 0 } = {}) => {
  const inner = mkKV({})
  let deletes = 0
  return { ops: inner.ops, _m: inner._m, _meta: inner._meta,
    get: async k => { await sleep(latency); return inner.get(k) },
    put: async (k, v, o) => { await sleep(latency); return inner.put(k, v, o) },
    delete: async k => {
      const first = ++deletes === 1
      await sleep(first && stallFirstDelete ? stallFirstDelete : latency)
      return inner.delete(k)
    },
    list: async o => { await sleep(latency); return inner.list(o) } }
}
const envWith = (opts = {}) => ({
  SUBS: kvWith(opts), SUBS_SECRET: SECRET,
  SUBSCRIBE_LIMIT: { limit: async () => ({ success: true }) },
  BUDGET: mkNamespace(WriteBudget),
})
const post = (env, name, installId) => w.fetch(new Request('https://x/subscribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
  body: JSON.stringify({ subscription: { endpoint: EP(name), keys: mkKeys() },
    teamId: 7, device: 'ios', installId }),
}), env)
const subKeys = env => [...env.SUBS._m.keys()].filter(k => k.startsWith('sub:'))
// Which endpoint a stored record belongs to, so a test can assert WHICH one survived
// rather than merely counting.
const endpointsIn = env => subKeys(env)
  .map(k => { try { return JSON.parse(env.SUBS._m.get(k)).subscription.endpoint } catch { return null } })
  .map(e => (e || '').split('/').pop())
  .sort()

console.log('--- an overlapping registration must not delete a live record ---')
let losses = 0, runs = 0, bothOk = 0
for (const stagger of [0, 2, 4, 6, 8, 10, 12]) {
  for (const stall of [40, 80]) {
    const env = envWith({ latency: 3, stallFirstDelete: stall })
    const I = randomUUID()
    await post(env, 'X', I)
    if (nSubs(env) !== 1) continue

    const a = post(env, 'Y', I)          // moves this install to endpoint Y
    await sleep(stagger)
    const b = post(env, 'X', I)          // re-registers endpoint X for the same install
    const [ra, rb] = await Promise.all([a, b])
    runs++
    if (ra.status === 200 && rb.status === 200) bothOk++
    if (nSubs(env) === 0) losses++
  }
}
ok(runs >= 12, runs + ' overlapping pairs exercised across stagger x stall')
// A weak floor would let most pairs fail admission while the suite stayed green, so
// require that the schedule under test is actually reached most of the time.
ok(bothOk >= runs - 2, '  both calls succeeded in ' + bothOk + ' of ' + runs +
  ' — the losing schedule is genuinely exercised')
ok(losses === 0, '  none left the device with zero records  [' + losses + ' lost of ' + runs + ']')
console.log('      (12 of 14 before the guard: each call deleted the other’s record,')
console.log('       both returned 200, and the roster still claimed one existed)')

console.log('--- but the sweep still works: an ordinary reinstall retires its old record ---')
{
  const env = envWith({ latency: 1 })
  const I = randomUUID()
  await post(env, 'old', I)
  const r = await post(env, 'new', I)
  ok((await r.json()).replaced === 1, 're-registering the same install reports replaced:1')
  ok(nSubs(env) === 1, '  store holds exactly one record  [' + nSubs(env) + ']')
  ok(endpointsIn(env).join() === 'new', '  and it is the NEW endpoint, not the old one  [' +
    endpointsIn(env).join() + ']')
}

console.log('--- SEVERAL stale records for one install are all retired ---')
// Serial re-registration never accumulates more than one, so the extra records are
// planted: two endpoints reassigned to one installId in both the record metadata and
// the roster, exactly as a store that drifted would hold them.
{
  const env = envWith({ latency: 1 })
  const I = randomUUID()
  await post(env, 'p1', randomUUID())
  await post(env, 'p2', randomUUID())
  const planted = subKeys(env)
  ok(planted.length === 2, 'two records planted from different installs')
  for (const k of planted) {
    const v = JSON.parse(env.SUBS._m.get(k))
    v.installId = I
    env.SUBS._m.set(k, JSON.stringify(v))
    env.SUBS._meta.set(k, { installId: I, ipHash: (env.SUBS._meta.get(k) || {}).ipHash ?? null })
  }
  const idx = idxOf(env)
  for (const k of planted) idx.e[k] = [I, idx.e[k] ? idx.e[k][1] : null]
  env.SUBS._m.set(IDX, JSON.stringify(idx))

  const r = await post(env, 'p3', I)
  const body = await r.json()
  ok(body.replaced === 2, '  one registration retires BOTH  [replaced=' + body.replaced + ']')
  ok(nSubs(env) === 1, '  leaving exactly one record  [' + nSubs(env) + ']')
  ok(endpointsIn(env).join() === 'p3', '  and it is the new endpoint  [' + endpointsIn(env).join() + ']')
}

console.log('--- uncertainty must mean SKIP, not delete-everything ---')
// readIndex repairs a malformed roster into an empty one, which the guard would read
// as "nothing is live" and therefore licence to delete every stale key — most
// destructive exactly when the roster is corrupt. liveEntries answers null instead.
{
  const env = envWith({ latency: 1 })
  const I = randomUUID()
  await post(env, 'c1', I)
  const real = env.SUBS.get
  env.SUBS.get = async k => (k === IDX ? JSON.stringify({ t: Date.now(), e: 'not-an-object' }) : real.call(env.SUBS, k))
  const r = await post(env, 'c2', I)
  env.SUBS.get = real
  ok(r.status === 200, 'a malformed roster still registers the device  [' + r.status + ']')
  ok((await r.json()).replaced === 0, '  and retires nothing rather than everything  [replaced=0]')
  ok(nSubs(env) === 2, '  so the old record survives as a duplicate  [' + nSubs(env) + ']')
  console.log('      (a duplicate costs an extra push per notification until the cron')
  console.log('       prunes it; the alternative was deleting a possibly-live record)')
}

console.log('--- a roster read that THROWS must not lose a successful registration ---')
// readIndex does its KV get outside its own try, so a rejected read escapes. By the
// time the guard runs the replacement is already stored, and an error here would make
// the client retry something that had actually worked.
{
  const env = envWith({ latency: 1 })
  const I = randomUUID()
  await post(env, 'r1', I)
  const real = env.SUBS.get
  let seen = 0
  env.SUBS.get = async k => {
    if (k === IDX && ++seen > 1) throw new Error('KV read failed')
    return real.call(env.SUBS, k)
  }
  const r = await post(env, 'r2', I)
  env.SUBS.get = real
  ok(r.status === 200, 'the registration still reports success  [' + r.status + ']')
  ok(nSubs(env) === 2, '  record stored, old one left alone  [' + nSubs(env) + ']')
}

console.log('--- a rebuild between the save and the re-read: leaks one, then self-heals ---')
// The cost of the guard: if a rebuild re-lists KV in that window the stale key is back
// in the roster, so the guard skips it. This pins that it leaks ONE and that the next
// registration clears it, rather than accumulating.
{
  const env = envWith({ latency: 1 })
  const I = randomUUID()
  await post(env, 'h1', I)
  const xKey = subKeys(env)[0]
  const realPut = env.SUBS.put
  let once = false
  env.SUBS.put = async (k, v, o) => {
    const res = await realPut.call(env.SUBS, k, v, o)
    if (k === IDX && !once) {            // as a concurrent rebuild re-listing KV would
      once = true
      const i = JSON.parse(env.SUBS._m.get(IDX))
      i.e[xKey] = [I, null]
      env.SUBS._m.set(IDX, JSON.stringify(i))
    }
    return res
  }
  await post(env, 'h2', I)
  env.SUBS.put = realPut
  ok(nSubs(env) === 2, 'the skipped delete leaves one extra record  [' + nSubs(env) + ']')
  await post(env, 'h3', I)
  ok(nSubs(env) === 1, '  and the next registration clears it  [' + nSubs(env) + ']')
  ok(endpointsIn(env).join() === 'h3', '  leaving the newest endpoint  [' + endpointsIn(env).join() + ']')
  console.log('      (bounded and self-healing — it does not accumulate)')
}

console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
