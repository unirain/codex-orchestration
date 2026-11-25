import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, connect, invoke } from '../src/host/server.ts'
import { Host } from '../src/host/runtime.ts'
import { terminalTrigger } from '../src/domain.ts'
import type { ChatView, ChatEvent } from '../src/host/chat.ts'
import type { Config } from '../src/host/config.ts'

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-attention-'))
  const config: Config = {
    repository: 'sandbox/test',
    actor: 'owner',
    repoDir: dir,
    codex: '/unused',
    image: 'unused:v1',
    provider: 'deepseek',
    modelKeyEnv: 'UNUSED',
  }
  let host = new Host(config, dir)
  t.after(async () => {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  })
  function seed(name: string) {
    const d = host.domain
    d.engine.receive(terminalTrigger(name, name, 'owner'))
    for (const owner of d.store.triggers.disposition(name)?.fanout ?? [])
      d.engine.handback(owner, name, 'distinct task')
    d.engine.evaluateDue()
    const id = d.engine.decide(name, {
      kind: 'accept',
      title: name,
      scope: name,
      reason: 'explicit',
      evalId: d.engine.candidate(name)!.evalId,
    }).ticketId!
    d.engine.assignmentStarted(id, d.store.tickets.get(id)!.assignments[0].id)
    return id
  }
  function ask(id: string, text: string) {
    const t = host.domain.engine.report(id, { state: 'blocked', summary: 'Needs a decision', question: text })
    host.supervision.pause(id, 'question:' + t.attention!.id)
    return {
      repo: config.repository,
      id: 'send-' + t.attention!.id,
      ticket: id,
      question: t.attention!.id,
      mode: 'continue',
      text: '从第一条未回复的消息计时',
    }
  }
  return {
    dir,
    repo: config.repository,
    get host() {
      return host
    },
    seed,
    ask,
    async restart() {
      await host.close()
      host = new Host(config, dir)
    },
  }
}
test('targeted answer is atomic, goes only to the selected Ticket, and a lost receipt replays across restart', async (t) => {
  const f = fixture(t),
    a = f.seed('follow up'),
    b = f.seed('mail')
  const req = f.ask(a, '催促是否重置计时？'),
    other = f.ask(b, '使用哪个邮箱？')
  const old = f.host.domain.store.tickets.get(a)!.mandate
  const receipt = await f.host.command('answer', req)
  assert.equal((receipt as any).status, 'queued')
  assert.deepEqual(f.host.domain.store.triggers.disposition(req.id)?.fanout, [a])
  assert.ok(!f.host.supervision.isPaused(a) && f.host.supervision.isPaused(b))
  assert.equal(f.host.domain.store.tickets.get(b)?.attention?.id, other.question)
  assert.deepEqual(f.host.domain.store.tickets.get(a)?.mandate, old)
  assert.equal(f.host.domain.store.tickets.get(a)?.attention, undefined)
  await f.restart()
  assert.deepEqual(await f.host.command('answer', req), receipt)
  assert.deepEqual(await f.host.command('submission', { id: req.id }), receipt)
  assert.equal(
    f.host.domain.store.tickets.get(a)!.inputs.filter((i) => i.kind === 'trigger' && i.triggerId === req.id)
      .length,
    1,
  )
  await assert.rejects(f.host.command('answer', { ...req, id: 'competitor' }), /已处理/)
  await assert.rejects(f.host.command('answer', { ...req, text: 'changed' }), /发送标识/)
  await f.host.command('say', { id: 'normal', text: '另一个话题' })
  assert.deepEqual(new Set(f.host.domain.store.triggers.disposition('normal')?.fanout), new Set([a, b]))
  const trace: any = await f.host.command('trace', { trigger: req.id })
  assert.equal(trace.trigger.meta.attentionId, req.question)
  assert.deepEqual(
    trace.tickets.map((t: any) => t.id),
    [a],
  )
})
test('manual pause wins both races; legacy/unknown pauses never authorize answer-and-continue', async (t) => {
  const f = fixture(t),
    a = f.seed('A')
  const req = f.ask(a, '请选择')
  await f.host.command('pause', { ticket: a })
  assert.equal(((await f.host.command('chat-view', {})) as ChatView).tickets[0].question?.mode, 'save')
  assert.equal(((await f.host.command('answer', req)) as any).status, 'paused')
  assert.ok(f.host.supervision.isPaused(a))
  await f.host.command('resume', { ticket: a })
  assert.ok(!f.host.supervision.isPaused(a))
  const req2 = f.ask(a, '请选择')
  assert.notEqual(req2.question, req.question)
  await f.host.command('answer', req2)
  await f.host.command('pause', { ticket: a })
  assert.equal(
    f.host.supervision.reserve(a, f.host.domain.store.tickets.get(a)!.assignments.at(-1)!.id, 'human'),
    false,
  )
  const req3 = f.ask(a, '新问题')
  f.host.domain.db.prepare("UPDATE worker_pause SET cause='unknown' WHERE ticketId=?").run(a)
  assert.equal(((await f.host.command('answer', req3)) as any).status, 'paused')
})
test('replacement, ended ticket, conflicting IDs and foreign bindings fail without partially saving', async (t) => {
  const f = fixture(t),
    a = f.seed('A'),
    obsolete = f.ask(a, 'first'),
    current = f.ask(a, 'second')
  await assert.rejects(f.host.command('answer', obsolete), /已处理/)
  await assert.rejects(f.host.command('answer', { ...current, repo: 'other' }), /仓库/)
  f.host.domain.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON chat_answer BEGIN SELECT RAISE(ABORT,'fixture'); END",
  )
  await assert.rejects(f.host.command('answer', current), /fixture/)
  assert.equal(f.host.domain.store.triggers.get(current.id), undefined)
  assert.equal(f.host.domain.store.tickets.get(a)?.attention?.id, current.question)
  assert.ok(f.host.supervision.isPaused(a))
  f.host.domain.db.exec('DROP TRIGGER fail_receipt')
  f.host.domain.engine.stopTicket(a)
  await assert.rejects(f.host.command('answer', current), /已处理/)
})
test('chat feed paginates user and host records, deduplicates replay, and survives reconnect', async (t) => {
  const f = fixture(t),
    db = f.host.domain.db
  await f.host.command('say', { id: 'one', text: '你好' })
  await f.host.command('say', { id: 'one', text: '你好' })
  await assert.rejects(f.host.command('say', { id: 'one', text: '另一个输入' }), /标识/)
  for (let n = 0; n < 113; n++)
    db.prepare("INSERT INTO host_messages VALUES(?,?,NULL,'reply')").run('m' + n, '回执' + n)
  const view = (await f.host.command('chat-view', {})) as ChatView
  const first = (await f.host.command('chat-events', { after: 0 })) as ChatEvent[]
  assert.equal(first.length, 100)
  assert.equal(first[0].kind, 'user')
  await f.restart()
  const next = (await f.host.command('chat-events', { after: first.at(-1)!.seq })) as ChatEvent[]
  assert.equal(next.length, 14)
  assert.equal(next.at(-1)!.seq, view.latest)
  assert.equal(((await f.host.command('chat-view', {})) as ChatView).stream, view.stream)
  assert.equal(f.host.domain.db.prepare('SELECT count(*) AS n FROM host_turns').get()!.n, 0)
})

test('two authenticated terminals compete for one answer; invalid credentials cannot consume it', async (t) => {
  const f = fixture(t),
    a = f.seed('Follow up'),
    req = f.ask(a, '哪个时间起算？')
  const stop = await serve(f.dir, f.repo, (action, b) => f.host.command(action, b))
  try {
    const endpoint = (await connect(f.dir, f.repo))!
    await assert.rejects(invoke({ ...endpoint, key: 'wrong' }, 'answer', req), /credentials/)
    assert.equal(f.host.domain.store.tickets.get(a)?.attention?.id, req.question)
    const result = await Promise.allSettled([
      invoke(endpoint, 'answer', req),
      invoke(endpoint, 'answer', { ...req, id: 'another-terminal' }),
    ])
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(result.filter((r) => r.status === 'rejected').length, 1)
    assert.equal(f.host.domain.db.prepare('SELECT count(*) n FROM chat_answer').get()!.n, 1)
  } finally {
    await stop()
  }
})
