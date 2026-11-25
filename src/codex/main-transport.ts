import { fork } from 'node:child_process'
import { homedir } from 'node:os'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProcessOptions } from './transport.ts'

interface Options {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}
export interface MainTransport {
  descriptor: ProcessOptions
  close(): Promise<void>
}
async function privateDirectory(path: string) {
  const resolved = await realpath(path)
  const st = await stat(resolved)
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077))
    throw Error('Main service requires a private operator-owned directory')
  return resolved
}

/** Starts exactly one dedicated Main App Server. Disconnecting its stdio bridge
 * leaves the server, original turn and control socket alive for reattachment. */
export async function openMainTransport(options: Options): Promise<MainTransport> {
  if (!isAbsolute(options.bin) || !isAbsolute(options.cwd) || options.args[0] !== 'app-server')
    throw Error('Expected an absolute Codex executable and dedicated Main working directory')
  const {env} = options
  if (!env.HOME || !env.CODEX_HOME) throw Error('Main requires dedicated service home and session storage')
  const [home,state,cwd,operator] = await Promise.all([
    privateDirectory(env.HOME), privateDirectory(env.CODEX_HOME),privateDirectory(options.cwd),realpath(homedir()),
  ])
  if ([home,state,cwd].some(p=>p===operator || p===join(operator,'.codex')) || cwd===home || cwd===state)
    throw Error('Main service directories overlap the operator profile or session storage')
  const serviceEnv: NodeJS.ProcessEnv = { HOME:home,CODEX_HOME:state,PATH:env.PATH,LANG:'C.UTF-8',NO_COLOR:'1' }
  for (const k of ['OPENAI_API_KEY','DEEPSEEK_API_KEY']) if (env[k]) serviceEnv[k]=env[k]
  const args=options.args.filter(a=>a!=='--stdio')
  if(args.slice(1).some((v,i)=>i%2===0 ? v!=='-c' : !v.includes('=')) || args.length%2!==1)
    throw Error('Unexpected Main App Server launcher options')

  const guard=fork(fileURLToPath(new URL('./main-guard.mjs',import.meta.url)),[],{
    cwd,env:serviceEnv,execArgv:[],stdio:['ignore','ignore','ignore','ipc'],
  })
  const closed = new Promise<void>(resolve=>{guard.once('exit',()=>resolve());guard.once('error',()=>resolve())})
  const ready = Promise.withResolvers<{address:string,token:string}>()
  guard.once('message',(info:unknown)=>{
    if(!info || typeof info!=='object' || !('address' in info) || !('token' in info)
      || typeof info.address!=='string' || !/^ws:\/\/127\.0\.0\.1:\d+$/.test(info.address) || typeof info.token!=='string'){
      ready.reject(Error('Invalid Main service endpoint'));return
    }
    ready.resolve({address:info.address,token:info.token})
  })
  guard.once('error',()=>ready.reject(Error('Unable to start Main service guardian')))
  guard.once('exit',()=>ready.reject(Error('Main service exited before initialization')))
  const timeout=setTimeout(()=>ready.reject(Error('Main service startup timed out')),30_000)
  async function close(){
    if(guard.connected)guard.disconnect()
    await closed
  }
  try {
    guard.send({bin:options.bin,args},err=>{if(err)ready.reject(Error('Unable to initialize Main service guardian'))})
    const {address,token}=await ready.promise
    return {descriptor:{command:process.execPath,args:[
      fileURLToPath(new URL('./ws-stdio.mjs',import.meta.url)),address,token,
    ],cwd,env:{PATH:env.PATH,LANG:'C.UTF-8'}},close}
  }catch(error){await close();throw error}
  finally{clearTimeout(timeout)}
}
