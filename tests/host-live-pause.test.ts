import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Host} from '../src/host/runtime.ts'
import {terminalTrigger} from '../src/domain.ts'
import {ticketKey} from '../src/executor/workspace.ts'

const exec=promisify(execFile)
const image=process.env.ORCH_TEST_IMAGE
test('AC-004/015: pause a real Worker turn while its supervised check finishes and another Worker progresses',{
  skip:!image||process.env.ORCH_DEEPSEEK_LIVE!=='1',timeout:180000
},async t=>{
  assert.ok(process.env.DEEPSEEK_API_KEY)
  const dir=await realpath(await mkdtemp(join(homedir(),'.orch-pause-proof-')))
  const host=new Host({repository:'local/worker-pause-proof',repoDir:dir,actor:'operator',codex:process.env.CODEX_TEST_BIN??'codex',
    image:image!,provider:'deepseek',modelKeyEnv:'DEEPSEEK_API_KEY'},dir)
  const ids:string[]=[]
  t.after(async()=>{
    await host.close()
    for(const id of ids)await exec('docker',['volume','rm','orch-ticket-'+ticketKey(dir+'\0'+id).slice(0,28)+'-history']).catch(()=>{})
    await rm(dir,{recursive:true,force:true})
  })
  const d=host.domain
  // Start from two ordinary accepted tickets without spending a separate router call in this execution-only test.
  function assign(id:string,scope:string){
    d.engine.receive(terminalTrigger(id,scope,'operator'))
    for(const owner of ids)d.engine.handback(owner,id,'Independent acceptance scenario')
    d.engine.evaluateDue()
    const evalId=d.engine.candidate(id)!.evalId
    const ticket=d.engine.decide(id,{kind:'accept',evalId,title:id,scope,reason:'Operator-requested fixture'}).ticketId!
    ids.push(ticket);return ticket
  }
  const a=assign('slow-mail','Run exactly one supervised check using orchestrator_test with command "sleep 8 && exit 1". Then end the turn and wait. If the operator resumes you, report waiting and acknowledge the collected failed result without retrying.')
  await host.initialize()
  const until=async (condition:()=>boolean)=>{
    for(let i=0;i<1300;i++){if(condition())return;await delay(100)}
    assert.fail('Timed out. Host faults: '+JSON.stringify((await host.command('status',{}) as any).faults))
  }
  const runs=(id:string)=>d.db.prepare('SELECT turn,state FROM host_turns WHERE owner=? ORDER BY rowid').all(id)
  await until(()=>host.supervision.tests(a).some(r=>r.status==='running'))
  const first=runs(a)[0]
  assert.equal(first.state,'active')
  await host.command('pause',{ticket:a})
  const b=assign('follow-up','Independently inspect the empty synthetic workspace, then report waiting for the operator to define the follow-up condition. Do not create a PR.')
  await until(()=>host.supervision.tests(a)[0].status==='failed'&&d.store.tickets.get(b)?.assignments.at(-1)?.report?.state==='waiting')
  assert.deepEqual(runs(a),[{...first,state:'interrupted'}].map(x=>Object.assign(Object.create(null),x)))
  assert.equal(host.supervision.isPaused(a),true)
  const thread=d.db.prepare('SELECT thread FROM host_sessions WHERE owner=?').get(a)!.thread
  assert.notEqual(thread,d.db.prepare('SELECT thread FROM host_sessions WHERE owner=?').get(b)!.thread)
  await host.command('resume',{ticket:a})
  await until(()=>runs(a).length>1&&d.store.tickets.get(a)?.assignments.at(-1)?.report?.state==='waiting')
  assert.equal(d.db.prepare('SELECT thread FROM host_sessions WHERE owner=?').get(a)!.thread,thread)
  t.diagnostic(JSON.stringify({mailThread:thread,interrupted:first.turn,followUp:b,test:host.supervision.tests(a)[0].status,resumed:runs(a).at(-1)?.turn}))
})
