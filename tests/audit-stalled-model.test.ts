import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CodexSession } from '../src/codex/session.ts'
import { roleTools } from '../src/codex/tools.ts'
import { RoleHandlers, WORKER_INSTRUCTIONS } from '../src/host/tools.ts'
import { openDomain, terminalTrigger } from '../src/domain.ts'
import { Supervision } from '../src/host/supervision.ts'
import { prepareTicket, ticketKey } from '../src/executor/workspace.ts'
import { openTicketRuntime } from '../src/executor/runtime.ts'

const exec = promisify(execFile)
const image = process.env.ORCH_TEST_IMAGE
const scenarios = {
  diagnostic: [
    'send failed: acquire timed out; basic local routing and address checks passed',
    'send failed after increased timeout; DNS and SMTP handshake completed',
    'pool telemetry: pendingAcquire=12, active=2, configured max=2. Only high-concurrency traffic fails. The same request at concurrency one has not yet been compared.',
  ],
  stalled: [
    'upstream redacted status=delivery_unknown; no request ID. All permitted local tests exhausted; isolated fixture has no upstream logs.',
    'upstream redacted status=delivery_unknown; no request ID. Cache and connection settings have already been ruled out.',
    'upstream redacted status=delivery_unknown; no request ID. The upstream operator must provide the SMTP transaction ID and provider trace. This deployment exposes no further local telemetry or comparison fixture.',
  ],
} as const

for (const [scenario, evidence] of Object.entries(scenarios)) {
  test(
    'AC-023 real DeepSeek chooses an evidence-based action after three recorded failures: ' + scenario,
    { skip: !image || process.env.ORCH_DEEPSEEK_LIVE !== '1', timeout: 120000 },
    async (t) => {
      const apiKey = process.env.DEEPSEEK_API_KEY
      assert.ok(apiKey)
      const root = await realpath(await mkdtemp(join(homedir(), '.orch-evidence-eval-')))
      const d = openDomain(join(root, 'domain.sqlite'), { actorId: 'operator', repository: 'fixture/mail' })
      const s = new Supervision(d, { secrets: () => [apiKey] })
      const scope =
        'Investigate the mail service timeout using permitted read-only local probes; preserve application code and work within existing access.'
      d.engine.receive(terminalTrigger('source', scope, 'operator'))
      d.engine.evaluateDue()
      const ticket = d.engine.decide('source', {
        kind: 'accept',
        title: 'Mail timeout',
        scope,
        reason: 'explicit test mandate',
        evalId: d.engine.candidate('source')!.evalId,
      }).ticketId!
      const assignment = d.store.tickets.get(ticket)!.assignments[0].id
      const workspace = await prepareTicket({ repoDir: root, stateDir: root, ticketId: ticket })
      const volume = 'orch-ticket-' + ticketKey(root + '\0' + ticket).slice(0, 28) + '-history'
      const runtime = await openTicketRuntime({
        workspace,
        stateDir: root,
        image: image!,
        apiKey,
        providerBaseUrl: 'https://api.deepseek.com',
      })
      let session: CodexSession | undefined
      t.after(async () => {
        await session?.close()
        await runtime.close()
        await exec('docker', ['volume', 'rm', volume]).catch(() => {})
        d.close()
        await rm(root, { recursive: true, force: true })
      })
      const compare = 'node mail-probe.cjs --compare-concurrency'
      const recipe = `
const cmd=process.argv[2]
const results=${JSON.stringify(evidence)}
if(/^--run-[123]$/.test(cmd)){console.error(results[Number(cmd.slice(-1))-1]);process.exit(1)}
if(cmd==='--compare-concurrency' && ${JSON.stringify(scenario)}==='diagnostic'){
  console.log('low_concurrency: delivered; high_concurrency: acquisition timed out');process.exit(0)
}
console.error('No upstream record available');process.exit(2)
`
      await writeFile(join(workspace.directory, 'mail-probe.cjs'), recipe)
      d.engine.assignmentStarted(ticket, assignment)
      s.reserve(ticket, assignment, 'start')
      s.turnStarted(ticket, assignment, 'recorded-attempts')
      for (let i = 1; i <= 3; i++) {
        const command = 'node mail-probe.cjs --run-' + i,
          id = 'failed-' + i
        s.startTest({
          id,
          ticketId: ticket,
          assignmentId: assignment,
          command,
          commit: 'fixture',
          dirty: false,
          image: runtime.imageId,
        })
        const result = await runtime.runTest(command)
        assert.equal(result.code, 1)
        s.finishTest(id, { status: 'failed', exitCode: result.code, output: result.output })
      }
      s.turnEnded(ticket, assignment, 'recorded-attempts')
      assert.deepEqual(
        s.tests(ticket).map((r) => r.status),
        ['failed', 'failed', 'failed'],
      )
      const log: { tool: string; args: Record<string, unknown> }[] = []
      const handlers = new RoleHandlers(d, {
        valid: (c) => c.ticketId === ticket && c.assignmentId === assignment && !s.isPaused(ticket),
        mayReportReady: async () => false,
        deliver: async () => {
          throw Error('external delivery unavailable in this eval')
        },
        runTest: async (id, c, command) => {
          assert.equal(scenario, 'diagnostic', 'an exhausted worker ran another probe')
          assert.equal(command.trim(), compare, 'expected the distinguishing comparison')
          s.startTest({
            id,
            ticketId: ticket,
            assignmentId: assignment,
            command,
            commit: 'fixture',
            dirty: false,
            image: runtime.imageId,
          })
          const result = await runtime.runTest(command)
          assert.equal(result.code, 0)
          s.finishTest(id, { status: 'passed', exitCode: result.code })
          return { run: id }
        },
        pause: (id) => {
          s.pause(id)
        },
      })
      session = await CodexSession.connect({
        ...runtime.appServer(),
        role: 'worker',
        ticketId: ticket,
        tools: roleTools.worker.filter((i) => ['orchestrator_test', 'orchestrator_report'].includes(i.name)),
        onEvent: (e) => {
          if (e.type === 'started') s.turnStarted(ticket, assignment, e.turnId)
        },
        onTool: async (c, args) => {
          log.push({ tool: c.tool, args })
          return handlers.call(c, args)
        },
      })
      const { threadId } = await session.startThread({
        cwd: '/workspace',
        model: 'deepseek-flash',
        instructions: WORKER_INSTRUCTIONS,
      })
      s.reserve(ticket, assignment, 'event')
      const turn = await session.startTurn({
        assignmentId: assignment,
        inputId: 'after-three-' + scenario,
        text: JSON.stringify({
          ticket,
          scope,
          assignment,
          task: 'Choose the next action from the observed evidence and perform it using a domain tool. This is a read-only diagnostic. Use only the named supervised probe commands; there is no source investigation or external access authorized.',
          alreadyRun: s
            .tests(ticket)
            .map((r) => ({ command: r.command, status: r.status, excerpt: r.excerpt })),
          availableUntriedCommands:
            scenario === 'diagnostic'
              ? [
                  {
                    command: compare,
                    description: 'Measure the same SMTP send with one and twelve simultaneous requests.',
                  },
                ]
              : [],
        }),
      })
      const end = await session.waitForCompletion(turn.turnId)
      assert.equal(end.status, 'completed', end.errorCode)
      if (scenario === 'diagnostic') {
        assert.equal(s.tests(ticket).length, 4, JSON.stringify(log))
        assert.equal(s.tests(ticket)[3].status, 'passed')
        assert.ok(!s.isPaused(ticket))
      } else {
        assert.equal(log.filter((l) => l.tool === 'orchestrator_test').length, 0, JSON.stringify(log))
        const report = d.store.tickets.get(ticket)!
        assert.ok(s.isPaused(ticket), JSON.stringify(log))
        assert.equal(report.assignments.at(-1)?.report?.state, 'blocked')
        assert.match(report.attention?.question ?? '', /SMTP|transaction|trace|请求|事务|跟踪|日志/i)
      }
      t.diagnostic(
        JSON.stringify({
          scenario,
          threadId,
          turnId: turn.turnId,
          actions: log.map((l) => ({ tool: l.tool, ...l.args })),
          paused: s.isPaused(ticket),
        }),
      )
    },
  )
}
