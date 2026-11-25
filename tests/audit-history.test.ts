import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../src/host/runtime.ts'
import type { Config } from '../src/host/config.ts'
import { Delivery } from '../src/host/delivery.ts'
import type { Pull, Remote } from '../src/host/github.ts'
import { terminalTrigger } from '../src/domain.ts'

test('AC-045 after restart and manual cleanup, host trace recovers original message, mandate, reports, assignments, PR and test receipts',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'orch-history-')))
  t.after(()=>rmSync(root,{force:true,recursive:true}))
  const directory=join(root,'workspace'), gitDir=join(root,'git'), state=join(root,'state')
  mkdirSync(directory);mkdirSync(state,{mode:0o700})
  const git=(args:string[])=>execFileSync('git',args,{cwd:directory,encoding:'utf8',env:{PATH:process.env.PATH,
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',LANG:'C'}}).trim()
  git(['init','-q','-b','ticket/a','--separate-git-dir',gitDir])
  writeFileSync(join(directory,'subject.txt'),'mail repair')
  git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','mail'])
  const revision=git(['rev-parse','HEAD'])
  const config:Config={actor:'operator',provider:'openai',modelKeyEnv:'FIXTURE_UNUSED',repository:'fixture/repo',repoDir:root,
    codex:'/usr/bin/false',image:'fixture/missing',github:{repo:'fixture/repo',account:'agent',gh:'/usr/bin/false',configDir:state}}
  const host=new Host(config,state)
  const origin='mail-origin'
  const trigger=terminalTrigger(origin,'fix mail','operator')
  let id:string, assignment:string
  try{
    host.domain.engine.receive(trigger)
    host.domain.engine.evaluateDue()
    const acceptance=host.domain.engine.decide(origin,{kind:'accept',title:'mail',scope:'mail',reason:'explicit request',evalId:host.domain.engine.candidate(origin)!.evalId})
    id=acceptance.ticketId!
    assignment=host.domain.store.tickets.get(id)!.assignments[0].id
    host.domain.engine.assignmentStarted(id,assignment)
    host.supervision.reserve(id,assignment,'start');host.supervision.turnStarted(id,assignment,'turn')
    host.supervision.startTest({id:'failed-before-fix',ticketId:id,assignmentId:assignment,command:'node --test',commit:revision,dirty:false,image:'fixture'})
    host.supervision.finishTest('failed-before-fix',{status:'failed',exitCode:1,output:'erasable local failure'})
    host.domain.engine.report(id,{state:'progress',summary:'recorded failure'})
    let pr:Pull|undefined, head:string|null=null
    const remote:Remote={
      async verify(){},async head(){return head},async push(_ref,sha){head=sha},async lookup(){return pr?[pr]:[]},
      async create(ref,title,body,draft){
        return pr={repo:config.repository,headRepo:config.repository,author:'agent',base:ref.base,branch:ref.branch,number:1,
          title,body,draft,closedAt:null,merged:false,commit:revision}
      },
      async read(){assert.ok(pr);return pr},async edit(_n,title,body){assert.ok(pr);Object.assign(pr,{title,body})},async ready(){assert.ok(pr);pr.draft=false},
    }
    const thread={source:'github',id:'fixture/repo/pull/1'}
    const delivery=new Delivery(host.domain.db,remote,config.repository,'agent',{
      open:ticket=>ticket==='other-open-ticket' || !host.domain.store.tickets.get(ticket)?.ended,authorize:()=>{},
      bind:()=>host.domain.engine.bindThread(id,thread,true),closed:p=>host.domain.engine.threadClosed(thread,'merged',p.closedAt!),
    })
    const ref={ticket:id,directory,gitDir,base:'trunk',branch:'ticket/a'}
    await delivery.deliver('gh-create',ref,{operation:'create',title:'Mail',body:'Remaining check',draft:true,commit:revision})
    assert.equal(pr?.draft,true)
    assert.equal(host.domain.store.tickets.get(id)!.ended,undefined)
    await delivery.deliver('gh-update',ref,{operation:'update',pr:1,title:'Mail',body:'Checks complete',draft:false,commit:revision})
    assert.equal(pr?.draft,false)
    assert.equal(pr.body,'Checks complete')
    const req={operation:'update' as const,pr:1,title:'Mail',body:'Checks complete',draft:false,commit:revision}
    pr.branch='other-ticket'
    await assert.rejects(delivery.deliver('wrong-branch',ref,req),/not owned/)
    pr.branch=ref.branch
    pr.headRepo='fork/repo'
    await assert.rejects(delivery.deliver('fork',ref,req),/not owned/)
    pr.headRepo=config.repository
    host.domain.db.prepare('INSERT INTO tracked_pr(ticket,number) VALUES(?,?)').run('other-open-ticket',pr.number)
    await assert.rejects(delivery.deliver('already-owned',ref,req),/another open Ticket/)
    host.domain.db.prepare('DELETE FROM tracked_pr WHERE ticket=?').run('other-open-ticket')

    host.domain.engine.report(id,{state:'ready',summary:'self-review complete'})
    assert.ok(pr);pr.closedAt='2030-01-01T00:00:00Z';pr.merged=true
    await delivery.poll(1)
    assert.equal(host.domain.store.tickets.get(id)!.ended?.outcome,'merged')
    await host.command('clear-excerpts',{ticket:id})
    rmSync(directory,{recursive:true})
  }finally{await host.close()}
  const reopened=new Host(config,state)
  try{
    const result=await reopened.command('trace',{trigger:origin}) as any
    assert.equal(result.trigger.id,origin);assert.equal(result.trigger.text,trigger.text)
    assert.equal(result.disposition.decisionId,result.decisions[0].id)
    assert.equal(result.tickets.length,1)
    const ticket=result.tickets[0]
    assert.equal(ticket.id,id);assert.equal(ticket.assignments[0].id,assignment)
    assert.equal(ticket.mandate.scope,'mail')
    assert.deepEqual(ticket.history.filter((r:any)=>r.entity==='report').map((r:any)=>r.value.summary),['recorded failure','self-review complete'])
    assert.deepEqual(ticket.deliveries.filter((r:any)=>r.done).map((r:any)=>[r.pr,r.commit_sha,r.done]),[[1,revision,1],[1,revision,1]])
    assert.equal(ticket.tests[0].exitCode,1);assert.equal(ticket.tests[0].cleared,true);assert.equal(ticket.tests[0].excerpt,null)
    assert.equal(reopened.domain.engine.receive(trigger),'duplicate')
    assert.equal(reopened.domain.store.tickets.list().length,1)
  }finally{await reopened.close()}
})
