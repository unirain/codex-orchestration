import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { key } from '../src/core/ids.ts'
import { Host } from '../src/host/runtime.ts'
import { ticketKey } from '../src/executor/workspace.ts'

const exec = promisify(execFile)
test(
  'shared Thread: greetings stay quiet, ambiguous plans reach Main, and explicit follow-ups reach their Worker',
  {
    skip: process.env.ORCH_DEEPSEEK_LIVE !== '1' || !process.env.ORCH_TEST_IMAGE,
    timeout: 180_000,
  },
  async (t) => {
    const dir = await realpath(await mkdtemp(join(homedir(), '.orch-conversation-')))
    const h = new Host(
      {
        repository: 'fixture/conversation',
        repoDir: dir,
        actor: 'operator',
        codex: process.env.CODEX_TEST_BIN!,
        image: process.env.ORCH_TEST_IMAGE!,
        provider: 'deepseek',
        modelKeyEnv: 'DEEPSEEK_API_KEY',
      },
      dir,
    )
    const { db, engine, store } = h.domain
    const ids: string[] = []
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
    async function seed(id: string, scope: string) {
      await h.command('say', { id, text: scope })
      for (const ticket of ids) engine.handback(ticket, id, 'separate fixture task')
      engine.evaluateDue()
      const ticket = engine.decide(id, {
        kind: 'accept',
        evalId: engine.candidate(id)!.evalId,
        title: id,
        scope,
        reason: 'explicit request',
      }).ticketId!
      ids.push(ticket)
      return ticket
    }
    const follow = await seed(
      'follow-up',
      '只读检查 follow up 的触发条件。现场已知条件为 status=open。等待用户明确提供新的触发条件，不得改代码。',
    )
    const mail = await seed('mail', '修复邮件地址校验。')
    engine.assignmentStarted(mail, store.tickets.get(mail)!.assignments[0].id)
    engine.report(mail, { state: 'ready', summary: '已完成邮件校验任务。' })
    assert.ok(store.tickets.get(mail)!.ended)
    await h.initialize()
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 500; i++) {
        if (check()) return
        await delay(100)
      }
      throw Error(
        'Missing expected routing outcome: ' +
          JSON.stringify((await h.command('status', {})) as { messages: unknown; faults: unknown }),
      )
    }
    const messageCount = () => Number(db.prepare('SELECT count(*) n FROM host_messages').get()!.n)
    const turns = (ticket: string) =>
      Number(
        db.prepare("SELECT count(*) n FROM host_turns WHERE owner=? AND state='completed'").get(ticket)!.n,
      )
    await until(() => turns(follow) > 0)
    await h.tick()
    const before = messageCount(),
      baseline = ids.map(turns)
    await h.command('say', { id: 'greeting', text: '你好呀' })
    await until(() => ids.every((id, i) => turns(id) > baseline[i]))
    await h.tick()
    assert.deepEqual(new Set(store.triggers.disposition('greeting')!.fanout), new Set(ids))
    assert.deepEqual(store.triggers.disposition('greeting')!.acked ?? [], [])
    assert.deepEqual(store.triggers.disposition('greeting')!.handbacks ?? [], [])
    assert.equal(messageCount(), before)

    for (const [id, text] of [
      ['next', '我们接下来我要做什么呢'],
      ['plan', '我们可以制定新的计划吗'],
    ]) {
      await h.command('say', { id, text })
      await until(
        () =>
          !!db
            .prepare(
              "SELECT 1 FROM domain_effect WHERE json_extract(payload,'$.message.kind')='reply' AND state='sent' AND id=?",
            )
            .get(key('clarify', store.triggers.disposition(id)?.evalId ?? '', id)),
      )
      const disposition = store.triggers.disposition(id)!
      assert.deepEqual(new Set(disposition.handbacks?.map((x) => x.ticketId)), new Set(ids))
      assert.deepEqual(disposition.acked ?? [], [])
    }
    await h.command('say', {
      id: 'specific',
      text: '刚才那个 follow up 的触发条件是什么？只需要重复一下已有结论。',
    })
    await until(() => store.triggers.disposition('specific')?.acked?.includes(follow) === true)
    assert.equal(store.triggers.disposition('specific')!.evalId, undefined)
    assert.equal(store.tickets.list().length, 2)

    // Seed the prior exchange as the old Worker actually recorded it. The user
    // specified the behavior, and delegates the choice of repository fields.
    // Start the real decision at the short authorization, with both Workers subscribed.
    await h.command('say', {
      id: 'proposal',
      text: 'follow up 要新增三天没回复的理由；用项目已有字段，可以先查代码决定实现。',
    })
    engine.reply({
      purpose: 'acknowledgement',
      ticketId: follow,
      triggerId: 'proposal',
      text: '当前工单只读。你是否授权实现这个三天没回复的规则？',
    })
    engine.handback(mail, 'proposal', 'Different goal')
    for (const id of ids) {
      const ticket = store.tickets.get(id)!
      const input = ticket.inputs.find((i) => i.kind === 'trigger' && i.triggerId === 'proposal')!
      engine.inputsDelivered(id, ticket.assignments.at(-1)!.id, [input.id])
      engine.inputsRead(id, [input.id])
    }
    const proposalAck = key('ack', 'proposal')
    await until(() => !!db.prepare('SELECT 1 FROM host_messages WHERE id=?').get(proposalAck))
    await until(() => h.supervision.occupied() === 0)
    const initial = store.tickets.get(follow)!.mandate
    await h.command('say', { id: 'approval', text: '授权' })
    await until(() =>
      store.decisions.byThread('terminal:default').some((d) => d.triggerIds.includes('approval')),
    )
    const granted = store.decisions
      .byThread('terminal:default')
      .find((d) => d.triggerIds.includes('approval'))!
    assert.equal(granted.kind, 'accept', JSON.stringify(granted))
    assert.equal(store.tickets.list().length, 3)
    assert.notEqual(granted.ticketId, follow)
    assert.match(store.tickets.get(granted.ticketId!)!.mandate.scope, /3|三|three/i)
    assert.deepEqual(store.tickets.get(follow)!.mandate, initial)
    assert.deepEqual(
      new Set(store.triggers.disposition('approval')!.handbacks?.map((x) => x.ticketId)),
      new Set(ids),
    )
    ids.push(granted.ticketId!)
  },
)
