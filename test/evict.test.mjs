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
const ep=n=>`https://fcm.googleapis.com/fcm/send/${n}`
const kv=s=>'sub:'+createHash('sha256').update(s).digest('hex')
const rec=(e,t,d,i)=>JSON.stringify({subscription:{endpoint:e,keys:KEYS},teamId:t,device:d,installId:i})
const post=(env,b)=>w.fetch(new Request('https://x/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),env)

const VICTIM_TEAM = 3439162          // a real, public FPL team id — the whole point
const victimInstall = randomUUID()
const attackerInstall = randomUUID()

// ---- THE ATTACK: attacker holds a valid push subscription of their own and posts
// ---- the victim's public team id with no device, which previously matched everything.
let init={
  [kv(ep('victim-phone'))]: rec(ep('victim-phone'), VICTIM_TEAM, 'ios',     victimInstall),
  [kv(ep('victim-mac'))]:   rec(ep('victim-mac'),   VICTIM_TEAM, 'mac',     victimInstall),
}
let env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
let r=await post(env,{subscription:{endpoint:ep('attacker'),keys:KEYS},teamId:VICTIM_TEAM})
let b=await r.json()
ok(r.status===200,'attack request itself is accepted (it is a valid subscription)')
ok(b.replaced===0,'  but it retired NOTHING (was: replaced both victim records)')
ok(env.SUBS._m.has(kv(ep('victim-phone'))) && env.SUBS._m.has(kv(ep('victim-mac'))),
   '  both victim registrations survive')

// ---- attacker supplies their OWN installId plus the victim's team: still can't touch them
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
r=await post(env,{subscription:{endpoint:ep('attacker2'),keys:KEYS},teamId:VICTIM_TEAM,device:'ios',installId:attackerInstall})
ok((await r.json()).replaced===0,'attacker with own installId + victim team retires nothing')
ok(nSubs(env)===3,'  victim records intact, attacker record added')

// ---- attacker guesses a device kind too: still nothing
env={SUBS:mkKV(init),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
r=await post(env,{subscription:{endpoint:ep('attacker3'),keys:KEYS},teamId:VICTIM_TEAM,device:'mac'})
ok((await r.json()).replaced===0,'attacker guessing the device kind retires nothing')

// ---- LEGITIMATE: same install, fresh endpoint -> its own old record is retired
env={SUBS:mkKV({[kv(ep('old'))]: rec(ep('old'), VICTIM_TEAM, 'ios', victimInstall)}),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
r=await post(env,{subscription:{endpoint:ep('new'),keys:KEYS},teamId:VICTIM_TEAM,device:'ios',installId:victimInstall})
ok((await r.json()).replaced===1,'same installId, new endpoint -> own old record retired')
ok(!env.SUBS._m.has(kv(ep('old'))) && env.SUBS._m.has(kv(ep('new'))),'  old gone, new stored')

// ---- the benign bug: two iPhones, same team, same device kind, different installs
env={SUBS:mkKV({[kv(ep('phone1'))]: rec(ep('phone1'), VICTIM_TEAM, 'ios', victimInstall)}),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
r=await post(env,{subscription:{endpoint:ep('phone2'),keys:KEYS},teamId:VICTIM_TEAM,device:'ios',installId:randomUUID()})
ok((await r.json()).replaced===0,'second iPhone on the same team retires nothing (was: evicted the first)')
ok(nSubs(env)===2,'  both phones registered')

// ---- fails closed: no installId, or a malformed one, retires nothing
for (const [label,id] of [['absent',undefined],['empty',''],['too short','abc'],
                          ['bad charset','../../etc/passwd!!!!!!!!'],['not a string',12345678901234567]]) {
  env={SUBS:mkKV({[kv(ep('other'))]: rec(ep('other'), VICTIM_TEAM, 'ios', victimInstall)}),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
  r=await post(env,{subscription:{endpoint:ep('x'+label),keys:KEYS},teamId:VICTIM_TEAM,installId:id})
  const got=(await r.json()).replaced
  ok(got===0,`installId ${label} -> retires nothing (fails closed)`)
}

// ---- a record stored before installId existed is never matched by anyone
env={SUBS:mkKV({[kv(ep('legacy'))]: JSON.stringify({subscription:{endpoint:ep('legacy'),keys:KEYS},teamId:VICTIM_TEAM,device:'ios'})}),SUBS_SECRET:SECRET,BUDGET:mkBudget()}
r=await post(env,{subscription:{endpoint:ep('newcomer'),keys:KEYS},teamId:VICTIM_TEAM,device:'ios',installId:randomUUID()})
ok((await r.json()).replaced===0,'legacy record with no installId is not retired by a stranger')
ok(env.SUBS._m.has(kv(ep('legacy'))),'  legacy record survives')

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
