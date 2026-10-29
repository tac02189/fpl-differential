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
const mkKV=(init={})=>{const m=new Map(Object.entries(init));return{
  get:async k=>(m.has(k)?m.get(k):null), put:async(k,v)=>void m.set(k,v), delete:async k=>void m.delete(k),
  list:async({prefix='',limit=1000}={})=>{const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name})),list_complete:all.length<=limit}}, _m:m}}
const b64=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const ec=createECDH('prime256v1'); ec.generateKeys()
const KEYS={p256dh:b64(ec.getPublicKey()),auth:b64(randomBytes(16))}
const ZEROS={p256dh:b64(Buffer.alloc(65)),auth:b64(Buffer.alloc(16))}   // Codex's filler
const EP=n=>`https://fcm.googleapis.com/fcm/send/${n}`
const sub=async(body)=>{const env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget()};
  const r=await w.fetch(new Request('https://x/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  return {status:r.status, json:await r.json(), env}}

// --- poisoned teamId must never reach storage (it kills the cron) ---
for (const [label,tid] of [['{toString:null}',{toString:null}],['array',[1]],['object',{a:1}],
                           ['negative',-5],['float',1.5],['huge',1e15],['non-numeric string','abc']]) {
  const {env}=await sub({subscription:{endpoint:EP('t'+label),keys:KEYS},teamId:tid,installId:randomUUID()})
  const stored=JSON.parse(subVals(env)[0])
  ok(stored.teamId===null, `teamId ${label} -> stored as null`)
}
let {env}=await sub({subscription:{endpoint:EP('good'),keys:KEYS},teamId:'3439162',installId:randomUUID()})
let stored=JSON.parse(subVals(env)[0])
ok(stored.teamId===3439162,'numeric-string teamId -> stored as the number 3439162')

// --- all-zero keys: 65 and 16 bytes, right lengths, not a real point ---
let r=await sub({subscription:{endpoint:EP('zeros'),keys:ZEROS},teamId:1,installId:randomUUID()})
ok(r.status===400,'all-zero keys (correct byte lengths) -> 400, cannot squat a slot')
r=await sub({subscription:{endpoint:EP('real'),keys:KEYS},teamId:1,installId:randomUUID()})
ok(r.status===200,'  a real P-256 point still accepted')

// --- installId is never downgraded to null by a storage-blocked client ---
const inst=randomUUID()
const e2={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget()}
const call=(b)=>w.fetch(new Request('https://x/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),e2)
await call({subscription:{endpoint:EP('keep'),keys:KEYS},teamId:7,device:'ios',installId:inst})
await call({subscription:{endpoint:EP('keep'),keys:KEYS},teamId:8,device:'ios'})   // same endpoint, no installId
const kept=JSON.parse(subVals(e2)[0])
ok(kept.installId===inst,'re-registration without an installId keeps the stored one')
ok(kept.teamId===8,'  but the rest of the record still updates')

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
