import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalTrigger } from '../src/domain.ts'
import { domainFixture } from './support/domain.ts'

test('accept commits a decision, mandate, assignment, subscription, ack and launch together', async t => {
  const { d,receive,accept,ports,close } = domainFixture()
  t.after(close)
  receive('one','调整 follow up')
  d.engine.evaluateDue()
  const evalId = d.engine.candidate('one')!.evalId
  await d.drain(ports.dispatch)
  d.db.exec("CREATE TEMP TRIGGER reject_launch BEFORE INSERT ON domain_effect WHEN json_extract(NEW.payload,'$.kind')='start' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END")
  assert.throws(() => accept('one','follow up'), /fixture disk failure/)
  assert.deepEqual(d.store.tickets.list(),[])
  assert.deepEqual(d.store.decisions.byThread('terminal:default'),[])
  assert.deepEqual(d.store.threads.get('terminal:default')!.subscriptions,[])
  assert.equal(d.engine.candidate('one')!.evalId,evalId)
  await d.drain(ports.dispatch)
  assert.deepEqual(ports.calls.map(e => e.kind),['assess'])
  d.db.exec('DROP TRIGGER reject_launch')
  const decision = accept('one','follow up')
  const ticket = d.store.tickets.get(decision.ticketId!)!
  assert.deepEqual(ticket.mandate,decision.mandate)
  assert.equal(ticket.mandate.actor.id,'owner')
  assert.equal(ticket.mandate.scope,'follow up')
  assert.equal(ticket.assignments.length,1)
  assert.deepEqual(d.store.threads.get('terminal:default')!.subscriptions,[ticket.id])
  assert.deepEqual(d.engine.decide('one',{kind:'accept',title:'duplicate',scope:'other',reason:'retry',evalId}),decision)
  assert.equal(receive('one','attempt to replace original'),'duplicate')
  assert.equal(d.store.triggers.get('one')!.text,'调整 follow up')
  await d.drain(ports.dispatch)
  assert.deepEqual(ports.calls.map(e => e.kind),['assess','send','start'])
})

test('feedback, non-user identities and foreign owner messages cannot originate work', async t => {
  const {d,ports,close} = domainFixture()
  t.after(close)
  const valid = terminalTrigger('fake','open a new job','owner')
  for (const trigger of [{...valid,human:false},{...valid,id:'wrong',actor:{source:'terminal',id:'outsider'}},
    {...valid,id:'log',source:'test-result'}]) {
    assert.equal(d.engine.receive(trigger),'filtered')
    assert.throws(() => d.engine.decide(trigger.id,{kind:'accept',title:'fake',scope:'fake',reason:'log'}))
  }
  d.engine.evaluateDue(); await d.drain(ports.dispatch)
  assert.deepEqual(ports.calls,[])
})
