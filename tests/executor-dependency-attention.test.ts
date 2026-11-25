import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { prepareTicket, ticketKey } from '../src/executor/workspace.ts'
import { checked } from '../src/executor/process.ts'

const image = process.env.ORCH_TEST_IMAGE
test(
  'AC-021 required registry denial produces a specific durable human Attention in the local terminal',
  { skip: !image || process.env.ORCH_DEEPSEEK_LIVE !== '1', timeout: 150000 },
  async (t) => {
    const { Host } = await import('../src/host/runtime.ts')
    const { terminalTrigger } = await import('../src/domain.ts')
    assert.ok(process.env.DEEPSEEK_API_KEY)
    const dir = await realpath(await mkdtemp(join(homedir(), '.orch-dependency-attention-')))
    const host = new Host(
      {
        repoDir: dir,
        repository: 'local/dependency-proof',
        actor: 'operator',
        image: image!,
        provider: 'deepseek',
        modelKeyEnv: 'DEEPSEEK_API_KEY',
        codex: process.env.CODEX_TEST_BIN ?? 'codex',
      },
      dir,
    )
    const requirement =
      'Run the existing verify.sh unchanged using orchestrator_test. The locked package is required for the acceptance test. If installation is blocked and cannot proceed, report blocked with a concrete question for the operator specifying the full host, port and dependency purpose. Do not alter the manifest, package, test, or authorization.'
    const d = host.domain
    d.engine.receive(terminalTrigger('dependency-test', requirement, 'operator'))
    d.engine.evaluateDue()
    const { evalId } = d.engine.candidate('dependency-test')!
    const id = d.engine.decide('dependency-test', {
      kind: 'accept',
      evalId,
      title: 'Verify dependency',
      scope: requirement,
      reason: 'Operator requested locked dependency validation',
    }).ticketId!
    const ws = await prepareTicket({ repoDir: dir, stateDir: dir, ticketId: id })
    t.after(async () => {
      await host.close()
      await checked('docker', [
        'volume',
        'rm',
        'orch-ticket-' + ticketKey(dir + '\0' + id).slice(0, 28) + '-history',
      ]).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    })
    const hostname = 'required-registry.example.invalid',
      port = 8443
    await writeFile(
      join(ws.directory, 'package.json'),
      JSON.stringify({
        name: 'locked-dependency-test',
        private: true,
        dependencies: {
          'required-mail-parser': 'https://' + hostname + ':' + port + '/required-mail-parser-1.0.0.tgz',
        },
        scripts: { test: 'node -e "require(\'required-mail-parser\')"' },
      }),
    )
    await writeFile(
      join(ws.directory, 'verify.sh'),
      'set -eu\ncd /workspace\nnpm install --ignore-scripts --no-audit --no-fund --fetch-retries=0\nnpm test\n',
      { mode: 0o755 },
    )
    await host.initialize()
    for (let i = 0; i < 1400; i++) {
      const s = d.store.tickets.get(id)
      if (s?.attention && host.supervision.isPaused(id)) break
      await delay(90)
    }
    const show = (await host.command('show', { ticket: id })) as {
      ticket: {
        attention?: { question: string }
        assignments: { report?: { state: string; summary: string } }[]
      }
      deniedTargets: string[]
      tests: { status: string }[]
    }
    const question = show.ticket.attention?.question ?? ''
    assert.ok(show.deniedTargets.includes(hostname + ':' + port), 'actual outbound socket was denied')
    assert.ok(
      show.tests.some((r) => r.status === 'failed'),
      'required dependency caused a real failing test',
    )
    assert.ok(host.supervision.isPaused(id), 'worker waits for human')
    assert.equal(show.ticket.assignments.at(-1)?.report?.state, 'blocked')
    assert.ok(
      question.includes(hostname) &&
        question.includes(String(port)) &&
        /required-mail-parser/i.test(question),
      'question must name the package, host and port: ' + question,
    )
    const status = (await host.command('status', {})) as {
      tickets: { id: string; status: string; attention?: string }[]
    }
    assert.ok(status.tickets.some((x) => x.id === id && x.status === 'paused' && x.attention === question))
    const facts = d.db
      .prepare("SELECT entity,value FROM domain_history WHERE entity_id=? AND entity='attention'")
      .all(id)
    assert.ok(
      facts.some((r) => JSON.stringify(r).includes(hostname)),
      'Attention persisted to SQLite',
    )
    t.diagnostic('blocked dependency: ' + hostname + ':' + port + '; terminal question: ' + question)
  },
)
