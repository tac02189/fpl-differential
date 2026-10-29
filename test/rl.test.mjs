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
// KV stub that counts every operation, so we can prove a throttled request touches none
const mkKV=()=>{const m=new Map(); const n={get:0,put:0,del:0,list:0}; return {ops:n,_m:m,
  get:async k=>{n.get++;return m.get(k)??null}, put:async(k,v)=>{n.put++;m.set(k,v)}, delete:async k=>{n.del++;m.delete(k)},
  list:async({prefix='',limit=1000}={})=>{n.list++;const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name})),list_complete:all.length<=limit}}}}
const mkLimiter=(max)=>{const seen={}; return {calls:[], limit:async({key})=>{seen[key]=(seen[key]||0)+1; return {success:seen[key]<=max}}}}
const b64=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const ec=createECDH('prime256v1'); ec.generateKeys()
const KEYS={p256dh:b64(ec.getPublicKey()),auth:b64(randomBytes(16))}
const EP='https://fcm.googleapis.com/fcm/send/rl-test'
const call=(env,ip)=>w.fetch(new Request('https://x/subscribe',{method:'POST',
  headers:{'Content-Type':'application/json', ...(ip?{'CF-Connecting-IP':ip}:{})},
  body:JSON.stringify({subscription:{endpoint:EP,keys:KEYS},teamId:7,installId:randomUUID()})}),env)

// --- six requests from one IP against a 5/min limiter ---
let env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget(),SUBSCRIBE_LIMIT:mkLimiter(5)}
const codes=[]
for (let i=0;i<6;i++) codes.push((await call(env,'203.0.113.9')).status)
ok(codes.slice(0,5).every(c=>c===200),'first five from one IP -> 200  ['+codes.join(',')+']')
ok(codes[5]===429,'sixth -> 429')
const after={...env.SUBS.ops}
let r=await call(env,'203.0.113.9')
ok(r.status===429,'seventh also 429')
ok(JSON.stringify(env.SUBS.ops)===JSON.stringify(after),'  a throttled request performs ZERO KV operations')
ok((await r.json()).error==='too many requests','  distinguishable from the cap 429')

// --- a different IP has its own bucket ---
env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget(),SUBSCRIBE_LIMIT:mkLimiter(5)}
for (let i=0;i<5;i++) await call(env,'203.0.113.9')
ok((await call(env,'203.0.113.9')).status===429,'IP A exhausted -> 429')
ok((await call(env,'198.51.100.4')).status===200,'IP B unaffected -> 200')

// --- fail open ---
env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget(),SUBSCRIBE_LIMIT:mkLimiter(0)}
ok((await call(env,null)).status===200,'no CF-Connecting-IP -> not throttled (fails open)')
env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget()}
ok((await call(env,'203.0.113.9')).status===200,'binding absent -> not throttled (fails open)')
env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget(),SUBSCRIBE_LIMIT:{limit:async()=>{throw new Error('limiter down')}}}
ok((await call(env,'203.0.113.9')).status===200,'limiter throwing -> not throttled (fails open)')

// --- other routes unaffected ---
env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget(),SUBSCRIBE_LIMIT:mkLimiter(0)}
r=await w.fetch(new Request('https://x/subs',{headers:{'CF-Connecting-IP':'203.0.113.9',Authorization:'Bearer s'}}),env)
ok(r.status===200,'/subs not throttled by the subscribe limiter')
r=await w.fetch(new Request('https://x/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9'},body:JSON.stringify({endpoint:EP})}),env)
ok(r.status===429,'/unsubscribe IS throttled for anonymous callers (quota defence)')
r=await w.fetch(new Request('https://x/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.9',Authorization:'Bearer s'},body:JSON.stringify({endpoint:EP})}),env)
ok(r.status===200,'  but the cron bypasses that throttle with the bearer')
console.log(''); console.log(pass+' passed, '+fail+' failed'); process.exit(fail?1:0)
