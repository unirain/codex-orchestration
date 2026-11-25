import assert from 'node:assert/strict'
import test from 'node:test'
import { key } from '../src/core/ids.ts'
import { recoverOwner } from '../src/host/recovery.ts'
import { domainFixture } from './support/domain.ts'

function fixture(started = true) {
  const h = domainFixture()
  const {d,receive,accept}=h
  const db=d.db
  db.exec(`
    CREATE TABLE host_recovery(owner TEXT PRIMARY KEY);
    CREATE TABLE host_sessions(owner TEXT PRIMARY KEY,thread TEXT UNIQUE,model TEXT,source TEXT);
    CREATE TABLE host_turns(id TEXT PRIMARY KEY,owner TEXT,assignment TEXT,ids TEXT,text TEXT,turn TEXT,state TEXT,attempt INTEGER DEFAULT 0,due INTEGER DEFAULT 0);
  `)
  receive('one','first task');d.engine.evaluateDue()
  const owner=accept('one','task').ticketId!
  const assignment=d.store.tickets.get(owner)!.assignments[0].id
  if (started) d.engine.assignmentStarted(owner,assignment)
  db.prepare("INSERT INTO host_sessions VALUES(?,'thread-w',NULL,'runtime')").run(owner)
  const mark=(who=owner)=>db.prepare('INSERT OR IGNORE INTO host_recovery VALUES(?)').run(who)
  mark()
  function prepared(id:string,ids:string[],state='prepared',turn:string|null=null) {
    db.prepare('INSERT INTO host_turns(id,owner,assignment,ids,text,turn,state) VALUES(?,?,?,?,?,?,?)')
      .run(id,owner,assignment,JSON.stringify(ids),'payload',turn,state)
  }
  return {...h,owner,assignment,mark,prepared}
}
const remote = (id:string, dispatch:string, status='completed', attempt=0) =>
  ({id,status,itemsView:'full',items:[{type:'userMessage',clientId:key('turn-input',dispatch,String(attempt))}]})
const forbidInterrupt=async()=>{throw Error('unexpected interruption')}

test('AC-035 lost turn/start receipt: identify by persisted client ID, interrupt exact turn, restore only accepted inputs and restart once', async t=>{
  const h=fixture();t.after(h.close)
  const {d,owner,assignment,receive}=h
  receive('seen','specific followup')
  const acceptedId=d.store.tickets.get(owner)!.undelivered[0]
  h.prepared('dispatch-1',[acceptedId])
  receive('not-seen','another followup')
  const unread=d.store.tickets.get(owner)!.undelivered[1]
  let status='inProgress', reads=0, interrupts=0
  const read=async(thread:string)=>{
    assert.equal(thread,'thread-w');reads++
    return {turns:[remote('target','dispatch-1',status)]}
  }
  const interrupt=async(id:string,aid:string)=>{
    assert.equal(id,'target');assert.equal(aid,assignment);interrupts++;status='interrupted'
  }
  await Promise.all([recoverOwner(d,owner,read,interrupt,false),recoverOwner(d,owner,read,interrupt,false)])
  await recoverOwner(d,owner,read,interrupt,false)
  assert.equal(reads,2);assert.equal(interrupts,1)
  const ticket=d.store.tickets.get(owner)!
  assert.deepEqual(ticket.assignments.map(a=>a.state),['ended','pending'])
  assert.equal(ticket.assignments[0].endedReason,'hostRestarted')
  assert.ok(ticket.undelivered.includes(unread))
  assert.ok(!ticket.undelivered.includes(acceptedId))
  const accepted=ticket.inputs.find(i=>i.id===acceptedId)!
  assert.ok(accepted.kind==='trigger' && accepted.readAt && accepted.deliveredTo===assignment)
  assert.deepEqual({...d.db.prepare('SELECT turn,observation FROM host_recovery_receipt').get()},{turn:'target',observation:'interrupted'})
  assert.equal(d.db.prepare('SELECT count(*) AS n FROM host_recovery').get()!.n,0)
})

test('missing, partial, ambiguous or unknown history blocks new work with marker retained',async t=>{
  for (const history of [
    {turns:[{id:'old',status:'completed',items:[{type:'userMessage'}]}]},
    {turns:[{...remote('old','other'),itemsView:'summary'}]},
    {turns:[remote('unexpected','dispatch','future-terminal')]},
    {turns:[remote('x','dispatch'),remote('y','dispatch')]},
    {turns:[remote('elsewhere','another','inProgress')]},
    {turns:[remote('x','dispatch')],id:'other-thread'},
    {},
  ]) {
    const h=fixture();t.after(h.close)
    h.prepared('dispatch',[])
    await assert.rejects(recoverOwner(h.d,h.owner,async()=>history,forbidInterrupt,false),/Recovery blocked/)
    assert.equal(h.d.store.tickets.get(h.owner)!.assignments.length,1)
    assert.equal(h.d.db.prepare('SELECT state FROM host_turns').get()!.state,'prepared')
    assert.equal(h.d.db.prepare('SELECT owner FROM host_recovery').get()!.owner,h.owner)
  }
})

test('acknowledging an interruption alone or losing the target on reread cannot prove it stopped',async t=>{
  for (const after of [[remote('x','dispatch','inProgress')],[]]) {
    const h=fixture();t.after(h.close)
    h.prepared('dispatch',[],'active','x')
    let called=false
    await assert.rejects(recoverOwner(h.d,h.owner,async()=>({turns:called?after:[remote('x','dispatch','inProgress')]}),async()=>{called=true},false))
    assert.ok(called)
    assert.equal(h.d.store.tickets.get(h.owner)!.assignments.length,1)
  }
})

test('verified-unsent launch keeps the pending Assignment and its stable attempt; positive receipt promotes an interrupted start',async t=>{
  for (const received of [false,true]) {
    const h=fixture(false);t.after(h.close)
    h.prepared('launch',[])
    await recoverOwner(h.d,h.owner,async()=>({turns:received?[remote('turn','launch')]:[remote('older','another')]}),forbidInterrupt,false)
    const ticket=h.d.store.tickets.get(h.owner)!
    assert.equal(ticket.assignments.length,received?2:1)
    assert.equal(ticket.assignments.at(-1)!.state,'pending')
    assert.equal(h.d.db.prepare('SELECT state FROM host_turns').get()!.state,received?'completed':'retry')
  }
})

test('AC-035 preserves operator pause, waiting for human, review, blocked and failed without newer inputs',async t=>{
  for (const state of ['paused','waiting','ready','blocked','failed'] as const) {
    const h=fixture();t.after(h.close)
    const {d,owner,assignment}=h
    if (state==='ready') d.engine.bindThread(owner,{source:'github',id:'example/pull/1'},true)
    if (state!=='paused') d.engine.report(owner,{state,summary:'waiting'})
    await recoverOwner(d,owner,async()=>({turns:[]}),forbidInterrupt,state==='paused')
    assert.deepEqual(d.store.tickets.get(owner)!.assignments.map(a=>a.id),[assignment])
    assert.equal(d.store.tickets.get(owner)!.assignments[0].report?.state,state==='paused'?undefined:state)
  }
})

test('waiting work with new undelivered human input stays eligible on its original assignment',async t=>{
  const h=fixture();t.after(h.close)
  const {d,owner,assignment}=h
  d.engine.report(owner,{state:'blocked',summary:'need project details',question:'Which project?'})
  h.receive('answer','Use test project')
  const fresh=d.store.tickets.get(owner)!.undelivered
  await recoverOwner(d,owner,async()=>({turns:[]}),forbidInterrupt,false)
  assert.equal(d.store.tickets.get(owner)!.assignments.at(-1)!.id,assignment)
  assert.deepEqual(d.store.tickets.get(owner)!.undelivered,fresh)
  assert.equal(d.db.prepare("SELECT count(*) AS n FROM domain_effect WHERE state='pending' AND json_extract(payload,'$.kind')='deliver'").get()!.n,1)
})

test('pending Main Eval gets exactly one new assess attempt after verified stop; settled Eval gets none',async t=>{
  for(const settled of [false,true]) {
    const h=fixture();t.after(h.close)
    const {d}=h
    h.receive('unowned','second request');d.engine.handback(h.owner,'unowned','out of scope');d.engine.evaluateDue()
    const evalId=d.engine.candidate('unowned')!.evalId
    const dispatch=key('assess',evalId)
    h.mark('main')
    d.db.prepare("INSERT INTO host_sessions VALUES ('main','thread-main',NULL,'runtime')").run()
    d.db.prepare("INSERT INTO host_turns(id,owner,assignment,ids,text,state) VALUES(?,'main',?,'[]','assess','prepared')").run(dispatch,evalId)
    if(settled)d.engine.decide('unowned',{kind:'ignore',reason:'handled',evalId})
    const read=async()=>({turns:[remote('m',dispatch)]})
    await recoverOwner(d,'main',read,forbidInterrupt,false)
    await recoverOwner(d,'main',read,forbidInterrupt,false)
    const r=d.db.prepare('SELECT state,attempt,assignment FROM host_turns WHERE id=?').get(dispatch)!
    assert.equal(r.state,settled?'completed':'retry');assert.equal(r.attempt,settled?0:1)
    assert.equal(r.assignment,evalId)
  }
})
