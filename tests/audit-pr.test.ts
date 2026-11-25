import test from 'node:test'
import assert from 'node:assert/strict'
import { Delivery } from '../src/host/delivery.ts'
import { RetryLater, type Pull, type Remote } from '../src/host/github.ts'
import { domainFixture } from './support/domain.ts'

const closeEarly='2027-01-03T00:00:00.000Z'
const closeLate='2027-01-05T00:00:00.000Z'
const thread=(n:number)=>({source:'github',id:'fixture/repo/pull/'+n})

function fixture(){
  const h=domainFixture()
  const {d}=h
  h.receive('origin','follow up changes');d.engine.evaluateDue()
  const ticket=h.accept('origin','follow up').ticketId!
  const assignment=d.store.tickets.get(ticket)!.assignments[0].id
  d.engine.assignmentStarted(ticket,assignment)
  return {...h,ticket,assignment}
}
function endedEvents(h:ReturnType<typeof fixture>){
  return h.d.db.prepare("SELECT value FROM domain_history WHERE entity='event' AND json_extract(value,'$.type')='ticket.ended' AND entity_id=?").all(h.ticket)
}

test('AC-033 reverse PR fact arrival uses last actual close, owned PRs take precedence, replay ends once',t=>{
  for(const reverse of [false,true]){
    const h=fixture();t.after(h.close)
    const {d,ticket}=h
    d.engine.bindThread(ticket,thread(1),true)
    d.engine.bindThread(ticket,thread(2),true)
    d.engine.bindThread(ticket,thread(3),false)
    d.engine.report(ticket,{state:'ready',summary:'review prepared'})
    const facts=[[1,'merged',closeEarly],[2,'closed',closeLate]] as const
    const [first,last]=reverse?[facts[1],facts[0]]:facts
    d.engine.threadClosed(thread(first[0]),first[1],first[2])
    assert.equal(d.store.tickets.get(ticket)!.ended,undefined)
    d.engine.threadClosed(thread(last[0]),last[1],last[2])
    d.engine.threadClosed(thread(last[0]),last[1],last[2])
    const end=d.store.tickets.get(ticket)!.ended
    assert.equal(end?.outcome,'closed');assert.equal(end.at,closeLate)
    assert.equal(endedEvents(h).length,1)
  }
})

test('AC-033 a ticket that owns no PR waits for every context PR to close',t=>{
  const h=fixture();t.after(h.close)
  const {d,ticket}=h
  d.engine.bindThread(ticket,thread(1),false);d.engine.bindThread(ticket,thread(2),false)
  d.engine.report(ticket,{state:'ready',summary:'review prepared'})
  d.engine.threadClosed(thread(2),'merged',closeLate)
  assert.ok(!d.store.tickets.get(ticket)!.ended)
  d.engine.threadClosed(thread(1),'closed',closeEarly)
  assert.equal(d.store.tickets.get(ticket)!.ended?.outcome,'merged')
})

test('AC-034 preserve merge fact during an acknowledged follow-up; after its ready report retain actual closing time',t=>{
  const h=fixture();t.after(h.close)
  const {d,ticket,assignment}=h
  d.engine.bindThread(ticket,thread(1),true)
  d.engine.report(ticket,{state:'ready',summary:'review prepared'})
  h.receive('reply','please address another follow up detail')
  const pending=d.store.tickets.get(ticket)!.undelivered
  d.engine.inputsDelivered(ticket,assignment,pending);d.engine.inputsRead(ticket,pending)
  d.engine.reply({purpose:'acknowledgement',ticketId:ticket,triggerId:'reply',text:'working'})
  const closedAt=h.now()
  d.engine.threadClosed(thread(1),'merged',closedAt)
  const waiting=d.store.tickets.get(ticket)!
  assert.equal(waiting.ended,undefined)
  assert.equal(waiting.follows?.[0].closed?.at,closedAt)
  d.engine.report(ticket,{state:'ready',summary:'follow up complete'})
  assert.equal(d.store.tickets.get(ticket)!.ended?.outcome,'merged')
  assert.equal(d.store.tickets.get(ticket)!.ended?.at,closedAt)
  assert.equal(endedEvents(h).length,1)
  const notices=d.db.prepare("SELECT payload FROM domain_effect WHERE json_extract(payload,'$.message.kind')='notice'").all()
  assert.equal(notices.length,1)
  assert.equal(JSON.parse(String(notices[0].payload)).message.ticketId,ticket)
})

test('AC-037/038 persisted tracking survives restarts, respects 120s backoff, deduplicates repeated reads and skips unbound PRs',async t=>{
  const h=fixture();t.after(h.close)
  const {d,ticket}=h
  const seen:number[]=[]
  let outage=true,finalized=0,closedAt:string|null=null
  const remote={read:async(n:number)=>{
    seen.push(n)
    if(outage)throw new RetryLater(120_000)
    return {number:n,repo:'fixture/repo',closedAt,merged:true} as Pull
  }} as Remote
  const fresh=()=>new Delivery(d.db,remote,'fixture/repo','agent',{
    authorize:()=>{throw Error('poll requested write permission')},bind:()=>{throw Error('unexpected binding')},
    open:()=>true,closed:p=>{finalized++;d.engine.threadClosed(thread(p.number),'merged',p.closedAt!)}
  })
  const old=fresh()
  d.engine.bindThread(ticket,thread(7),true)
  d.engine.report(ticket,{state:'ready',summary:'awaiting review'})
  d.db.prepare('INSERT INTO tracked_pr(ticket,number) VALUES(?,7),(?,7)').run(ticket,'other')
  await assert.rejects(old.poll(100),RetryLater)
  outage=false
  await old.poll(60_100);await old.poll(120_099)
  assert.deepEqual(seen,[7])
  await old.poll(120_100);assert.deepEqual(seen,[7,7])
  await old.poll(180_099);assert.deepEqual(seen,[7,7])
  closedAt=closeLate
  const restarted=fresh()
  await restarted.poll(160_000)
  assert.equal(d.store.tickets.get(ticket)!.ended?.outcome,'merged')
  await restarted.poll(240_000);await fresh().poll(250_000)
  assert.deepEqual(seen,[7,7,7]);assert.equal(finalized,1)
})
