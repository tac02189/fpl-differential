// A stale-delete list is permission to delete a key, computed from a roster read
// several KV operations earlier. By the time the delete runs, that key can belong to
// a NEWER registration. Two overlapping calls for one installId — one moving to Y,
// one re-registering X — each saw the other's record as stale and deleted it, leaving
// the device with no registration at all while both calls returned 200.
//
// Two mechanisms answer that, and this suite exists to keep both honest.
//
// The guard re-reads the roster immediately before acting on the list and skips any key
// present again. It narrows the window and cannot close it: KV has no compare-and-delete,
// so nothing checked BEFORE a delete can bind a delete. The enumeration below found the
// schedule that survived it.
//
// The claim closes that one. A registration takes an exclusive claim, in the Durable
// Object, on its own key and on every key it is about to retire, and holds all of them
// until it answers — so the request whose write the delete would have destroyed is
// refused the key instead, and never writes. The guard stays, because a concurrent
// REBUILD puts a candidate back in the roster without claiming anything.
//
// What this suite has to keep true, for both:
//   - no schedule leaves the device with zero records, and
//   - neither mechanism is vacuous: ordinary sweeps still retire records, and an
//     ordinary registration is not refused because another one is in flight.
// A guard that never deleted anything, or a claim that refused everything, would each
// pass the first half alone.
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
const SEQ_A = ['A get sub:Y', 'A get idx', 'A get sub:X', 'A put idx', 'A put sub:Y', 'A delete sub:X']
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
  'A get sub:Y':    { records: 1, endpoints: 'Y', roster: 'Y', status: '200/200',
    why: 'B finishes before A has claimed anything, and A then moves the install to Y' },
  'A get idx':      { records: 1, endpoints: 'Y', roster: 'Y', status: '200/200',
    why: 'same, one read later — A claims nothing until its occupancy checks have passed' },
  'A get sub:X':    { records: 1, endpoints: 'Y', roster: 'Y', status: '200/503',
    why: 'A is confirming from X’s own record that X is still its to retire — the check that replaced the roster re-read. It holds the claim by now, so B is refused' },
  'A put idx':      { records: 1, endpoints: 'Y', roster: 'Y', status: '200/503',
    why: 'the claim is taken before this, so B cannot write the endpoint A is about to delete and is told to retry' },
  'A put sub:Y':    { records: 1, endpoints: 'Y', roster: 'Y', status: '200/503',
    why: 'was 2 records with Y stored UNLISTED — the duplicate the old roster guard traded for' },
  'A delete sub:X': { records: 1, endpoints: 'Y', roster: 'Y', status: '200/503',
    why: 'THE ONE THE GUARD COULD NOT CLOSE: the delete still outlives B, and now it can only remove a record B was refused permission to write' },
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
  // The status pair is now the column that discriminates: 200/503 says the second call
  // was refused the key the first was holding, which is the whole mechanism. Asserting
  // it inside report rather than beside it means a schedule cannot quietly change which
  // of the two it was while the store still looks right.
  if (r.status !== e.status) wrong.push('EXPECTED status ' + e.status)
  ok(!wrong.length, point.padEnd(width) + ' -> ' + r.records + ' record(s) [' +
    (r.endpoints || '-') + '], roster [' + (r.roster || '-') + '], ' + r.status + '  ' +
    (wrong.length ? wrong.join('; ') + '  ' : '') + '— ' + e.why)
}

// A schedule that throws has to become a failing check, not an exception that kills the
// process: the runner reads the tally this file prints, and a stack trace instead of
// "N passed, M failed" loses every result before it as well as the cause.
const attempt = async (point, fn) => {
  try { return await fn() } catch (err) { ok(false, point + ' threw: ' + err.message); return null }
}

const lostAt = []
const disagreed = []
for (const point of SEQ_A) {
  const e = EXPECT_A[point]
  if (!e) { ok(false, 'no stated outcome for barrier ' + point); continue }
  const r = await attempt(point, () => drive(point, A, B))
  if (!r) continue
  if (r.records === 0) lostAt.push(point)
  if (r.roster !== r.endpoints) disagreed.push(point)
  report(point, r, e, 15)
}
ok(!lostAt.length, 'none of the ' + SEQ_A.length + ' loses every record  [' +
  (lostAt.join() || 'none does') + ']')
// Before the claim, three of these six ended with a record the roster did not list or a
// listing with no record behind it — the store under-counting until a rebuild, which is
// the direction that admits past the occupancy cap. Pinned as an aggregate because it is
// a property of the set, not of any one row.
ok(!disagreed.length, 'and in every one the roster agrees with the store  [' +
  (disagreed.join() || 'all agree') + ']')

console.log('--- the schedule that used to lose everything ---')
// This was a characterization test until the key claim landed: it PASSED while the
// defect existed, and the comment here said so, because a fix should arrive with this
// block rewritten rather than be discovered later. This is that rewrite.
//
// What it was: A cleared the guard against a roster B had not touched yet, B then swept
// A's record, and A's delete arrived afterwards. Both calls returned 200 and the device
// was left with no registration at all. No stall was needed — an ordinary interleaving
// produced it, which is why a guard that looked closed on a timing harness was not.
{
  const r = await drive('A delete sub:X', A, B)
  ok(r.records === 1, 'the device still has a registration  [' + r.records + ' record(s)]')
  ok(r.endpoints === 'Y' && r.roster === 'Y',
    '  one record, and the roster lists exactly it  [' + (r.endpoints || '-') + ' / ' +
    (r.roster || '-') + ']')
  ok(r.status === '200/503', '  B was refused rather than told it had succeeded  [' + r.status + ']')
  ok(r.replaced[0] === 1, '  and A retired the record it had claimed  [replaced=' +
    r.replaced[0] + ']')
  console.log('      (A holds X as a retirement candidate from before its first write')
  console.log('       until after its delete, so B cannot write the endpoint A is about to')
  console.log('       remove. KV has no compare-and-delete and nothing checked BEFORE a')
  console.log('       delete can bind it, so the claim keeps B out of the window instead')
  console.log('       of trying to detect it from inside.)')
}

console.log('--- the key changed hands: the record decides, and the claim makes that bind ---')
// Peer review found this one after the claim had closed the schedule above, and it is
// the reason the ownership check reads the RECORD rather than the roster.
//
// A candidate list comes from a roster snapshot, and a snapshot is not authority: that
// key can have changed hands since. It needs a yield point between the snapshot and the
// claim, and there is one — a registration that finds the index stale and is REFUSED the
// rebuild grant awaits that refusal and then carries on with the snapshot it read before
// asking. Install J re-registering the very endpoint install I is retiring is the real
// case: clearing a browser's storage mints a new installId while leaving its push
// endpoint intact, so the record at one key legitimately changes install.
//
// Driven here at the confirming read rather than through that whole schedule, because
// what is under test is the decision, not the route to it: the record at X is rewritten
// to carry another install exactly as J's registration would leave it, while A holds the
// claim and is about to act on a snapshot that says X is A's.
{
  const ch = mkChoreo(['X', 'Y'])
  const I = randomUUID(), J = randomUUID()
  await must(ch, 'X', I)
  const h = ch.hold('A get sub:X')
  const p = ch.as('A', () => post(ch, 'Y', I))
  p.catch(() => {})
  ok(await settle(h.what, h.reached, p.then(() => null, () => null)) === 'A get sub:X',
    'A stops at the read that confirms X is still its own')
  const rec = JSON.parse(ch.env.SUBS._m.get(keyOf('X')))
  rec.installId = J                                   // as J's re-registration would leave it
  ch.env.SUBS._m.set(keyOf('X'), JSON.stringify(rec))
  h.release()

  const body = await (await p).json()
  ok(body.replaced === 0, '  and retires nothing  [replaced=' + body.replaced + ']')
  ok(ch.env.SUBS._m.has(keyOf('X')), '  J’s record survives')
  ok(endpointsIn(ch).join() === 'X,Y', '  one record per install  [' +
    endpointsIn(ch).join() + ']')
  console.log('      (the roster could not have answered this. A’s own index save drops X')
  console.log('       from the roster moments later, so a roster read after the save sees')
  console.log('       X absent and deletes it; a read BEFORE the save sees whatever the')
  console.log('       roster happens to hold, which is a cache that can be absent, five')
  console.log('       minutes stale, or lost to a concurrent save. The record is the only')
  console.log('       authority, and it is readable here only because the key is claimed.)')
}

console.log('--- stopping B instead: the side that re-registers what it already has ---')
// The other half of the pairing, and not a mirror of it: B updates a record that
// exists where A creates one. The first two rows are where B resumes after A has
// rewritten the roster, so those are the schedules in which B does sweep — they are
// how B's own guard and delete get exercised at all. The last two are where B had
// already read the roster first, so it has nothing to retire and the store keeps both.
const EXPECT_B = {
  'B get sub:X': { records: 1, endpoints: 'X', roster: 'X', status: '200/200',
    why: 'B had claimed nothing yet, so A sweeps X; B resumes into a roster holding only Y, sweeps it, and its own record is the survivor' },
  'B get idx':   { records: 1, endpoints: 'X', roster: 'X', status: '200/200',
    why: 'same — the claim is taken after the roster read, so stopping before it leaves A free to sweep. B’s guard re-read and delete both run here' },
  'B put idx':   { records: 2, endpoints: 'X,Y', roster: 'X', status: '200/200',
    why: 'B holds X by now, so A sweeps nothing instead of deleting a record B is about to rewrite. B’s own index save then drops Y, which is the unserialized roster and not this race' },
  'B put sub:X': { records: 2, endpoints: 'X,Y', roster: 'X,Y', status: '200/200',
    why: 'same, one write later — and here A finds X claimed, so it no longer reports X gone while the record stands' },
}
const bRecords = []
for (const point of SEQ_B) {
  const e = EXPECT_B[point]
  if (!e) { ok(false, 'no stated outcome for barrier ' + point); continue }
  const r = await attempt(point, () => drive(point, B, A))
  if (!r) continue
  bRecords.push(r.records)
  report(point, r, e, 13)
}
ok(bRecords.length === SEQ_B.length && Math.min(...bRecords) >= 1,
  'no B-held schedule leaves the device with zero records  [' + bRecords.join(',') + ']')

console.log('--- and B gets the same protection, in the only schedule where B can sweep ---')
// B alone never sweeps, so without this its ownership check had only ever been watched
// AGREEING — the two schedules above where it acquires a candidate list never changed
// that record's owner first. A check that covered A's path and not B's would have passed
// everything above. Two barriers in sequence put B in the refusing role: stop it before
// it reads the roster, let A finish, re-arm on its confirming read, then hand the record
// to another install.
{
  const ch = mkChoreo(['X', 'Y'])
  const I = randomUUID(), J = randomUUID()
  await must(ch, 'X', I)
  const h1 = ch.hold('B get idx')
  const b = ch.as('B', () => post(ch, 'X', I))
  b.catch(() => {})
  ok(await settle(h1.what, h1.reached, b.then(() => null, () => null)) === 'B get idx',
    'B stops before reading the roster')
  await ch.as('A', () => post(ch, 'Y', I))     // A completes: store and roster hold Y
  const h2 = ch.hold('B get sub:Y')            // re-armed BEFORE the release, or B sails past
  h1.release()
  ok(await settle(h2.what, h2.reached, b.then(() => null, () => null)) === 'B get sub:Y',
    '  resumes, finds Y stale, and stops to confirm Y is its own')
  const recY = JSON.parse(ch.env.SUBS._m.get(keyOf('Y')))
  recY.installId = J
  ch.env.SUBS._m.set(keyOf('Y'), JSON.stringify(recY))
  h2.release()

  const body = await (await b).json()
  ok(body.replaced === 0, '  and skips the delete  [replaced=' + body.replaced + ']')
  ok(nSubs(ch.env) === 2, '  so the record at Y survives  [' + nSubs(ch.env) + ' records]')
  ok(endpointsIn(ch).join() === 'X,Y', '  both endpoints stored  [' + endpointsIn(ch).join() + ']')
}

console.log('--- a candidate somebody else holds drops out of the sweep, and that is all ---')
// The other half of the claim's contract, and the asymmetry is the whole design. Short
// of the grant on its OWN key is a refusal, because a second writer behind the first is
// exactly what the claim exists to prevent. Short of the grant on a CANDIDATE is not: a
// record somebody else is holding is simply not this request's to retire, and failing
// the registration over it would turn a transient overlap into a failed enable.
//
// All-or-nothing would have been the easier thing to write and it is the wrong thing:
// one busy candidate would refuse a registration that had every right to proceed.
{
  const ch = mkChoreo(['X', 'Y'])
  const I = randomUUID()
  await must(ch, 'X', I)
  // After B's claim, not before it — the claim is taken once the occupancy checks pass,
  // so a barrier on B's roster read would leave B holding nothing at all.
  const h = ch.hold('B put idx')
  const b = ch.as('B', () => post(ch, 'X', I))
  b.catch(() => {})
  ok(await settle(h.what, h.reached, b.then(() => null, () => null)) === 'B put idx',
    'B stops holding its own key, which is A’s only retirement candidate')

  const a = await ch.as('A', () => post(ch, 'Y', I))
  const body = await a.clone().json()
  ok(a.status === 200, '  A still registers rather than being refused  [' + a.status + ']')
  ok(body.replaced === 0, '  retiring nothing, because X was not its to retire  [replaced=' +
    body.replaced + ']')
  ok(ch.env.SUBS._m.has(keyOf('X')), '  the record at X is still there: A did not delete it')
  ok(rosterIn(ch) === 'X,Y',
    '  and the roster still lists X rather than reporting a record that is standing as gone  [' +
    rosterIn(ch) + ']')
  h.release()
  await b
  console.log('      (that last one is new: the sweep used to drop every candidate from the')
  console.log('       roster before the guard ran, so a skipped delete left the store')
  console.log('       under-counted — the direction that admits past the occupancy cap.)')
}

console.log('--- claims are per KEY, not per install ---')
// Two requests contending for one endpoint need not share an installId. A browser whose
// localStorage is cleared mints a new installId and re-registers the SAME push endpoint,
// so the record at that key changes hands between installs — and a claim keyed on the
// installId would not have excluded them.
//
// It also drives the one path the schedules above cannot reach: a request granted SOME
// of what it asked for and then refused its own key. It has to hand back the candidates
// it did get, or they stay locked until the lease expires and the next sweep skips them.
{
  const ch = mkChoreo(['x', 'w', 'y', 'w2'])
  const I = randomUUID(), J = randomUUID()
  await must(ch, 'w', J)      // a second install, with a record of its own
  await must(ch, 'x', I)

  const h = ch.hold('A put idx')
  const a = ch.as('A', () => post(ch, 'y', I))      // install I moves x -> y, claiming both
  a.catch(() => {})
  ok(await settle(h.what, h.reached, a.then(() => null, () => null)) === 'A put idx',
    'install I holds x as a retirement candidate')

  // Install J now claims the endpoint I currently owns: a cleared-localStorage
  // re-registration. Its own key is held, so it is refused — but w, its own stale
  // record, was free and was granted to it before that was known.
  const r = await ch.as('B', () => post(ch, 'x', J))
  ok(r.status === 503, '  a DIFFERENT install is refused that endpoint too  [' + r.status + ']')
  h.release()
  await a

  ok(nSubs(ch.env) === 2 && endpointsIn(ch).join() === 'w,y',
    '  I keeps its move and J keeps its own record  [' + endpointsIn(ch).join() + ']')
  const third = await (await post(ch, 'w2', J)).json()
  ok(third.replaced === 1,
    '  and J’s next registration can still retire w, so the refused request handed it back  [replaced=' +
    third.replaced + ']')
  ok(endpointsIn(ch).join() === 'w2,y', '  leaving one record per install  [' +
    endpointsIn(ch).join() + ']')
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

console.log('--- a MIXED sweep: one candidate changed hands, one did not ---')
// Every schedule above that refuses a retirement has exactly ONE candidate, and the test
// above has several but refuses none. Two broken checks survive that combination: one
// that stops checking as soon as there are several candidates, and one that abandons the
// WHOLE sweep the moment any single candidate turns out not to be ours. They are wrong in
// opposite directions — the first deletes a live record, the second keeps dead ones
// forever — and only a sweep holding both kinds at once tells either from the real thing.
// Raised by peer review of the roster version of this check; neither mutant failed
// anything before this block existed, and both still fail it now that the check reads the
// record instead.
{
  const ch = mkChoreo(['m1', 'm2', 'm3'])
  const I = randomUUID(), J = randomUUID()
  await must(ch, 'm1', randomUUID())
  await must(ch, 'm2', randomUUID())
  plantUnder(ch, I)
  const live = keyOf('m1'), dead = keyOf('m2')

  // Stop at the FIRST candidate's confirming read, which happens before either delete,
  // and hand m1 to another install while both are still being judged.
  const h = ch.hold(['A get sub:m1', 'A get sub:m2'])
  const p = ch.as('A', () => post(ch, 'm3', I))
  p.catch(() => {})
  const at = await settle('a candidate confirming read', h.reached, p.then(() => null, () => null))
  ok(at === 'A get sub:m1' || at === 'A get sub:m2',
    'the registration stops to confirm the first of two candidates  [' + at + ']')
  const recM1 = JSON.parse(ch.env.SUBS._m.get(live))
  recM1.installId = J
  ch.env.SUBS._m.set(live, JSON.stringify(recM1))
  h.release()

  const body = await (await p).json()
  ok(body.replaced === 1, '  exactly one is retired  [replaced=' + body.replaced + ']')
  ok(ch.env.SUBS._m.has(live), '  the one that changed hands survives')
  ok(!ch.env.SUBS._m.has(dead), '  the one still its own is deleted')
  ok(endpointsIn(ch).join() === 'm1,m3', '  leaving exactly those two  [' +
    endpointsIn(ch).join() + ']')
}

console.log('--- uncertainty must mean SKIP, not delete-everything ---')
// Every shape a candidate record can be in that is not a plain "yes, still mine". The
// check answers false to all of them, so the record is kept.
//
// This table used to aim at the roster instead, and the two defects it was written for
// were both about reading the roster wrongly: readIndex repairs a malformed roster into
// an EMPTY one, which a presence check reads as "nothing is live" and therefore licence
// to delete every candidate — most destructive exactly when the roster is corrupt — and
// its KV get sits outside its own try, so a rejected read escaped AFTER the replacement
// was stored and turned a registration that had worked into an error the client retries.
// Reading the record instead of the roster retires the first of those: there is no
// repair step to misread. The second is still a live hazard and is the last row here.
//
// A record that parses and belongs to ANOTHER install is not in this list — that is not
// uncertainty, it is a clear no, and the two blocks above drive it.
const UNCONFIRMABLE = [
  ['missing',            () => null],
  ['invalid JSON',       () => '{'],
  ['JSON null',          () => 'null'],
  ['not an object',      () => '"a bare string"'],
  ['no installId',       () => JSON.stringify({ subscription: {}, teamId: 7 })],
  ['installId is null',  () => JSON.stringify({ installId: null })],
  ['installId is an object', () => JSON.stringify({ installId: {} })],
  ['the read THROWS',    () => { throw new Error('KV read failed') }],
]
for (const [what, fault] of UNCONFIRMABLE) {
  const ch = mkChoreo(['c1', 'c2'])
  const I = randomUUID()
  await must(ch, 'c1', I)
  // Aimed at the confirming read by name, so it cannot drift onto another read the way
  // a "third get() wins" counter does.
  ch.fault('A get sub:c1', fault)
  const r = await ch.as('A', () => post(ch, 'c2', I))
  const body = await r.json()
  ok(r.status === 200 && body.replaced === 0 && nSubs(ch.env) === 2,
    what.padEnd(23) + ' -> registered, retired nothing, old record kept  [' + r.status +
    ', replaced=' + body.replaced + ', ' + nSubs(ch.env) + ' records]')
}
console.log('      (the kept record is a duplicate: an extra push on every notification')
console.log('       until that endpoint starts returning 404/410 and the cron unsubscribes')
console.log('       it. A healthy duplicate is not pruned on a timer. Still the better')
console.log('       side of the trade — the alternative deletes a possibly-live record.)')

console.log('--- a concurrent rebuild no longer makes a registration leak its own record ---')
// This block used to measure the OPPOSITE, and the change is the point of reading the
// record rather than the roster. The old check asked whether the candidate was in the
// roster again and skipped it if so. A rebuild re-lists KV and writes a roster naming
// everything it finds, including the record about to be retired — so an ordinary rebuild
// landing in that window made the registration skip its own delete and leak a duplicate.
// Measured then at one per interfering registration (2,3,4,5 over four in a row), which
// is why the comment in the worker calls the roster the wrong authority: a rebuild
// re-listing a record is not evidence that anyone else wants it.
//
// Each iteration uses its own label because the tag counter is per store, so one fixed
// barrier name in a loop would only ever match the first iteration.
{
  const names = ['i0', 'i1', 'i2', 'i3', 'i4']
  const ch = mkChoreo([...names, 'i5'])
  const I = randomUUID()
  await must(ch, names[0], I)
  const counts = []
  for (let n = 1; n < names.length; n++) {
    const who = 'A' + n
    const back = subKeys(ch)                       // everything stored comes back mid-flight
    const h = ch.hold(who + ' get ' + ch.nameOf(back[0]).replace(/^/, 'sub:'))
    const p = ch.as(who, () => post(ch, names[n], I))
    p.catch(() => {})
    const at = await settle(h.what, h.reached, p.then(() => null, () => null))
    if (at) restore(ch, ...back)                   // as a rebuild re-listing KV would
    h.release()
    await p
    counts.push(nSubs(ch.env))
  }
  ok(counts.join(',') === '1,1,1,1',
    'four registrations in a row, each with a rebuild landing mid-sweep, leak nothing  [' +
    counts.join(',') + ']')
  ok(endpointsIn(ch).join() === 'i4', '  one record, the newest endpoint  [' +
    endpointsIn(ch).join() + ']')
  const after = await post(ch, 'i5', randomUUID())
  ok(after.status === 200, '  and the store still admits registrations  [' + after.status + ']')
}

console.log('--- MAX_SWEEP: a drifted store heals over registrations, not in one ---')
// Each candidate costs a claim and a confirming read, and the read reservation had to
// name a worst case before the request knew how many it would have. So the sweep is
// capped, and the remainder has to be retired by the NEXT registration rather than
// lingering — a cap that never caught up would be a leak with a bound on it.
{
  const ch = mkChoreo(['s0', 's1', 's2', 's3', 's4', 's5', 's6'])
  const I = randomUUID()
  for (let i = 0; i < 6; i++) await must(ch, 's' + i, randomUUID())
  ok(plantUnder(ch, I).length === 6, 'six records planted on one install')

  const first = await (await post(ch, 's6', I)).json()
  ok(first.replaced === 4, '  one registration retires four  [replaced=' + first.replaced + ']')
  ok(nSubs(ch.env) === 3, '  leaving the two it could not reach plus the new one  [' +
    nSubs(ch.env) + ']')

  // The leftovers are still this install's, so the next registration at a new endpoint
  // takes them. (An identical re-registration would not: it returns early.)
  const next = await (await post(ch, 's6', randomUUID())).json()
  void next
  const third = await (await post(ch, 's5', I)).json()
  ok(third.replaced >= 1, '  and the next registration takes the rest  [replaced=' +
    third.replaced + ']')
  ok(nSubs(ch.env) <= 2, '  the store converges  [' + nSubs(ch.env) + ' records]')
}

console.log('--- the cap must credit what the install COULD retire, not what it will ---')
// The lockout the second review found, and the reason the occupancy caps count the full
// candidate list while the sweep is capped at MAX_SWEEP. Credit only what this request
// attempts and a device holding more than MAX_SWEEP of its own records at either cap is
// refused 429 — and refused again on every retry, because the only thing that could
// reduce its count is the sweep the cap just blocked. It never registers again.
//
// Driven at the per-source cap, the smaller of the two and the one a single device can
// reach. It only bites once the store is OVER that cap, which is a state this worker is
// measured to reach: neither cap holds under concurrency (61 records against 50, and 20
// from one source against 12). The caps are not exported, so the first one is discovered
// here rather than restated — a copy of a constant is how the last one of these rotted.
{
  const ch = mkChoreo([])
  const I = randomUUID()
  let perIp = 0
  while (perIp < 40) {
    const rr = await post(ch, 'lk' + perIp, randomUUID())
    if (rr.status !== 200) break
    perIp++
  }
  ok(perIp > 0 && perIp < 40, 'the per-source cap refuses at ' + perIp + ' records')

  // Plant past it, as a burst does: copy an existing record's source so the roster
  // counts them against it, which is the whole point of the schedule.
  const first = subKeys(ch)[0]
  const over = []
  for (let i = 0; i < 5; i++) {
    const src = JSON.parse(ch.env.SUBS._m.get(first))
    const meta = ch.env.SUBS._meta.get(first) || {}
    const k = keyOf('ov' + i)
    ch.env.SUBS._m.set(k, JSON.stringify({ ...src, subscription: { ...src.subscription, endpoint: EP('ov' + i) } }))
    ch.env.SUBS._meta.set(k, { installId: null, ipHash: meta.ipHash ?? null })
    const idx = idxOf(ch.env)
    idx.e[k] = [null, meta.ipHash ?? null]
    ch.env.SUBS._m.set(IDX, JSON.stringify(idx))
    over.push(k)
  }
  const total = perIp + over.length
  ok(plantUnder(ch, I).length === total,
    '  ' + total + ' records, all one install and one source: over the cap by ' +
    over.length)

  let r = await post(ch, 'lknew', I)
  ok(r.status === 200,
    'the device can still move to a new endpoint rather than being locked out  [' +
    r.status + ']')

  // And it converges, rather than sitting one capped sweep short of the cap forever.
  let rounds = 0
  while (nSubs(ch.env) > 1 && rounds < 30) {
    rounds++
    r = await post(ch, 'lkr' + rounds, I)
    if (r.status !== 200) break
  }
  ok(r.status === 200 && nSubs(ch.env) === 1,
    '  and repeated replacements converge to one record  [' + nSubs(ch.env) +
    ' after ' + rounds + ' more, last status ' + r.status + ']')
}

console.log('--- the residual: a stale KV read can still mislead the confirmation ---')
// A characterization test. It PASSES while the defect exists and goes red when someone
// fixes it, which is the same shape the schedule this whole change closed used to have.
//
// The claim stops another request from WRITING a held key. It cannot make a KV read
// return the latest completed write — KV is eventually consistent, and /unsubscribe's
// own comment has said so for as long as it has existed. So the confirming read can
// return the record as it was BEFORE another install re-registered that endpoint, and
// then the delete is wrong for exactly the reason the roster was wrong: the observation
// was stale, and exclusion preserves an authoritative observation rather than creating
// one. Second review called this, correctly, and it is the honest limit of the design.
//
// Closing it needs the ownership assertion to live where reads are strongly consistent —
// the Durable Object, written under the key's own claim before the KV put, and returned
// by the claim itself so it costs no extra round trip. That is deliberately NOT built
// here: it is a second roster inside the object, and moving the roster in there is a
// settled decision in this project. The record read is still strictly better than the
// roster read it replaced, which could be absent, five minutes stale, or clobbered.
{
  const ch = mkChoreo(['X', 'Y'])
  const I = randomUUID(), J = randomUUID()
  await must(ch, 'X', I)
  const fresh = JSON.parse(ch.env.SUBS._m.get(keyOf('X')))
  const stale = JSON.stringify({ ...fresh, installId: I })
  // X now really belongs to J, as a cleared-storage re-registration would leave it...
  ch.env.SUBS._m.set(keyOf('X'), JSON.stringify({ ...fresh, installId: J }))
  // ...but the confirming read is served the version from before that write.
  ch.fault('A get sub:X', () => stale)

  const r = await ch.as('A', () => post(ch, 'Y', I))
  const body = await r.json()
  ok(body.replaced === 1, 'a stale read makes the sweep retire a record it no longer owns  [replaced=' +
    body.replaced + ']')
  ok(!ch.env.SUBS._m.has(keyOf('X')), '  J’s record is gone, and J was told it succeeded')
  console.log('      (red here is the good news: it means the ownership assertion moved')
  console.log('       somewhere with read-after-write, and this block should be rewritten')
  console.log('       the way the one above it was.)')
}

console.log('--- /unsubscribe deletes by name too, so it claims as well ---')
// Found by peer review: the delete at the end of /unsubscribe was outside the exclusion
// entirely. Suspend a prune just before its delete, let a registration claim that
// endpoint and store a record there, and the prune removes a registration that had just
// succeeded — and because that registration retires an older record of its own, the
// device is left with neither. Both /unsubscribe paths claim now; this drives the
// authenticated one, which is the cron's prune.
{
  const ch = mkChoreo(['u1', 'u2'])
  const I = randomUUID()
  await must(ch, 'u1', I)
  const unsub = () => w.fetch(new Request('https://x/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SECRET },
    body: JSON.stringify({ endpoint: EP('u2') }),
  }), ch.env)

  // A registration for u2 is stopped while holding the claim on u2 and on u1.
  const h = ch.hold('A put sub:u2')
  const p = ch.as('A', () => post(ch, 'u2', I))
  p.catch(() => {})
  ok(await settle(h.what, h.reached, p.then(() => null, () => null)) === 'A put sub:u2',
    'a registration is mid-flight holding the endpoint the cron wants to prune')
  const r = await ch.as('U', () => unsub())
  ok(r.status === 200, '  the prune still answers 200, because the cron does not retry bodies  [' +
    r.status + ']')
  ok(ch.log.filter(t => t.startsWith('U delete')).length === 0,
    '  but it issued no delete  [' + (ch.log.filter(t => t.startsWith('U ')).join(', ') || 'no KV ops') + ']')
  h.release()
  await p
  ok(nSubs(ch.env) === 1 && endpointsIn(ch).join() === 'u2',
    '  so the registration that succeeded is the one that stands  [' +
    endpointsIn(ch).join() + ']')
}

process.exit(fail ? 1 : 0)   // the exit handler above prints the tally, crash or not
