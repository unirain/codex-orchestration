import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepseekArgs } from '../src/codex/deepseek.ts'
import { CodexSession } from '../src/codex/session.ts'
import type { SessionEvent, ToolContext } from '../src/codex/session.ts'

test('opt-in: DeepSeek Responses main session resumes and reads a synthetic host resource', {
  skip: process.env.CODEX_LIVE_DEEPSEEK !== '1', timeout: 90_000,
}, async t => {
  assert.ok(process.env.CODEX_TEST_BIN, 'Provide an explicit absolute App Server binary')
  assert.ok(process.env.DEEPSEEK_API_KEY, 'Provide a dedicated DeepSeek API identity')
  const root = await mkdtemp(join(tmpdir(),'codex-live-main-'))
  const sessions: CodexSession[] = []
  t.after(async () => {
    await Promise.all(sessions.map(s => s.close()))
    await rm(root,{recursive:true,force:true,maxRetries:3})
  })
  const state = join(root,'codex')
  const cwd = join(root,'empty')
  await Promise.all([mkdir(state),mkdir(cwd)])
  const calls: ToolContext[] = []
  const events: SessionEvent[] = []
  async function connect() {
    const s = await CodexSession.connect({
      command: process.env.CODEX_TEST_BIN!, args: deepseekArgs(), cwd,
      env:{ PATH:process.env.PATH, HOME:root, CODEX_HOME:state, TMPDIR:root,
        DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY }, role:'main',
      tools:[{ name:'orchestrator_read', description:'Read the single synthetic test item.',
        inputSchema:{ type:'object',properties:{},additionalProperties:false }}],
      onEvent:event => { events.push(event) },
      onTool:async ctx => { calls.push(ctx); return { synthetic:true, value:'READY' } },
    })
    sessions.push(s)
    return s
  }
  const model = 'deepseek-flash'
  const instructions = 'Protocol smoke test in an empty project. Use only orchestrator_read. Never read any files or run commands.'
  const first = await connect()
  const {threadId,model:actual} = await first.startThread({cwd,model,instructions})
  assert.equal(actual,model)
  const {turnId} = await first.startTurn({ text:'Call orchestrator_read with an empty object exactly once. Then reply with the returned value and stop.',
    assignmentId:'synthetic-route', inputId:'synthetic-1' })
  const end = await first.waitForCompletion(turnId)
  assert.equal(end.status,'completed',end.errorCode)
  assert.deepEqual(calls.map(call=>[call.threadId,call.turnId,call.tool]),[[threadId,turnId,'orchestrator_read']])
  await first.close()
  const resumed = await connect()
  assert.equal((await resumed.resumeThread({threadId,cwd,model,instructions})).threadId,threadId)
  const history = await resumed.readThread()
  assert.match(JSON.stringify(history.turns), /"clientId":"synthetic-1"/)
  assert.ok(events.some(e=>e.type==='usage' && e.totalTokens>0))
  t.diagnostic(JSON.stringify({model,threadId,turnId,callbacks:calls.length,usage:events.filter(e=>e.type==='usage').at(-1),resumed:true}))
})
