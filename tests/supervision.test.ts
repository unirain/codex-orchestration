import assert from 'node:assert/strict'
import test from 'node:test'
import { openDomain, terminalTrigger } from '../src/domain.ts'
import { Supervision } from '../src/host/supervision.ts'
import { temporaryDatabase } from './support/fixture.ts'

function setup() {
  const tmp=temporaryDatabase()
  const options={actorId:'owner',repository:'test/repo'}
  const d=openDomain(tmp.path,options)
  let time=0
  const s=new Supervision(d,{now:()=>time,excerptBytes:24,secrets:()=>['sample-secret']})
  function ticket(name: string,started=false) {
    // Isolate fixture origins so every created ticket has its own Routing Decision.
    d.engine.receive({...terminalTrigger(name,name,'owner'),threads:[{source:'terminal',id:name}]})
    d.engine.evaluateDue()
    const result=d.engine.decide(name,{kind:'accept',title:name,scope:name,reason:'owner request',evalId:d.engine.candidate(name)!.evalId})
    const tid=result.ticketId!
    const aid=d.store.tickets.get(tid)!.assignments[0].id
    if(started)d.engine.assignmentStarted(tid,aid)
    return [tid,aid] as const
  }
  return {d,s,ticket,tmp,options,setTime:(milliseconds:number)=>{time=milliseconds},close:()=>{d.close();tmp.cleanup()}}
}
type Pair = readonly [string,string]
function launch(s:Supervision,ids:Pair,turn='turn') {
  assert.equal(s.reserve(...ids,'start'),true)
  s.turnStarted(...ids,turn)
}
function job(s:Supervision,ids:Pair,id='test-1') {
  return s.startTest({id,ticketId:ids[0],assignmentId:ids[1],command:'make test TOKEN=sample-secret',commit:'abc',dirty:true,image:'sha256:abc'})
}

test('AC-011 reserves count immediately, only an existing human wake takes slot four; earlier queued human wins',t=>{
  const h=setup();t.after(h.close)
  const {s,ticket}=h
  const a=ticket('A'),b=ticket('B'),c=ticket('C')
  launch(s,a);launch(s,b);launch(s,c);job(s,c)
  s.turnEnded(...c,'turn')
  const pending=ticket('D'), follow=ticket('E',true), second=ticket('F',true),ordinary=ticket('G',true)
  assert.equal(s.occupied(),3)
  assert.equal(s.reserve(...pending,'human'),false)
  assert.equal(s.reserve(...ordinary,'event'),false)
  assert.equal(s.reserve(...follow,'human'),true)
  assert.equal(s.reserve(...second,'human'),false)
  assert.equal(s.reserve(...b,'event'),true)
  assert.equal(s.occupied(),4)
  s.turnEnded(...a,'turn')
  assert.equal(s.reserve(...pending,'start'),false)
  assert.equal(s.reserve(...second,'human'),true)
  assert.equal(s.occupied(),4)
})

test('AC-012 pause waits for the actual turn terminal, releases before test exits, suppresses wake, explicit resume consumes feedback once',t=>{
  const h=setup();t.after(h.close)
  const {s,d,ticket}=h
  const a=ticket('A',true), b=ticket('B'), c=ticket('C'), next=ticket('D')
  launch(s,a);launch(s,b);launch(s,c);job(s,a)
  assert.equal(s.reserve(...next,'start'),false)
  assert.equal(s.pause(a[0]),'turn')
  assert.equal(s.occupied(),3)
  assert.throws(()=>job(s,a,'new'))
  s.turnEnded(...a,'late-other-turn')
  assert.equal(s.occupied(),3)
  s.turnEnded(...a,'turn');assert.equal(s.occupied(),2)
  assert.equal(s.reserve(...next,'start'),true)
  assert.equal(s.finishTest('test-1',{status:'failed',exitCode:1,output:'error'}),true)
  assert.equal(s.finishTest('test-1',{status:'passed',exitCode:0}),false)
  assert.equal(s.flushFeedback(),0)
  assert.equal(s.tests(a[0])[0].feedback,'pending')
  assert.equal(s.reserve(...a,'human'),false)
  s.resume(a[0])
  assert.equal(s.tests(a[0])[0].feedback,'delivered')
  assert.equal(s.flushFeedback(),0)
  assert.equal(d.store.tickets.get(a[0])!.inputs.filter(x=>x.kind==='note').length,1)
  assert.equal(s.occupied(),3)
})

test('AC-026 30 minutes begin at turn end; a new turn cancels the old window and paused tests finish outside it',t=>{
  const h=setup();t.after(h.close)
  const {s,ticket,setTime}=h
  const a=ticket('A',true)
  launch(s,a);job(s,a,'long')
  setTime(20*60_000);s.turnEnded(...a,'turn')
  setTime(30*60_000);assert.deepEqual(s.overdueTests(),[])
  setTime(50*60_000);assert.deepEqual(s.overdueTests(),['long'])
  s.turnStarted(...a,'second')
  assert.deepEqual(s.overdueTests(),[])
  s.turnEnded(...a,'second')
  setTime(79*60_000);assert.deepEqual(s.overdueTests(),[])
  setTime(80*60_000);assert.deepEqual(s.overdueTests(),['long'])
  s.pause(a[0]);assert.equal(s.occupied(),0)
  assert.deepEqual(s.overdueTests(),[])
  s.finishTest('long',{status:'passed',exitCode:0})
  assert.equal(s.flushFeedback(),0)
})

test('AC-019/020 bounded redact-before-store excerpts, immutable reruns and scoped cleanup survive restart and age', t=>{
  const h=setup();t.after(h.close)
  const {s,d,ticket,setTime,tmp,options}=h
  const a=ticket('A',true),b=ticket('B',true)
  launch(s,a);launch(s,b)
  job(s,a,'a1');assert.equal(job(s,a,'a1'),false)
  assert.throws(()=>job(s,b,'a1'),/Conflicting/)
  job(s,a,'a2');job(s,b,'b1')
  const output='秘密'.repeat(100)+' sample-secret'
  s.finishTest('a1',{status:'failed',exitCode:3,output})
  s.finishTest('a2',{status:'passed',exitCode:0,output:'unretained'})
  s.finishTest('b1',{status:'failed',exitCode:4,output:'other'})
  const [one,two]=s.tests(a[0])
  assert.equal(one.exitCode,3);assert.equal(one.dirty,true)
  assert.ok(Buffer.byteLength(one.excerpt!)<=24);assert.equal(one.truncated,true)
  assert.ok(one.excerpt!.includes('[REDACTED]'));assert.ok(!one.excerpt!.includes('�'))
  assert.equal(two.excerpt,null)
  assert.doesNotMatch(JSON.stringify(s.tests(a[0])),/sample-secret|unretained/)
  assert.equal(s.flushFeedback(),3)
  assert.doesNotMatch(JSON.stringify(d.store.tickets.get(a[0])!.inputs),/秘密|sample-secret/)
  setTime(365*24*60*60_000)
  d.engine.stopTicket(a[0])
  const other=openDomain(tmp.path,options)
  try{
    const after=new Supervision(other)
    assert.equal(after.tests(a[0])[0].excerpt,one.excerpt)
    assert.equal(after.clearExcerpts(a[0]),1)
    const result=after.tests(a[0])[0]
    assert.equal(result.cleared,true);assert.equal(result.excerpt,null);assert.equal(result.exitCode,3)
    assert.equal(after.tests(b[0])[0].excerpt,'other')
  }finally{other.close()}
})

test('uncertain restarted tests record unknown. Stale assignments cannot acquire slots or inject feedback into the replacement', t=>{
  const h=setup();t.after(h.close)
  const {s,d,ticket}=h
  const a=ticket('A',true)
  launch(s,a);job(s,a,'lost');job(s,a,'alive')
  s.turnEnded(...a,'turn')
  d.engine.assignmentInterrupted(...a)
  const newAssignment=d.store.tickets.get(a[0])!.assignments.at(-1)!.id
  assert.notEqual(newAssignment,a[1])
  s.reconcile();assert.equal(s.occupied(),0)
  s.recoverInterruptedTests(new Set(['alive']))
  assert.deepEqual(s.tests(a[0]).map(j=>j.status),['unknown','running'])
  assert.equal(s.flushFeedback(),0)
  assert.equal(s.tests(a[0])[0].feedback,'historical')
  assert.equal(s.reserve(...a,'human'),false)
  assert.equal(s.reserve(a[0],newAssignment,'start'),true)
})

test('AC-032 delayed snapshots do not gate work; dedupe thread-cumulative snapshots, separate Main and reject cross-ticket binding', t=>{
  const h=setup();t.after(h.close)
  const {s,ticket}=h
  const a=ticket('A',true),b=ticket('B',true)
  launch(s,a)
  const snapshot={role:'worker' as const,threadId:'th-a',turnId:'1',ticketId:a[0],total:7}
  s.recordUsage(snapshot);s.recordUsage(snapshot)
  s.recordUsage({...snapshot,turnId:'2',total:11})
  s.recordUsage({...snapshot,total:4})
  s.recordUsage({role:'main',threadId:'th-m',turnId:'1',total:5})
  assert.throws(()=>s.recordUsage({...snapshot,ticketId:b[0],total:99}),/identity/)
  assert.equal(s.usage(a[0]),11);assert.equal(s.usage(b[0]),0);assert.equal(s.usage(),5)
})

test('AC-023 records new attempts independently; only an explicit blocked report holds feedback for human input', t=>{
  const h=setup();t.after(h.close)
  const {s,d,ticket}=h
  const a=ticket('A',true)
  launch(s,a)
  for (let n=1;n<=3;n++) {
    const id='failure-'+n
    job(s,a,id)
    s.finishTest(id,{status:'failed',exitCode:1,output:n===3?'connection pool exhausted':'timed out'})
    assert.equal(s.flushFeedback(),1)
  }
  assert.equal(s.isPaused(a[0]),false)
  assert.equal(s.tests(a[0])[2].excerpt,'connection pool exhausted'.slice(-24))
  job(s,a,'pending')
  d.engine.report(a[0],{state:'blocked',summary:'No distinct next experiment',question:'Which worker pool is used in the failing deployment?'})
  s.turnEnded(...a,'turn')
  assert.equal(s.occupied(),0)
  s.finishTest('pending',{status:'failed',exitCode:1})
  assert.equal(s.flushFeedback(),0)
  const history=d.db.prepare("SELECT count(*) AS n FROM domain_history WHERE entity='attention' AND entity_id=?").get(a[0])
  assert.equal(history?.n,1)
})

test('an interrupted reservation reusing a waiting slot cannot release the next turn before its terminal receipt',t=>{
  const h=setup();t.after(h.close)
  const {s,ticket}=h
  const a=ticket('race',true)
  launch(s,a)
  job(s,a)
  s.turnEnded(...a,'turn')
  assert.equal(s.reserve(...a,'event'),true)
  assert.equal(s.pause(a[0]),undefined)
  assert.equal(s.occupied(),1)
  s.turnStarted(...a,'racing-start')
  assert.equal(s.pause(a[0]),'racing-start')
  s.turnEnded(...a,'racing-start')
  assert.equal(s.occupied(),0)
})

test('a rollback in Engine.note leaves the test feedback pending and retryable exactly once',t=>{
  const h=setup();t.after(h.close)
  const {d,s,ticket}=h
  const a=ticket('atomic',true)
  launch(s,a);job(s,a);s.finishTest('test-1',{status:'passed',exitCode:0})
  d.db.exec("CREATE TEMP TRIGGER fail_test_delivery BEFORE UPDATE ON domain_ticket BEGIN SELECT RAISE(ABORT,'disk full'); END")
  assert.throws(()=>s.flushFeedback(),/disk full/)
  assert.equal(s.tests(a[0])[0].feedback,'pending')
  assert.equal(d.store.tickets.get(a[0])!.inputs.length,0)
  d.db.exec('DROP TRIGGER fail_test_delivery')
  assert.equal(s.flushFeedback(),1);assert.equal(s.flushFeedback(),0)
  assert.equal(d.store.tickets.get(a[0])!.inputs.length,1)
})
