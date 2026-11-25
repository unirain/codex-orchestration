import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,copyFile,writeFile,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

test('receipt fault requires exact acceptance branch; kills verified disposable host once, then allows readback',async t=>{
  const root=await mkdtemp(join(tmpdir(),'codex-acceptance-fault-'))
  t.after(()=>rm(root,{force:true,recursive:true}))
  const fixture=(name:string,data:unknown)=>writeFile(join(root,name),JSON.stringify(data),{mode:0o600})
  const wrapper=join(root,'gh-fault.mjs'),fake=join(root,'fake-gh.mjs'), repo='unirain/test-orch-code'
  await copyFile(new URL('./fixtures/gh-lost-receipt.mjs',import.meta.url),wrapper)
  await writeFile(fake,`#!/usr/bin/env node
const number=97, r={full_name:'unirain/test-orch-code'}
process.stdout.write(JSON.stringify({number,base:{repo:r},head:{repo:r,ref:'ticket/mail',sha:'test-sha'}}))`,{mode:0o700})
  await fixture('fixture.json',{repo,gh:fake,configDir:root,instanceFile:join(root,'instance.json'),instanceRepo:'fixture'})
  await fixture('armed.json',{branch:'ticket/mail'})
  const host=join(root,'host.mjs')
  await writeFile(host,`
import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs'
const [root,path,flags]=process.argv.slice(2),repo='fixture',key='synthetic'
const server=createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+key){res.writeHead(403).end();return}
  res.end(JSON.stringify({repo}))
})
server.listen(0,'127.0.0.1',()=>{
  writeFileSync(root+'/instance.json',JSON.stringify({repo,key,pid:process.pid,url:'http://127.0.0.1:'+server.address().port}),{mode:0o600})
  const child=spawn(process.execPath,[root+'/gh-fault.mjs','api','--hostname','github.com',path,...JSON.parse(flags)],{
    env:{PATH:process.env.PATH,GH_CONFIG_DIR:root,GH_HOST:'github.com'},stdio:['ignore','inherit','ignore']})
  child.on('close',code=>{server.close();process.exitCode=code})
})`)
  async function run(path:string, args:string[]) {
    const hostProcess=spawn(process.execPath,[host,root,path,JSON.stringify(args)],{stdio:['ignore','pipe','pipe']})
    let stdout=''
    hostProcess.stdout.on('data',buf=>{stdout+=buf})
    const [status,signal]=await once(hostProcess,'close')
    return {stdout,status,signal}
  }
  assert.equal((await run('repos/someone/other/pulls',['--method','POST'])).status,1)
  const args=['--method','POST','-f','head=ticket/mail']
  assert.equal((await run('repos/'+repo+'/pulls',['--method','POST','-f','head=other'])).status,0)
  const killed=await run('repos/'+repo+'/pulls',args)
  assert.equal(killed.signal,'SIGKILL')
  assert.equal(killed.stdout,'')
  const saved=JSON.parse(await readFile(join(root,'injected.json'),'utf8'))
  assert.equal(saved.pr,97)
  const replay=await run('repos/'+repo+'/pulls',args)
  assert.equal(replay.status,0);assert.equal(JSON.parse(replay.stdout).number,97)
})
