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
  const handler=new URL('./fixtures/main-for-cli.mjs',import.meta.url).href
  await writeFile(fakeCodex,`#!${process.execPath}\nimport ${JSON.stringify(handler)}\n`,{mode:0o700})
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
  assert.deepEqual(await run(['resume',id]),{resumed:id})
  const after=await run(['status'])
  // The fixture intentionally supplies an unavailable Docker binary. A later dispatch may
  // already have recorded a new environmental block after the operator's successful resume.
  if(after.tickets[0].status==='paused'){
    assert.ok(after.faults.some((f:{owner:string;message:string})=>f.owner===id && /docker.*exited 3/i.test(f.message)),JSON.stringify(after))
    const detail=await run(['show',id])
    assert.equal(detail.ticket.assignments.at(-1).report.state,'blocked')
  }
  const second=JSON.parse(await readFile(endpoint,'utf8'))
  assert.equal(second.pid,first.pid);assert.equal(second.url,first.url)
})

test('offline scripted Main accepts the guardian capability over loopback and rejects unauthenticated clients',async t=>{
  const {openMainTransport}=await import('../src/codex/main-transport.ts')
  const {CodexSession}=await import('../src/codex/session.ts')
  const root=await mkdtemp(join(tmpdir(),'orch-scripted-main-'))
  const home=join(root,'home'),cwd=join(root,'cwd'),bin=join(root,'fake-main')
  await Promise.all([home,cwd].map(dir=>mkdir(dir,{mode:0o700})))
  const handler=new URL('./fixtures/main-for-cli.mjs',import.meta.url).href
  await writeFile(bin,`#!${process.execPath}\nimport(${JSON.stringify(handler)})\n`,{mode:0o700})
  const transport=await openMainTransport({bin,args:['app-server','--stdio'],cwd,
    env:{HOME:home,CODEX_HOME:home,PATH:process.env.PATH}})
  t.after(async()=>{await transport.close();await rm(root,{recursive:true,force:true})})
  const address=transport.descriptor.args.find(v=>v.startsWith('ws://127.0.0.1:'))
  assert.ok(address)
  const unauthorized=new WebSocket(address)
  const allowed=await new Promise<boolean>(resolve=>{
    unauthorized.addEventListener('error',()=>resolve(false),{once:true})
    unauthorized.addEventListener('open',()=>{unauthorized.close();resolve(true)},{once:true})
  })
  assert.equal(allowed,false)
  const session=await CodexSession.connect({...transport.descriptor,role:'main',onTool:async()=>{throw Error('unexpected tool')}})
  try {assert.equal((await session.startThread({cwd})).threadId,'synthetic-local-main')}
  finally {await session.close()}
})
