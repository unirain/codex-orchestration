import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Host } from '../src/host/runtime.ts'
import { ticketKey } from '../src/executor/workspace.ts'
import { terminalTrigger } from '../src/domain.ts'
import type { CodexSession } from '../src/codex/session.ts'
import type { Config } from '../src/host/config.ts'

const exec = promisify(execFile)
const image = process.env.ORCH_TEST_IMAGE
const bin = process.env.CODEX_TEST_BIN

test(
  'AC-017 actual new Main/Workers receive the configured role model; resumed Worker and Main retain model/thread',
  {
    skip: !image || !bin || process.env.ORCH_DEEPSEEK_LIVE !== '1',
    timeout: 150000,
  },
  async (t) => {
    const root = await realpath(await mkdtemp(join(homedir(), '.orch-model-audit-')))
    const later = await realpath(await mkdtemp(join(homedir(), '.orch-model-audit-')))
    assert.ok(process.env.DEEPSEEK_API_KEY)
    const config: Config = {
      actor: 'owner',
      repository: 'fixture/models',
      repoDir: root,
      modelKeyEnv: 'DEEPSEEK_API_KEY',
      image: image!,
      codex: bin!,
      provider: 'deepseek',
    }
    const h = new Host(config, root),
      second = new Host({ ...config, repoDir: later }, later)
    const volumes: string[] = []
    t.after(async () => {
      await Promise.all([h.close(), second.close()])
      for (const name of volumes) await exec('docker', ['volume', 'rm', name]).catch(() => {})
      await Promise.all([root, later].map((dir) => rm(dir, { recursive: true, force: true })))
    })
    // Two bounded turns make Codex persist the initial Main and Worker rollouts. The later role override
    // opens new Sessions and a process/container replacement exercises the production resume path.
    type Live = { session: CodexSession }
    type Access = { session(owner: string): Promise<Live>; drop(owner: string): Promise<void> }
    const aHost = h as unknown as Access,
      bHost = second as unknown as Access
    function create(label: string) {
      h.domain.engine.receive({
        ...terminalTrigger(label, label, 'owner'),
        threads: [{ source: 'terminal', id: label }],
      })
      h.domain.engine.evaluateDue()
      const ticket = h.domain.engine.decide(label, {
        kind: 'accept',
        evalId: h.domain.engine.candidate(label)!.evalId,
        title: label,
        scope: label,
        reason: 'explicit',
      }).ticketId!
      volumes.push('orch-ticket-' + ticketKey(root + '\0' + ticket).slice(0, 28) + '-history')
      return ticket
    }
    function binding(host: Host, owner: string) {
      return host.domain.db
        .prepare('SELECT owner,thread,model,source FROM host_sessions WHERE owner=?')
        .get(owner)!
    }
    const a = create('followup'),
      b = create('mail')
    const main = await aHost.session('main'),
      workerA = await aHost.session(a)
    const origMain = binding(h, 'main'),
      origA = binding(h, a)
    assert.equal(origMain.source, 'runtime default')
    assert.equal(origA.source, 'runtime default')
    assert.equal(origMain.model, 'deepseek-flash')
    assert.equal(origA.model, 'deepseek-flash')
    h.domain.engine.receive({
      ...terminalTrigger('model-check', 'Acknowledge my thanks; no further work.', 'owner'),
      threads: [{ source: 'terminal', id: 'model-check' }],
    })
    h.domain.engine.evaluateDue()
    const evalId = h.domain.engine.candidate('model-check')!.evalId
    const assignment = h.domain.store.tickets.get(a)!.assignments[0].id
    h.supervision.reserve(a, assignment, 'start')
    async function persist(session: CodexSession, owner: string, aid: string, prompt: string) {
      h.domain.db
        .prepare("INSERT INTO host_turns(id,owner,assignment,ids,text,state) VALUES(?,?,?,'[]',?,'prepared')")
        .run('persist-' + owner, owner, aid, prompt)
      const { turnId } = await session.startTurn({
        assignmentId: aid,
        text: prompt,
        inputId: 'persist-' + owner,
      })
      const outcome = await session.waitForCompletion(turnId)
      assert.equal(outcome.status, 'completed', outcome.errorCode)
    }
    await persist(main.session, 'main', evalId, 'Route the pending courtesy thank-you; it asks for no work.')
    await persist(
      workerA.session,
      a,
      assignment,
      'Synthetic smoke task: report progress with summary "session saved" and finish the turn. No workspace changes or tests are needed.',
    )
    await h.command('role-model', { role: 'worker', model: 'deepseek-v4-pro' })
    const workerB = await aHost.session(b),
      boundB = binding(h, b)
    assert.equal(boundB.model, 'deepseek-v4-pro')
    assert.equal(boundB.source, 'role override')
    assert.notEqual(workerA.session.threadId, workerB.session.threadId)
    assert.equal(main.session.model, 'deepseek-flash')
    await h.command('role-model', { role: 'main', model: 'deepseek-v4-pro' })
    await aHost.drop(a)
    await aHost.drop('main')
    const resumedMain = (await aHost.session('main')).session,
      resumedA = (await aHost.session(a)).session
    assert.equal(resumedMain.threadId, origMain.thread)
    assert.equal(resumedA.threadId, origA.thread)
    assert.equal(resumedMain.model, 'deepseek-flash')
    assert.equal(resumedA.model, 'deepseek-flash')
    await second.command('role-model', { role: 'main', model: 'deepseek-v4-pro' })
    const newMain = await bHost.session('main')
    assert.equal(newMain.session.model, 'deepseek-v4-pro')
    assert.equal(binding(second, 'main').source, 'role override')
    assert.deepEqual(binding(h, a), origA)
    assert.deepEqual(binding(h, 'main'), origMain)
    t.diagnostic(
      JSON.stringify({
        main: origMain,
        originalWorker: origA,
        newWorker: boundB,
        newMain: binding(second, 'main'),
      }),
    )
  },
)
