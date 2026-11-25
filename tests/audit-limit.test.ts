import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Host } from '../src/host/runtime.ts'
import { serve } from '../src/host/server.ts'
import type { Config } from '../src/host/config.ts'
import { terminalTrigger } from '../src/domain.ts'
import { CodexSession } from '../src/codex/session.ts'
import type { SessionEvent } from '../src/codex/session.ts'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const wire = `
const rl=require('node:readline').createInterface({input:process.stdin})
const out=m=>console.log(JSON.stringify(m))
let count=0
rl.on('line',line=>{
 const q=JSON.parse(line),{method,id,params}=q
 if(method==='initialize')out({id,result:{userAgent:'codex-orchestration/0.171.0 quota-fixture'}})
 else if(method==='thread/start')out({id,result:{thread:{id:'quota-thread'},model:'fixture-model'}})
 else if(method==='turn/start'){
   const turnId='t'+(++count)
   out({id,result:{turn:{id:turnId,status:'inProgress'}}})
   if(count===2){
     // Delayed repeated cumulative updates for the first turn arrive after its successor starts.
     for(let i=0;i<2;i++)out({method:'thread/tokenUsage/updated',params:{threadId:'quota-thread',turnId:'t1',tokenUsage:{total:{totalTokens:61}}}})
   }
   out({method:'turn/completed',params:{threadId:'quota-thread',turn:count===1?{id:turnId,status:'completed'}:
     {id:turnId,status:'failed',error:{codexErrorInfo:'usageLimitExceeded',message:'provider hard limit'}}}})
 }
})
`

test('AC-032 terminal shows per-role usage once and names the Worker blocked by a provider hard limit after an independent test wake', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-hard-limit-')),
    cfg: Config = {
      repoDir: dir,
      repository: 'audit/limit',
      actor: 'operator',
      codex: '/unused',
      image: 'unused:fixture',
      provider: 'openai',
      modelKeyEnv: 'SYNTHETIC_ONLY',
    }
  const binding = join(dir, 'binding.json'),
    state = join(dir, createHash('sha256').update(cfg.repository).digest('hex').slice(0, 24))
  mkdirSync(state, { mode: 0o700 })
  writeFileSync(binding, JSON.stringify(cfg), { mode: 0o600 })
  const host = new Host(cfg, state),
    { domain, supervision } = host
  const stop = await serve(state, cfg.repository, (action, b) => host.command(action, b))
  t.after(async () => {
    await stop()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  })
  domain.engine.receive(terminalTrigger('mail', 'Fix the mail transport', 'operator'))
  domain.engine.evaluateDue()
  const ticket = domain.engine.decide('mail', {
    kind: 'accept',
    reason: 'explicit',
    title: 'mail',
    scope: 'mail',
    evalId: domain.engine.candidate('mail')!.evalId,
  }).ticketId!
  const assignment = domain.store.tickets.get(ticket)!.assignments[0].id
  const hostBoundary = host as unknown as {
    event: (owner: string, e: SessionEvent) => void
    live: Map<string, { session: CodexSession }>
  }
  const worker = await CodexSession.connect({
    role: 'worker',
    ticketId: ticket,
    command: process.execPath,
    args: ['-e', wire],
    env: {},
    onTool: async () => {},
    onEvent: (e) => {
      hostBoundary.event(ticket, e)
      if (e.type === 'started' && e.turnId === 't1')
        supervision.startTest({
          id: 'late-test',
          ticketId: ticket,
          assignmentId: assignment,
          command: 'node test.mjs',
          commit: 'fixture',
          dirty: false,
          image: 'fixture',
        })
    },
  })
  const opened = await worker.startThread({ cwd: dir })
  domain.db
    .prepare('INSERT INTO host_sessions VALUES(?,?,?,?)')
    .run(ticket, opened.threadId, opened.model ?? null, 'fixture')
  domain.db.prepare("INSERT INTO host_sessions VALUES('main','m','fixture-model','fixture')").run()
  hostBoundary.live.set(ticket, { session: worker })
  hostBoundary.event('main', { type: 'usage', threadId: 'm', turnId: 'main-turn', totalTokens: 5 })
  await host.tick()
  assert.equal((await worker.waitForCompletion('t1')).status, 'completed')
  assert.equal(supervision.usage(ticket), 0)
  supervision.finishTest('late-test', { status: 'failed', exitCode: 1, output: 'failure evidence' })
  await host.tick()
  assert.equal((await worker.waitForCompletion('t2')).errorCode, 'usageLimitExceeded')
  async function command(action: string, ...args: string[]) {
    return JSON.parse(
      (
        await exec(process.execPath, [cli, '--config', binding, action, ...args], {
          cwd: dir,
          env: { PATH: process.env.PATH, ORCH_STATE_ROOT: dir, HOME: dir },
          timeout: 3000,
        })
      ).stdout,
    )
  }
  const status = await command('status'),
    show = await command('show', ticket)
  assert.equal(status.mainTokens, 5)
  assert.equal(show.tokens, 61)
  assert.deepEqual(
    show.runs.map((r: any) => r.turn),
    ['t1', 't2'],
  )
  assert.equal(status.tickets.find((t: any) => t.id === ticket).status, 'paused')
  assert.ok(status.faults.some((f: any) => f.owner === ticket && /usageLimitExceeded/.test(f.message)))
  assert.equal(show.tests[0].status, 'failed')
  assert.ok(show.ticket.attention.question)
  assert.equal(domain.db.prepare("SELECT COUNT(*) AS n FROM host_turns WHERE state='retry'").get()?.n, 0)
})
