import { pathToFileURL } from 'node:url'
import { createECDH, randomBytes, randomUUID, createHash } from 'node:crypto'
const w = (await import(pathToFileURL(process.env.WORKER_FILE).href)).default
const { WriteBudget: _WB } = await import(pathToFileURL(process.env.WORKER_FILE).href)
// A Durable Object stub: real serialization, in-memory storage. Each env gets its
// own instance, so suites cannot spend each other's budget.
// Rebuild admission is gated by the object, so a test that simulates five minutes
// passing — or wipes the index — has to move that clock too, or no rebuild is
// granted and the assertion measures the gate instead of the rebuild.
const clearCooldown = e => { const b = e.BUDGET._state._store.get("b"); if (b) e.BUDGET._state._store.set("b", { ...b, lastRebuild: 0 }) }
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
const SUBINDEX='meta:subindex'
// A KV stub that behaves like the real thing: put stores metadata, list returns it.
const mkKV=()=>{const m=new Map(), meta=new Map(); const ops={get:0,list:0,put:0,del:0}; return {ops,_m:m,_meta:meta,
  get:async k=>{ops.get++;return m.get(k)??null},
  put:async(k,v,o)=>{ops.put++;m.set(k,v); if(o&&o.metadata!==undefined) meta.set(k,o.metadata); else meta.delete(k)},
  delete:async k=>{ops.del++;m.delete(k);meta.delete(k)},
  list:async({prefix='',limit=1000}={})=>{ops.list++;const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name, ...(meta.has(name)?{metadata:meta.get(name)}:{})})), list_complete:all.length<=limit}}}}
const b64=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const keys=()=>{const e=createECDH('prime256v1');e.generateKeys();return{p256dh:b64(e.getPublicKey()),auth:b64(randomBytes(16))}}
const SECRET='s3cret', IP='203.0.113.9'
const reg=(env,n,ip,inst)=>w.fetch(new Request('https://x/subscribe',{method:'POST',
  headers:{'Content-Type':'application/json',...(ip?{'CF-Connecting-IP':ip}:{})},
  body:JSON.stringify({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+n,keys:keys()},teamId:7,device:'ios',installId:inst||randomUUID()})}),env)

// --- metadata is written, and the sweep then reads it without touching values ---
let env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
for (let i=0;i<10;i++) await reg(env,'m'+i,IP)
const md=env.SUBS._meta.get(subKeys(env)[0])
ok(md && typeof md.installId==='string' && typeof md.ipHash==='string','put attaches {installId, ipHash} metadata')
ok(JSON.stringify(md).length<200,'  metadata is small ('+JSON.stringify(md).length+' bytes, KV allows 1024)')

const before={...env.SUBS.ops}
await reg(env,'m99',IP,randomUUID())
const used={get:env.SUBS.ops.get-before.get, list:env.SUBS.ops.list-before.list}
ok(used.list===0,'one registration against 10 stored records -> 0 lists (the index is fresh)  [got '+used.list+']')
ok(used.get===2,'  2 gets: the index and the existing-key probe  [got '+used.get+']')

// Metadata's payoff moved to the rebuild: that is the only place values would
// otherwise be fetched, and it is where an attacker could force repeated work.
const stale=JSON.parse(env.SUBS._m.get(SUBINDEX)); stale.t=Date.now()-10*60*1000
env.SUBS._m.set(SUBINDEX,JSON.stringify(stale)); clearCooldown(env)
const b1={...env.SUBS.ops}
await reg(env,'m98',IP,randomUUID())
const r1={get:env.SUBS.ops.get-b1.get, list:env.SUBS.ops.list-b1.list}
ok(r1.list===1,'a rebuild spends exactly 1 list  [got '+r1.list+']')
ok(r1.get===2,'  and still only 2 gets — metadata means the 11 values are never read  [got '+r1.get+']')

// --- the same work before metadata would have cost a get per record ---
const legacy=()=>{const m=new Map(); const ops={get:0,list:0,put:0,del:0}; return {ops,_m:m,
  get:async k=>{ops.get++;return m.get(k)??null}, put:async(k,v)=>{ops.put++;m.set(k,v)}, delete:async k=>{ops.del++;m.delete(k)},
  list:async({prefix='',limit=1000}={})=>{ops.list++;const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name})),list_complete:all.length<=limit}}}}
env={SUBS:legacy(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
for (let i=0;i<10;i++) await reg(env,'L'+i,IP)
const b2={...env.SUBS.ops}
await reg(env,'L99',IP,randomUUID())
const u2={get:env.SUBS.ops.get-b2.get, list:env.SUBS.ops.list-b2.list}
ok(u2.get===2,'without metadata, a registration between rebuilds still costs just 2 gets  [got '+u2.get+']')
ok(u2.list===0,'  and no list  [got '+u2.list+']')
const s2=JSON.parse(env.SUBS._m.get(SUBINDEX)); s2.t=Date.now()-10*60*1000
env.SUBS._m.set(SUBINDEX,JSON.stringify(s2)); clearCooldown(env)
const b3={...env.SUBS.ops}
await reg(env,'L98',IP,randomUUID())
const u3={get:env.SUBS.ops.get-b3.get, list:env.SUBS.ops.list-b3.list}
ok(u3.list===1 && u3.get>=12,'  but ITS rebuild fetches every value: 1 list + '+u3.get+' gets, against 2 with metadata')

// --- and the fallback is still CORRECT, not just cheap ---
env={SUBS:legacy(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
const mine=randomUUID()
await reg(env,'old',IP,mine)
let r=await reg(env,'new',IP,mine)
ok((await r.json()).replaced===1,'legacy record (no metadata) is still retired by its own install')
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
await reg(env,'old2',IP,mine)
r=await reg(env,'new2',IP,mine)
ok((await r.json()).replaced===1,'metadata record is retired by its own install')

// --- a legacy record upgrades itself on rewrite ---
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
const E='https://fcm.googleapis.com/fcm/send/upg'
const kv='sub:'+createHash('sha256').update(E).digest('hex')
env.SUBS._m.set(kv, JSON.stringify({subscription:{endpoint:E,keys:keys()},teamId:1,device:'ios'}))  // no metadata
ok(!env.SUBS._meta.has(kv),'precondition: stored without metadata')
await w.fetch(new Request('https://x/subscribe',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':IP},
  body:JSON.stringify({subscription:{endpoint:E,keys:keys()},teamId:2,device:'ios',installId:randomUUID()})}),env)
ok(env.SUBS._meta.has(kv),'re-registering a legacy record attaches metadata (self-healing)')

// --- occupancy and retirement still behave via metadata ---
env={SUBS:mkKV(),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
const codes=[]
for (let i=0;i<13;i++) codes.push((await reg(env,'c'+i,IP)).status)
ok(codes.slice(0,12).every(c=>c===200) && codes[12]===429,'per-source cap of 12 still enforced from metadata')
console.log(''); console.log(pass+' passed, '+fail+' failed'); process.exit(fail?1:0)
