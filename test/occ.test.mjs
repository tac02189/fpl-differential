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
const mkKV=()=>{const m=new Map();return{_m:m,get:async k=>m.get(k)??null,put:async(k,v)=>void m.set(k,v),delete:async k=>void m.delete(k),
  list:async({prefix='',limit=1000}={})=>{const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name})),list_complete:all.length<=limit}}}}
const b64=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const keys=()=>{const e=createECDH('prime256v1');e.generateKeys();return{p256dh:b64(e.getPublicKey()),auth:b64(randomBytes(16))}}
const SECRET='s3cret', IP='203.0.113.9', IP2='198.51.100.4'
const reg=(env,n,ip,inst,extra)=>w.fetch(new Request('https://x/subscribe',{method:'POST',
  headers:{'Content-Type':'application/json',...(ip?{'CF-Connecting-IP':ip}:{})},
  body:JSON.stringify({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+n,keys:keys(),...(extra||{})},
    teamId:7,device:'ios',installId:inst||randomUUID()})}),env)

// --- the limit is 12 ---
let env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
const codes=[]
for (let i=0;i<13;i++) codes.push((await reg(env,'a'+i,IP)).status)
ok(codes.slice(0,12).every(c=>c===200),'twelve records from one source -> 200')
ok(codes[12]===429,'thirteenth -> 429')
ok(nSubs(env)===12,'  store holds exactly twelve')
ok((await (await reg(env,'a99',IP)).json()).error==='too many subscriptions from this network','  distinct from the global cap error')
ok((await reg(env,'b0',IP2)).status===200,'a different source -> 200')

// --- IPv6: a whole /64 must count as ONE source (was: billions) ---
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
for (let i=0;i<12;i++) await reg(env,'v'+i,`2001:db8:1:2:aaaa::${i+1}`)
ok(nSubs(env)===12,'twelve from distinct addresses inside one /64 -> accepted')
let r=await reg(env,'v99','2001:db8:1:2:ffff::9')
ok(r.status===429,'a thirteenth address in the SAME /64 -> 429 (prefix counts once)')
ok((await reg(env,'w0','2001:db8:1:3:aaaa::1')).status===200,'a different /64 -> 200')

// --- a reinstall still does not block itself ---
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
const mine=randomUUID()
for (let i=0;i<11;i++) await reg(env,'c'+i,IP)
await reg(env,'cOLD',IP,mine)
ok(nSubs(env)===12,'precondition: twelve from this source, one of them ours')
r=await reg(env,'cNEW',IP,mine)
ok(r.status===200 && (await r.json()).replaced===1,'reinstall at the limit -> 200, retires its own')
ok(nSubs(env)===12,'  still twelve')

// --- oversized caller-supplied fields are not stored ---
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
await reg(env,'fat',IP,null,{junk:'x'.repeat(200000)})
const stored=subVals(env)[0]
ok(!stored.includes('xxxxxxxxxx'),'caller-supplied extra fields are dropped, not stored')
ok(stored.length<1000,'  stored record stays small ('+stored.length+' bytes)')
const rec=JSON.parse(stored)
ok(rec.subscription.endpoint && rec.subscription.keys.p256dh && rec.subscription.keys.auth,'  endpoint and both keys survive')
r=await reg(env,'fat',IP,null,{junk:'x'.repeat(200000)})
ok(r.status===200,'  re-sending the same fat body still succeeds')

// --- privacy and fail-open ---
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
await reg(env,'p0',IP)
const s0=JSON.parse(subVals(env)[0])
ok(typeof s0.ipHash==='string' && s0.ipHash.length===16 && !s0.ipHash.includes(IP),'ipHash stored, not the raw address')
r=await w.fetch(new Request('https://x/subs',{headers:{Authorization:'Bearer '+SECRET}}),env)
ok(!JSON.stringify(await r.json()).includes(s0.ipHash),'ipHash withheld from GET /subs')
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
for (let i=0;i<13;i++) await reg(env,'e'+i,null)
ok(nSubs(env)===13,'no CF-Connecting-IP -> check skipped (fails open)')
console.log(''); console.log(pass+' passed, '+fail+' failed'); process.exit(fail?1:0)
