import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs'
const [action,id,command]=process.argv.slice(2)
if(!/^[0-9a-f-]{36}$/.test(id))throw Error('invalid test run ID')
const pidfile='/tmp/project/'+id+'.pid'
if(action==='cancel'){
  try { process.kill(-Number(readFileSync(pidfile,'utf8')),'SIGKILL') } catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e}
} else if(action==='run'){
  const child=spawn('/bin/sh',['-c',command],{cwd:'/workspace',detached:true,stdio:['ignore','inherit','inherit']})
  writeFileSync(pidfile,String(child.pid),{mode:0o600,flag:'wx'})
  child.once('exit',(code,signal)=>{
    // Terminate any subprocess still attached to the completed test process group.
    try { process.kill(-child.pid,'SIGKILL') } catch(e){if(e.code!=='ESRCH')throw e}
    unlinkSync(pidfile);process.exit(code??(signal==='SIGKILL'?137:1))
  })
} else throw Error('unknown action')
