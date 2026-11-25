import {spawn} from 'node:child_process'
import {openSync,closeSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {homedir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {createInterface} from 'node:readline/promises'
import {loadConfig,instanceDir} from './host/config.ts'
import {connect,invoke,lockInstance,privateDir,serve} from './host/server.ts'

async function main(args:string[]){
  let configFile=process.env.ORCH_CONFIG||join(homedir(),'.config','codex-orchestration','binding.json')
  if(args[0]==='--config'){if(!args[1])throw Error('Missing config path');configFile=resolve(args[1]);args=args.slice(2)}
  const [action,...words]=args
  const usage='orch [--config PATH] chat | say MESSAGE | status | trace TRIGGER | show TICKET | pause TICKET | resume TICKET | clear-excerpts TICKET | track-pr TICKET N | role-model ROLE MODEL | grant | revoke | stop'
  if(action==='--help'){console.log(usage);return}
  const config=loadConfig(configFile),dir=instanceDir(config)
  privateDir(dir)
  if(action==='daemon'){
    let release
    try{release=lockInstance(dir)}catch(e){if(String(e).includes('already owns'))return;throw e}
    let stopHttp:(()=>Promise<void>)|undefined
    const {Host}=await import('./host/runtime.ts')
    const host=new Host(config,dir)
    let shuttingDown=false
    const shutdown=async()=>{
      if(shuttingDown)return
      shuttingDown=true
      try{await stopHttp?.();await host.close()}finally{release();process.exitCode=0}
    }
    try {
      await host.initialize()
      stopHttp=await serve(dir,config.repository,async(cmd,body)=>{
        if(cmd==='stop'){setTimeout(()=>void shutdown(),30);return {status:'stopping'}}
        return host.command(cmd,body)
      })
      process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown())
    }catch(e){await host.close();release();throw e}
    return
  }
  let info=await connect(dir,config.repository)
  if(!info){
    if(action==='stop'){console.log('Host is stopped');return}
    const log=openSync(join(dir,'startup.log'),'a',0o600)
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--config',configFile,'daemon'],
      {detached:true,stdio:['ignore',log,log],env:process.env})
    closeSync(log);child.unref()
    for(let n=0;n<150&&!info;n++){await delay(120);info=await connect(dir,config.repository)}
    if(!info)throw Error('Host startup failed: '+readFileSync(join(dir,'startup.log'),'utf8').slice(-512))
  }
  async function command(name:string,body:Record<string,unknown>){console.log(JSON.stringify(await invoke(info!,name,body),null,2))}
  if(!action||action==='chat'){
    const input=createInterface({input:process.stdin,output:process.stdout})
    let cursor=0,reading=false
    const readMessages=async()=>{
      if(reading)return
      reading=true
      try{for(const row of await invoke(info!,'events',{after:cursor})){
        console.log((row.ticket?'['+row.ticket+'] ':'')+row.text)
        cursor=row.seq
      }}catch(e){console.error((e as Error).message)}finally{reading=false}
    }
    await readMessages()
    const listen=setInterval(()=>void readMessages(),750)
    try{for await(const line of input){
      if(line==='/exit')break
      if(line==='/status')await command('status',{})
      else if(/^\/(show|pause|resume|clear-excerpts)\s+\S+$/.test(line)){const [name,ticket]=line.slice(1).split(/\s+/);await command(name,{ticket})}
      else if(line.trim())await command('say',{id:randomUUID(),text:line})
    }}finally{clearInterval(listen);input.close()}
  }else if(action==='say')await command(action,{id:randomUUID(),text:words.join(' ')})
  else if(action==='trace'&&words.length===1)await command(action,{trigger:words[0]})
  else if(action==='track-pr'&&words.length===2)await command(action,{ticket:words[0],pr:Number(words[1])})
  else if(action==='role-model'&&words.length===2)await command(action,{role:words[0],model:words[1]==='default'?'':words[1]})
  else if(['status','grant','revoke','stop'].includes(action))await command(action,{})
  else if(['show','pause','resume','clear-excerpts'].includes(action)&&words[0])await command(action,{ticket:words[0]})
  else throw Error(usage)
}
main(process.argv.slice(2)).catch(err=>{console.error(err.message);process.exitCode=1})
