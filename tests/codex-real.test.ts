import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSession } from '../src/codex/session.ts'
import type { ToolContext } from '../src/codex/session.ts'

test('real App Server: dynamic tool callback, persisted input ID, restart/resume same thread', {
  skip: !process.env.CODEX_TEST_BIN, timeout: 60_000,
}, async t => {
  const calls: ToolContext[] = []
  let requests = 0
  let main = false
  let tools: unknown[] = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (!req.url?.endsWith('/responses')) { res.writeHead(404).end(); return }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    tools = body.tools
    const n = ++requests
    const id = 'response-' + n
    const item = !main && n % 2
      ? {type:'function_call', call_id:'call-' + n, name:'orchestrator_report', arguments:'{"state":"progress","summary":"tested"}'}
      : {type:'message', role:'assistant', id:'msg-' + n, content:[{type:'output_text', text:'done'}]}
    const events = [
      {type:'response.created', response:{id}},
      {type:'response.output_item.done', item},
      {type:'response.completed', response:{id,usage:{input_tokens:12, output_tokens:1,total_tokens:13}}},
    ]
    res.writeHead(200, {'Content-Type':'text/event-stream'})
    res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
  })
  server.listen(0, '127.0.0.1')
  await once(server,'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = (server.address() as {port:number}).port
  const root = await mkdtemp(join(tmpdir(),'codex-session-contract-'))
  const sessions: CodexSession[] = []
  t.after(async () => {
    await Promise.all(sessions.map(s => s.close()))
    await rm(root,{recursive:true,force:true,maxRetries:3})
  })
  const state = join(root,'state')
  const cwd = join(root,'repo')
  await Promise.all([mkdir(cwd),mkdir(state)])
  await writeFile(join(state,'config.toml'), [
    'model = "gpt-5.4"', 'model_provider = "fixture"', 'web_search = "disabled"',
    '[analytics]', 'enabled = false', '[model_providers.fixture]','name = "Local deterministic provider"',
    'base_url = "http://127.0.0.1:' + port + '/v1"', 'wire_api = "responses"',
    'request_max_retries = 0','stream_max_retries = 0','requires_openai_auth = false', 'supports_websockets = false',
  ].join('\n'))
  async function connect() {
    const session = await CodexSession.connect({
      command: process.env.CODEX_TEST_BIN!, args:['app-server','--stdio'],
      env:{ PATH:process.env.PATH, HOME:root, CODEX_HOME:state, TMPDIR:root }, cwd,
      role:main ? 'main' : 'worker', ticketId:main ? undefined : 'ticket-local',
      onTool:async (ctx,args) => { assert.equal(args.state,'progress'); calls.push(ctx); return 'recorded' },
    })
    sessions.push(session)
    return session
  }
  const first = await connect()
  const {threadId} = await first.startThread({cwd})
  const a = await first.startTurn({text:'Report progress.', assignmentId:'assignment-1', inputId:'input-1'})
  assert.equal((await first.waitForCompletion(a.turnId)).status,'completed')
  const history = await first.readThread()
  assert.match(JSON.stringify(history.turns), /"clientId":"input-1"/)
  await first.close()
  const second = await connect()
  assert.equal((await second.resumeThread({cwd,threadId})).threadId,threadId)
  const b = await second.startTurn({text:'Continue on the same ticket.',assignmentId:'assignment-2',inputId:'input-2'})
  assert.equal((await second.waitForCompletion(b.turnId)).status,'completed')
  assert.deepEqual(calls.map(c => [c.threadId,c.turnId,c.assignmentId,c.tool]),[
    [threadId,a.turnId,'assignment-1','orchestrator_report'], [threadId,b.turnId,'assignment-2','orchestrator_report'],
  ])
  assert.equal(requests,4)
  main = true
  const assessor = await connect()
  await assessor.startThread({cwd})
  const turn = await assessor.startTurn({assignmentId:'eval-1',text:'ready'})
  assert.equal((await assessor.waitForCompletion(turn.turnId)).status,'completed')
  const names = tools.map(t => (t as {name:string}).name)
  assert.ok(names.includes('orchestrator_read'))
  assert.ok(names.every(name => ['orchestrator_route','orchestrator_read','request_user_input'].includes(name)),
    'Main must not receive file, shell, service or other execution tools')
})
