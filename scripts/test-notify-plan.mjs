// Exercises the pure parts of notify.mjs without running the cron itself:
// planInjuryAlerts, and the deadline-reminder windows.
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

// Same for the reminder windows: the two constants through the end of hoursLeft.
// Each index is checked on its own, because a missed marker would otherwise make the
// next indexOf search from the top of the file and load the wrong slice.
const rFrom = src.indexOf('const FINAL_WINDOW_H')
const rFn = src.indexOf('export function hoursLeft', rFrom)
const rTo = rFn < 0 ? -1 : src.indexOf('\n}', rFn) + 2
if (rFrom < 0 || rFn < 0 || rTo < 2) throw new Error('could not locate the reminder windows in notify.mjs')
const { reminderPhase, hoursLeft } = await import('data:text/javascript,' + encodeURIComponent(src.slice(rFrom, rTo)))

const A = { subscription: { endpoint: 'https://fcm.googleapis.com/A' }, teamId: '1' }
const B = { subscription: { endpoint: 'https://fcm.googleapis.com/B' }, teamId: '2' }
const keyOf = s => s.subscription.endpoint.slice(-1)
const subs = [A, B]

let failures = 0, passes = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? passes++ : failures++
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

// --- deadline-reminder windows ---
// The final window was 6h until 2026-11-03, so 7h out sent the day-before reminder.
check('7h out sends the final reminder', reminderPhase(7), 't2')
check('the final window includes its edge (8h)', reminderPhase(8), 't2')
check('just past 8h is the day-before reminder', reminderPhase(8.01), 't24')
check('a minute out is still the final reminder', reminderPhase(1 / 60), 't2')
check('the day-before window includes its edge (24h)', reminderPhase(24), 't24')
check('beyond 24h sends nothing', reminderPhase(24.01), null)
check('at the deadline sends nothing', reminderPhase(0), null)
check('after the deadline sends nothing', reminderPhase(-0.5), null)
check('an unparseable deadline sends nothing', reminderPhase(NaN), null)
// A test of the function proves nothing if the cron stops calling it.
check('the cron takes its phase from reminderPhase', /const phase = reminderPhase\(hrs\)/.test(src), true)
check('time left rounds before splitting (no "6h 60m")', hoursLeft(6.9999), '7h 00m')
check('time left pads the minutes', hoursLeft(7.1), '7h 06m')
check('under an hour reads in minutes', hoursLeft(0.75), '45 minutes')

// Same wording as the suites under test/, so the runner can count these checks
// toward its total instead of reporting the suite as untallied.
console.log(`\n${failures ? 'FAILED ' : ''}${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
