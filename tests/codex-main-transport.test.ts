import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir,mkdtemp,rm,stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexSession } from '../src/codex/session.ts'
import type { ProcessOptions } from '../src/codex/transport.ts'
import { openMainTransport } from '../src/codex/main-transport.ts'

test('Main service refuses a shared or nonprivate working directory before launch',async t=>{
  const root=await mkdtemp('/tmp/main-policy-')
  t.after(()=>rm(root,{recursive:true,force:true}))
  const cwd=join(root,'workspace')
  await mkdir(cwd,{mode:0o755})
  await assert.rejects(openMainTransport({bin:process.execPath,env:{HOME:root,CODEX_HOME:root},args:['app-server'],cwd}),/private/)
  await assert.rejects(openMainTransport({bin:process.execPath,env:{HOME:root,CODEX_HOME:root},args:['app-server'],cwd:root}),/overlap/)
})

test('dedicated Main listener requires its private capability and exits when the hosting process dies', {
  skip: !process.env.CODEX_TEST_BIN, timeout:20_000,
}, async t=>{
  const root=await mkdtemp('/tmp/main-lifetime-')
  const cwd=join(root,'workspace')
  await mkdir(cwd,{mode:0o700})
  const code=`
    import {openMainTransport} from ${JSON.stringify(new URL('../src/codex/main-transport.ts',import.meta.url).href)}
    const transport=await openMainTransport({bin:process.env.BIN, args:['app-server','--stdio'],
      env:{PATH:process.env.PATH,HOME:process.env.ROOT,CODEX_HOME:process.env.ROOT,OPENAI_API_KEY:'fixture-identity'},cwd:process.argv[1]})
    console.log(JSON.stringify(transport.descriptor))
  `
  const host=spawn(process.execPath,['--input-type=module','-e',code,cwd],{
    cwd,env:{PATH:process.env.PATH,BIN:process.env.CODEX_TEST_BIN,ROOT:root},stdio:['ignore','pipe','ignore'],
  })
  const ended=once(host,'exit')
  let client: CodexSession|undefined
  t.after(async()=>{
    await client?.close()
    if(host.exitCode===null && host.signalCode===null)host.kill('SIGKILL')
    await ended
    await rm(root,{recursive:true,force:true,maxRetries:3})
  })
  const output=createInterface({input:host.stdout})
  const [line]=await once(output,'line')
  assert.ok(!line.includes('fixture-identity'))
  const descriptor=JSON.parse(line) as ProcessOptions
  const [,endpoint,capabilityFile]=descriptor.args
  assert.equal((await stat(capabilityFile)).mode&0o777,0o600)
  assert.equal(descriptor.env.OPENAI_API_KEY,undefined)
  await new Promise<void>((resolve,reject)=>{
    const socket=new WebSocket(endpoint)
    socket.addEventListener('error',()=>resolve(),{once:true})
    socket.addEventListener('open',()=>{socket.close();reject(Error('Unauthenticated Main client connected'))},{once:true})
  })
  client=await CodexSession.connect({...descriptor,role:'main',onTool:async()=>null})
  assert.match(String(client.initialized?.userAgent),/0\.171\.0/)
  host.kill('SIGKILL')
  await ended
  const health=endpoint.replace('ws:','http:')+'/readyz'
  for(let n=0;n<80;n++) {
    const alive=await fetch(health,{signal:AbortSignal.timeout(250)}).then(()=>true,()=>false)
    if(!alive && !await stat(capabilityFile).catch(()=>null)) return
    await delay(50)
  }
  assert.fail('Private App Server or capability survived host death')
})
