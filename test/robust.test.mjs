// Codex finding 4 (pre-existing): /subscribe chose WHICH fields to store but never
// bounded their SIZES. The counter-robustness half of this suite moved to
// dobj.test.mjs when the budget left the KV index for the Durable Object.
import { pathToFileURL } from 'node:url'
import { IP, mkKeys, EP, mkEnv, nSubs } from './dostub.mjs'
const mod = await import(pathToFileURL(process.env.WORKER_FILE).href)
const w = mod.default
const { WriteBudget } = mod
let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('PASS  ' + m)) : (fail++, console.log('FAIL  ' + m)) }

const post = (env, body) => w.fetch(new Request('https://x/subscribe', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP }, body: JSON.stringify(body) }), env)
const sub = (ep, keys) => ({ subscription: { endpoint: ep, keys: keys || mkKeys() }, teamId: 7, installId: 'install-' + Math.random().toString(36).slice(2) + 'xxxxxxxxxxxxxxxx' })
const storedRecord = env => JSON.parse(env.SUBS._m.get([...env.SUBS._m.keys()].find(k => k.startsWith('sub:'))))

console.log('--- the endpoint is bounded, not just host-checked ---')
let env = mkEnv(WriteBudget)
let r = await post(env, sub('https://fcm.googleapis.com/fcm/send/' + 'A'.repeat(2000)))
ok(r.status === 400, 'a 2 KB endpoint on an ALLOWED host -> 400')
ok(env.SUBS.ops.put === 0, '  and nothing is stored  [puts ' + env.SUBS.ops.put + ']')
console.log('      (picking three fields out of the body stopped a caller attaching')
console.log('       megabytes of extra ones; it never bounded the three it kept, and')
console.log('       GET /subs holds every record in one array for the cron)')
r = await post(env, sub(EP('ok1')))
ok(r.status === 200, 'a normal-length endpoint still registers')
ok(storedRecord(env).subscription.endpoint.length < 1024,
  '  stored endpoint is ' + storedRecord(env).subscription.endpoint.length + ' chars, inside the 1024 bound')

console.log('--- and so are the push keys ---')
env = mkEnv(WriteBudget)
const k = mkKeys()
ok((await post(env, sub(EP('b1'), { p256dh: 'A'.repeat(5000), auth: k.auth }))).status === 400,
  'a 5 KB p256dh -> 400, before the decoder is handed it')
ok((await post(env, sub(EP('b2'), { p256dh: k.p256dh, auth: 'A'.repeat(5000) }))).status === 400, 'a 5 KB auth -> 400')
ok((await post(env, sub(EP('b3'), { p256dh: k.p256dh, auth: Buffer.from(Array(120).fill(7)).toString('base64url') }))).status === 400,
  'an auth of 120 decoded bytes -> 400 (RFC 8291 says 16; the cap is 64)')
console.log('      (the decoder strips trailing = padding, so a length floor alone let')
console.log('       an arbitrarily long auth through — and the ORIGINAL string is stored)')
ok((await post(env, sub(EP('b4'), { p256dh: k.p256dh, auth: null }))).status === 400, 'a null auth -> 400')
ok((await post(env, sub(EP('b5'), { p256dh: 42, auth: k.auth }))).status === 400, 'a numeric p256dh -> 400')
ok(nSubs(env) === 0, '  none of those were stored  [' + nSubs(env) + ']')
r = await post(env, sub(EP('good'), k))
ok(r.status === 200 && nSubs(env) === 1, 'a real 65-byte key and 16-byte auth still registers')

console.log((fail ? 'FAILED ' : '') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
