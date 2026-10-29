import { pathToFileURL } from 'node:url'
import { createHash, createECDH, randomBytes, randomUUID } from 'node:crypto'
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
const mkKV=(init={})=>{const m=new Map(Object.entries(init));return{
  get:async k=>(m.has(k)?m.get(k):null), put:async(k,v)=>void m.set(k,v), delete:async k=>void m.delete(k),
  list:async({prefix='',limit=1000}={})=>{const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name})),list_complete:all.length<=limit}},
  _m:m}}
const b64=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const ec=createECDH('prime256v1'); ec.generateKeys()
const KEYS={p256dh:b64(ec.getPublicKey()),auth:b64(randomBytes(16))}
const SECRET='s'
const ep=n=>`https://fcm.googleapis.com/fcm/send/dev${n}`
const kv=s=>'sub:'+createHash('sha256').update(s).digest('hex')
const rec=(e,t,d,i)=>JSON.stringify({subscription:{endpoint:e,keys:KEYS},teamId:t,device:d,installId:i})
const post=(env,b)=>w.fetch(new Request('https://x/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),env)
const MINE=randomUUID()

// --- FULL store (50) where one entry is this install's own earlier registration ---
let init={}
for (let i=0;i<49;i++) init[kv(ep(i))]=rec(ep(i), 100+i, 'android', randomUUID())
init[kv(ep(99))]=rec(ep(99), 7, 'ios', MINE)
let env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
ok(nSubs(env)===50,'precondition: store is full (50)')
let r=await post(env,{subscription:{endpoint:ep('NEW'),keys:KEYS},teamId:7,device:'ios',installId:MINE})
let b=await r.json()
ok(r.status===200 && b.replaced===1,'full store, reinstall reclaims its own slot -> 200')
ok(nSubs(env)===50,'  store did not grow: still 50')
ok(!env.SUBS._m.has(kv(ep(99))) && env.SUBS._m.has(kv(ep('NEW'))),'  own old entry retired, new one stored')

// --- FULL store, a DIFFERENT install: must reject, and delete nothing ---
init={}
for (let i=0;i<50;i++) init[kv(ep(i))]=rec(ep(i), 100+i, 'android', randomUUID())
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
const before=subKeys(env).sort().join(',')
r=await post(env,{subscription:{endpoint:ep('NEW'),keys:KEYS},teamId:555,device:'ios',installId:randomUUID()})
ok(r.status===429,'full store, unrelated install -> 429')
ok(subKeys(env).sort().join(',')===before,'  rejected request deleted nothing')

// --- FULL store, same TEAM but a different install: must not evict at the cap either ---
init={}
for (let i=0;i<49;i++) init[kv(ep(i))]=rec(ep(i), 100+i, 'android', randomUUID())
init[kv(ep(99))]=rec(ep(99), 7, 'ios', MINE)
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
r=await post(env,{subscription:{endpoint:ep('NEW'),keys:KEYS},teamId:7,device:'ios',installId:randomUUID()})
ok(r.status===429,'full store, same team but different install -> 429')
ok(env.SUBS._m.has(kv(ep(99))),'  the other install was NOT evicted by a rejected request')

// --- room to spare ---
init={}; for (let i=0;i<5;i++) init[kv(ep(i))]=rec(ep(i),100+i,'android',randomUUID())
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
r=await post(env,{subscription:{endpoint:ep('NEW'),keys:KEYS},teamId:555,device:'ios',installId:randomUUID()})
ok(r.status===200 && nSubs(env)===6,'store with room -> 200, stored')

// --- truncated page must not be used for the subtraction ---
init={}
for (let i=0;i<81;i++) init[kv(ep('t'+i))]=rec(ep('t'+i), 7, 'ios', MINE)
for (let i=0;i<20;i++) init[kv(ep('u'+i))]=rec(ep('u'+i), 500+i, 'android', randomUUID())
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
ok(nSubs(env)===101,'precondition: oversized store (101)')
ok((await env.SUBS.list({prefix:'sub:',limit:100})).list_complete===false,'precondition: page truncated')
r=await post(env,{subscription:{endpoint:ep('NEW'),keys:KEYS},teamId:7,device:'ios',installId:MINE})
ok(r.status===429,'truncated page -> 429 (no subtraction on an undercount)')
ok(nSubs(env)===101,'  nothing deleted on that rejection')

// --- a stored "null" must not 500 the registration ---
init={}
for (let i=0;i<49;i++) init[kv(ep(i))]=rec(ep(i), 100+i, 'android', randomUUID())
init[kv(ep(98))]='null'
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
let threw=false
try { r=await post(env,{subscription:{endpoint:ep('NEW'),keys:KEYS},teamId:7,device:'ios',installId:MINE}) } catch { threw=true }
ok(!threw && r.status===429,'stored "null" -> clean 429, not a throw')

init={}; init[kv(ep(98))]='null'; init[kv(ep(1))]=rec(ep(1),7,'ios',MINE)
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
threw=false
try { r=await post(env,{subscription:{endpoint:ep('NEW'),keys:KEYS},teamId:7,device:'ios',installId:MINE}) } catch { threw=true }
ok(!threw && r.status===200,'null record skipped, registration still succeeds')
ok(env.SUBS._m.has(kv(ep(98))),'  the null record was left alone')

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
