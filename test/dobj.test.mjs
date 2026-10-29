// The Durable Object that owns the write budget. Consolidates what budget.test.mjs
// used to assert against the KV counters, which no longer exist.
import { pathToFileURL } from 'node:url'
import {
  IDX, SECRET, IP, BUDGET, PER_SOURCE, PER_REG, today,
  mkNamespace, usedIn, srcIn, mkEnv, reg, unreg, idxOf, setIdx, nSubs, EP,
} from './dostub.mjs'
const mod = await import(pathToFileURL(process.env.WORKER_FILE).href)
const w = mod.default
const { WriteBudget } = mod
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }

const ns0 = (o) => mkNamespace(WriteBudget, o)
// Five minutes passing means BOTH clocks move: the index timestamp in KV and the
// cooldown the object holds. Ageing only the KV one no longer grants a rebuild,
// which is the point of the gate.
const ageKvOnly = env => setIdx(env, i => { i.t = Date.now() - 6 * 60 * 1000 })
const ageAll = (env, ms = 6 * 60 * 1000) => {
  setIdx(env, i => { i.t = Date.now() - ms })
  const b = env.BUDGET._state._store.get("b")
  if (b) env.BUDGET._state._store.set("b", { ...b, lastRebuild: Date.now() - ms })
}
const call = (ns, path, body) => ns.get().fetch('https://budget.invalid' + path, { method: 'POST', body: JSON.stringify(body) })

console.log('--- the object in isolation ---')
let ns = ns0()
let j = await (await call(ns, '/reserve', { source: 'src1', n: 3 })).json()
ok(j.ok === true && j.used === 3, 'a reservation inside the budget is granted  [used ' + j.used + ']')
ok(j.day === today(), '  and reports the UTC day it was granted on  [' + j.day + ']')
await call(ns, '/reserve', { source: 'src1', n: 3 })
ok(usedIn(ns) === 6, '  reservations accumulate  [' + usedIn(ns) + ']')
j = await (await call(ns, '/refund', { source: 'src1', n: 3, day: today() })).json()
ok(j.used === 3, 'a refund gives it back  [' + j.used + ']')
for (let i = 0; i < 5; i++) await call(ns, '/refund', { source: 'src1', n: 3, day: today() })
ok(usedIn(ns) === 0, '  floored at zero, so stray refunds cannot mint budget  [' + usedIn(ns) + ']')

ns = ns0()
let granted = 0
for (let i = 0; i < PER_SOURCE / PER_REG + 5; i++) {
  if ((await (await call(ns, '/reserve', { source: 'one', n: PER_REG })).json()).ok) granted++
}
ok(granted === PER_SOURCE / PER_REG, 'one source is held to ' + (PER_SOURCE / PER_REG) + ' reservations  [' + granted + ']')
ok((await (await call(ns, '/reserve', { source: 'one', n: PER_REG })).json()).reason === 'source', '  refused with reason "source"')
ok((await (await call(ns, '/reserve', { source: 'other', n: PER_REG })).json()).ok, '  a different source is unaffected')

ns = ns0()
let total = 0
while (total < BUDGET + 60) {
  const res = await (await call(ns, '/reserve', { source: 'src' + total, n: PER_REG })).json()
  if (!res.ok) { ok(res.reason === 'global', 'the global ceiling refuses with reason "global" at used=' + usedIn(ns)); break }
  total += PER_REG
}
ok(usedIn(ns) + PER_REG > BUDGET && usedIn(ns) <= BUDGET, '  stopping at the ceiling, never above  [' + usedIn(ns) + ' of ' + BUDGET + ']')

console.log('--- a refund must name the day it is giving back to ---')
ns = ns0()
await call(ns, '/reserve', { source: 'a', n: 30 })
j = await (await call(ns, '/refund', { source: 'a', n: 30, day: '2000-01-01' })).json()
ok(j.expired === true && usedIn(ns) === 30,
  "a refund stamped with another day is discarded, not applied  [used " + usedIn(ns) + "]")
console.log('      (a reservation taken at 23:59:59 and refunded at 00:00:01 would')
console.log('       otherwise erase reservations other callers took after midnight)')
j = await (await call(ns, '/refund', { source: 'a', n: 30, day: today() })).json()
ok(usedIn(ns) === 0, "  while today's refund applies normally  [" + usedIn(ns) + ']')

console.log('--- stored state it must not trust ---')
ns = ns0()
await call(ns, '/reserve', { source: 'a', n: 3 })
ns._state._store.set('b', { day: '2000-01-01', used: BUDGET, src: { a: PER_SOURCE } })
ok((await (await call(ns, '/reserve', { source: 'a', n: 3 })).json()).ok, "yesterday's spent budget does not block today")
ns._state._store.set('b', { day: today(), used: 1e100, src: {} })
ok((await (await call(ns, '/reserve', { source: 'a', n: 3 })).json()).ok, 'a stored used of 1e100 is discarded, not read as spent')
ns._state._store.set('b', { day: today(), used: 10, src: { a: -1e9 } })
let n2 = 0
for (let i = 0; i < PER_SOURCE; i++) if ((await (await call(ns, '/reserve', { source: 'a', n: PER_REG })).json()).ok) n2++
ok(n2 <= PER_SOURCE / PER_REG, 'a negative source counter buys nothing extra  [' + n2 + ']')
ns._state._store.set('b', { day: today(), used: BUDGET, src: {} })
ok(!(await (await call(ns, '/reserve', { source: 'a', n: 3 })).json()).ok, 'a genuinely spent budget still refuses — clamping is not amnesty')
for (const bad of [{ n: 0 }, { n: -5 }, { n: 1e6 }, {}]) {
  ok((await call(ns, '/reserve', { source: 'a', ...bad })).status === 400, 'n of ' + JSON.stringify(bad.n) + ' is rejected')
}
ok((await call(ns, '/nonsense', { source: 'a', n: 3 })).status === 404, 'an unknown path is 404')

console.log('--- a throwing callback must not reset the object ---')
ns = ns0({ failPut: true })
let res = await call(ns, '/reserve', { source: 'a', n: 3 })
ok(res.status === 503, 'a storage failure returns 503 rather than escaping the callback')
ok((await res.json()).ok === false, '  with ok:false')
console.log('      (an escaping throw terminates and resets the object, dropping every')
console.log('       other in-flight reservation — the docs are explicit about that)')

console.log('--- THE POINT: serialization is what makes it a bound ---')
ns = ns0()
ns._state._store.set('b', { day: today(), used: BUDGET - 30, src: {} })
let results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
  call(ns, '/reserve', { source: 's' + i, n: PER_REG }).then(x => x.json())))
let okCount = results.filter(x => x.ok).length
ok(okCount === 10, '50 concurrent reservations with room for 10 -> exactly 10 granted  [' + okCount + ']')
ok(usedIn(ns) === BUDGET, '  the counter lands exactly on the ceiling, never over  [' + usedIn(ns) + ']')

const racy = ns0({ serial: false })
racy._state._store.set('b', { day: today(), used: BUDGET - 30, src: {} })
results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
  call(racy, '/reserve', { source: 's' + i, n: PER_REG }).then(x => x.json())))
const racyOk = results.filter(x => x.ok).length
ok(racyOk > 10, 'the SAME class without serialization grants ' + racyOk + ', over-committing by ' + (racyOk - 10))
console.log('      (that is what a KV read-modify-write gave: every caller reads the')
console.log('       same number, every caller passes, one write survives)')

console.log('--- the worker reserving through it ---')
let env = mkEnv(WriteBudget)
await reg(w, env, 'd1')
ok(usedIn(env.BUDGET) === PER_REG, 'a registration reserves ' + PER_REG + '  [' + usedIn(env.BUDGET) + ']')
ok(idxOf(env).used === undefined, '  and the KV index carries no budget fields at all')

// The alternation: delete each record before the next, so occupancy stays at one and
// MAX_PER_IP never fires. This is the attack the budget exists for.
env = mkEnv(WriteBudget)
let accepted = 0
for (let i = 0; i < 30; i++) { if ((await reg(w, env, 'e' + i)).status === 200) accepted++; await unreg(w, env, 'e' + i) }
ok(accepted === PER_SOURCE / PER_REG, 'the alternation is cut off after ' + (PER_SOURCE / PER_REG) + ' cycles  [' + accepted + ']')
ok(usedIn(env.BUDGET) === PER_SOURCE, '  having spent exactly its allowance  [' + usedIn(env.BUDGET) + ']')
ok(nSubs(env) === 0, '  while holding zero records, so no occupancy cap was involved')

console.log('--- the cron keeps its headroom, which is the ceiling’s whole job ---')
env = mkEnv(WriteBudget)
await reg(w, env, 'g0')
env.BUDGET._state._store.set('b', { day: today(), used: BUDGET, src: {} })
ok((await reg(w, env, 'g1', '198.51.100.44')).status === 429, 'with the global budget spent, a fresh source is refused')
let b4 = { ...env.SUBS.ops }
let r = await w.fetch(new Request('https://x/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + SECRET }, body: '{"seen":{}}' }), env)
ok(r.status === 200 && env.SUBS.ops.put - b4.put === 1, 'PUT /state still succeeds and spends its write')
r = await w.fetch(new Request('https://x/subs', { headers: { Authorization: 'Bearer ' + SECRET } }), env)
ok(r.status === 200, 'GET /subs still works, so the cron can still read subscribers')
b4 = { ...env.SUBS.ops }
r = await reg(w, env, 'g2')
ok(r.status === 429 && env.SUBS.ops.put - b4.put === 0 && env.SUBS.ops.list - b4.list === 0,
  'a budget refusal performs zero writes and zero lists')

console.log('--- a reservation whose writes never happen is handed back ---')
env = mkEnv(WriteBudget, { kv: { failPutOn: IDX } })
let before = usedIn(env.BUDGET)
res = await reg(w, env, 'f1')
ok(res.status === 503, 'a failed index write returns 503')
ok(usedIn(env.BUDGET) === before, '  and refunds all ' + PER_REG + '  [' + usedIn(env.BUDGET) + ']')
ok(nSubs(env) === 0, '  with no record stored')

env = mkEnv(WriteBudget, { kv: { failRecordPut: true } })
res = await reg(w, env, 'f2')
ok(res.status === 503, 'a failed RECORD write returns 503')
ok(usedIn(env.BUDGET) === 1,
  '  and refunds only ' + (PER_REG - 1) + ': the index write already landed and cannot be taken back  [' + usedIn(env.BUDGET) + ']')
console.log('      (refunding all 3 would hand back budget for a write really spent)')

console.log('--- unreachable, or unbound, refuses rather than waving writes through ---')
env = mkEnv(WriteBudget, { ns: ns0({ broken: true }) })
ok((await reg(w, env, 'u1')).status === 503, 'an unreachable object returns 503')
ok(nSubs(env) === 0, '  and stores nothing unmetered')
env = mkEnv(WriteBudget, { noBudget: true })
ok(env.BUDGET === undefined, 'precondition: no Durable Object bound')
ok((await reg(w, env, 'u2')).status === 503, 'no binding is also a 503 — there is no unmetered fallback any more')
ok(nSubs(env) === 0, '  and nothing is stored')

console.log('--- a rebuild cannot disturb the budget ---')
env = mkEnv(WriteBudget)
for (let i = 0; i < 4; i++) await reg(w, env, 'rb' + i)
const spent = usedIn(env.BUDGET)
ageAll(env)
await reg(w, env, 'rb9')
ok(usedIn(env.BUDGET) === spent + PER_REG,
  'the five-minute index rebuild leaves the spend alone  [' + usedIn(env.BUDGET) + ']')
ok(idxOf(env).used === undefined, '  the rebuilt index still has no budget fields')

console.log('--- a real user is nowhere near any of it ---')
env = mkEnv(WriteBudget)
const codes = []
for (let i = 0; i < 6; i++) codes.push((await reg(w, env, 'real' + i, '198.51.100.' + i)).status)
ok(codes.every(c => c === 200), 'six devices on six networks all register  [' + codes.join(',') + ']')
env = mkEnv(WriteBudget)
let okc = 0
for (let i = 0; i < 10; i++) { if ((await reg(w, env, 'toggle')).status === 200) okc++; await unreg(w, env, 'toggle') }
ok(okc === 10, 'one device toggling push on and off ten times is never refused  [' + okc + ']')

console.log('--- the writes outside the budget, and the sum ---')
const REBUILD_CEILING = 86400 / (5 * 60)
const CRON_STATE = 48
const CARRYOVER = 20
ok(REBUILD_CEILING === 288, 'the five-minute floor caps unreserved rebuild saves at ' + REBUILD_CEILING + '/day')
ok(BUDGET + REBUILD_CEILING + CRON_STATE + CARRYOVER <= 1000,
  'worst case fits the quota: ' + BUDGET + ' + ' + REBUILD_CEILING + ' + ' + CRON_STATE + ' + ' + CARRYOVER +
  ' = ' + (BUDGET + REBUILD_CEILING + CRON_STATE + CARRYOVER) + ' of 1000')
ok(1000 - (BUDGET + REBUILD_CEILING + CRON_STATE + CARRYOVER) >= 100,
  '  with ' + (1000 - (BUDGET + REBUILD_CEILING + CRON_STATE + CARRYOVER)) + ' to spare for cron retries')
ok(PER_SOURCE * 8 <= BUDGET, 'one source can take at most an eighth of the global ceiling')


console.log('--- reads are a second, separate currency ---')
const rusedIn = n => (n._state._store.get('b') || {}).rused || 0
const READ_CAP = 50000, PER_SOURCE_READS = 600, R_SUB = 3, R_UNSUB = 2
ns = ns0()
await call(ns, '/reserve', { source: 'a', n: 10, kind: 'r' })
ok(rusedIn(ns) === 10 && usedIn(ns) === 0, 'reserving reads does not touch the write counter')
await call(ns, '/reserve', { source: 'a', n: 3 })
ok(usedIn(ns) === 3 && rusedIn(ns) === 10, '  and reserving writes does not touch the read counter')
j = await (await call(ns, '/refund', { source: 'a', n: 10, day: today(), kind: 'r' })).json()
ok(rusedIn(ns) === 0 && usedIn(ns) === 3, 'a read refund gives back reads only')

ns = ns0()
let rgranted = 0
for (let i = 0; i < PER_SOURCE_READS / R_UNSUB + 5; i++) {
  if ((await (await call(ns, '/reserve', { source: 'one', n: R_UNSUB, kind: 'r' })).json()).ok) rgranted++
}
ok(rgranted === PER_SOURCE_READS / R_UNSUB, 'one source is held to ' + PER_SOURCE_READS + ' reads  [' + rgranted * R_UNSUB + ']')
ok((await (await call(ns, '/reserve', { source: 'other', n: R_UNSUB, kind: 'r' })).json()).ok, '  another source is unaffected')
ok((await (await call(ns, '/reserve', { source: 'one', n: 3 })).json()).ok, '  and its WRITE budget is still intact')

ns = ns0()
ns._state._store.set('b', { day: today(), used: 0, src: {}, rused: 1e100, rsrc: {} })
ok((await (await call(ns, '/reserve', { source: 'a', n: 3, kind: 'r' })).json()).ok, 'a corrupt rused is discarded, not read as spent')
ns._state._store.set('b', { day: '2000-01-01', used: 0, src: {}, rused: READ_CAP, rsrc: {} })
ok((await (await call(ns, '/reserve', { source: 'a', n: 3, kind: 'r' })).json()).ok, "yesterday's spent reads do not block today")

console.log('--- probing an endpoint that was never stored is now metered ---')
env = mkEnv(WriteBudget)
let probes = 0
for (let i = 0; i < PER_SOURCE_READS / R_UNSUB + 20; i++) {
  if ((await unreg(w, env, 'ghost' + i)).status === 200) probes++; else break
}
ok(probes === PER_SOURCE_READS / R_UNSUB, 'unsubscribe probes stop after ' + probes + ' (' + PER_SOURCE_READS + ' reads)')
let rr = await unreg(w, env, 'ghostX')
ok(rr.status === 429 && (await rr.json()).error === 'read budget exhausted for today', '  then 429 with the read-budget error')
let bk = { ...env.SUBS.ops }
await unreg(w, env, 'ghostY')
ok(env.SUBS.ops.get - bk.get === 0, '  and a refused probe performs ZERO KV reads  [' + (env.SUBS.ops.get - bk.get) + ']')
console.log('      (before this, each probe spent a KV read: 7200/day/source against')
console.log('       100,000, so seven or eight sources could stop GET /subs)')

console.log('--- the cron is untouched by an exhausted read budget ---')
rr = await w.fetch(new Request('https://x/subs', { headers: { Authorization: 'Bearer ' + SECRET } }), env)
ok(rr.status === 200, 'GET /subs still works, so the cron can still find subscribers')
rr = await w.fetch(new Request('https://x/state', { method: 'PUT', headers: { Authorization: 'Bearer ' + SECRET }, body: '{}' }), env)
ok(rr.status === 200, 'PUT /state still works')
rr = await w.fetch(new Request('https://x/unsubscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP, Authorization: 'Bearer ' + SECRET },
  body: JSON.stringify({ endpoint: EP('ghost1') }) }), env)
ok(rr.status === 200, "the cron's own prune bypasses the read budget too")

console.log('--- the terminal state of any abuse: registration down, cron fine ---')
env = mkEnv(WriteBudget, { ns: ns0({ broken: true }) })
bk = { ...env.SUBS.ops }
ok((await reg(w, env, 'z1')).status === 503, 'with the object unreachable, /subscribe is 503')
ok((await unreg(w, env, 'z2')).status === 503, '  and anonymous /unsubscribe is 503')
ok(env.SUBS.ops.get - bk.get === 0 && env.SUBS.ops.put - bk.put === 0 && env.SUBS.ops.list - bk.list === 0,
  '  having spent NO KV reads, writes or lists at all')
rr = await w.fetch(new Request('https://x/subs', { headers: { Authorization: 'Bearer ' + SECRET } }), env)
ok(rr.status === 200, '  while GET /subs keeps working')
console.log('      (so the worst any amount of abuse can do is take registration down,')
console.log('       never notifications — the object fails closed in front of KV)')

console.log('--- the read arithmetic ---')
const CRON_READS = 48 * 51   // a list plus a get per record, at the 50 cap
ok(READ_CAP + CRON_READS <= 100000,
  'worst case fits: ' + READ_CAP + ' public + ~' + CRON_READS + ' cron = ' + (READ_CAP + CRON_READS) + ' of 100,000')
ok(100000 - READ_CAP >= 20 * CRON_READS, '  the cron has ' + Math.floor((100000 - READ_CAP) / CRON_READS) + 'x the reads it needs')
ok(Math.ceil(READ_CAP / PER_SOURCE_READS) >= 50, 'it takes ' + Math.ceil(READ_CAP / PER_SOURCE_READS) + ' distinct sources to reach the global read ceiling, against the 7 or 8 that used to drain KV')


console.log('--- the one place the flat charge undercounts: an index rebuild ---')
// A rebuild adds a list and, for any record predating metadata, a get each. The
// charge is a flat 3, so the overshoot has to be bounded by something.
const rebuildReads = async strip => {
  const e = mkEnv(WriteBudget)
  for (let i = 0; i < 19; i++) await reg(w, e, 'rc' + i, '198.51.100.' + i)
  if (strip) for (const k of [...e.SUBS._meta.keys()]) e.SUBS._meta.delete(k)
  ageAll(e)
  const b = { ...e.SUBS.ops }
  await reg(w, e, 'rcprobe', '198.51.100.250')
  return (e.SUBS.ops.get - b.get) + (e.SUBS.ops.list - b.list)
}
const withMeta = await rebuildReads(false)
const allLegacy = await rebuildReads(true)
ok(withMeta === R_SUB, 'with metadata a rebuild reads exactly the ' + R_SUB + ' it reserved  [' + withMeta + ']')
console.log('      (that is the earlier metadata work paying off: the sweep never')
console.log('       fetches a value, so the common rebuild does not undercount at all)')
ok(allLegacy > R_SUB && allLegacy <= 25,
  'all-legacy worst case reads ' + allLegacy + ', bounded by the 20-record cap')
ok(288 * allLegacy + READ_CAP + CRON_READS <= 100000,
  '  even forced 288 times a day: ' + (288 * allLegacy) + ' overshoot + ' + READ_CAP + ' + ' + CRON_READS +
  ' = ' + (288 * allLegacy + READ_CAP + CRON_READS) + ' of 100,000')


console.log('--- CODEX P1: the rebuild decision is serialized too ---')
// The five-minute floor was never a bound. Nothing serialized the DECISION, so a
// burst all read the same stale index and all spent a list — the scarcest quota.
const DAILY_LISTS = 300, R_REBUILD = 55
env = mkEnv(WriteBudget)
for (let i = 0; i < 3; i++) await reg(w, env, 'p' + i, '198.51.100.' + i)
ageAll(env)
let b0 = { ...env.SUBS.ops }
await Promise.all(Array.from({ length: 25 }, (_, i) => reg(w, env, 'burst' + i, '198.51.100.1' + i)))
ok(env.SUBS.ops.list - b0.list === 1,
  '25 concurrent requests against a stale index -> exactly 1 list  [' + (env.SUBS.ops.list - b0.list) + ']')
console.log('      (before the grant moved into the object this was 25 — and at the')
console.log('       read ceiling that is tens of thousands of lists against 1000/day)')

env = mkEnv(WriteBudget)
await reg(w, env, 'c0')
ageAll(env)
b0 = { ...env.SUBS.ops }
await reg(w, env, 'c1')
ok(env.SUBS.ops.list - b0.list === 1, 'a stale index is rebuilt once')
ageKvOnly(env)
b0 = { ...env.SUBS.ops }
await reg(w, env, 'c2')
ok(env.SUBS.ops.list - b0.list === 0,
  '  and staleness alone does NOT buy a second one inside the cooldown  [' + (env.SUBS.ops.list - b0.list) + ']')
console.log('      (the cooldown lives in the object now, so forging a stale timestamp')
console.log('       in KV no longer grants a list)')

ns = ns0()
let lists = 0
for (let i = 0; i < DAILY_LISTS + 10; i++) {
  ns._state._store.set('b', { ...ns._state._store.get('b'), lastRebuild: 0 })
  if ((await (await ns.get().fetch('https://budget.invalid/rebuild', { method: 'POST', body: '{"n":1}' })).json()).ok) lists++
}
ok(lists === DAILY_LISTS, 'the daily list allowance caps rebuilds at ' + DAILY_LISTS + '  [' + lists + ']')
ok(rusedIn(ns) === DAILY_LISTS * R_REBUILD, "  and each one charged its own reads  [" + rusedIn(ns) + ']')

console.log('--- what a request does when it is not the one rebuilding ---')
env = mkEnv(WriteBudget)
await reg(w, env, 'st0')
const rosterWas = Object.keys(idxOf(env).e).length
ageAll(env)
await reg(w, env, 'st1')          // takes the grant
b0 = { ...env.SUBS.ops }
ageKvOnly(env)
rr = await reg(w, env, 'st2')     // inside the cooldown: no grant
ok(rr.status === 200, 'a request refused the grant still registers normally')
ok(env.SUBS.ops.list - b0.list === 0, '  spending no list')
ok(Object.keys(idxOf(env).e).length === rosterWas + 2, '  and the roster still grows  [' + Object.keys(idxOf(env).e).length + ']')

env = mkEnv(WriteBudget)
env.BUDGET._state._store.set('b', { day: today(), used: 0, src: {}, rused: 0, rsrc: {}, lists: 0, lastRebuild: Date.now() })
rr = await reg(w, env, 'none')
ok(rr.status === 503, 'with NO roster and no grant, the request is told to retry')
ok(nSubs(env) === 0, '  rather than building one off the books')

console.log('--- the list arithmetic, which is the quota this protects ---')
const CRON_LISTS = 48
ok(DAILY_LISTS + CRON_LISTS <= 1000,
  'worst case: ' + DAILY_LISTS + ' public + ' + CRON_LISTS + ' cron = ' + (DAILY_LISTS + CRON_LISTS) + ' of 1000')
ok(1000 - (DAILY_LISTS + CRON_LISTS) >= 600, '  leaving ' + (1000 - DAILY_LISTS - CRON_LISTS) + ' spare')
ok(DAILY_LISTS * R_REBUILD + READ_CAP + CRON_READS <= 100000,
  'reads still fit with rebuilds charged: ' + (DAILY_LISTS * R_REBUILD) + ' + ' + READ_CAP + ' + ' + CRON_READS +
  ' = ' + (DAILY_LISTS * R_REBUILD + READ_CAP + CRON_READS) + ' of 100,000')

console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
