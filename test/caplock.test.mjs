// The reinstall-at-cap lockout. Identification of a reinstall is impossible, so what
// is addressed is the precondition: the cap was the only thing bounding the store and
// is not any more, so it can be loose enough that the condition stops occurring.
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { SECRET, IP, EP, mkKeys, mkNamespace, mkEnv, reg, unreg, nSubs, idxOf, setIdx } from './dostub.mjs'
const mod = await import(pathToFileURL(process.env.WORKER_FILE).href)
const w = mod.default
const { WriteBudget } = mod
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }

const MAX_RECORDS = 50, MAX_PER_IP = 12
const ns0 = o => mkNamespace(WriteBudget, o)
// Each registration costs 3 of the per-source WRITE budget, so filling a 50-record
// store needs the sources spread out; that is realistic anyway.
const fill = async (env, n, tag) => {
  let made = 0
  for (let i = 0; i < n; i++) if ((await reg(w, env, tag + i, '198.51.' + Math.floor(i / 4) + '.' + (i % 4))).status === 200) made++
  return made
}

console.log('--- the ceiling moved, and is still a ceiling ---')
let env = mkEnv(WriteBudget)
let made = await fill(env, MAX_RECORDS, 'f')
ok(made === MAX_RECORDS, MAX_RECORDS + ' records are accepted  [' + made + ']')
ok(nSubs(env) === MAX_RECORDS, '  and all are stored  [' + nSubs(env) + ']')
let r = await reg(w, env, 'overflow', '198.51.99.1')
ok(r.status === 429 && (await r.json()).error === 'subscription limit reached',
  '  the ' + (MAX_RECORDS + 1) + 'th is still refused — a ceiling, just a higher one')

env = mkEnv(WriteBudget)
made = await fill(env, 21, 'g')
ok(made === 21, 'a store of 21 — which the old cap of 20 refused — is now fine  [' + made + ']')
console.log('      (that is the whole of the lockout fix: a returning device is fifty')
console.log('       records from the cap rather than nineteen)')

console.log('--- raising it did NOT weaken what replaced it ---')
env = mkEnv(WriteBudget)
let n = 0
for (let i = 0; i < 20; i++) if ((await reg(w, env, 'ip' + i, IP)).status === 200) n++
ok(n === MAX_PER_IP, 'one network still holds at most ' + MAX_PER_IP + '  [' + n + ']')
ok(MAX_PER_IP / MAX_RECORDS < 0.25,
  '  which is now under a quarter of the store, where it used to be 60%  [' +
  Math.round((MAX_PER_IP / MAX_RECORDS) * 100) + '%]')
r = await reg(w, env, 'ip99', IP)
ok((await r.json()).error === 'too many subscriptions from this network',
  '  and refuses with the per-network reason, not the store-full one')

env = mkEnv(WriteBudget)
let accepted = 0
for (let i = 0; i < 30; i++) { if ((await reg(w, env, 'b' + i, IP)).status === 200) accepted++; await unreg(w, env, 'b' + i) }
ok(accepted === 20, 'the daily write budget still cuts one source off at 20 registrations  [' + accepted + ']')
console.log('      (so the store cannot be grown quickly even with the looser ceiling)')

console.log('--- the store still fits one index page, which the cap must guarantee ---')
env = mkEnv(WriteBudget)
await fill(env, MAX_RECORDS, 'p')
setIdx(env, i => { i.t = 0 })
const b = env.BUDGET._state._store.get('b')
env.BUDGET._state._store.set('b', { ...b, lastRebuild: 0 })
await reg(w, env, 'p-probe', '198.51.99.2')
ok(idxOf(env).complete !== false,
  'a full store rebuilds as ONE complete page  [complete=' + idxOf(env).complete + ']')
ok(MAX_RECORDS < 100, '  because the cap stays under buildIndex’s list limit of 100')
const bytes = JSON.stringify(await (await w.fetch(new Request('https://x/subs', { headers: { Authorization: 'Bearer ' + SECRET } }), env)).json()).length
ok(bytes < 60000, 'GET /subs for a full store is ' + bytes + ' bytes — the cron loads it in one array')

console.log('--- what is NOT claimed: a reinstall is still unidentifiable ---')
env = mkEnv(WriteBudget)
const first = randomUUID()
await reg(w, env, 'phone', IP)
const before = nSubs(env)
// A reinstall clears localStorage, so the same phone returns with a NEW installId and
// a NEW endpoint. Nothing ties it to the record it left behind.
r = await w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
  body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/phone-reinstalled',
    keys: (await import('./dostub.mjs')).mkKeys() }, teamId: 7, device: 'ios', installId: randomUUID() }) }), env)
ok(r.status === 200 && (await r.json()).replaced === 0,
  'a reinstalled phone retires nothing — it cannot prove it owned the old record')
ok(nSubs(env) === before + 1, '  so the corpse stays, and the store grows by one  [' + nSubs(env) + ']')
console.log('      (unchanged on purpose: every signal that WOULD match it is public,')
console.log('       forgeable, or shared with a real second device — which is exactly')
console.log('       how the old teamId sweep let anyone delete anyone)')


console.log('--- CODEX 2: a record moving between sources is counted on arrival ---')
// Create records from many networks, then update each from ONE network. The update
// reassigns ipHash to the caller, so without a check on transfer that one network
// ends up owning them all without ever being counted.
env = mkEnv(WriteBudget)
const eps = []
const OVER = MAX_PER_IP + 3
for (let i = 0; i < OVER; i++) { eps.push('mv' + i); await reg(w, env, 'mv' + i, '198.51.7.' + i) }
ok(nSubs(env) === OVER, OVER + ' records created across ' + OVER + ' networks  [' + nSubs(env) + ']')
let moved = 0
for (const e of eps) if ((await reg(w, env, e, IP)).status === 200) moved++
ok(moved === MAX_PER_IP, 'only ' + MAX_PER_IP + ' of ' + OVER + ' can move into one network  [' + moved + ']')
r = await reg(w, env, eps[eps.length - 1], IP)
ok((await r.json()).error === 'too many subscriptions from this network',
  '  with the per-network reason — a transfer in counts like an addition')
console.log('      (the check used to run only for NEW records, so this moved the whole')
console.log('       set into one allocation without it ever being counted)')
// and an update that does NOT change source is still free
env = mkEnv(WriteBudget)
await reg(w, env, 'same', IP)
ok((await reg(w, env, 'same', IP)).status === 200, 'an update from the SAME network is unaffected')

console.log('--- CODEX 3: the replacement is durable before the old one is removed ---')
// A reinstall that kept its installId replaces its own record. If the new write
// fails, the old one must survive — otherwise alerts stop during a routine swap.
const inst = randomUUID()
env = mkEnv(WriteBudget)
await w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
  body: JSON.stringify({ subscription: { endpoint: EP('old'), keys: mkKeys() }, teamId: 7, installId: inst }) }), env)
ok(nSubs(env) === 1, 'a device is registered')
// now make the record write fail on the NEW endpoint only
const realPut = env.SUBS.put
env.SUBS.put = async (k, v, o) => {
  if (k.startsWith('sub:') && !env.SUBS._m.has(k)) throw new Error('KV PUT failed')
  return realPut.call(env.SUBS, k, v, o)
}
r = await w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
  body: JSON.stringify({ subscription: { endpoint: EP('new'), keys: mkKeys() }, teamId: 7, installId: inst }) }), env)
ok(r.status === 503, 'a failed replacement write returns 503')
ok(nSubs(env) === 1, '  and the ORIGINAL registration survives  [' + nSubs(env) + ' record(s)]')
console.log('      (deleting first left the device with neither, silently ending alerts')
console.log('       during what was an ordinary endpoint replacement)')
env.SUBS.put = realPut
// The failed attempt had already saved an index with the old key dropped, so the
// roster now UNDER-counts: the record exists in KV and the index cannot see it.
// That is the cost of writing the index first, and the rebuild is what repays it.
ok(!(Object.keys(idxOf(env).e).some(k => idxOf(env).e[k])) || Object.keys(idxOf(env).e).length === 1,
  'after the failure the roster lists 1 while KV holds 1 surviving record')
setIdx(env, i => { i.t = 0 })
const bb = env.BUDGET._state._store.get('b')
env.BUDGET._state._store.set('b', { ...bb, lastRebuild: 0 })
r = await w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
  body: JSON.stringify({ subscription: { endpoint: EP('new'), keys: mkKeys() }, teamId: 7, installId: inst }) }), env)
ok((await r.json()).replaced === 1 && nSubs(env) === 1,
  'once the rebuild re-lists KV, the retry retires the old record  [' + nSubs(env) + ' record(s)]')
console.log('      (so a failed replacement costs a short under-count, not a lost')
console.log('       registration — the old trade was the other way round)')

console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
