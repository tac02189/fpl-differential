// The client maps the worker's error strings to user-facing text. Nothing links the
// two files, so a new 4xx in the worker silently falls back to "try again shortly" —
// which is the exact lie this change exists to stop telling.
import { readFileSync } from 'node:fs'
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }
const root = process.env.PROJ
const worker = readFileSync(root + '/worker/fpl-proxy.js', 'utf8')
const push = readFileSync(root + '/src/lib/push.js', 'utf8')

// Every error string the /subscribe handler can return with a 4xx.
const sub = worker.slice(worker.indexOf("url.pathname === '/subscribe'"), worker.indexOf("url.pathname === '/unsubscribe'"))
const codes = [...sub.matchAll(/json\(\{ error: '([^']+)' \}, (4\d\d)\)/g)].map(m => m[1])
const fmap = push.slice(push.indexOf('const FAILURE_TEXT'), push.indexOf('const RETRY_TEXT'))
const mapped = [...fmap.matchAll(/^  '([^']+)':/gm)].map(m => m[1])
console.log('  worker 4xx reasons : ' + codes.join(', '))
console.log('  client maps        : ' + mapped.join(', '))

ok(codes.length > 0, 'found the worker\u2019s 4xx reasons  [' + codes.length + ']')
for (const c of codes) ok(mapped.includes(c), 'the client has user-facing text for: "' + c + '"')
for (const m of mapped) ok(codes.includes(m), '  and maps nothing stale: "' + m + '" is still a real worker reason')
ok(push.includes('RETRY_TEXT'), 'an unmapped reason still falls back to the retry wording')
ok(/res\.status >= 400 && res\.status < 500/.test(push), 'only 4xx is treated as a reason worth repeating')
ok(!push.includes("throw new Error('Could not register with the alert service — try again shortly.')"),
  'the unconditional retry message is gone')
console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
