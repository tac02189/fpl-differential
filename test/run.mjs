// Runs every suite and reports one verdict.  `npm test`
//
// Each suite is its own process on purpose. They share a module-level worker
// import and a Durable Object stub holding a day's budget, so running them in
// one process would let an earlier suite's spending decide a later suite's
// result — and the failure would look like a real cap being hit. Separate
// processes make that impossible rather than merely unlikely.
//
// A suite locates the code under test through two environment variables, set
// here so no suite carries a path of its own:
//   WORKER_FILE  absolute path to worker/fpl-proxy.js
//   PROJ         repo root, for the suite that reads worker and client together
//
// Filter with a substring to run one suite while working on it:
//   npm test -- index      runs index.test.mjs and index2.test.mjs
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = path.resolve(here, '..')
const env = {
  ...process.env,
  WORKER_FILE: path.join(root, 'worker', 'fpl-proxy.js'),
  PROJ: root,
}

// A hung suite would otherwise hold the run open until CI's own timeout fires,
// which reports as an infrastructure failure rather than as the suite's fault.
// The slowest suite today finishes in 1.3s, so a minute is pure headroom.
// Overridable so the timeout path itself can be exercised without a 60s wait —
// an untested timeout is indistinguishable from no timeout.
const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS) || 60_000

// Suites are discovered, not listed, so adding one needs no edit here. The cost
// of discovery is that DELETING one silently reduces coverage while the run stays
// green — so the count has a floor. This is a constant sized against another
// constant, which is exactly the pattern that rots; the difference is that this
// one cannot rot quietly. Drop a suite and the run goes red naming this line.
const EXPECTED_SUITES = 17

// The planner test predates this directory and lives beside the cron it covers.
// It is listed rather than globbed so that moving it is a deliberate act.
const suites = [
  ...readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(here, f)),
  path.join(root, 'scripts', 'test-notify-plan.mjs'),
]

const filter = process.argv[2]
const selected = filter ? suites.filter(f => path.basename(f).includes(filter)) : suites
if (!selected.length) {
  console.error(`No suite matches ${JSON.stringify(filter)}. Available:`)
  for (const s of suites) console.error('  ' + path.basename(s))
  process.exit(1)
}
if (!filter && suites.length < EXPECTED_SUITES) {
  console.error(
    `Expected at least ${EXPECTED_SUITES} suites, found ${suites.length}. A suite has been ` +
    `removed or renamed, which lowers coverage without failing any check. If that was ` +
    `deliberate, lower EXPECTED_SUITES in test/run.mjs in the same commit.`,
  )
  process.exit(1)
}

const run = file => new Promise(resolve => {
  const child = spawn(process.execPath, [file], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('error', e => resolve({ code: 1, out: out + '\nfailed to start: ' + e.message }))
  // A suite killed by a signal — the timeout above included — closes with a null
  // code, which is not 0 and so fails the run. That is the intent: only a clean
  // zero passes.
  child.on('close', (code, signal) => resolve({ code, signal, out }))
})

// Suites print their own tally as "N passed, M failed". Parsed only to report a
// total — the exit code is what decides pass or fail, so a suite that dies before
// printing anything still fails the run instead of contributing a silent zero.
const tally = out => {
  const m = /(\d+) passed, (\d+) failed/.exec(out)
  return m ? { passed: +m[1], failed: +m[2] } : null
}

let failed = 0, crashed = 0, passedChecks = 0, failedChecks = 0, untallied = 0
const start = Date.now()

for (const file of selected) {
  const name = path.basename(file).replace(/\.(test\.)?mjs$/, '')
  const t0 = Date.now()
  const { code, signal, out } = await run(file)
  const counts = tally(out)
  if (counts) { passedChecks += counts.passed; failedChecks += counts.failed } else untallied++

  const ms = String(Date.now() - t0).padStart(5)
  if (code === 0) {
    console.log(`  ok   ${name.padEnd(16)} ${String(counts.passed).padStart(3)} checks ${ms}ms`)
  } else {
    failed++
    // No tally means the suite did not reach its own summary line: it threw, or it
    // was killed. Saying "0 failing checks" for that would read like nothing was
    // wrong, so it is named as a crash instead.
    if (!counts) crashed++
    const why = signal
      ? (signal === 'SIGKILL' ? `timed out after ${SUITE_TIMEOUT_MS / 1000}s` : `killed by ${signal}`)
      : counts ? `exit ${code}` : `exit ${code}, no tally printed — crashed before summarising`
    console.log(`  FAIL ${name.padEnd(16)} ${ms}ms  (${why})`)
    console.log(out.split('\n').map(l => '       ' + l).join('\n'))
  }
}

const secs = ((Date.now() - start) / 1000).toFixed(1)
console.log()
if (failed) {
  const checks = failedChecks ? `${failedChecks} failing checks` : 'no failing checks reported'
  const crashNote = crashed ? `, ${crashed} crashed without a tally` : ''
  console.log(`FAILED — ${failed} of ${selected.length} suites, ${checks}${crashNote} (${secs}s)`)
} else {
  console.log(`${selected.length} suites, ${passedChecks} checks, all passing (${secs}s)`)
  if (untallied) console.log(`(${untallied} suite(s) printed no tally — counted by exit code only)`)
}
process.exit(failed ? 1 : 0)
