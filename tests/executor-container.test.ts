import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { prepareTicket,openTicketRuntime } from '../src/executor/index.ts'
import { checked } from '../src/executor/process.ts'
import { ticketKey } from '../src/executor/workspace.ts'
import { realpath } from 'node:fs/promises'

const image=process.env.ORCH_TEST_IMAGE
test('real Ticket containers keep project, service and network boundaries; cancellation stops the test', {skip:!image}, async t=>{
  const stateDir=await mkdtemp(join(homedir(),'.orch-executor-eval-')); const root=await realpath(stateDir)
  t.after(()=>rm(stateDir,{recursive:true,force:true}))
  const key='test-only-'+randomUUID()
  const o={stateDir,repoDir:stateDir}
  const a=await prepareTicket({...o,ticketId:'A'}), b=await prepareTicket({...o,ticketId:'B'})
  const containerName=(id:string)=>'orch-ticket-'+ticketKey(root+'\0'+id).slice(0,28)
  async function open(workspace:typeof a){
    const r=await openTicketRuntime({workspace,stateDir,image:image!,apiKey:key})
    t.after(async()=>{await r.close();await checked('docker',['volume','rm',containerName(workspace.ticketId)+'-history'])})
    return r
  }
  const ra=await open(a),rb=await open(b)
  assert.match(ra.codexVersion,/codex-cli/);assert.equal(ra.imageId,rb.imageId)
  await writeFile(join(b.directory,'b-only'),'ticket-b')
  await symlink(join(b.directory,'b-only'),join(a.directory,'foreign'))
  const result=await ra.runTest('set -eu; test -z "${TICKET_MODEL_LEASE:-}"; test ! -r /private/provider-key; test ! -r /service/proxy-token; test ! -r /relay/model.sock; test ! -r /workspace/foreign; test ! -S /var/run/docker.sock; test -z "$(ls -A /sys/class/net | grep -v ^lo$)"; echo revised > /workspace/only-a')
  assert.equal(result.code,0,result.output);assert.equal(await readFile(join(a.directory,'only-a'),'utf8'),'revised\n')
  assert.equal((await rb.runTest('test ! -f /workspace/only-a')).code,0)
  const blocked=await ra.runTest('curl -sf --max-time 2 http://denied.example/path')
  assert.notEqual(blocked.code,0);assert.deepEqual(await ra.deniedTargets(),['denied.example:80'])
  const provider=await ra.runTest('curl -sS -w "%{http_code}" -x "" http://127.0.0.1:4021/models')
  assert.match(provider.output,/403$/)
  const abort=new AbortController()
  const testRun=ra.runTest('sleep 2; touch /workspace/late',abort.signal)
  setTimeout(()=>abort.abort(),150)
  assert.notEqual((await testRun).code,0)
  await new Promise(ok=>setTimeout(ok,2100));assert.equal((await ra.runTest('test ! -e late')).code,0)
  const fail=await prepareTicket({...o,ticketId:'missing'})
  await assert.rejects(openTicketRuntime({workspace:fail,stateDir,image:'orch-local/image-absent-test:missing',apiKey:key}),/image|object/i)
})

test('DeepSeek Worker runs its built-in shell as project identity and resumes the same thread after rebuild',
  {skip: !image || process.env.ORCH_DEEPSEEK_LIVE !== '1', timeout:180000}, async t=>{
  const apiKey=process.env.DEEPSEEK_API_KEY
  assert.ok(apiKey,'set the dedicated DeepSeek key')
  // The protocol adapter is supplied by EN-002 in the integrated tree.
  const {CodexSession}=await import('../src/codex/session.ts')
  const stateDir=await mkdtemp(join(homedir(),'.orch-live-executor-'))
  const workspace=await prepareTicket({stateDir,repoDir:stateDir,ticketId:'live-proof'})
  const name='orch-ticket-'+ticketKey(await realpath(stateDir)+'\0live-proof').slice(0,28)
  t.after(async()=>{await checked('docker',['volume','rm',name+'-history']);await rm(stateDir,{recursive:true,force:true})})
  let previous:string|undefined
  const proof=join(workspace.directory,'proof')
  for(const step of ['first','resumed']){
    const runtime=await openTicketRuntime({workspace,stateDir,image:image!,apiKey,providerBaseUrl:'https://api.deepseek.com',requireHistory:!!previous})
    try{
      const session=await CodexSession.connect({...runtime.appServer(),role:'worker',ticketId:workspace.ticketId,tools:[],onTool:async()=>{throw Error('unexpected dynamic tool')}})
      try{
        const options={cwd:'/workspace',model:'deepseek-flash'}
        const {threadId}=previous?await session.resumeThread({...options,threadId:previous}):await session.startThread(options)
        if(previous)assert.equal(threadId,previous)
        const command=step==='first'
          ? 'test -z "${TICKET_MODEL_LEASE:-}" && test ! -r /private/provider-key && test ! -r /service/proxy-token && printf first > /workspace/proof'
          : 'test "$(cat /workspace/proof)" = first && printf resumed >> /workspace/proof'
        const {turnId}=await session.startTurn({assignmentId:step,inputId:step,text:'Run exactly this harmless project smoke test with your built-in shell tool, once. Do not substitute another command. Command: '+command})
        assert.equal((await session.waitForCompletion(turnId)).status,'completed')
        const thread=await session.readThread(threadId)
        const executed=(thread.turns as Array<{id:string;items:Array<{type:string;command?:string;exitCode?:number}>}>)
          .find(turn=>turn.id===turnId)?.items
        assert.ok(executed?.some(item=>item.type==='commandExecution' && item.exitCode===0 && item.command?.includes(step==='first'?'TICKET_MODEL_LEASE':'/workspace/proof')),'expected the real built-in command and exit status')
        assert.equal(await readFile(proof,'utf8'),step==='first'?'first':'firstresumed')
        previous=threadId
      }finally{await session.close()}
    }finally{await runtime.close()}
  }
})
