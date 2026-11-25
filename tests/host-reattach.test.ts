import assert from 'node:assert/strict'
import test from 'node:test'
import { key } from '../src/core/ids.ts'
import { observeDispatch } from '../src/host/reattach.ts'
import type { Completion } from '../src/codex/session.ts'
import { domainFixture } from './support/domain.ts'

function fixture() {
  const h=domainFixture(), {d}=h
  h.receive('first','first work');d.engine.evaluateDue()
  const owner=h.accept('first','first').ticketId!
  const ticket=d.store.tickets.get(owner)!, assignment=ticket.assignments[0].id
  d.engine.assignmentStarted(owner,assignment);h.receive('input','an update')
  const ids=d.store.tickets.get(owner)!.undelivered
  d.db.exec(`CREATE TABLE host_sessions(owner TEXT PRIMARY KEY, thread TEXT);
    CREATE TABLE host_turns(id TEXT PRIMARY KEY,owner TEXT,assignment TEXT,ids TEXT,turn TEXT,state TEXT,attempt INTEGER,due INTEGER);`)
  d.db.prepare("INSERT INTO host_sessions VALUES(?,'thread')").run(owner)
  d.db.prepare("INSERT INTO host_turns VALUES('call',?,?,?,NULL,'prepared',0,0)").run(owner,assignment,JSON.stringify(ids))
  const events:string[]=[]
  const callbacks={
    started(id:string,aid:string) {
      assert.equal(aid,assignment);events.push('started')
      d.db.prepare("UPDATE host_turns SET turn=?,state='active' WHERE id='call'").run(id)
      d.engine.inputsDelivered(owner,aid,ids);d.engine.inputsRead(owner,ids)
    },
    ended(e:Completion) {events.push(e.status);d.db.prepare("UPDATE host_turns SET state=? WHERE id='call'").run(e.status);d.engine.turnEnded(owner,e.assignmentId)},
  }
  return {...h,owner,assignment,ids,events,callbacks}
}
function turn(id:string,dispatch:string,status:string) {
  return {id,status,itemsView:'full',items:[{type:'userMessage',clientId:key('turn-input',dispatch,'0')}]}
}
test('AC-018 recover lost start acknowledgement, observe original turn without replacing its assignment',async t=>{
  const h=fixture();t.after(h.close)
  const remote=turn('turn1','call','inProgress')
  const read=()=>({id:'thread',turns:[remote]})
  for (let i=0;i<2;i++) assert.equal(await observeDispatch(h.d,h.owner,read(),h.callbacks),'observing')
  assert.deepEqual(h.events,['started'])
  const ticket=h.d.store.tickets.get(h.owner)!
  assert.equal(ticket.assignments.length,1)
  assert.equal(ticket.assignments[0].id,h.assignment)
  assert.equal(ticket.undelivered.length,0)
  assert.ok(ticket.inputs.some(i=>i.kind==='trigger' && i.readAt && i.deliveredTo===h.assignment))
  remote.status='completed'
  for (let i=0;i<2;i++) assert.equal(await observeDispatch(h.d,h.owner,read(),h.callbacks),'idle')
  assert.deepEqual(h.events,['started','completed'])
})
test('terminal failure received while disconnected uses the normal terminal policy once',async t=>{
  const h=fixture();t.after(h.close)
  const raw={...turn('turn1','call','failed'),error:{codexErrorInfo:'unauthorized',message:'private details'}}
  let observed:Completion|undefined
  await observeDispatch(h.d,h.owner,{turns:[raw]},{...h.callbacks,ended:e=>{observed=e;h.callbacks.ended(e)}})
  assert.equal(observed?.errorCode,'unauthorized')
  assert.deepEqual(h.events,['started','failed'])
  assert.ok(!JSON.stringify(observed).includes('private details'))
})
test('only a positively absent input is scheduled once with its existing attempt and undelivered IDs',async t=>{
  const h=fixture();t.after(h.close)
  const history={turns:[turn('older','else','completed')]}
  assert.equal(await observeDispatch(h.d,h.owner,history,h.callbacks),'retry')
  assert.equal(await observeDispatch(h.d,h.owner,history,h.callbacks),'idle')
  const row=h.d.db.prepare("SELECT state,attempt,turn FROM host_turns WHERE id='call'").get()!
  assert.deepEqual({...row},{state:'retry',attempt:0,turn:null})
  assert.deepEqual(h.events,[])
  assert.deepEqual(h.d.store.tickets.get(h.owner)!.undelivered,h.ids)
})
test('wrong thread, duplicate markers, unbound active turn or incomplete view block all new execution',async t=>{
  const h=fixture();t.after(h.close)
  const mine=turn('turn','call','inProgress')
  for (const history of [
    {id:'other',turns:[mine]}, {turns:[mine,{...mine,id:'duplicate'}]}, {turns:[turn('unknown','other','inProgress')]},
    {turns:[{...turn('prior','else','completed'),itemsView:'summary'}]}, {historyMode:'paginated',turns:[]}, {},
  ]) await assert.rejects(observeDispatch(h.d,h.owner,history,h.callbacks))
  assert.deepEqual(h.events,[])
  assert.equal(h.d.db.prepare('SELECT state FROM host_turns').get()!.state,'prepared')
})
