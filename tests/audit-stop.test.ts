import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../src/host/runtime.ts'
import type { Config } from '../src/host/config.ts'
import { terminalTrigger } from '../src/domain.ts'

test('AC-031 explicit Host.close cancels Main, Worker turns and outstanding test, and preserves undelivered input and local edits',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'orch-stop-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const cfg:Config={actor:'me',provider:'openai',repository:'org/repo',repoDir:dir,codex:'/unused',image:'test',modelKeyEnv:'SYNTHETIC_ONLY'}
  const host=new Host(cfg,dir),{domain,supervision}=host
  const sessions:string[]=[],confirmed:string[]=[]
  // Inject only the live resources at the Codex/process boundary; use actual Host.close, SQLite and supervision.
  const resources=host as unknown as {
    live:Map<string,{session:object;environment?:object}>,
    tests:Map<string,{abort:AbortController;done:Promise<void>}>
  }
  function live(owner:string){
    resources.live.set(owner,{session:{
      interrupt:async()=>{sessions.push(owner);return {turnId:owner+'-turn'}},
      waitForCompletion:async(turn:string)=>{assert.equal(turn,owner+'-turn');confirmed.push(owner)},
      close:async()=>{},
    }})
  }
  live('main')
  const tickets:{id:string;assignment:string}[]=[]
  for (const letter of ['a','b']) {
    domain.engine.receive({...terminalTrigger(letter,letter,'me'),threads:[{source:'terminal',id:letter}]})
    domain.engine.evaluateDue()
    const decision=domain.engine.decide(letter,{kind:'accept',reason:'test',title:letter,scope:letter,evalId:domain.engine.candidate(letter)!.evalId})
    const id=decision.ticketId!,assignment=domain.store.tickets.get(id)!.assignments[0].id
    domain.engine.assignmentStarted(id,assignment)
    supervision.reserve(id,assignment,'start');supervision.turnStarted(id,assignment,id+'-turn')
    live(id);tickets.push({id,assignment})
  }
  domain.engine.note(tickets[0].id,'saved input before stop')
  const pendingIds=domain.store.tickets.get(tickets[0].id)!.undelivered
  const {id,assignment}=tickets[1]
  supervision.startTest({id:'active-test',ticketId:id,assignmentId:assignment,command:'test',commit:'abc',dirty:true,image:'fixture'})
  const abort=new AbortController()
  const done=new Promise<void>(resolve=>abort.signal.addEventListener('abort',()=>{
    assert.equal(abort.signal.reason,'shutdown')
    supervision.finishTest('active-test',{status:'interrupted'})
    resolve()
  },{once:true}))
  resources.tests.set('active-test',{abort,done})
  const file=join(dir,'uncommitted');writeFileSync(file,'evidence')
  await host.close()
  assert.deepEqual(sessions.sort(),['main',...tickets.map(t=>t.id)].sort());assert.deepEqual(confirmed.sort(),sessions)
  const reopened=new Host(cfg,dir)
  try {
    assert.deepEqual(reopened.domain.store.tickets.get(tickets[0].id)!.undelivered,pendingIds)
    assert.equal(reopened.supervision.tests(id)[0].status,'interrupted')
    assert.equal(readFileSync(file,'utf8'),'evidence')
  } finally {await reopened.close()}
})
