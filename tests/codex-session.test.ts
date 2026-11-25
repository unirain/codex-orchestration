import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexSession, ConnectionLost } from '../src/codex/session.ts'
import type { SessionEvent } from '../src/codex/session.ts'
import { retryWorker } from '../src/codex/retry.ts'

const fixture = `
const rl=require('node:readline').createInterface({input:process.stdin})
const out=m=>process.stdout.write(JSON.stringify(m)+'\\n')
let specs,turnPolicy,replies=[],serial=0
const req=(id,tool,overrides={})=>out({id,method:'item/tool/call',params:{threadId:'thread1',turnId:'turn'+serial,callId:'call',namespace:null,tool,arguments:{summary:'test',state:'ready'},...overrides}})
rl.on('line',l=>{
 const {method,id,params,result,error}=JSON.parse(l)
 if(!method){replies.push({id,result,error}); if(replies.length===6)out({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn'+serial,status:'completed'}}});return}
 if(method==='initialize')out({id,result:{userAgent:'test'}})
 if(method==='thread/start'){specs=params;out({id,result:{thread:{id:'thread1',status:{type:'idle'}},model:params.model||'default-model'}})}
 if(method==='thread/read')out({id,result:{thread:{id:'thread1',specs,replies,turnPolicy}}})
 if(method==='turn/start'){
  serial++;turnPolicy=params.sandboxPolicy;if(process.env.SCENARIO==='disconnect')return process.exit(0)
  if(process.env.SCENARIO==='calls'){
   req(201,'orchestrator_report');req(202,'orchestrator_report')
   req(203,'orchestrator_route')
   req(204,'orchestrator_report',{threadId:'other'})
   req(205,'orchestrator_report',{turnId:'other',callId:'late'})
   req(206,'orchestrator_report',{arguments:{summary:'changed'}})
  }
  out({id,result:{turn:{id:'turn'+serial,status:'inProgress'}}})
  out({method:'thread/tokenUsage/updated',params:{threadId:'thread1',turnId:'turn'+serial,tokenUsage:{total:{totalTokens:80}}}})
 }
 if(method==='turn/interrupt'){
  out({id,result:{}})
  out({method:'error',params:{threadId:'thread1',turnId:'turn'+serial,error:{codexErrorInfo:'unauthorized',message:'do not retain'},willRetry:false}})
  setTimeout(()=>out({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn'+serial,status:'interrupted'}}}),30)
 }
})
`
test('role, thread, turn and call identity hold for out-of-order requests', async t=>{
  let calls=0
  const events:SessionEvent[]=[]
  const session=await CodexSession.connect({command:process.execPath,args:['-e',fixture],env:{SCENARIO:'calls'},
    role:'worker',ticketId:'mail',onEvent:e=>events.push(e),onTool:async ctx=>{
      calls++; assert.deepEqual(ctx,{role:'worker',ticketId:'mail',assignmentId:'assignment-mail',threadId:'thread1',turnId:'turn1',callId:'call',tool:'orchestrator_report'})
      return {stored:true}
    }})
  t.after(()=>session.close())
  assert.deepEqual(await session.startThread({cwd:'/workspace'}),{threadId:'thread1',model:'default-model'})
  const {turnId}=await session.startTurn({assignmentId:'assignment-mail',text:'task'})
  assert.equal((await session.waitForCompletion(turnId)).status,'completed')
  const {specs,replies}=await session.readThread() as {specs:{dynamicTools:{name:string}[]},replies:{id:number,result:{success:boolean}}[]}
  assert.ok(!specs.dynamicTools.some(t=>t.name==='orchestrator_route'))
  assert.deepEqual(replies.sort((a,b)=>a.id-b.id).map(r=>r.result.success),[true,true,false,false,false,false])
  assert.equal(calls,1)
  assert.deepEqual(events.map(e=>e.type),['started','usage','completed'])
})
test('interrupt acknowledgement keeps turn busy until terminal status',async t=>{
  const events:SessionEvent[]=[]
  const session=await CodexSession.connect({command:process.execPath,args:['-e',fixture],env:{},role:'main',onTool:async()=>null,onEvent:e=>events.push(e)})
  t.after(()=>session.close())
  const binding=await session.startThread({cwd:'/empty',model:'override'})
  assert.equal(binding.model,'override')
  const turn=await session.startTurn({assignmentId:'eval-1',text:'evaluate'})
  await session.interrupt()
  await assert.rejects(session.startTurn({assignmentId:'eval-2',text:'evaluate'}))
  assert.equal((await session.waitForCompletion(turn.turnId)).status,'interrupted')
  assert.deepEqual(events.find(e=>e.type==='error'),{type:'error',threadId:'thread1',turnId:'turn1',errorCode:'unauthorized',willRetry:false})
})
test('lost start acknowledgement fails with uncertain status; cannot redeliver on the connection',async t=>{
  const session=await CodexSession.connect({command:process.execPath,args:['-e',fixture],env:{SCENARIO:'disconnect'},role:'worker', ticketId:'A',onTool:async()=>null})
  t.after(()=>session.close())
  await session.startThread({cwd:'/workspace'})
  await assert.rejects(session.startTurn({assignmentId:'one',text:'go'}), ConnectionLost)
  await assert.rejects(session.startTurn({assignmentId:'one',text:'go'}))
})
test('worker retry uses 15/30/60s, stops on expired eligibility, auth and uncertain outcomes',async ()=>{
  const delays:number[]=[]
  assert.deepEqual(await retryWorker({attempt:async n=>({value:n,errorCode:'serverOverloaded'}),canRetry:async()=>true,
    sleep:async ms=>{delays.push(ms)}}),{value:4,attempts:4})
  assert.deepEqual(delays,[15000,30000,60000])
  for(const code of ['unauthorized','usageLimitExceeded','modelNotFound','unknown']){
    assert.equal((await retryWorker({attempt:async n=>({value:n,errorCode:code}),canRetry:async()=>true})).attempts,1)
  }
  let paused=false
  assert.equal((await retryWorker({attempt:async()=>({value:'failed',errorCode:'serverOverloaded'}),
    canRetry:async()=>!paused,sleep:async()=>{paused=true}})).attempts,1)
  await assert.rejects(retryWorker({attempt:async()=>{throw new ConnectionLost('uncertain')},canRetry:async()=>true}),ConnectionLost)
})

test('only a Worker launched inside its verified boundary selects externalSandbox',async t=>{
  const opts={command:process.execPath,args:['-e',fixture],env:{},onTool:async()=>null}
  await assert.rejects(CodexSession.connect({...opts,role:'main',externallySandboxed:true}),/isolated Worker/)
  const session=await CodexSession.connect({...opts,role:'worker',ticketId:'isolated',externallySandboxed:true})
  t.after(()=>session.close())
  await session.startThread({cwd:'/workspace'})
  await session.startTurn({assignmentId:'active',text:'test'})
  assert.deepEqual((await session.readThread()).turnPolicy,{type:'externalSandbox',networkAccess:'enabled'})
})
