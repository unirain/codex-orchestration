import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoleHandlers } from '../src/host/tools.ts'
import { domainFixture } from './support/domain.ts'
import type { ToolContext } from '../src/codex/session.ts'

const hooks = {
  valid: () => true, runTest: async()=>{throw new Error('unexpected test')},
  deliver: async()=>{throw new Error('unexpected remote write')},
  mayReportReady: async()=>false, pause:()=>{},
}
function caller(role:'main'|'worker',at:string,tool:string,callId=tool,ticketId?:string): ToolContext {
  return {role,threadId:'thread-'+role,turnId:'turn-'+at,assignmentId:at,tool,callId,ticketId}
}
function active() {
  const f = domainFixture()
  f.receive('origin','fix follow up')
  f.d.engine.evaluateDue()
  const id = f.accept('origin','follow up').ticketId!
  const assignmentId = f.d.store.tickets.get(id)!.assignments[0].id
  f.d.engine.assignmentStarted(id,assignmentId)
  return {...f,id,assignmentId}
}

test('Main binds commands to the actual batch and replays a successful receipt even after Eval finishes',async t=>{
  const f=domainFixture();t.after(f.close)
  f.receive('origin','fix follow up');f.d.engine.evaluateDue()
  const evalId=f.d.engine.candidate('origin')!.evalId
  const handlers=new RoleHandlers(f.d,hooks)
  const ctx=caller('main',evalId,'orchestrator_route')
  const args={kind:'accept',scope:'follow up',reason:'explicit user request'}
  await assert.rejects(handlers.call(ctx,{...args,triggerId:'foreign'}),/outside this Eval/)
  const result=await handlers.call(ctx,args) as {ticketId:string}
  const replay=await new RoleHandlers(f.d,{...hooks,valid:()=>false}).call(ctx,args)
  assert.deepEqual(replay,result)
  assert.ok(result.ticketId)
  assert.equal(f.d.store.tickets.list().length,1)
  await assert.rejects(handlers.call(ctx,{...args,scope:'other'}),/Conflicting callback/)
  await assert.rejects(handlers.call({...ctx,callId:'new'},args),/stale/)
})
test('clarification sends one question and does not open another ticket',async t=>{
  const f=domainFixture();t.after(f.close)
  f.receive('vague','那个也改一下');f.d.engine.evaluateDue()
  const handlers=new RoleHandlers(f.d,hooks)
  const evalId=f.d.engine.candidate('vague')!.evalId
  const session=caller('main',evalId,'orchestrator_read')
  const context=await handlers.call(session,{}) as {triggers:{id:string}[]}
  assert.equal(context.triggers[0].id,'vague')
  const args={kind:'clarify',reason:'ambiguous',question:'你指哪一项？'}
  await handlers.call({...session,tool:'orchestrator_route',callId:'route'},args)
  await f.d.drain(f.ports.dispatch)
  assert.equal(f.ports.calls.filter(e=>e.kind==='send'&&e.message.text===args.question).length,1)
  assert.equal(f.d.store.tickets.list().length,0)
})
test('Worker binding rejects injected and stale targets and commits one report plus attention',async t=>{
  const f=active();t.after(f.close)
  let paused=''
  const h=new RoleHandlers(f.d,{...hooks,valid:()=>!paused,pause:id=>{paused=id}})
  const w=caller('worker',f.assignmentId,'orchestrator_report','report-1',f.id)
  const report={state:'blocked',summary:'Missing a dependency',question:'Which package source is authorized?'}
  await assert.rejects(h.call(w,{...report,ticketId:'sibling'}),/Unexpected tool arguments/)
  await assert.rejects(h.call({...w,assignmentId:'old'},report),/Inactive Ticket/)
  await assert.rejects(h.call({...w,tool:'orchestrator_route'},{}),/Unknown Worker tool/)
  const first=await h.call(w,report)
  assert.equal(paused,f.id)
  assert.deepEqual(await h.call(w,report),first)
  await assert.rejects(h.call({...w,callId:'late'},report),/paused/)
  assert.equal(f.d.store.tickets.get(f.id)?.attention?.question,report.question)
  assert.equal(f.d.db.prepare("SELECT count(*) AS n FROM domain_history WHERE entity='report'").get()!.n,1)
})
test('ready requires current evidence and rechecks eligibility after asynchronous verification',async t=>{
  const f=active();t.after(f.close)
  const promise=Promise.withResolvers<boolean>()
  let valid=true
  const h=new RoleHandlers(f.d,{...hooks,valid:()=>valid,mayReportReady:()=>promise.promise})
  const w=caller('worker',f.assignmentId,'orchestrator_report','ready',f.id)
  const args={state:'ready',summary:'Reviewed; all checks passed',pr:12}
  await assert.rejects(h.call(w,{state:'ready',summary:'done'}),/valid PR/)
  const inFlight=h.call(w,args)
  valid=false;promise.resolve(true)
  await assert.rejects(inFlight,/paused/)
  assert.equal(f.d.store.tickets.get(f.id)?.ended,undefined)
})
test('duplicate test/delivery callbacks share a single invocation; restart retries with original operation key',async t=>{
  const f=active();t.after(f.close)
  const handles:string[]=[]
  const captured=Promise.withResolvers<object>()
  const h=new RoleHandlers(f.d,{...hooks,runTest:async id=>{handles.push(id);return captured.promise}})
  const w=caller('worker',f.assignmentId,'orchestrator_test','bg1',f.id)
  const first=h.call(w,{command:'npm test'}),second=h.call(w,{command:'npm test'})
  captured.resolve({runId:'run1'})
  assert.deepEqual(await Promise.all([first,second]),[{runId:'run1'},{runId:'run1'}])
  assert.equal(handles.length,1)
  const d=caller('worker',f.assignmentId,'orchestrator_deliver','push1',f.id)
  const op={operation:'push'}
  const failed=new RoleHandlers(f.d,{...hooks,deliver:async id=>{handles.push(id);throw new Error('lost receipt')}})
  await assert.rejects(failed.call(d,op),/lost receipt/)
  const resumed=new RoleHandlers(f.d,{...hooks,deliver:async id=>{assert.equal(id,handles.at(-1));return {commit:'reconciled'}}})
  assert.deepEqual(await resumed.call(d,op),{commit:'reconciled'})
  assert.deepEqual(await new RoleHandlers(f.d,hooks).call(d,op),{commit:'reconciled'})
})
test('Worker can accept or hand back reached human input, but cannot claim it after hand-back',async t=>{
  const f=active();t.after(f.close)
  const h=new RoleHandlers(f.d,hooks)
  const w=caller('worker',f.assignmentId,'orchestrator_ack','ack-1',f.id)
  await assert.rejects(h.call(w,{triggerId:'foreign'}),/outside Ticket/)
  f.receive('follow','follow up detail')
  await h.call(w,{triggerId:'follow',answer:'Understood.'})
  assert.deepEqual(f.d.store.triggers.disposition('follow')?.acked,[f.id])
  f.receive('mail','fix mail')
  const result=await h.call({...w,tool:'orchestrator_trigger_handback',callId:'back'},{triggerId:'mail',reason:'mail is outside scope'})
  assert.deepEqual(result,{requeued:true})
  await assert.rejects(h.call({...w,callId:'late'},{triggerId:'mail'}),/outside Ticket/)
})
