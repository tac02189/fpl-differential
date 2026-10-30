// The Durable Object that owns the write budget. Consolidates what budget.test.mjs
// used to assert against the KV counters, which no longer exist.
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  IDX, SECRET, IP, BUDGET, PER_SOURCE, PER_REG, today,
  mkNamespace, usedIn, srcIn, mkEnv, reg, unreg, idxOf, setIdx, nSubs, EP, mkKeys,
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
const READ_CAP = 50000, PER_SOURCE_READS = 600, R_UNSUB = 2
// Reserved up front, vs what a request actually spends. They diverged when the
// stale-delete guard added a roster re-read that only a SWEEPING request makes:
// a registration with nothing to retire still reads 3. One name for both is what
// broke this assertion when the reservation moved, so they are now two.
// MAX_SWEEP moved them apart again: the sweep now confirms ownership from each
// candidate RECORD rather than from one roster read, so the reservation covers the
// worst case (3 + MAX_SWEEP) while a one-candidate sweep still spends 3.
const MAX_SWEEP = 4
const R_SUB_RESERVED = 3 + MAX_SWEEP, R_SUB_ONE = 3, R_SUB_ONE_REBUILD = 4
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


console.log('--- a sweeping registration must not read more than it reserved ---')
// The reservation went 3 -> 4 for the stale-delete guard's roster re-read. Nothing
// measured that, so nothing confirmed 4 is actually the worst case — which is how a
// constant sized against another constant goes quietly wrong.
{
  // (a) sweeping, no rebuild: the existing-record get, the roster read, and the
  // guard's re-read. Three — the guard re-read stands in for the list it did not need.
  const eA = mkEnv(WriteBudget)
  const instA = randomUUID()
  await w.fetch(new Request('https://x/subscribe', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
    body: JSON.stringify({ subscription: { endpoint: EP('sw1'), keys: mkKeys() },
      teamId: 7, installId: instA } ) }), eA)
  let before = { ...eA.SUBS.ops }
  const rA = await w.fetch(new Request('https://x/subscribe', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
    body: JSON.stringify({ subscription: { endpoint: EP('sw2'), keys: mkKeys() },
      teamId: 7, installId: instA } ) }), eA)
  const sweepOnly = (eA.SUBS.ops.get - before.get) + (eA.SUBS.ops.list - before.list)
  ok((await rA.json()).replaced === 1, 'a sweeping registration retires one')
  ok(sweepOnly === R_SUB_ONE, '  and reads ' + R_SUB_ONE + '  [' + sweepOnly + ']')

  // (b) sweeping AND rebuilding in one request.
  const eB = mkEnv(WriteBudget)
  const instB = randomUUID()
  await w.fetch(new Request('https://x/subscribe', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
    body: JSON.stringify({ subscription: { endpoint: EP('wc1'), keys: mkKeys() },
      teamId: 7, installId: instB } ) }), eB)
  ageAll(eB)
  before = { ...eB.SUBS.ops }
  const rB = await w.fetch(new Request('https://x/subscribe', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
    body: JSON.stringify({ subscription: { endpoint: EP('wc2'), keys: mkKeys() },
      teamId: 7, installId: instB } ) }), eB)
  const oneRebuild = (eB.SUBS.ops.get - before.get) + (eB.SUBS.ops.list - before.list)
  ok((await rB.json()).replaced === 1, 'a registration that sweeps AND rebuilds retires one')
  ok(oneRebuild === R_SUB_ONE_REBUILD, '  and reads ' + R_SUB_ONE_REBUILD +
    '  [' + oneRebuild + ']')
  ok(oneRebuild > sweepOnly, '  i.e. the rebuild costs a read the plain sweep does not')

  // (c) the worst case, which is what the reservation is sized against: a rebuild AND
  // a full sweep. Nothing measured this when the reservation was 4 for a single roster
  // re-read, so nothing confirmed the number covered anything — which is how a constant
  // sized against another constant goes quietly wrong. MAX_SWEEP + 1 records are planted
  // so the cap itself is exercised: the extra one must NOT be read.
  const eC = mkEnv(WriteBudget)
  const instC = randomUUID()
  for (let i = 0; i <= MAX_SWEEP; i++) {
    await w.fetch(new Request('https://x/subscribe', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
      body: JSON.stringify({ subscription: { endpoint: EP('mx' + i), keys: mkKeys() },
        teamId: 7, installId: randomUUID() } ) }), eC)
  }
  // Reassign every one of them to a single install, as a drifted store would hold them.
  for (const k of [...eC.SUBS._m.keys()].filter(k => k.startsWith('sub:'))) {
    const v = JSON.parse(eC.SUBS._m.get(k))
    v.installId = instC
    eC.SUBS._m.set(k, JSON.stringify(v))
    eC.SUBS._meta.set(k, { installId: instC, ipHash: (eC.SUBS._meta.get(k) || {}).ipHash ?? null })
  }
  ageAll(eC)
  before = { ...eC.SUBS.ops }
  const rC = await w.fetch(new Request('https://x/subscribe', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
    body: JSON.stringify({ subscription: { endpoint: EP('mxnew'), keys: mkKeys() },
      teamId: 7, installId: instC } ) }), eC)
  const worst = (eC.SUBS.ops.get - before.get) + (eC.SUBS.ops.list - before.list)
  ok((await rC.json()).replaced === MAX_SWEEP,
    'a full sweep retires MAX_SWEEP and no more  [' + MAX_SWEEP + ' expected]')
  ok(worst === R_SUB_RESERVED, '  reading exactly the ' + R_SUB_RESERVED +
    ' it reserved  [' + worst + ']')
  ok(nSubs(eC) === 2, '  leaving the new record and the one over the cap  [' + nSubs(eC) + ']')
}

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
ok(withMeta === R_SUB_ONE,
  'with metadata, a rebuild on a NON-sweeping registration reads ' + R_SUB_ONE +
  ' of the ' + R_SUB_RESERVED + ' reserved  [' + withMeta + ']')
console.log('      (that is the earlier metadata work paying off: the sweep never')
console.log('       fetches a value, so the common rebuild does not undercount at all)')
ok(allLegacy > R_SUB_RESERVED && allLegacy <= 25,
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

console.log('--- exclusive key claims: what a stale delete cannot be made safe without ---')
// A KV delete is issued by name and KV has no compare-and-delete, so /subscribe cannot
// make the delete conditional on the record still being the one it decided to retire.
// It claims the name instead, and holds it across its own writes and deletes. These are
// the object-level properties the handler leans on; test/stale.test.mjs drives the
// schedules that need them.
// The token is the CALLER's. The object used to mint it from a counter, which review
// killed twice over: a counter restarts at zero when the object loses its memory, so a
// token from before that matches a grant from after it and frees somebody else's claim;
// and a caller whose /claim response is lost holds claims it cannot name.
const tok = () => randomUUID()
{
  const cl = ns0()
  const T1 = tok(), T2 = tok()
  const first = await (await call(cl, '/claim', { names: ['sub:a', 'sub:b'], id: T1 })).json()
  ok(first.ok === true && first.names.join() === 'sub:a,sub:b',
    'two free names are granted  [' + (first.names.join() || 'nothing') + ']')
  ok(first.until > Date.now() + 10000, '  with a lease of at least ten seconds  [' +
    (first.until - Date.now()) + 'ms]')

  const second = await (await call(cl, '/claim', { names: ['sub:b', 'sub:c'], id: T2 })).json()
  ok(second.names.join() === 'sub:c',
    'a second caller gets what is free and not what is held  [' +
    (second.names.join() || 'nothing') + ']')

  const wrong = await (await call(cl, '/release', { names: ['sub:a'], id: T2 })).json()
  ok(wrong.freed === 0, 'releasing a name under the WRONG token frees nothing  [freed=' +
    wrong.freed + ']')
  ok((await (await call(cl, '/claim', { names: ['sub:a'], id: tok() })).json()).names.length === 0,
    '  so it is still held')

  const freed = await (await call(cl, '/release', { names: ['sub:a', 'sub:b'], id: T1 })).json()
  ok(freed.freed === 2, 'releasing under the right token frees both  [freed=' + freed.freed + ']')
  ok((await (await call(cl, '/claim', { names: ['sub:a', 'sub:b'], id: tok() })).json()).names.length === 2,
    '  and they can be claimed again')

  // The reason the token cannot be the object's own counter. A fresh instance is the
  // object having lost its memory; its first grant would be id 1 again, and a release
  // left over from before would match it.
  const reborn = ns0()
  const T3 = tok()
  ok((await (await call(reborn, '/claim', { names: ['sub:a'], id: T3 })).json()).names.join() === 'sub:a',
    'after the object loses its memory the name is free, which is the expiry by another route')
  ok((await (await call(reborn, '/release', { names: ['sub:a'], id: T1 })).json()).freed === 0,
    '  and a token from BEFORE that cannot free the new holder’s claim  [freed=0 expected]')
}
{
  // The expiry exists for a request that dies between claiming and releasing — without
  // it that endpoint would be locked out until the object was evicted. Driven off the
  // `until` the grant reports rather than a second copy of the constant, so the boundary
  // is pinned and cannot drift from the value the object is actually using.
  const cl = ns0()
  const T = tok()
  const g = await (await call(cl, '/claim', { names: ['sub:x'], id: T })).json()
  const realNow = Date.now
  try {
    Date.now = () => g.until - 1
    ok((await (await call(cl, '/claim', { names: ['sub:x'], id: tok() })).json()).names.length === 0,
      'one millisecond before the lease expires the name is still held')
    Date.now = () => g.until + 1
    const after = await (await call(cl, '/claim', { names: ['sub:x'], id: tok() })).json()
    ok(after.names.join() === 'sub:x', '  one millisecond after it, the name is free  [' +
      (after.names.join() || 'nothing') + ']')
    ok((await (await call(cl, '/release', { names: ['sub:x'], id: T })).json()).freed === 0,
      '  and the lapsed holder cannot free what was reissued  [freed=0 expected]')
  } finally { Date.now = realNow }
}
{
  // Both ceilings, discovered rather than restated. Being full has to REFUSE, because
  // the alternative is a delete with no exclusion behind it.
  const cl = ns0()
  const wide = await (await call(cl, '/claim',
    { names: Array.from({ length: 200 }, (_, k) => 'sub:w' + k), id: tok() })).json()
  ok(wide.names.length === 128, 'one call claims at most 128 names  [' + wide.names.length + ']')

  const cl2 = ns0()
  let held = 0
  for (let i = 0; i < 8; i++) {
    const names = Array.from({ length: 128 }, (_, k) => 'sub:' + i + '-' + k)
    const g = await (await call(cl2, '/claim', { names, id: tok() })).json()
    held += g.names.length
    if (g.names.length < names.length) break
  }
  ok(held === 512, 'and the object holds at most 512 at once  [' + held + ']')
  ok((await (await call(cl2, '/claim', { names: ['sub:one-more'], id: tok() })).json()).names.length === 0,
    '  a full map grants nothing rather than over-filling')
}
{
  const cl = ns0()
  for (const [what, body] of [
    ['no names', { names: [], id: tok() }],
    ['names that are not an array', { names: 'sub:a', id: tok() }],
    ['no token', { names: ['sub:a'] }],
    ['a token that is not a string', { names: ['sub:a'], id: 7 }],
    ['nothing at all', null],
  ]) ok((await call(cl, '/claim', body)).status === 400, '/claim with ' + what + ' is rejected')
  const T = tok()
  await call(cl, '/claim', { names: ['sub:z'], id: T })
  ok((await call(cl, '/release', { names: ['sub:z'] })).status === 400,
    '/release with no token is rejected rather than read as a wildcard')
  ok((await (await call(cl, '/claim', { names: ['sub:z'], id: tok() })).json()).names.length === 0,
    '  so the claim survives it')
  // The reservation paths require an `n` and 400 without one. Claims are named rather
  // than counted, so they have to route AHEAD of that check or every one would be
  // rejected over a field it has no use for.
  ok((await call(cl, '/claim', { names: ['sub:q'], id: tok() })).status === 200,
    'a claim needs no `n`, which every reservation does')
}

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
