import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { instanceDir } from '../src/host/config.ts'
import type {Config} from '../src/host/config.ts'

const exec=promisify(execFile)
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url))

test('two real CLI processes auto-connect to one host, post a message and later query/pause/resume the same Ticket from another cwd', {timeout:40000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'orch-terminal-audit-'))
  const repo=join(root,'repo'),bin=join(root,'bin'), elsewhere=join(root,'elsewhere'),file=join(root,'binding.json'),bound=join(root,'state')
  await Promise.all([repo,bin,elsewhere].map(path=>mkdir(path)))
  const fakeCodex=join(bin,'app-server.mjs')
  const firstMessage='调整 follow up'
  await writeFile(fakeCodex,`#!${process.execPath}
import {createInterface} from 'node:readline'
const out=m=>console.log(JSON.stringify(m))
const threadId='synthetic-local-main',turnId='synthetic-turn'
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line),{id,method,params}=q
 if(method==='initialize')out({id,result:{userAgent:'codex-orchestration/0.171.0 LOCAL-AUDIT-FIXTURE'}})
 else if(method==='thread/start')out({id,result:{thread:{id:threadId,status:{type:'idle'}},model:'audit-model'}})
 else if(method==='turn/start'){
   out({id,result:{turn:{id:turnId,status:'inProgress'}}})
   out({id:987,method:'item/tool/call',params:{threadId,turnId,callId:'accept',namespace:null,tool:'orchestrator_route',
     arguments:{kind:'accept',title:'Follow up',scope:'Follow up',reason:'explicit local fixture request'}}})
 } else if(!method&&id===987)out({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}})
 else if(method==='thread/read')out({id,result:{thread:{id:threadId,turns:[]}}})
})
`,{mode:0o700})
  // No credentials, real provider or running container are needed for this host/CLI boundary test.
  await writeFile(join(bin,'docker'),'#!/bin/sh\nexit 3\n',{mode:0o700})
  const config:Config={actor:'local-owner',repository:'audit/terminal',repoDir:repo,codex:fakeCodex,image:'audit/missing:fixture',
    modelKeyEnv:'ORCH_SYNTHETIC_KEY',provider:'openai'}
  await writeFile(file,JSON.stringify(config),{mode:0o600})
  const env={PATH:bin+':'+dirname(process.execPath)+':/usr/bin:/bin',HOME:root,LANG:'C',ORCH_STATE_ROOT:bound,ORCH_SYNTHETIC_KEY:'synthetic-noncredential'}
  async function run(command:string[],cwd=repo) {
    const {stdout}=await exec(process.execPath,[cli,'--config',file,...command],{cwd,env,timeout:23000})
    return JSON.parse(stdout)
  }
  let endpoint:string|undefined
  t.after(async()=>{
    try{
      await run(['stop']).catch(()=>{})
      // Wait for the host to unlink its endpoint before deleting its private runtime directory.
      for(let n=0;endpoint && n<100;n++){
        if(!await readFile(endpoint).then(()=>true,()=>false))break
        await delay(50)
      }
    }finally{await rm(root,{force:true,recursive:true})}
  })
  const [a,b]=await Promise.all([run(['status']),run(['status'],elsewhere)])
  assert.equal(a.repo,'audit/terminal');assert.equal(a.thread,b.thread)
  const bindingName=instanceDir(config).split('/').at(-1)!
  endpoint=join(bound,bindingName,'instance.json')
  const first=JSON.parse(await readFile(endpoint,'utf8'))
  const trigger=await run(['say',firstMessage])
  let status
  for(let n=0;n<60;n++){
    status=await run(['status'],elsewhere)
    if(status.tickets.length)break
    await delay(100)
  }
  assert.equal(status.tickets.length,1,JSON.stringify(status))
  const id=status.tickets[0].id
  const details=await run(['show',id],elsewhere)
  assert.equal(details.ticket.origin.triggerId,trigger.trigger)
  assert.equal(details.ticket.assignments.length,1)
  await run(['pause',id],elsewhere)
  assert.equal((await run(['status'])).tickets[0].status,'paused')
  await run(['resume',id])
  assert.notEqual((await run(['status'])).tickets[0].status,'paused')
  const second=JSON.parse(await readFile(endpoint,'utf8'))
  assert.equal(second.pid,first.pid);assert.equal(second.url,first.url)
})
