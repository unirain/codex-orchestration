import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Host } from '../src/host/runtime.ts'
import { ticketKey } from '../src/executor/workspace.ts'
import { terminalTrigger } from '../src/domain.ts'
import type { ChatView } from '../src/host/chat.ts'

const image = process.env.ORCH_TEST_IMAGE,
  exec = promisify(execFile)
test(
  'AC-003: a scoped reply wakes only the selected real worker, once, after capacity becomes available',
  {
    skip: !image || process.env.ORCH_DEEPSEEK_LIVE !== '1',
    timeout: 120000,
  },
  async (t) => {
    const dir = await realpath(await mkdtemp(join(homedir(), '.orch-tui-answer-')))
    const repo = 'fixture/terminal-answers'
    const h = new Host(
      {
        repository: repo,
        repoDir: dir,
        actor: 'owner',
        provider: 'deepseek',
        modelKeyEnv: 'DEEPSEEK_API_KEY',
        codex: process.env.CODEX_TEST_BIN ?? 'codex',
        image: image!,
      },
      dir,
    )
    const d = h.domain,
      ids: string[] = []
    t.after(async () => {
      await h.close()
      for (const id of ids)
        await exec('docker', [
          'volume',
          'rm',
          'orch-ticket-' + ticketKey(dir + '\0' + id).slice(0, 28) + '-history',
        ]).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    })
    const first =
      '只读讨论计时规则。先用 orchestrator_report 报告 blocked，提问“催促重置计时吗？”。收到定向答复后，复述业务选择并报告 waiting。无需编辑文件、执行测试或交付。'
    const second = '只读邮件讨论。用 orchestrator_report 报告 blocked，向用户询问邮件主题。收到回答之前等待。'
    d.engine.receive(terminalTrigger('first', first, 'owner'))
    d.engine.evaluateDue()
    // Receive the second goal while the first Eval is open, before subscriptions exist.
    d.engine.receive(terminalTrigger('second', second, 'owner'))
    function accept(id: string, scope: string) {
      const ticket = d.engine.decide(id, {
        kind: 'accept',
        title: id,
        scope,
        reason: 'operator',
        evalId: d.engine.candidate(id)!.evalId,
      }).ticketId!
      ids.push(ticket)
      return ticket
    }
    const a = accept('first', first)
    d.engine.evaluateDue()
    const b = accept('second', second)
    await h.initialize()
    async function until(check: () => boolean) {
      for (let i = 0; i < 750; i++) {
        if (check()) return
        await delay(100)
      }
      assert.fail('Timed out: ' + JSON.stringify(((await h.command('status', {})) as any).faults))
    }
    await until(() => [a, b].every((id) => h.supervision.isPaused(id)) && h.supervision.occupied() === 0)
    const view = (await h.command('chat-view', {})) as ChatView
    const q = view.tickets.find((t) => t.id === a)!.question!,
      other = d.store.tickets.get(b)!.attention!
    assert.equal(q.mode, 'continue')
    const original = d.store.tickets.get(a)!.mandate
    const running = (id: string) =>
      Number(d.db.prepare('SELECT count(*) n FROM host_turns WHERE owner=?').get(id)!.n)
    const oldA = running(a),
      oldB = running(b)
    // Hold the three ordinary slots with pending fixture tickets. No provider work is needed to exercise the queue.
    const held: string[] = []
    for (let n = 0; n < 3; n++) {
      const ticket = structuredClone(d.store.tickets.get(b)!)
      ticket.id = 'hold-' + n
      ticket.assignments = [{ id: ticket.id, state: 'pending', createdAt: ticket.createdAt }]
      d.store.tickets.save(ticket)
      assert.ok(h.supervision.reserve(ticket.id, ticket.id, 'start'))
      held.push(ticket.id)
    }
    const send = {
      id: 'operator-answer',
      repo,
      ticket: a,
      question: q.id,
      mode: q.mode,
      text: '不重置，从第一条未获回复的消息计时。',
    }
    const result = await h.command('answer', send)
    assert.equal((result as any).status, 'queued')
    for (let i = 0; i < 2; i++) await h.tick()
    assert.equal(running(a), oldA)
    for (const id of held) h.supervision.release(id, id)
    await until(
      () =>
        d.store.tickets.get(a)?.assignments.at(-1)?.report?.state === 'waiting' &&
        h.supervision.occupied() === 0,
    )
    assert.deepEqual(await h.command('answer', send), result)
    assert.equal(running(a), oldA + 1)
    assert.equal(running(b), oldB)
    assert.deepEqual(d.store.tickets.get(a)!.mandate, original)
    assert.equal(d.store.tickets.get(b)!.attention!.id, other.id)
  },
)
