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
//
// EVERY schedule here is driven by operation barriers, never by sleeping and hoping.
// A barrier names the exact KV operation a request must stop at; the test then drives
// the other request to completion and releases the first. The schedule is therefore
// identical on this machine, on a loaded CI runner, and in a year.
//
// It replaces a sweep of 7 staggers x 2 stall lengths that reproduced the loss in 12
// of 14 — a SAMPLE of the schedule space, chosen by the Node timer queue — and it
// exposed something that sweep could not: one point where the loss still happens,
// now pinned below instead of waiting to be rediscovered.
//
// WHAT THIS IS NOT: exhaustive. A driver that stops one request at a boundary and runs
// the other to completion generates only `prefix -> all of the other -> suffix`. It
// cannot produce arbitrary alternation — A,B,A,B through both sequences at once is a
// legal ordering that appears nowhere here. Nor is a solo trace a full inventory of
// suspension points: B acquires a roster re-read and a delete under concurrency that
// it never issues alone. The claim this file supports is the narrow one — every
// pre-operation boundary in a request's solo trace, with the other request run to
// completion at each — and that is enough to be a useful regression test without
// pretending to be a model checker.
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { IP, EP, mkKeys, mkKV, mkNamespace, nSubs, idxOf, SECRET, IDX } from './dostub.mjs'

const mod = await import(pathToFileURL(process.env.WORKER_FILE).href)
const w = mod.default
const { WriteBudget } = mod
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }

// The tally has to be printed even when a block below throws. The runner decides pass
// or fail from the exit code, but it reads the COUNTS from this line, so without it
// every check that already passed is discarded as "crashed without a tally" — which is
// exactly what happened mid-rewrite, when a helper was used above its own declaration
// and sixty passing checks vanished with it. Registered here rather than at the foot of
// the file, because a handler installed on the last line never runs after a crash on an
// earlier one.
let summarised = false
process.on('exit', () => {
  if (summarised) return
  summarised = true
  console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
})
// Without this the crash tally reads "43 passed, 0 failed", which is true and reads as
// success; only the exit code says otherwise. Printing the error ourselves is the price
// of handling it — Node suppresses its own report once a handler exists.
process.on('uncaughtException', err => {
  console.error(err)
  ok(false, 'the suite threw and stopped early: ' + err.message)
  process.exit(1)
})

// The worker keys a record by SHA-256 of its endpoint, so a test can name a key before
// the record exists. That is what lets a barrier read 'A delete sub:X' rather than a
// hash prefix nobody can match to an endpoint.
const keyOf = n => 'sub:' + createHash('sha256').update(EP(n)).digest('hex')

// Which request issued an operation. Both run against one KV binding and their roster
// reads are indistinguishable by key, so attribution has to come from the asynchronous
// execution context — not the call stack, which is empty of the caller by the time an
// awaited continuation runs. A `.then` registered under a request's context keeps that
// context; releasing a gate from elsewhere does not re-attribute the continuation it
// resumes.
const als = new AsyncLocalStorage()

// A barrier cannot fire if the operation it names stops happening. Without a limit the
// run would hang until the suite runner SIGKILLs it at 60s with nothing to say; with
// one, the failure names the point that was never reached.
//
// The timer has to be both REFERENCED and cleared. Unreferenced it never fires at all:
// Node finds nothing left to run, exits 13 for an unsettled top-level await, and the
// suite dies mid-sentence with no tally and no failing check — which is exactly what
// the first version of this file did when the guard was removed to test it. Left
// running it holds the process open and eventually rejects into nobody's hands.
//
// It only ever fires on a true deadlock: every wait below also races the request's own
// completion, so a barrier that cannot be reached resolves at once rather than waiting.
// Generous anyway, because it is the one wall-clock number in the file and a loaded
// runner must not turn it into a false failure.
const DEADLOCK_MS = 10000
const settle = async (what, ...racers) => {
  let t
  const limit = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('barrier never reached: ' + what)), DEADLOCK_MS)
  })
  try { return await Promise.race([...racers, limit]) } finally { clearTimeout(t) }
}

// A KV binding that can stop a named request at a named operation, and can make one
// specific operation fail. Both are keyed on the same tag vocabulary — `who op key`,
// with `#n` for a repeat — which is also what the operation log prints.
const mkChoreo = (names = []) => {
  const inner = mkKV({})
  const label = new Map(names.map(n => [keyOf(n), 'sub:' + n]))
  const log = []
  const counts = new Map()
  const faults = new Map()
  let held = null

  const tagFor = (op, key) => {
    const who = als.getStore() ?? '-'
    const name = key == null ? '' : key === IDX ? ' idx' : ' ' + (label.get(key) || key.slice(0, 10))
    const base = who + ' ' + op + name
    const n = (counts.get(base) || 0) + 1
    counts.set(base, n)
    return n > 1 ? base + ' #' + n : base
  }

  // Runs BEFORE the operation, so a hold pauses the request before it acts and a fault
  // replaces the act outright — no counting reads and swapping the binding mid-flight,
  // which targets the wrong operation the moment the sequence changes.
  const run = async (op, key, real) => {
    const tag = tagFor(op, key)
    log.push(tag)
    if (held && held.tags.has(tag)) { const h = held; held = null; h.hit(tag); await h.gate }
    return faults.has(tag) ? faults.get(tag)() : real()
  }

  const SUBS = {
    ops: inner.ops, _m: inner._m, _meta: inner._meta,
    get: k => run('get', k, () => inner.get(k)),
    put: (k, v, o) => run('put', k, () => inner.put(k, v, o)),
    delete: k => run('delete', k, () => inner.delete(k)),
    list: o => run('list', null, () => inner.list(o)),
  }

  return {
    log,
    env: { SUBS, SUBS_SECRET: SECRET,
      SUBSCRIBE_LIMIT: { limit: async () => ({ success: true }) },
      BUDGET: mkNamespace(WriteBudget) },
    nameOf: k => (label.get(k) || k.slice(0, 10)).replace(/^sub:/, ''),
    as: (who, fn) => als.run(who, fn),
    fault: (tag, fn) => faults.set(tag, fn),
    // Several tags means "whichever this request reaches first". That is what keeps the
    // suite honest about a guard that has been removed: the guard's roster re-read is
    // then simply absent, and the barrier catches the delete instead of hanging.
    hold (tags) {
      let hit, release
      const reached = new Promise(r => { hit = r })
      const gate = new Promise(r => { release = r })
      const list = [].concat(tags)
      // The identity check is load-bearing for any schedule that stops a request twice:
      // the second barrier has to be armed BEFORE the first is released, so a release
      // that cleared `held` unconditionally would throw the new one away and the request
      // would sail straight past it. Found by the B-side test further down, which is the
      // only one here that re-arms.
      const mine = { tags: new Set(list), hit, gate }
      held = mine
      return { reached, what: list.join(' | '),
        release: () => { if (held === mine) held = null; release() } }
    },
  }
}

const post = (ch, name, installId) => w.fetch(new Request('https://x/subscribe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
  body: JSON.stringify({ subscription: { endpoint: EP(name), keys: mkKeys() },
    teamId: 7, device: 'ios', installId }),
}), ch.env)

// For the registrations a test needs to have WORKED — seeding, planting, the clearing
// registration at the end of a block. A silent 429 or 503 there (budget exhausted, rate
// limited, a Durable Object stub that stopped answering) leaves every assertion after it
// measuring a store that was never set up, and it reads as a behaviour change rather
// than as a broken fixture. The throw becomes one named failing check via the handler at
// the top of the file.
const must = async (ch, name, installId) => {
  const r = await post(ch, name, installId)
  if (r.status !== 200) throw new Error('setup: ' + name + ' returned ' + r.status)
  return r
}

const subKeys = ch => [...ch.env.SUBS._m.keys()].filter(k => k.startsWith('sub:'))
// Which endpoint a stored record belongs to, so a test can assert WHICH one survived
// rather than merely counting.
const endpointsIn = ch => subKeys(ch)
  .map(k => { try { return JSON.parse(ch.env.SUBS._m.get(k)).subscription.endpoint } catch { return null } })
  .map(e => (e || '').split('/').pop())
  .sort()

// Reassign every stored record to one installId, in the record, its metadata and the
// roster — exactly as a store that drifted would hold them. Serial re-registration
// never accumulates more than one, so a multi-candidate sweep has to be planted.
const plantUnder = (ch, installId) => {
  const planted = subKeys(ch)
  for (const k of planted) {
    const v = JSON.parse(ch.env.SUBS._m.get(k))
    v.installId = installId
    ch.env.SUBS._m.set(k, JSON.stringify(v))
    ch.env.SUBS._meta.set(k, { installId, ipHash: (ch.env.SUBS._meta.get(k) || {}).ipHash ?? null })
  }
  const idx = idxOf(ch.env)
  for (const k of planted) idx.e[k] = [installId, idx.e[k] ? idx.e[k][1] : null]
  ch.env.SUBS._m.set(IDX, JSON.stringify(idx))
  return planted
}
// Put a key back into the roster, as a concurrent registration or a rebuild would.
const restore = (ch, ...keys) => {
  const i = JSON.parse(ch.env.SUBS._m.get(IDX))
  for (const k of keys) i.e[k] = [JSON.parse(ch.env.SUBS._m.get(k) || '{}').installId ?? null, null]
  ch.env.SUBS._m.set(IDX, JSON.stringify(i))
}

// What the roster CLAIMS is stored, which is not the same question as what is stored.
// Several schedules below end with a surviving record the roster does not list; the
// store under-counts until a rebuild, and counting records alone would hide that.
const rosterIn = ch => {
  try { return Object.keys(JSON.parse(ch.env.SUBS._m.get(IDX)).e).map(ch.nameOf).sort().join(',') }
  catch { return '?' }
}

// One schedule. Seed endpoint X for install I, start `first`, stop it dead at `point`,
// drive `second` to completion, then release. `stoppedAt` is null when `first` ran to
// the end without reaching the point — a fact worth recording rather than a hang.
const A = { who: 'A', ep: 'Y' }   // moves the install to a new endpoint
const B = { who: 'B', ep: 'X' }   // re-registers the endpoint it already has
const drive = async (point, first, second) => {
  const ch = mkChoreo(['X', 'Y'])
  const I = randomUUID()
  const seed = await post(ch, 'X', I)
  if (seed.status !== 200) throw new Error('seed failed: ' + seed.status)
  // The seed and B both register endpoint X, so they share a key and an endpoint and
  // differ only in their generated push keys. Without this, "a record at X survived"
  // cannot tell B's write apart from the seed record B was supposed to replace.
  const p256 = k => { try { return JSON.parse(ch.env.SUBS._m.get(k)).subscription.keys.p256dh } catch { return null } }
  const seedP256 = p256(keyOf('X'))
  const h = ch.hold(point)
  const p1 = ch.as(first.who, () => post(ch, first.ep, I))
  p1.catch(() => {})   // a failed schedule can abandon this run; don't surface it as unhandled
  let stoppedAt, r2
  try {
    // Null means `first` ran to the end without reaching the point — a fact to record,
    // not a hang, and the difference between "this schedule is impossible" and "this
    // barrier no longer names anything".
    stoppedAt = await settle(h.what, h.reached, p1.then(() => null, () => null))
    r2 = await ch.as(second.who, () => post(ch, second.ep, I))
  } finally {
    // Unconditional: if the second request threw, the first is still suspended on the
    // gate, and leaving it there turns one failed check into a hung suite.
    h.release()
  }
  const r1 = await p1
  return { ch, stoppedAt, records: nSubs(ch.env), endpoints: endpointsIn(ch).join(','),
    roster: rosterIn(ch),
    // null when nothing is stored at X; true means the ORIGINAL seed record is what
    // survived, which for a schedule where B wrote X means B's write was lost.
    xIsSeed: p256(keyOf('X')) === null ? null : p256(keyOf('X')) === seedP256,
    status: [r1.status, r2.status].join('/'),
    replaced: [(await r1.clone().json()).replaced, (await r2.clone().json()).replaced] }
}

console.log('--- the operations a registration issues, which every barrier below names ---')
// Discovered, not assumed, so that /subscribe gaining or losing a KV operation fails
// HERE by name rather than leaving a barrier below permanently unreachable.
//
// Each side is discovered ALONE. Reading the sequence off an unbarriered pair instead
// is the obvious shortcut and it is wrong: that interleaving is decided by the
// microtask queue, and it moved — B issued six operations under one harness and four
// under another that differed only in bookkeeping. Deriving the barrier names from a
// race is the same bug this file exists to remove, one level up.
const SEQ_A = ['A get sub:Y', 'A get idx', 'A put idx', 'A put sub:Y', 'A get idx #2', 'A delete sub:X']
const SEQ_B = ['B get sub:X', 'B get idx', 'B put idx', 'B put sub:X']
const solo = async (who, ep) => {
  const ch = mkChoreo(['X', 'Y'])
  const I = randomUUID()
  await must(ch, 'X', I)
  await ch.as(who, () => post(ch, ep, I))
  return ch.log.filter(t => t.startsWith(who + ' '))
}
{
  const seqA = await solo('A', 'Y')
  const seqB = await solo('B', 'X')
  ok(seqA.join(' | ') === SEQ_A.join(' | '), 'A, replacing its endpoint: ' + seqA.join(', '))
  ok(seqB.join(' | ') === SEQ_B.join(' | '), 'B, re-registering its own:  ' + seqB.join(', '))
  console.log('      (A sweeps, so it has the guard’s roster re-read and a delete. B on its')
  console.log('       own does not: the roster it reads already holds its own key, so it has')
  console.log('       nothing to retire. B only acquires a sweep when A rewrites the roster')
  console.log('       first, which the B-held schedules further down do produce.)')
}

console.log('--- stopping A at each of its operations in turn: the whole schedule space ---')
// Not a sample. Every point at which A can be suspended relative to a complete B,
// each with a stated outcome — so a change that moves one of these has to say so.
// `roster` is what meta:subindex claims, which is a separate question from what is
// stored, and in three of these six they disagree. Counting records alone would hide
// that, so both are pinned: the roster is what the occupancy caps are computed from,
// and a rebuild is the only thing that reconciles it.
const EXPECT_A = {
  'A get sub:Y':    { records: 1, endpoints: 'Y', roster: 'Y',
    why: 'B finishes before A reads anything; A then moves the install to Y' },
  'A get idx':      { records: 1, endpoints: 'Y', roster: 'Y',
    why: 'same, one read later — A still computes its sweep from a roster B has finished with' },
  'A put idx':      { records: 1, endpoints: 'Y', roster: 'Y',
    why: 'B read the roster before A rewrote it, so B swept nothing: the case that never was a race' },
  'A put sub:Y':    { records: 2, endpoints: 'X,Y', roster: 'X',
    why: 'A finds X back in the roster and skips. The duplicate the guard trades for — and Y is stored UNLISTED, so the store under-counts until a rebuild' },
  'A get idx #2':   { records: 1, endpoints: 'X', roster: 'X',
    why: 'THE CASE THE GUARD EXISTS FOR: without it A deletes the X that B just wrote' },
  'A delete sub:X': { records: 0, endpoints: '', roster: 'X',
    why: 'KNOWN LIMIT: the guard passed, then the delete outlived B. The roster still lists X, over-counting a store that is empty. See below' },
}
// One line per schedule: what it did, and — only when it diverged — what was expected.
// A barrier that was never reached is its own kind of divergence and has to say so,
// or a schedule that quietly degenerated into "one request, then the other" reads as
// a pass whenever that happens to produce the same store.
const report = (point, r, e, width) => {
  const wrong = []
  if (r.stoppedAt !== point) {
    wrong.push('NEVER STOPPED THERE' + (r.stoppedAt ? ' (stopped at ' + r.stoppedAt + ')' : ' (ran to the end)'))
  }
  if (r.records !== e.records || r.endpoints !== e.endpoints) {
    wrong.push('EXPECTED ' + e.records + ' [' + (e.endpoints || '-') + ']')
  }
  if (r.roster !== e.roster) wrong.push('EXPECTED roster [' + (e.roster || '-') + ']')
  ok(!wrong.length, point.padEnd(width) + ' -> ' + r.records + ' record(s) [' +
    (r.endpoints || '-') + '], roster [' + (r.roster || '-') + ']  ' +
    (wrong.length ? wrong.join('; ') + '  ' : '') + '— ' + e.why)
}

// A schedule that throws has to become a failing check, not an exception that kills the
// process: the runner reads the tally this file prints, and a stack trace instead of
// "N passed, M failed" loses every result before it as well as the cause.
const attempt = async (point, fn) => {
  try { return await fn() } catch (err) { ok(false, point + ' threw: ' + err.message); return null }
}

const lostAt = []
for (const point of SEQ_A) {
  const e = EXPECT_A[point]
  if (!e) { ok(false, 'no stated outcome for barrier ' + point); continue }
  const r = await attempt(point, () => drive(point, A, B))
  if (!r) continue
  if (r.records === 0) lostAt.push(point)
  report(point, r, e, 15)
  ok(r.status === '200/200', '  both calls returned 200  [' + r.status + ']')
}
ok(lostAt.join() === 'A delete sub:X',
  'exactly one of the ' + SEQ_A.length + ' loses every record, and it is the stalled delete  [' +
  (lostAt.join() || 'none') + ']')

console.log('--- the one the guard closes, stated on its own ---')
// Named separately because it is the suite's non-vacuity anchor, and because it has to
// keep working when the guard does not exist. Stopping at EITHER the guard's roster
// re-read or the delete means the barrier fires in both worlds: with the guard A stops
// at the re-read and skips; without it there is no re-read, A stops at the delete, and
// releasing it destroys the registration B just made.
{
  const r = await drive(['A get idx #2', 'A delete sub:X'], A, B)
  ok(r.stoppedAt === 'A get idx #2',
    'A stops at its roster re-read, which only exists because of the guard  [' + r.stoppedAt + ']')
  ok(r.records >= 1, '  the device still has a registration after both calls  [' +
    r.records + ' record(s)]')
  ok(r.endpoints === 'X', '  and it is the one B wrote, not a ghost  [' + (r.endpoints || '-') + ']')
  ok(r.xIsSeed === false, '  carrying B’s push keys, so it is B’s write and not the seed record' +
    ' it replaced  [' + (r.xIsSeed === null ? 'nothing stored' : r.xIsSeed ? 'seed record' : 'B’s') + ']')
  ok(r.replaced[0] === 0, '  A reports retiring nothing, because it retired nothing  [replaced=' +
    r.replaced[0] + ']')
  console.log('      (without the guard A stops at the delete instead and this reads 0 records:')
  console.log('       both calls return 200 and every future alert goes nowhere)')
}

console.log('--- and the one it does NOT close, so nobody has to rediscover it ---')
// A characterization test, deliberately: it PASSES while the defect exists and goes
// red when someone fixes it. That is the intent — a fix should land with this block
// rewritten rather than discovered later — but it does mean three checks here and in
// the table above encode data loss as the expected outcome, so read this before
// assuming a red one is a regression.
//
// (An earlier version of this comment had it exactly backwards, saying a green run
// would be the good news. It is a red one.)
{
  const r = await drive('A delete sub:X', A, B)
  ok(r.records === 0, 'a delete that outlives B still destroys both records  [' +
    r.records + ' record(s)]')
  ok(r.status === '200/200', '  and both calls report success  [' + r.status + ']')
  console.log('      (A cleared its guard against a roster B had not touched yet, then B')
  console.log('       swept A’s record and A’s delete landed afterwards. KV has no')
  console.log('       compare-and-delete, so nothing checked BEFORE a delete can bind it.')
  console.log('       Closing it needs a version on the record the delete is conditional on.)')
}

console.log('--- stopping B instead: the side that re-registers what it already has ---')
// The other half of the pairing, and not a mirror of it: B updates a record that
// exists where A creates one. The first two rows are where B resumes after A has
// rewritten the roster, so those are the schedules in which B does sweep — they are
// how B's own guard and delete get exercised at all. The last two are where B had
// already read the roster first, so it has nothing to retire and the store keeps both.
const EXPECT_B = {
  'B get sub:X': { records: 1, endpoints: 'X', roster: 'X',
    why: 'B resumes into a roster holding only Y, sweeps it, and its own record is the survivor' },
  'B get idx':   { records: 1, endpoints: 'X', roster: 'X',
    why: 'same — B’s guard re-read and delete both run here' },
  'B put idx':   { records: 2, endpoints: 'X,Y', roster: 'X',
    why: 'B read the roster before A touched it, so it sweeps nothing and recreates the record A deleted. Y stored unlisted' },
  'B put sub:X': { records: 2, endpoints: 'X,Y', roster: 'Y',
    why: 'same, one write later — and here it is X that is stored unlisted' },
}
const bRecords = []
for (const point of SEQ_B) {
  const e = EXPECT_B[point]
  if (!e) { ok(false, 'no stated outcome for barrier ' + point); continue }
  const r = await attempt(point, () => drive(point, B, A))
  if (!r) continue
  bRecords.push(r.records)
  report(point, r, e, 13)
  ok(r.status === '200/200', '  both calls returned 200  [' + r.status + ']')
}
ok(bRecords.length === SEQ_B.length && Math.min(...bRecords) >= 1,
  'no B-held schedule leaves the device with zero records  [' + bRecords.join(',') + ']')

console.log('--- and B gets the same protection, in the only schedule where B can sweep ---')
// B alone never sweeps, so until now its guard had only ever been watched DELETING —
// the two schedules above where it acquires a stale list never put a candidate back
// before its re-read. A guard that protected A's path and not B's would have passed
// everything above. Two barriers in sequence put B in the protecting role: stop it
// before it reads the roster, let A finish, re-arm on its guard, then hand the
// candidate back.
{
  const ch = mkChoreo(['X', 'Y'])
  const I = randomUUID()
  await must(ch, 'X', I)
  const h1 = ch.hold('B get idx')
  const b = ch.as('B', () => post(ch, 'X', I))
  b.catch(() => {})
  ok(await settle(h1.what, h1.reached, b.then(() => null, () => null)) === 'B get idx',
    'B stops before reading the roster')
  await ch.as('A', () => post(ch, 'Y', I))     // A completes: store and roster hold Y
  const h2 = ch.hold('B get idx #2')           // re-armed BEFORE the release, or B sails past
  h1.release()
  ok(await settle(h2.what, h2.reached, b.then(() => null, () => null)) === 'B get idx #2',
    '  resumes, finds Y stale, and stops at its own guard')
  restore(ch, keyOf('Y'))
  h2.release()

  const body = await (await b).json()
  ok(body.replaced === 0, '  and skips the delete  [replaced=' + body.replaced + ']')
  ok(nSubs(ch.env) === 2, '  so A’s record survives  [' + nSubs(ch.env) + ' records]')
  ok(endpointsIn(ch).join() === 'X,Y', '  both endpoints stored  [' + endpointsIn(ch).join() + ']')
}

console.log('--- but the sweep still works: an ordinary reinstall retires its old record ---')
{
  const ch = mkChoreo(['old', 'new'])
  const I = randomUUID()
  await must(ch, 'old', I)
  const r = await post(ch, 'new', I)
  ok((await r.json()).replaced === 1, 're-registering the same install reports replaced:1')
  ok(nSubs(ch.env) === 1, '  store holds exactly one record  [' + nSubs(ch.env) + ']')
  ok(endpointsIn(ch).join() === 'new', '  and it is the NEW endpoint, not the old one  [' +
    endpointsIn(ch).join() + ']')
}

console.log('--- SEVERAL stale records for one install are all retired ---')
{
  const ch = mkChoreo(['p1', 'p2', 'p3'])
  const I = randomUUID()
  await must(ch, 'p1', randomUUID())
  await must(ch, 'p2', randomUUID())
  ok(plantUnder(ch, I).length === 2, 'two records planted from different installs')

  const r = await post(ch, 'p3', I)
  const body = await r.json()
  ok(body.replaced === 2, '  one registration retires BOTH  [replaced=' + body.replaced + ']')
  ok(nSubs(ch.env) === 1, '  leaving exactly one record  [' + nSubs(ch.env) + ']')
  ok(endpointsIn(ch).join() === 'p3', '  and it is the new endpoint  [' + endpointsIn(ch).join() + ']')
}

console.log('--- a MIXED sweep: one candidate came back, one did not ---')
// Every protected schedule above has exactly ONE stale candidate, and the test above
// has several but none protected. Two broken guards survive that combination: one that
// stops protecting as soon as there are several candidates, and one that abandons the
// WHOLE sweep the moment any single candidate turns out to be live. They are wrong in
// opposite directions — the first deletes a live record, the second keeps dead ones
// forever — and only a sweep holding both kinds at once tells either from the real
// thing. Raised by peer review; neither mutant failed anything before this block.
{
  const ch = mkChoreo(['m1', 'm2', 'm3'])
  const I = randomUUID()
  await must(ch, 'm1', randomUUID())
  await must(ch, 'm2', randomUUID())
  plantUnder(ch, I)
  const live = keyOf('m1'), dead = keyOf('m2')

  const h = ch.hold('A get idx #2')
  const p = ch.as('A', () => post(ch, 'm3', I))
  p.catch(() => {})
  ok(await settle(h.what, h.reached, p.then(() => null, () => null)) === 'A get idx #2',
    'the registration stops at its guard with two candidates to judge')
  restore(ch, live)
  h.release()

  const body = await (await p).json()
  ok(body.replaced === 1, '  exactly one is retired  [replaced=' + body.replaced + ']')
  ok(ch.env.SUBS._m.has(live), '  the one that came back survives')
  ok(!ch.env.SUBS._m.has(dead), '  the one still missing from the roster is deleted')
  ok(endpointsIn(ch).join() === 'm1,m3', '  leaving exactly those two  [' +
    endpointsIn(ch).join() + ']')
}

console.log('--- uncertainty must mean SKIP, not delete-everything ---')
// readIndex repairs a malformed roster into an empty one, which the guard would read as
// "nothing is live" and therefore licence to delete every stale key — most destructive
// exactly when the roster is corrupt. liveEntries answers null instead, and it rejects
// SEVEN distinct shapes; the first version of this file exercised one of them. Each
// fault is aimed at the guard's own read by name, so it cannot drift onto another read
// the way a "third get() wins" counter does.
//
// A valid but EMPTY entry map is deliberately not in this list: it is not corrupt, it
// says nothing is live, and deleting is then correct. It is also unreachable here,
// because the request writes its own key into the roster before this read.
//
// The last row is the one the review found in the first version of the guard: readIndex
// does its KV get outside its own try, so a rejected read escaped AFTER the replacement
// was stored, turning a registration that had worked into an error the client retries.
const UNREADABLE = [
  ['missing',           () => null],
  ['invalid JSON',      () => '{'],
  ['JSON null',         () => 'null'],
  ['not an object',     () => '"a bare string"'],
  ['no entry map',      () => JSON.stringify({ t: Date.now() })],
  ['entry map is array', () => JSON.stringify({ t: Date.now(), e: [] })],
  ['entry map is string', () => JSON.stringify({ t: Date.now(), e: 'not-an-object' })],
  ['the read THROWS',   () => { throw new Error('KV read failed') }],
]
for (const [what, fault] of UNREADABLE) {
  const ch = mkChoreo(['c1', 'c2'])
  const I = randomUUID()
  await must(ch, 'c1', I)
  ch.fault('A get idx #2', fault)
  const r = await ch.as('A', () => post(ch, 'c2', I))
  const body = await r.json()
  ok(r.status === 200 && body.replaced === 0 && nSubs(ch.env) === 2,
    what.padEnd(19) + ' -> registered, retired nothing, old record kept  [' + r.status +
    ', replaced=' + body.replaced + ', ' + nSubs(ch.env) + ' records]')
}
console.log('      (the kept record is a duplicate: an extra push on every notification')
console.log('       until that endpoint starts returning 404/410 and the cron unsubscribes')
console.log('       it. A healthy duplicate is not pruned on a timer. Still the better')
console.log('       side of the trade — the alternative deletes a possibly-live record.)')

console.log('--- a rebuild between the save and the re-read: leaks one, then self-heals ---')
// The cost of the guard: if a rebuild re-lists KV in that window the stale key is back
// in the roster, so the guard skips it. This pins that it leaks ONE and that the next
// registration clears it, rather than accumulating. The rebuild is applied at the
// barrier immediately before the guard's read, which is the only window where it bites.
{
  const ch = mkChoreo(['h1', 'h2', 'h3'])
  const I = randomUUID()
  await must(ch, 'h1', I)
  const stale = subKeys(ch)[0]
  const h = ch.hold('A get idx #2')
  const p = ch.as('A', () => post(ch, 'h2', I))
  p.catch(() => {})
  ok(await settle(h.what, h.reached, p.then(() => null, () => null)) === 'A get idx #2',
    'the registration stops at the guard’s roster re-read')
  const i = JSON.parse(ch.env.SUBS._m.get(IDX))   // as a concurrent rebuild re-listing KV would
  i.e[stale] = [I, null]
  ch.env.SUBS._m.set(IDX, JSON.stringify(i))
  h.release()
  await p
  ok(nSubs(ch.env) === 2, 'the skipped delete leaves one extra record  [' + nSubs(ch.env) + ']')
  await must(ch, 'h3', I)
  ok(nSubs(ch.env) === 1, '  and the next registration AT A NEW ENDPOINT clears it  [' +
    nSubs(ch.env) + ']')
  ok(endpointsIn(ch).join() === 'h3', '  leaving the newest endpoint  [' + endpointsIn(ch).join() + ']')
  console.log('      (an IDENTICAL re-registration would not: it returns early without')
  console.log('       sweeping at all, so "the next registration" has to be a new endpoint)')
}

console.log('--- repeated interference: it does NOT stay at one ---')
// The block above shows recovery from ONE interference, which the first version of this
// file wrote up as "bounded and self-healing — it does not accumulate". That was a
// claim about every schedule drawn from a sample of one, and peer review called it.
// So: interfere on every registration in a row and measure. Each iteration uses its
// own label because the tag counter is per-store, and 'A get idx #2' in a loop would
// name the second read of the FIRST iteration only.
{
  const names = ['i0', 'i1', 'i2', 'i3', 'i4']
  const ch = mkChoreo([...names, 'i5'])
  const I = randomUUID()
  await must(ch, names[0], I)
  const counts = []
  for (let n = 1; n < names.length; n++) {
    const who = 'A' + n
    const back = subKeys(ch)                       // everything stored comes back mid-flight
    const h = ch.hold(who + ' get idx #2')
    const p = ch.as(who, () => post(ch, names[n], I))
    p.catch(() => {})
    const at = await settle(h.what, h.reached, p.then(() => null, () => null))
    if (at) restore(ch, ...back)
    h.release()
    await p
    counts.push(nSubs(ch.env))
  }
  ok(counts.join(',') === '2,3,4,5', 'sustained interference accumulates one per registration  [' +
    counts.join(',') + ']')
  const after = await post(ch, 'i5', randomUUID())
  ok(after.status === 200, '  the store still admits registrations  [' + after.status + ']')
  console.log('      (so the leak is self-healing only against ISOLATED interference. The')
  console.log('       bound is the occupancy cap, not the guard, and a rebuild reconciles')
  console.log('       the roster within five minutes.)')
}

process.exit(fail ? 1 : 0)   // the exit handler above prints the tally, crash or not
