// Exercises planInjuryAlerts from notify.mjs without running the cron itself.
//   node scripts/test-notify-plan.mjs
// Guards the failure Codex found: one subscriber's broken endpoint must not
// re-alert the subscribers who already received the notification.
import { readFileSync } from 'node:fs'

// notify.mjs runs its cron on import, so lift just the pure planner out of the
// source and load that slice as its own module.
const src = readFileSync(new URL('./notify.mjs', import.meta.url), 'utf8')
const from = src.indexOf('const statusLabel')
const to = src.indexOf('\n}', src.indexOf('return out', from)) + 2
if (from < 0 || to < 2) throw new Error('could not locate planInjuryAlerts in notify.mjs')
const { planInjuryAlerts } = await import('data:text/javascript,' + encodeURIComponent(src.slice(from, to)))

const A = { subscription: { endpoint: 'https://fcm.googleapis.com/A' }, teamId: '1' }
const B = { subscription: { endpoint: 'https://fcm.googleapis.com/B' }, teamId: '2' }
const keyOf = s => s.subscription.endpoint.slice(-1)
const subs = [A, B]

let failures = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`)
}

const salahFit = new Map([[1, { id: 1, web_name: 'Salah', status: 'a', news: '' }]])
const salahHurt = new Map([[1, { id: 1, web_name: 'Salah', status: 'i', news: 'Hamstring - 50% chance' }]])
const salahOut = new Map([[1, { id: 1, web_name: 'Salah', status: 'i', news: 'Ruled out until Nov' }]])
const ownedBy = new Map([
  ['A', new Set([1])],
  ['B', new Set([1])],
])

// run 1 — first sight of a fit player: silent baseline, no pushes
const seen = {}
check('first sight sends nothing', planInjuryAlerts({ subs, players: salahFit, ownedBy, keyOf, seen }).length, 0)
check('first sight records baseline', seen.A[1], 'a|')

// run 2 — he gets injured: both owners queued
let plans = planInjuryAlerts({ subs, players: salahHurt, ownedBy, keyOf, seen })
check('injury queues both owners', plans.map(p => p.subKey), ['A', 'B'])
check('label carries the news text', plans[0].label, 'Hamstring - 50% chance')

// A delivers, B's endpoint fails twice — only A's baseline advances
for (const p of plans) if (p.subKey === 'A') (seen[p.subKey] ||= {})[p.playerId] = p.statusKey

// run 3 — THE REGRESSION: A must not be re-alerted, B must be retried
plans = planInjuryAlerts({ subs, players: salahHurt, ownedBy, keyOf, seen })
check('delivered subscriber is not re-alerted', plans.map(p => p.subKey), ['B'])

// run 4 — B still failing, A still quiet (would have looped forever before the fix)
plans = planInjuryAlerts({ subs, players: salahHurt, ownedBy, keyOf, seen })
check('no duplicate on repeated failure', plans.map(p => p.subKey), ['B'])

// run 5 — escalation reaches both: B's pending change collapses into the newer one
plans = planInjuryAlerts({ subs, players: salahOut, ownedBy, keyOf, seen })
check('escalation alerts both owners', plans.map(p => p.subKey), ['A', 'B'])
check('escalation carries new text', plans[0].label, 'Ruled out until Nov')
for (const p of plans) (seen[p.subKey] ||= {})[p.playerId] = p.statusKey

// run 6 — recovery
plans = planInjuryAlerts({ subs, players: salahFit, ownedBy, keyOf, seen })
check('recovery alerts both owners', plans.map(p => p.label), ['Available again', 'Available again'])
for (const p of plans) (seen[p.subKey] ||= {})[p.playerId] = p.statusKey

// run 7 — cosmetic news edit while available stays silent
const salahFitNote = new Map([[1, { id: 1, web_name: 'Salah', status: 'a', news: 'Returned from injury' }]])
check('news shuffle while fit is silent', planInjuryAlerts({ subs, players: salahFitNote, ownedBy, keyOf, seen }).length, 0)

// run 8 — unreadable squad must not be read as "owns nothing"
const partial = new Map([['A', new Set([1])]])
check(
  'unknown squad is skipped, not wiped',
  planInjuryAlerts({ subs, players: salahHurt, ownedBy: partial, keyOf, seen }).map(p => p.subKey),
  ['A'],
)

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
