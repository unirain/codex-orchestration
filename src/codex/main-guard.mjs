/** An IPC disconnect is observable even after SIGKILL of the hosting daemon. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const directory = mkdtempSync(join(process.env.CODEX_HOME,'.main-transport-'))
const token = join(directory,'capability')
writeFileSync(token,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'})
let service
let stopping = false
let force
function finish(code) {
  clearTimeout(force)
  rmSync(directory,{recursive:true,force:true})
  if(process.connected)process.disconnect()
  process.exit(code)
}
function stop() {
  if(stopping)return
  stopping=true
  if(!service?.pid)return finish(0)
  try{process.kill(-service.pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}
  force=setTimeout(()=>{try{process.kill(-service.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}},2500)
}
process.once('disconnect',stop)
process.once('SIGTERM',stop)
process.once('SIGINT',stop)
process.once('message',({bin,args})=>{
  if(stopping)return
  service=spawn(bin,[...args,'--listen','ws://127.0.0.1:0','--ws-auth','capability-token','--ws-token-file',token],
    {env:process.env,cwd:process.cwd(),detached:true,stdio:['ignore','ignore','pipe']})
  service.once('error',()=>finish(1))
  service.once('close',()=>finish(stopping?0:1))
  let notified=false
  const lines=createInterface({input:service.stderr,crlfDelay:Infinity})
  lines.on('line',line=>{
    const url=line.match(/^\s*listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)\s*$/)?.[1]
    if(url&&!notified&&process.connected){
      notified=true
      process.send({address:url,token},error=>{if(error)stop()})
    }
  })
})
