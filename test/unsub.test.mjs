import { pathToFileURL } from 'node:url'
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
const w = (await import(pathToFileURL(process.env.WORKER_FILE).href)).default
const { WriteBudget: _WB } = await import(pathToFileURL(process.env.WORKER_FILE).href)
// A Durable Object stub: real serialization, in-memory storage. Each env gets its
// own instance, so suites cannot spend each other's budget.
const mkBudget = () => {
  const store = new Map(); let chain = Promise.resolve()
  const state = { _store: store,
    storage: { get: async k => structuredClone(store.get(k)),
               put: async (k, v) => { store.set(k, structuredClone(v)) } },
    blockConcurrencyWhile: fn => { const r = chain.then(fn); chain = r.then(() => {}, () => {}); return r } }
  const inst = new _WB(state)
  return { _state: state, idFromName: n => n,
           get: () => ({ fetch: (u, i) => inst.fetch(new Request(u, i)) }) }
}
let pass=0, fail=0
const ok=(c,m)=>{c?(pass++,console.log('PASS  '+m)):(fail++,console.log('FAIL  '+m))}
const _isSub = k => k.startsWith('sub:')
const nSubs = e => [...e.SUBS._m.keys()].filter(_isSub).length
const subKeys = e => [...e.SUBS._m.keys()].filter(_isSub)
const subVals = e => [...e.SUBS._m.entries()].filter(([k]) => _isSub(k)).map(([, v]) => v)

const mkKV=()=>{const m=new Map(), meta=new Map(); const n={get:0,put:0,del:0,list:0}; return {ops:n,_m:m,
  get:async k=>{n.get++;return m.get(k)??null},
  put:async(k,v,o)=>{n.put++;m.set(k,v); if(o&&o.metadata!==undefined) meta.set(k,o.metadata)},
  delete:async k=>{n.del++;m.delete(k);meta.delete(k)},
  list:async({prefix='',limit=1000}={})=>{n.list++;const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name, ...(meta.has(name)?{metadata:meta.get(name)}:{})})),list_complete:all.length<=limit}}}}
const mkLimiter=max=>{const seen={}; return {limit:async({key})=>{seen[key]=(seen[key]||0)+1; return {success:seen[key]<=max}}}}
const total=o=>o.get+o.put+o.del+o.list

const b64=x=>x.toString('base64url')
const mkKeys=()=>{const e=createECDH('prime256v1');e.generateKeys();return{p256dh:b64(e.getPublicKey()),auth:b64(randomBytes(16))}}
const SECRET='s3cret', IP='203.0.113.9'
const EP=n=>'https://fcm.googleapis.com/fcm/send/'+n
const fresh=(limit=1000)=>({SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget(),SUBSCRIBE_LIMIT:mkLimiter(limit)})

const sub=(env,n,ip)=>w.fetch(new Request('https://x/subscribe',{method:'POST',
  headers:{'Content-Type':'application/json',...(ip?{'CF-Connecting-IP':ip}:{})},
  body:JSON.stringify({subscription:{endpoint:EP(n),keys:mkKeys()},teamId:7,installId:randomUUID()})}),env)
const unsub=(env,endpoint,o={})=>w.fetch(new Request('https://x/unsubscribe',{method:'POST',
  headers:{'Content-Type':'application/json',...((o.ip===null?null:o.ip||IP)?{'CF-Connecting-IP':o.ip||IP}:{}),
           ...(o.bearer?{Authorization:'Bearer '+o.bearer}:{})},
  body:JSON.stringify({endpoint})}),env)

console.log('--- the quota burn itself ---')
let env=fresh()
let b={...env.SUBS.ops}
for(let i=0;i<50;i++) await unsub(env,EP('ghost'+i))
ok(env.SUBS.ops.del-b.del===0,'50 unsubscribes naming endpoints that were never stored -> 0 KV deletes  [got '+(env.SUBS.ops.del-b.del)+']')
ok(env.SUBS.ops.get-b.get===50,'  they spend 50 reads instead; reads have ~100x the daily budget  [got '+(env.SUBS.ops.get-b.get)+']')

env=fresh()
let r=await unsub(env,'https://evil.example.com/x')
ok(r.status===400,'an endpoint that is not a real push host -> 400')
ok(total(env.SUBS.ops)===0,'  and ZERO KV operations of any kind  [got '+total(env.SUBS.ops)+']')
r=await w.fetch(new Request('https://x/unsubscribe',{method:'POST',headers:{'CF-Connecting-IP':IP},body:'not json'}),env)
ok(r.status===400 && total(env.SUBS.ops)===0,'a malformed body -> 400, still zero KV operations')

console.log('--- the PWA must keep working with no Authorization header ---')
env=fresh()
await sub(env,'pwa',IP)
ok(nSubs(env)===1,'a device registers')
r=await unsub(env,EP('pwa'))
ok(r.status===200 && (await r.json()).ok===true,'disablePush() unsubscribes with NO Authorization header')
ok(nSubs(env)===0,'  and the record is actually gone')

env=fresh()
await sub(env,'real',IP)
const hit=await (await unsub(env,EP('real'))).text()
const miss=await (await unsub(env,EP('never'))).text()
ok(hit===miss,'a hit and a miss return byte-identical bodies -> no registration oracle  ['+hit+']')

console.log('--- throttle, and the bearer that bypasses it ---')
env=fresh(5)
const codes=[]
for(let i=0;i<7;i++) codes.push((await unsub(env,EP('t'+i))).status)
ok(codes.slice(0,5).every(c=>c===200),'first five anonymous unsubscribes -> 200  ['+codes.join(',')+']')
ok(codes[5]===429 && codes[6]===429,'  sixth and seventh -> 429')
let t0={...env.SUBS.ops}
r=await unsub(env,EP('t9'))
ok(total(env.SUBS.ops)===total(t0),'  a throttled unsubscribe performs ZERO KV operations')
ok((await r.json()).error==='too many requests','  with the throttle error, not the cap one')
await sub(env,'cron1',IP)
r=await unsub(env,EP('cron1'),{bearer:SECRET})
ok(r.status===200,'the cron gets through while anonymous callers from the same IP are throttled')
ok(nSubs(env)===0,'  and its prune really deleted the record')

console.log('--- the authenticated path skips every guard, on purpose ---')
env=fresh()
b={...env.SUBS.ops}
await unsub(env,EP('nothere'),{bearer:SECRET})
ok(env.SUBS.ops.get-b.get===1,'an authenticated prune reads only the index, never the record it deletes  [got '+(env.SUBS.ops.get-b.get)+']')
ok(env.SUBS.ops.del-b.del===1,'  it deletes unconditionally, so a stale KV read cannot silently skip a prune')
r=await unsub(env,'https://legacy-host.example/old',{bearer:SECRET})
ok(r.status===200,'the cron can prune a record whose host is no longer in the allow-list')
r=await w.fetch(new Request('https://x/unsubscribe',{method:'POST',
  headers:{'Content-Type':'application/json',Authorization:'Bearer '+SECRET},body:JSON.stringify({})}),env)
ok(r.status===400,'the authenticated path still demands an endpoint')

console.log('--- a wrong bearer is simply anonymous ---')
env=fresh(5)
for(let i=0;i<6;i++) await unsub(env,EP('w'+i),{bearer:'wrong'})
r=await unsub(env,EP('w9'),{bearer:'wrong'})
ok(r.status===429,'a WRONG bearer is throttled like anyone else')
env=fresh()
b={...env.SUBS.ops}
await unsub(env,EP('w'),{bearer:'wrong'})
ok(env.SUBS.ops.del-b.del===0,'  and existence-checked, so it cannot burn a delete')
env={SUBS:mkKV(),SUBSCRIBE_LIMIT:mkLimiter(1000)}
b={...env.SUBS.ops}
await unsub(env,EP('ns'),{bearer:'anything'})
ok(env.SUBS.ops.del-b.del===0,'with no SUBS_SECRET configured, no bearer grants the bypass')

console.log('--- the two throttle buckets are independent ---')
env=fresh(5)
for(let i=0;i<5;i++) await unsub(env,EP('b'+i))
r=await unsub(env,EP('b9'))
ok(r.status===429,'the unsubscribe bucket is exhausted')
r=await sub(env,'stillfine',IP)
ok(r.status===200,'  registration from the same IP is unaffected')

console.log('--- hoisting the auth check did not disturb the authed routes ---')
env=fresh()
await sub(env,'s1',IP)
r=await w.fetch(new Request('https://x/subs'),env)
ok(r.status===401,'GET /subs without a bearer -> 401')
r=await w.fetch(new Request('https://x/subs',{headers:{Authorization:'Bearer '+SECRET}}),env)
ok(r.status===200 && (await r.json()).length===1,'  with the bearer -> 200 and the record')
r=await w.fetch(new Request('https://x/state',{headers:{Authorization:'Bearer '+SECRET}}),env)
ok(r.status===200,'GET /state with the bearer -> 200')

console.log((fail?'FAILED ':'')+pass+' passed, '+fail+' failed')
process.exit(fail?1:0)
