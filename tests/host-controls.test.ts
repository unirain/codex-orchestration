import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import {Host} from '../src/host/runtime.ts'
import {terminalTrigger} from '../src/domain.ts'
test('terminal trace resolves the original request, mandate, report and a single ended receipt',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'orch-evidence-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const h=new Host({repoDir:dir,repository:'org/demo',actor:'me',provider:'deepseek',codex:'/unused',modelKeyEnv:'TEST_KEY',image:'unused:fixture'},dir)
  t.after(()=>h.close())
  const {engine,store}=h.domain
  engine.receive(terminalTrigger('one','Change mail validation','me'));engine.evaluateDue()
  const decision=engine.decide('one',{kind:'accept',title:'Mail',scope:'Validate addresses',reason:'Explicit request',evalId:engine.candidate('one')!.evalId})
  const ticket=store.tickets.get(decision.ticketId!)!,assignment=ticket.assignments[0].id
  engine.assignmentStarted(ticket.id,assignment)
  engine.bindThread(ticket.id,{source:'github',id:'org/demo/pull/1'},true)
  engine.report(ticket.id,{state:'ready',summary:'Validation passes'})
  for(let i=0;i<2;i++)engine.threadClosed({source:'github',id:'org/demo/pull/1'},'merged','2026-11-25T00:00:00Z')
  await h.tick()
  const result:any=await h.command('trace',{trigger:'one'})
  assert.equal(result.trigger.text,'Change mail validation')
  assert.equal(result.tickets[0].mandate.scope,'Validate addresses')
  assert.equal(result.tickets[0].history[0].value.state,'ready')
  assert.equal(result.channel.filter((m:any)=>m.text.includes('ended/merged')).length,1)
})
test('set role model without changing an already bound session',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'orch-model-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const h=new Host({repoDir:dir,repository:'org/demo',actor:'me',provider:'openai',codex:'/unused',modelKeyEnv:'TEST_KEY',image:'unused:fixture'},dir)
  t.after(()=>h.close())
  h.domain.db.prepare('INSERT INTO host_sessions VALUES(?,?,?,?)').run('old-worker','old-thread','old-model','default')
  await h.command('role-model',{role:'worker',model:'next-model'})
  assert.equal(h.domain.db.prepare("SELECT model FROM host_sessions WHERE owner='old-worker'").get()!.model,'old-model')
  assert.equal(h.domain.db.prepare("SELECT value FROM host_settings WHERE id='model:worker'").get()!.value,'next-model')
  await assert.rejects(h.command('role-model',{role:'other',model:'x'}),/role/)
})

test('AC-018/038: host retries definite pre-turn overload after 15/30/60 s and records exhaustion',async t=>{
  const {RpcError}=await import('../src/codex/session.ts')
  const dir=mkdtempSync(join(tmpdir(),'orch-retry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const h=new Host({repoDir:dir,repository:'org/demo',actor:'me',provider:'openai',codex:'/unused',modelKeyEnv:'TEST_KEY',image:'unused:fixture'},dir)
  t.after(()=>h.close())
  const d=h.domain
  d.engine.receive(terminalTrigger('retry','Fix mail','me'));d.engine.evaluateDue()
  const result=d.engine.decide('retry',{kind:'accept',title:'Mail',scope:'Mail',reason:'direct',evalId:d.engine.candidate('retry')!.evalId})
  let attempts=0
  const session={startTurn:async()=>{attempts++;throw new RpcError('turn/start',{code:-32001,message:'server overloaded'})}}
  // A rejected RPC is definitive. Exercise the production effect and timer loop with a deterministic port.
  Object.assign(h,{session:async()=>({session})})
  for(const wait of [15000,30000,60000]){
    const before=Date.now()
    await h.tick()
    const row=d.db.prepare("SELECT due,state FROM host_turns WHERE owner=?").get(result.ticketId!)!
    assert.equal(row.state,'retry');assert.ok(Number(row.due)>=before+wait&&Number(row.due)<=Date.now()+wait)
    d.db.prepare("UPDATE host_turns SET due=0 WHERE owner=?").run(result.ticketId!)
  }
  await h.tick()
  assert.equal(attempts,4);assert.equal(h.supervision.isPaused(result.ticketId!),true)
  assert.equal(d.db.prepare('SELECT state FROM host_turns WHERE owner=?').get(result.ticketId!)!.state,'failed')
  assert.equal(h.supervision.occupied(),0)
})
