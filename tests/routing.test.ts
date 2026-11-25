import test from 'node:test'
import assert from 'node:assert/strict'
import { domainFixture } from './support/domain.ts'
import { terminalTrigger } from '../src/domain.ts'

test('subscribed human inputs bypass Eval until all owners hand the same immutable trigger back', t => {
  const h = domainFixture()
  t.after(h.close)
  const {d,receive,accept} = h
  receive('origin','调整 follow up')
  d.engine.evaluateDue()
  const a = accept('origin','follow up').ticketId!
  receive('mail','发送邮件有 bug')
  d.engine.evaluateDue()
  assert.equal(d.engine.candidate('mail'),undefined)
  assert.equal(d.engine.handback(a,'mail','outside follow up'),true)
  d.engine.evaluateDue()
  assert.throws(() => d.engine.attach(a,'mail'),/handed/i)
  const b = accept('mail','mail').ticketId!
  const mandates = d.store.tickets.list().map(t => t.mandate)
  receive('third','另外一项工作')
  assert.equal(d.engine.handback(b,'third','outside mail'),false)
  d.engine.evaluateDue()
  assert.equal(d.engine.candidate('third'),undefined)
  assert.throws(() => d.engine.handback(b,'third','duplicate'),/handed/i)
  assert.equal(d.engine.handback(a,'third','outside follow up'),true)
  d.engine.evaluateDue()
  const evalId = d.engine.candidate('third')!.evalId
  d.engine.evaluateDue()
  assert.equal(d.engine.candidate('third')!.evalId,evalId)
  assert.deepEqual(d.store.triggers.disposition('third')!.handbacks?.map(x=>x.ticketId),[b,a])
  assert.deepEqual(d.store.tickets.list().map(t=>t.mandate),mandates)
  assert.equal(d.store.triggers.get('third')!.text,'另外一项工作')
})

test('later triggers wait for the next batch; stale Policy and Eval IDs do not authorize work', t => {
  let version='before'
  const h=domainFixture({policy:()=>({version,allowWork:true})})
  t.after(h.close)
  const {d,receive}=h
  receive('first','feature')
  d.engine.evaluateDue()
  const original=d.engine.candidate('first')!.evalId
  receive('second','new message')
  d.engine.evaluateDue()
  assert.equal(d.engine.candidate('second'),undefined)
  version='after'
  const outcome={kind:'accept',title:'old',scope:'old',reason:'old',evalId:original} as const
  assert.equal(d.engine.decide('first',outcome).kind,'unavailable')
  assert.deepEqual(d.store.tickets.list(),[])
  d.engine.evaluateDue()
  assert.deepEqual(d.engine.candidate('second')!.triggers.map(x=>x.id),['first','second'])
  assert.throws(()=>d.engine.decide('first',outcome),/eval/i)
})

test('context subscribers supply background; attaching a single-trigger Eval records ignore/routed', t => {
  const h=domainFixture()
  t.after(h.close)
  const {d,receive,accept}=h
  receive('origin','调整 follow up')
  d.engine.evaluateDue()
  const a=accept('origin','follow up').ticketId!
  const other={source:'terminal',id:'related'}
  d.engine.followForContext(a,other)
  const trigger={...terminalTrigger('context','调整同一项工作的边界','owner'),threads:[other]}
  d.engine.receive(trigger)
  d.engine.evaluateDue()
  assert.deepEqual(d.store.triggers.disposition('context')!.context,[a])
  const evalId=d.engine.candidate('context')!.evalId
  d.engine.attach(a,'context','明确指向已有工单',evalId)
  const decision=d.store.decisions.byThread('terminal:related').at(-1)!
  assert.equal(decision.kind,'ignore')
  assert.equal(decision.reason[0].code,'routed')
  assert.equal(d.store.threads.get('terminal:related')!.context?.includes(a),false)
})

test('normal ended tickets resume under their original mandate; revoked or stopped work remains ended', t => {
  for (const mode of ['normal','revoked','stop']) {
    let allowWork=true
    const h=domainFixture({policy:()=>({version:'current',allowWork})})
    t.after(h.close)
    const {d,receive,accept}=h
    receive('origin','工作'); d.engine.evaluateDue()
    const id=accept('origin','工作').ticketId!
    const original=d.store.tickets.get(id)!
    d.engine.assignmentStarted(id,original.assignments[0].id)
    if (mode==='stop') d.engine.stopTicket(id,'用户撤销')
    else d.engine.report(id,{state:'dropped',summary:'no open work'})
    if (mode==='revoked') allowWork=false
    receive('later','补充已有要求')
    const ticket=d.store.tickets.get(id)!
    assert.equal(Boolean(ticket.ended),mode!=='normal')
    assert.deepEqual(ticket.mandate,original.mandate)
    assert.equal(ticket.assignments.length,mode==='normal'?2:1)
  }
})

test('an ambiguous message creates a channel question without guessed work; filtered input cannot be attached', async t=>{
  const h=domainFixture()
  t.after(h.close)
  const {d,receive,accept,ports}=h
  receive('origin','工作'); d.engine.evaluateDue()
  const ticketId=accept('origin','工作').ticketId!
  receive('which','那个也改一下')
  d.engine.handback(ticketId,'which','归属不明'); d.engine.evaluateDue()
  d.clarify('which',d.engine.candidate('which')!.evalId,'你指的是哪项工作？')
  await d.drain(ports.dispatch)
  assert.equal(d.store.tickets.list().length,1)
  assert.equal(ports.calls.filter(e=>e.kind==='send' && e.message.text==='你指的是哪项工作？').length,1)
  d.engine.receive(terminalTrigger('foreign','advance work','other'))
  assert.throws(()=>d.engine.attach(ticketId,'foreign'))
})

test('Assess requests can be deferred without blocking terminal receipts or starts',async t=>{
  const h=domainFixture(); t.after(h.close)
  const {d,receive,accept}=h
  receive('a','one'); d.engine.evaluateDue()
  assert.equal(await d.drain(()=> 'defer'),0)
  accept('a','feature')
  assert.equal(await d.drain(()=>{}),2)
})
