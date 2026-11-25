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

test('AC-018 real service: dropped turn/start acknowledgement reattaches to the live turn', {
  skip: !process.env.CODEX_TEST_BIN, timeout: 30_000,
}, async t=>{
  const {spawn} = await import('node:child_process')
  const {mkdtemp, mkdir, writeFile, rm} = await import('node:fs/promises')
  const {join} = await import('node:path')
  const {createServer} = await import('node:http')
  const {once} = await import('node:events')
  const {setTimeout:delay} = await import('node:timers/promises')
  const {CodexSession,ConnectionLost} = await import('../src/codex/session.ts')
  const root=await mkdtemp('/tmp/reattach-')
  const cwd=join(root,'workspace'), state=join(root,'state')
  await Promise.all([mkdir(cwd),mkdir(state)])
  const env={HOME:root,CODEX_HOME:state,PATH:process.env.PATH,TMPDIR:root}
  const bin=process.env.CODEX_TEST_BIN!
  const received=Promise.withResolvers<void>(), finish=Promise.withResolvers<void>()
  let requests=0
  const provider=createServer(async(req,res)=>{
    for await (const _ of req) {}
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
    requests++;received.resolve()
    await finish.promise
    const events=[
      {type:'response.created',response:{id:'r1'}},
      {type:'response.output_item.done',item:{type:'message',role:'assistant',id:'m1',content:[{type:'output_text',text:'done'}]}},
      {type:'response.completed',response:{id:'r1',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}},
    ]
    res.writeHead(200,{'content-type':'text/event-stream'}).end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''))
  })
  provider.listen(0,'127.0.0.1');await once(provider,'listening')
  const port=(provider.address() as {port:number}).port
  await writeFile(join(state,'config.toml'),[
    'model="gpt-5.4"','model_provider="fixture"','[model_providers.fixture]','name="isolated test"',
    'base_url="http://127.0.0.1:'+port+'/v1"','wire_api="responses"','request_max_retries=0','stream_max_retries=0','supports_websockets=false',
  ].join('\n'))
  const reserve=createServer()
  reserve.listen(0,'127.0.0.1');await once(reserve,'listening')
  const address='ws://127.0.0.1:'+(reserve.address() as {port:number}).port
  await new Promise<void>(resolve=>reserve.close(()=>resolve()))
  const token=join(root,'cap')
  await writeFile(token,(await import('node:crypto')).randomBytes(32).toString('hex'),{mode:0o600})
  const service=spawn(bin,['app-server','--listen',address,'--ws-auth','capability-token','--ws-token-file',token],{env,cwd,stdio:'ignore'})
  const closed=once(service,'close')
  const clients: InstanceType<typeof CodexSession>[]=[]
  t.after(async()=>{
    finish.resolve()
    await Promise.all(clients.map(c=>c.close()))
    service.kill()
    await closed
    provider.closeAllConnections();provider.close()
    await rm(root,{recursive:true,force:true,maxRetries:3})
  })
  for(let n=0;n<100;n++){
    if(await fetch(address.replace('ws:','http:')+'/readyz').then(()=>true,()=>false))break
    await delay(25)
  }
  const h=fixture();t.after(h.close)
  const bridge=`
    const {createInterface}=require('node:readline'),{readFileSync}=require('node:fs')
    const [endpoint,file,mode]=process.argv.slice(1)
    const ws=new WebSocket(endpoint,{headers:{Authorization:'Bearer '+readFileSync(file,'utf8')}})
    ws.addEventListener('error',()=>process.exit(2));ws.addEventListener('close',()=>process.exit(0))
    let drop
    ws.addEventListener('open',()=>createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);if(mode==='drop'&&m.method==='turn/start')drop=m.id
      ws.send(line)
    }))
    ws.addEventListener('message',({data})=>{
      const m=JSON.parse(data)
      if(drop!==undefined&&m.id===drop&&m.result?.turn)process.exit(0)
      process.stdout.write(data+'\\n')
    })
  `
  const basic={env,cwd,role:'worker' as const,ticketId:h.owner,onTool:async()=>{throw Error('No tools expected')}}
  const first=await CodexSession.connect({...basic,command:process.execPath,args:['-e',bridge,address,token,'drop']})
  clients.push(first)
  const {threadId}=await first.startThread({cwd})
  h.d.db.prepare('UPDATE host_sessions SET thread=? WHERE owner=?').run(threadId,h.owner)
  await assert.rejects(first.startTurn({assignmentId:h.assignment,inputId:key('turn-input','call','0'),text:'Say done'}),ConnectionLost)
  await received.promise
  const second=await CodexSession.connect({...basic,command:process.execPath,args:['-e',bridge,address,token,'normal']})
  clients.push(second)
  const history=await second.readThread(threadId,true)
  const turns=history.turns as {id:string,status:string}[]
  assert.equal(turns.length,1)
  assert.equal(turns[0].status,'inProgress')
  const turnId=turns[0].id
  await second.resumeThread({threadId,cwd,active:{turnId,assignmentId:h.assignment}})
  assert.equal(await observeDispatch(h.d,h.owner,await second.readThread(threadId,true) as {turns:unknown[]},h.callbacks),'observing')
  finish.resolve()
  const done=await second.waitForCompletion(turnId)
  assert.equal(done.status,'completed')
  assert.equal(await observeDispatch(h.d,h.owner,await second.readThread(threadId,true) as {turns:unknown[]},h.callbacks),'idle')
  assert.deepEqual(h.events,['started','completed'])
  assert.equal(requests,1)
})
