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
const mkKV=()=>{const m=new Map();return{get:async k=>m.get(k)??null,put:async(k,v)=>void m.set(k,v),delete:async k=>void m.delete(k),
  list:async({prefix='',limit=1000}={})=>{const all=[...m.keys()].filter(k=>k.startsWith(prefix));
    return {keys:all.slice(0,limit).map(name=>({name})),list_complete:all.length<=limit}},_m:m}}
const b64=x=>x.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const ec=createECDH('prime256v1'); ec.generateKeys()
const REAL={p256dh:b64(ec.getPublicKey()),auth:b64(randomBytes(16))}
const z=Buffer.alloc(65); z[0]=4
const OFFCURVE={p256dh:b64(z),auth:b64(randomBytes(16))}                       // 65B, 0x04, not on curve
const OFFCURVE2={p256dh:b64(Buffer.concat([Buffer.from([4]),randomBytes(64)])),auth:b64(randomBytes(16))}
const post=async(keys,label)=>{const env={SUBS:mkKV(),SUBS_SECRET:'s',BUDGET:mkBudget()}
  const r=await w.fetch(new Request('https://x/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+label,keys},teamId:7,installId:randomUUID()})}),env)
  return {status:r.status, stored:nSubs(env)}}

let r=await post(REAL,'real');      ok(r.status===200 && r.stored===1,'a real P-256 point -> 200, stored')
r=await post(OFFCURVE,'zeros');     ok(r.status===400 && r.stored===0,'0x04 + 64 zeros (passes length AND marker) -> 400, not stored')
r=await post(OFFCURVE2,'random');   ok(r.status===400 && r.stored===0,'0x04 + 64 random bytes -> 400, not stored')
r=await post({p256dh:REAL.p256dh,auth:b64(randomBytes(8))},'shortauth'); ok(r.status===400,'short auth still rejected')
r=await post(undefined,'nokeys');   ok(r.status===400,'no keys still rejected')
console.log(''); console.log(pass+' passed, '+fail+' failed'); process.exit(fail?1:0)
