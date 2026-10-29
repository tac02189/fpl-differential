// The CORS proxy's edge cache was bypassable two ways: a unique query string, or a
// unique path under an allowed prefix. Both are a fresh fetch to
// fantasy.premierleague.com, whose patience is the thing actually at risk.
import { pathToFileURL } from 'node:url'
const w = (await import(pathToFileURL(process.env.WORKER_FILE).href)).default
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }

// Capture what the worker asks upstream for, instead of asking it.
const seen = []
const realFetch = globalThis.fetch
globalThis.fetch = async (u, init) => {
  seen.push({ url: String(u), ttl: init?.cf?.cacheTtl })
  return new Response('{"ok":1}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}
const env = { SUBS: null }
const hit = async (path, method = 'GET') => {
  seen.length = 0
  const res = await w.fetch(new Request('https://x' + path, { method }), env)
  return { status: res.status, up: seen[0]?.url, ttl: seen[0]?.ttl, calls: seen.length }
}

console.log('--- every endpoint the app actually calls still resolves ---')
// Taken from src/api/fpl.js and scripts/notify.mjs, not invented.
for (const [p, want] of [
  ['/bootstrap-static/', 'https://fantasy.premierleague.com/api/bootstrap-static/'],
  ['/fixtures/', 'https://fantasy.premierleague.com/api/fixtures/'],
  ['/fixtures/?event=9', 'https://fantasy.premierleague.com/api/fixtures/?event=9'],
  ['/element-summary/351/', 'https://fantasy.premierleague.com/api/element-summary/351/'],
  ['/event/9/live/', 'https://fantasy.premierleague.com/api/event/9/live/'],
  ['/entry/3439162/', 'https://fantasy.premierleague.com/api/entry/3439162/'],
  ['/entry/3439162/history/', 'https://fantasy.premierleague.com/api/entry/3439162/history/'],
  ['/entry/3439162/event/9/picks/', 'https://fantasy.premierleague.com/api/entry/3439162/event/9/picks/'],
  ['/leagues-classic/314/standings/?page_standings=2', 'https://fantasy.premierleague.com/api/leagues-classic/314/standings/?page_standings=2'],
]) {
  const r = await hit(p)
  ok(r.status === 200 && r.up === want, p + '  ->  ' + (r.up || r.status))
}

console.log('--- one canonical upstream URL per piece of data ---')
const canon = async paths => {
  const ups = []
  for (const p of paths) ups.push((await hit(p)).up)
  return new Set(ups)
}
let set = await canon([
  '/bootstrap-static/',
  '/bootstrap-static',
  '/bootstrap-static/?cachebust=1',
  '/bootstrap-static/?cachebust=2',
  '/bootstrap-static/?' + 'x'.repeat(50) + '=1',
  '/bootstrap-static/?event=9',
])
ok(set.size === 1, 'six dressed-up requests for bootstrap collapse to ONE upstream URL  [' + set.size + ']')
console.log('      [' + [...set][0] + ']')
console.log('      (each distinct string was a distinct cache key, so each was a fresh')
console.log('       fetch to fantasy.premierleague.com)')

set = await canon(['/fixtures/?event=9', '/fixtures/?event=009', '/fixtures/?event=9&junk=abc', '/fixtures?event=9'])
ok(set.size === 1, 'event=9, event=009 and a junk companion all collapse to one  [' + set.size + ']')
ok([...set][0].endsWith('?event=9'), '  with the parameter normalised  [' + [...set][0].split('/api')[1] + ']')
set = await canon(['/fixtures/?event=9', '/fixtures/?event=10'])
ok(set.size === 2, '  while genuinely different events stay different  [' + set.size + ']')

set = await canon([
  '/leagues-classic/314/standings/?page_standings=2',
  '/leagues-classic/314/standings/?page_standings=2&nonsense=1',
  '/leagues-classic/314/standings?page_standings=2',
])
ok(set.size === 1, 'league paging keeps its real parameter and drops the rest  [' + set.size + ']')

console.log('--- a unique PATH is no longer a unique cache key either ---')
for (const p of [
  '/bootstrap-static/junk',
  '/bootstrap-static/a/b/c',
  '/fixtures/9999',
  '/event/9/live/extra',
  '/entry/1/history/x',
  '/leagues-classic/314/standings/1',
]) {
  const r = await hit(p)
  ok(r.status === 404 && r.calls === 0, 'a path under an allowed prefix is 404 with NO upstream fetch:  ' + p)
}

console.log('--- the shapes themselves are checked, not just the prefix ---')
for (const p of ['/entry/abc/', '/event/x/live/', '/element-summary/-1/', '/entry/1234567890123/', '/nope/']) {
  const r = await hit(p)
  ok(r.status === 404 && r.calls === 0, 'rejected without an upstream fetch:  ' + p)
}

console.log('--- the live TTL cannot be claimed by dressing a request up ---')
ok((await hit('/event/9/live/')).ttl === 20, 'a real live endpoint gets the 20s TTL')
ok((await hit('/fixtures/?event=9')).ttl === 20, '  as does fixtures for one event')
ok((await hit('/fixtures/')).ttl === 60, 'the full fixtures list gets 60s')
ok((await hit('/bootstrap-static/?event=9')).ttl === 60,
  '  and bootstrap cannot buy the short TTL by carrying ?event  [' + (await hit('/bootstrap-static/?event=9')).ttl + ']')

console.log('--- only GET is proxied (unchanged: the guard predates this commit) ---')
for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
  const r = await hit('/bootstrap-static/', m)
  ok(r.status === 405 && r.calls === 0, m + ' is 405 with no upstream fetch')
}


console.log('--- GEMINI 1 (High): leading zeros in the PATH, not just the query ---')
set = await canon(['/entry/123/', '/entry/0123/', '/entry/00123/', '/entry/000000000000123/'])
ok(set.size === 1, 'four zero-paddings of one team id collapse to ONE upstream URL  [' + set.size + ']')
ok([...set][0].endsWith('/entry/123/'), '  normalised to the bare number  [' + [...set][0].split('/api')[1] + ']')
console.log('      (the first version normalised ?event=009 but forwarded the path raw,')
console.log('       so half the hole it was closing stayed open)')
set = await canon(['/entry/1/event/9/picks/', '/entry/01/event/09/picks/', '/entry/0001/event/009/picks/'])
ok(set.size === 1, 'the entry-plus-gameweek combinations collapse too  [' + set.size + ']')
set = await canon(['/entry/0/', '/entry/00/', '/entry/000/'])
ok(set.size === 1 && [...set][0].endsWith('/entry/0/'), 'a genuine zero id survives as 0, not stripped away')
ok((await hit('/entry/123/')).up !== (await hit('/entry/124/')).up, 'different teams stay different')
// padding can no longer smuggle an id past the digit bound, because stripping is first
ok((await hit('/entry/' + '0'.repeat(40) + '7/')).up.endsWith('/entry/7/'),
  'forty zeros of padding canonicalise rather than opening a separate key')

console.log('--- GEMINI 3: a parameter set to its own default is dropped ---')
set = await canon([
  '/leagues-classic/314/standings/',
  '/leagues-classic/314/standings/?page_standings=1',
  '/leagues-classic/314/standings/?page_standings=001',
  '/leagues-classic/314/standings/?phase=1',
  '/leagues-classic/314/standings/?page_standings=1&phase=1&page_new_entries=1',
])
ok(set.size === 1, "five spellings of page one collapse to ONE  [" + set.size + ']')
ok(!([...set][0].includes('?')), '  with no query at all, matching the bare request  [' + [...set][0].split('/api')[1] + ']')
ok((await hit('/leagues-classic/314/standings/?page_standings=2')).up.endsWith('?page_standings=2'),
  '  while page 2 keeps its parameter')
ok((await hit('/fixtures/?event=1')).up.endsWith('?event=1'),
  'event=1 is NOT dropped: /fixtures/ without it is every fixture, different data')

globalThis.fetch = realFetch
console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
