import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { readFile, realpath, lstat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { checked, run, redact } from './process.ts'
import { ticketKey, type Workspace } from './workspace.ts'
import { authority } from './container/proxy.mjs'

const serviceUid='61000', gatewayUid='61001'
const helperDir=fileURLToPath(new URL('./container/',import.meta.url))
const localProxy='http://127.0.0.1:4020'
const repoEnv=[
  '-e','HOME=/tmp/project','-e','CODEX_HOME=/tmp/project/codex',
  ...['http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY'].flatMap(key=>['-e',key+'='+localProxy]),
  '-e','NO_PROXY=','-e','no_proxy=',
]
export interface RuntimeOptions {
  workspace: Workspace; stateDir: string; image: string; apiKey: string; allow?: string[];
  docker?: string; providerBaseUrl?: string; requireHistory?: boolean
}
function bind(src:string,dst:string,readonly=false){
  if(src.includes(',') || dst.includes(','))throw Error('Docker mount path contains a comma')
  return ['--mount',`type=bind,src=${src},dst=${dst}${readonly?',readonly':''}`]
}

const active = new Set<string>()
export async function openTicketRuntime(opts: RuntimeOptions) {
  const id = join(await realpath(opts.stateDir),ticketKey(opts.workspace.ticketId))
  if (active.has(id)) throw Error('Ticket already has an opening or active runtime')
  active.add(id)
  try {
    const runtime = await createRuntime(opts)
    let closing: Promise<void> | undefined
    return {...runtime, close: () => {
      if (!closing) closing = runtime.close().finally(() => active.delete(id))
      return closing
    }}
  } catch (error) {
    active.delete(id)
    throw error
  }
}

interface TicketResourceRef { stateDir:string; ticketId:string; docker?:string }
async function ticketResources(opts:TicketResourceRef) {
  const bin=opts.docker ?? 'docker'
  // Docker client gets its operator-selected daemon endpoint, never inherits application secrets.
  const env: NodeJS.ProcessEnv={}
  for(const k of ['PATH','HOME','DOCKER_CONFIG','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','XDG_RUNTIME_DIR','TMPDIR'])
    if(process.env[k])env[k]=process.env[k]
  const docker=(args:string[],input?:string)=>checked(bin,args,{input,env})
  const tag=ticketKey((await realpath(opts.stateDir))+'\0'+opts.ticketId).slice(0,28)
  const name='orch-ticket-'+tag, side=name+'-egress', history=name+'-history', relay=name+'-relay'
  const label='local.codex-orchestration.ticket='+tag
  // A single-repo host lock serializes runtime replacement. Only touch labelled containers owned by this ticket.
  async function removeOwned(kind:'container'|'volume', id:string){
    const inspection=await run(bin,[kind,'inspect','--format','{{json .}}',id],{env})
    if(inspection.code!==0){if(/no such (container|volume|object)/i.test(inspection.output))return false;throw Error(inspection.output)}
    const data=JSON.parse(inspection.output)
    if((data.Config?.Labels??data.Labels)?.['local.codex-orchestration.ticket']!==tag) throw Error('Docker resource ownership mismatch: '+id)
    await docker([kind,'rm',...(kind==='container'?['-f']:[]),kind==='container'?data.Id:id])
    return true
  }
  async function reap() {
    const container=await removeOwned('container',name)
    const egress=await removeOwned('container',side)
    const removedRelay=await removeOwned('volume',relay)
    return {container,egress,relay:removedRelay}
  }
  return {docker, env, tag, name, side, history, relay, label, reap}
}

// Requires the caller's exclusive per-repository host lock.
export async function reapTicketRuntime(opts:TicketResourceRef) {
  const id=join(await realpath(opts.stateDir),ticketKey(opts.ticketId))
  if (active.has(id)) throw Error('live Ticket must close through its runtime handle')
  active.add(id)
  try { return await (await ticketResources(opts)).reap() } finally { active.delete(id) }
}

async function createRuntime(opts: RuntimeOptions) {
  const ws=opts.workspace, bin=opts.docker??'docker', stateDir=resolve(opts.stateDir)
  const ticketDir=join(stateDir,'tickets',ticketKey(ws.ticketId))
  const saved=JSON.parse(await readFile(join(ticketDir,'workspace.json'),'utf8'))
  const dir=await realpath(ws.directory)
  const st=await lstat(dir,{bigint:true})
  if(ws.directory!==saved.workspace.directory || ws.ticketId!==saved.workspace.ticketId ||
     !st.isDirectory() || st.ino.toString()!==saved.ino || st.dev.toString()!==saved.dev) throw Error('unverified Ticket workspace')
  const uid=String(process.getuid?.()??0)
  if(['0',serviceUid,gatewayUid].includes(uid))throw Error('run ticket host under a dedicated, non-root operator UID')
  if(!opts.apiKey || /[\r\n\0]/.test(opts.apiKey))throw Error('missing or invalid project model credential')
  const provider=new URL(opts.providerBaseUrl??'https://api.openai.com/v1')
  if(provider.protocol!=='https:' || provider.search || provider.hash || provider.username || provider.password)throw Error('require HTTPS model provider base URL')
  const allow=(opts.allow??[]).map(authority)
  const {docker,env,tag,name,side,history,relay,label,reap}=await ticketResources({stateDir,ticketId:ws.ticketId,docker:bin})
  if (!opts.image || opts.image.startsWith('-') || (!/(?:@sha256:|^sha256:)[a-f0-9]{64}$/.test(opts.image) &&
      (!opts.image.split('/').at(-1)?.includes(':') || opts.image.endsWith(':latest')))) throw Error('specify a fixed image tag or digest')
  const info=JSON.parse(await docker(['image','inspect','--format','{{json .}}',opts.image]))
  if(info.Os!=='linux' || typeof info.Id!=='string' || !/^sha256:[a-f0-9]{64}$/.test(info.Id) || Object.keys(info.Config.Volumes??{}).length)throw Error('expected a local immutable Linux development image without implicit volumes')
  const limits=['--read-only','--security-opt','no-new-privileges','--cap-drop','ALL','--pids-limit','400','--log-opt','max-size=1m','--log-opt','max-file=2','--label',label]
  const workerBin=(args:string[],user:string)=>['exec','--user',user,...(user===uid?repoEnv:[]),name,...args]
  await reap()
  const oldHistory=await run(bin,['volume','inspect',history],{env})
  if(oldHistory.code===0){
    if(JSON.parse(oldHistory.output)[0]?.Labels?.['local.codex-orchestration.ticket']!==tag)throw Error('private history belongs to another Ticket')
  } else if(opts.requireHistory)throw Error('persistent Ticket history volume is missing; resume blocked')
  else if(!/no such volume/i.test(oldHistory.output))throw Error(oldHistory.output)
  await docker(['volume','create','--label',label,history])
  await docker(['volume','create','--label',label,relay])
  const close=async()=>{await reap()}
  try {
    await docker(['run','-d','--pull=never','--name',side,...limits,'--user','0:0','--cap-add','CHOWN',
      '--mount',`type=volume,src=${relay},dst=/relay`,...bind(helperDir,'/opt/orch',true),
      '--entrypoint','node',info.Id,'/opt/orch/proxy.mjs','outbound',JSON.stringify({allow,providerBaseUrl:provider.href,serviceUid:Number(gatewayUid)})])
    await docker(['run','-d','--pull=never','--name',name,...limits,'--network','none',
      '--user','0:0','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER',
      '--tmpfs','/tmp:rw,nosuid,nodev,mode=1777','--tmpfs','/private:rw,nosuid,nodev,noexec,mode=0700',
      '--tmpfs','/service:rw,nosuid,nodev,noexec,mode=0700',
      '--mount',`type=volume,src=${history},dst=/history`,'--mount',`type=volume,src=${relay},dst=/relay,readonly`,
      ...bind(dir,'/workspace'),...bind(helperDir,'/opt/orch',true),'--entrypoint','sleep',info.Id,'infinity'])
    const init="umask 077; mkdir -p /tmp/project; chown \"$1\" /tmp/project; chmod 700 /history /private /service; chown \"$2\" /history /service; chown \"$3\" /private; test -S /relay/model.sock && test -S /relay/repo.sock"
    let ready=false
    for(let i=0;i<40 && !ready;i++){
      ready=(await run(bin,workerBin(['sh','-eu','-c',init,'init',uid,serviceUid,gatewayUid],'0'),{env})).code===0
      if(!ready)await delay(100)
    }
    if(!ready)throw Error('ticket proxy or private state initialization failed: '+(await docker(['logs','--tail','10',side])))
    const token=randomBytes(32).toString('hex')
    const secretFile=(user:string,file:string,secret:string)=>docker(['exec','-i','--user',user,name,'sh','-eu','-c','umask 077; cat > "$1"','secret',file],secret)
    await secretFile(gatewayUid,'/private/provider-key',opts.apiKey);await secretFile(gatewayUid,'/private/proxy-token',token)
    await secretFile(serviceUid,'/service/proxy-token',token)
    await docker(['exec','-d','--user',gatewayUid,name,'node','/opt/orch/proxy.mjs','local'])
    const codexVersion=await docker(workerBin(['codex','--version'],uid))
    await docker(['exec','-d','--user',uid,...repoEnv,'-w','/workspace',name,'codex','exec-server','--listen','ws://127.0.0.1:4022'])
    const probe='const net=require("node:net"); const ports=[4020,4021,4022]; Promise.all(ports.map(port=>new Promise((ok,fail)=>{const s=net.connect(port,"127.0.0.1",()=>{s.destroy();ok()}); s.on("error",fail)}))).catch(()=>process.exitCode=1)'
    ready=false
    for(let i=0;i<30 && !ready;i++){
      ready=(await run(bin,workerBin(['node','-e',probe],uid),{env})).code===0
      if(!ready) await delay(100)
    }
    if(!ready)throw Error('Ticket exec-server or egress relay unavailable: '+codexVersion)
    return {
      imageId:info.Id as string, codexVersion,
      appServer:()=>({externallySandboxed:true as const,command:bin,args:['exec','-i','--user',serviceUid,'-w','/history',name,'node','/opt/orch/app.mjs'],env}),
      runTest: async(command:string,signal?:AbortSignal)=>{
        signal?.throwIfAborted()
        const id=randomUUID()
        const cancel=async()=>{
          // Registration can race cancellation. Repeat until PID file appears or run has finished.
          while(!finished){
            await run(bin,workerBin(['node','/opt/orch/test.mjs','cancel',id],uid),{env}).catch(()=>{})
            if(!finished)await delay(70)
          }
        }
        let finished=false
        const onAbort=()=>{void cancel()}
        signal?.addEventListener('abort',onAbort,{once:true})
        try{
          const result=await run(bin,workerBin(['node','/opt/orch/test.mjs','run',id,command],uid),{env,timeoutMs:2147483647})
          return {...result,output:redact(result.output).replaceAll(opts.apiKey,'[redacted]')}
        }finally{finished=true;signal?.removeEventListener('abort',onAbort)}
      },
      deniedTargets:async()=>{
        const logs=await docker(['logs','--tail','200',side])
        return logs.split('\n').flatMap(line=>{try{const e=JSON.parse(line);return typeof e.denied==='string'?[e.denied]:[]}catch{return []}})
      },close,
    }
  } catch(error){await close();throw error}
}
