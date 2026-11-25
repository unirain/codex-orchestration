import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { prepareTicket, openTicketRuntime, reapTicketRuntime } from '../src/executor/index.ts'
import { checked } from '../src/executor/process.ts'
import { spawn } from 'node:child_process'
import { ticketKey } from '../src/executor/workspace.ts'
import { realpath } from 'node:fs/promises'

const image = process.env.ORCH_TEST_IMAGE
test(
  'real Ticket containers keep project, service and network boundaries; cancellation stops the test',
  { skip: !image },
  async (t) => {
    const stateDir = await mkdtemp(join(homedir(), '.orch-executor-eval-'))
    const root = await realpath(stateDir)
    t.after(() => rm(stateDir, { recursive: true, force: true }))
    const key = 'test-only-' + randomUUID()
    const o = { stateDir, repoDir: stateDir }
    const a = await prepareTicket({ ...o, ticketId: 'A' }),
      b = await prepareTicket({ ...o, ticketId: 'B' })
    const containerName = (id: string) => 'orch-ticket-' + ticketKey(root + '\0' + id).slice(0, 28)
    async function open(workspace: typeof a) {
      const r = await openTicketRuntime({ workspace, stateDir, image: image!, apiKey: key })
      t.after(async () => {
        await r.close()
        await checked('docker', ['volume', 'rm', containerName(workspace.ticketId) + '-history'])
      })
      return r
    }
    const ra = await open(a),
      rb = await open(b)
    assert.match(ra.codexVersion, /codex-cli/)
    assert.equal(ra.imageId, rb.imageId)
    await writeFile(join(b.directory, 'b-only'), 'ticket-b')
    await symlink(join(b.directory, 'b-only'), join(a.directory, 'foreign'))
    const result = await ra.runTest(
      'set -eu; test -z "${TICKET_MODEL_LEASE:-}"; test ! -r /private/provider-key; test ! -r /service/proxy-token; test ! -r /relay/model.sock; test ! -r /workspace/foreign; test ! -S /var/run/docker.sock; test -z "$(ls -A /sys/class/net | grep -v ^lo$)"; echo revised > /workspace/only-a',
    )
    assert.equal(result.code, 0, result.output)
    assert.equal(await readFile(join(a.directory, 'only-a'), 'utf8'), 'revised\n')
    assert.equal((await rb.runTest('test ! -f /workspace/only-a')).code, 0)
    const blocked = await ra.runTest('curl -sf --max-time 2 http://denied.example/path')
    assert.notEqual(blocked.code, 0)
    assert.deepEqual(await ra.deniedTargets(), ['denied.example:80'])
    const provider = await ra.runTest('curl -sS -w "%{http_code}" -x "" http://127.0.0.1:4021/models')
    assert.match(provider.output, /403$/)
    const abort = new AbortController()
    const testRun = ra.runTest(
      "setsid sh -c 'sleep 2; touch /workspace/detached-late' & sleep 2; touch /workspace/late",
      abort.signal,
    )
    setTimeout(() => abort.abort(), 150)
    assert.notEqual((await testRun).code, 0)
    await new Promise((ok) => setTimeout(ok, 2100))
    assert.equal(
      (
        await ra.runTest(
          'test ! -e late && test ! -e detached-late && test ! -r /test-control && test 0 != $(id -u)',
        )
      ).code,
      0,
    )
    const fail = await prepareTicket({ ...o, ticketId: 'missing' })
    await assert.rejects(
      openTicketRuntime({
        workspace: fail,
        stateDir,
        image: 'orch-local/image-absent-test:missing',
        apiKey: key,
      }),
      /image|object/i,
    )
  },
)

test(
  'DeepSeek Worker runs its built-in shell as project identity and resumes the same thread after rebuild',
  { skip: !image || process.env.ORCH_DEEPSEEK_LIVE !== '1', timeout: 180000 },
  async (t) => {
    const apiKey = process.env.DEEPSEEK_API_KEY
    assert.ok(apiKey, 'set the dedicated DeepSeek key')
    // The protocol adapter is supplied by EN-002 in the integrated tree.
    const { CodexSession } = await import('../src/codex/session.ts')
    const stateDir = await mkdtemp(join(homedir(), '.orch-live-executor-'))
    const workspace = await prepareTicket({ stateDir, repoDir: stateDir, ticketId: 'live-proof' })
    const name = 'orch-ticket-' + ticketKey((await realpath(stateDir)) + '\0live-proof').slice(0, 28)
    t.after(async () => {
      await checked('docker', ['volume', 'rm', name + '-history'])
      await rm(stateDir, { recursive: true, force: true })
    })
    let previous: string | undefined
    const proof = join(workspace.directory, 'proof')
    const marker = randomUUID()
    const firstExpected = String(process.getuid()) + ':' + marker
    // The model sees only the script name. The file is emitted by the command
    // after checking its actual Linux identity and the credential boundary.
    await writeFile(
      join(workspace.directory, 'service-check.sh'),
      [
        'set -eu',
        'test -z "${TICKET_MODEL_LEASE:-}"',
        'test ! -r /service/proxy-token',
        'test ! -r /private/provider-key',
        'test ! -r /relay/model.sock',
        'printf "%s:%s" "$(id -u)" "' + marker + '" > /workspace/proof',
      ].join('\n'),
    )
    for (const step of ['first', 'credential-expired', 'resumed']) {
      const runtime = await openTicketRuntime({
        workspace,
        stateDir,
        image: image!,
        apiKey: step === 'credential-expired' ? 'invalid-credential-smoke-test' : apiKey,
        providerBaseUrl: 'https://api.deepseek.com',
        requireHistory: !!previous,
      })
      try {
        const session = await CodexSession.connect({
          ...runtime.appServer(),
          role: 'worker',
          ticketId: workspace.ticketId,
          tools: [],
          onTool: async () => {
            throw Error('unexpected dynamic tool')
          },
        })
        try {
          const options = { cwd: '/workspace', model: 'deepseek-flash' }
          const { threadId } = previous
            ? await session.resumeThread({ ...options, threadId: previous })
            : await session.startThread(options)
          if (previous) assert.equal(threadId, previous)
          const command =
            step === 'first'
              ? '/bin/sh /workspace/service-check.sh'
              : 'test -s /workspace/proof && printf resumed >> /workspace/proof'
          const { turnId } = await session.startTurn({
            assignmentId: step,
            inputId: step,
            text:
              'Run exactly this harmless project smoke test with your built-in shell tool, once. Do not substitute another command. Command: ' +
              command,
          })
          const completion = await session.waitForCompletion(turnId)
          if (step === 'credential-expired') {
            assert.equal(completion.status, 'failed')
            assert.equal(await readFile(proof, 'utf8'), firstExpected)
            continue
          }
          assert.equal(completion.status, 'completed')
          const thread = await session.readThread(threadId)
          assert.ok((thread.turns as Array<{ id: string }>).some((turn) => turn.id === turnId))
          assert.equal(
            await readFile(proof, 'utf8'),
            step === 'first' ? firstExpected : firstExpected + 'resumed',
          )
          previous = threadId
        } finally {
          await session.close()
        }
      } finally {
        await runtime.close()
      }
    }
  },
)

test(
  'restart removes proven orphan jobs and relay while retaining working directory and session history',
  { skip: !image, timeout: 30000 },
  async (t) => {
    const stateDir = await mkdtemp(join(homedir(), '.orch-reap-eval-'))
    const workspace = await prepareTicket({ stateDir, repoDir: stateDir, ticketId: 'interrupted' })
    const name = 'orch-ticket-' + ticketKey((await realpath(stateDir)) + '\0interrupted').slice(0, 28)
    const ref = { stateDir, ticketId: workspace.ticketId }
    t.after(async () => {
      await reapTicketRuntime(ref)
      await checked('docker', ['volume', 'rm', name + '-history'])
      await rm(stateDir, { recursive: true, force: true })
    })
    // Exiting the host process leaves the independent container and its detached job active.
    const entry = new URL('../src/executor/index.ts', import.meta.url).href
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import {openTicketRuntime} from ${JSON.stringify(entry)}
    const r=await openTicketRuntime(${JSON.stringify({ workspace, stateDir, image, apiKey: 'test-only' })})
    console.log(r.imageId)
    process.exit(0)
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const exit = await new Promise((resolve) => child.once('close', resolve))
    assert.equal(exit, 0)
    await checked('docker', [
      'exec',
      '-d',
      '--user',
      String(process.getuid()),
      name,
      'sh',
      '-c',
      'echo running > /workspace/started; sleep 3; echo late > /workspace/late',
    ])
    await new Promise((ok) => setTimeout(ok, 200))
    assert.match(await readFile(join(workspace.directory, 'started'), 'utf8'), /running/)
    assert.deepEqual(await reapTicketRuntime(ref), { container: true, egress: true, relay: true })
    assert.deepEqual(await reapTicketRuntime(ref), { container: false, egress: false, relay: false })
    await new Promise((ok) => setTimeout(ok, 3000))
    await assert.rejects(readFile(join(workspace.directory, 'late')), { code: 'ENOENT' })
    assert.match(
      await checked('docker', ['volume', 'inspect', '--format', '{{.Name}}', name + '-history']),
      /-history$/,
    )
  },
)

test(
  'a Ticket installs from its allowed registry and checks every redirect against the current port list',
  { skip: !image, timeout: 45000 },
  async (t) => {
    const dir = await mkdtemp(join(homedir(), '.orch-package-eval-'))
    const { mkdir } = await import('node:fs/promises')
    const fixture = join(dir, 'package')
    await mkdir(fixture)
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'ticket-fixture', version: '1.0.0', main: 'index.js' }),
    )
    await writeFile(join(fixture, 'index.js'), 'module.exports = 42')
    await checked('npm', ['pack', '--offline', '--ignore-scripts', '--pack-destination', dir], {
      cwd: fixture,
      env: { PATH: process.env.PATH, HOME: dir },
    })
    const remote = 'orch-registry-test-' + randomUUID().slice(0, 12)
    t.after(async () => {
      await checked('docker', ['rm', '-f', remote])
      await rm(dir, { recursive: true, force: true })
    })
    const server = `
    const http=require('node:http'),fs=require('node:fs')
    http.createServer((q,s)=>{if(q.url==='/redirect'){s.writeHead(302,{location:'http://'+q.headers.host.split(':')[0]+':8081/pkg'});s.end()}else{fs.createReadStream('/fixtures/ticket-fixture-1.0.0.tgz').pipe(s)}}).listen(8080)
    http.createServer((q,s)=>{console.log('second registry received request');s.end('ok')}).listen(8081)
  `
    await checked('docker', [
      'run',
      '-d',
      '--name',
      remote,
      '--pull=never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--user',
      '65534:65534',
      '--mount',
      'type=bind,src=' + dir + '/ticket-fixture-1.0.0.tgz,dst=/fixtures/ticket-fixture-1.0.0.tgz,readonly',
      '--entrypoint',
      'node',
      image!,
      '-e',
      server,
    ])
    const ip = await checked('docker', [
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      remote,
    ])
    const workspace = await prepareTicket({ repoDir: dir, stateDir: dir, ticketId: 'install' })
    const name = 'orch-ticket-' + ticketKey((await realpath(dir)) + '\0install').slice(0, 28)
    t.after(() => checked('docker', ['volume', 'rm', name + '-history']))
    const opts = { workspace, stateDir: dir, image: image!, apiKey: 'test-only', allow: [ip + ':8080'] }
    let r = await openTicketRuntime(opts)
    try {
      const install = await r.runTest(
        'npm_config_update_notifier=false npm install --no-audit --no-fund --ignore-scripts --fetch-retries=0 http://' +
          ip +
          ':8080/pkg.tgz && node -p "require(\'ticket-fixture\')"',
      )
      assert.equal(install.code, 0, install.output)
      assert.match(install.output, /42$/)
      const request = 'curl -sfL --max-time 5 http://' + ip + ':8080/redirect'
      assert.notEqual((await r.runTest(request)).code, 0)
      assert.ok((await r.deniedTargets()).includes(ip + ':8081'))
      assert.doesNotMatch(await checked('docker', ['logs', remote]), /second registry received/)
      await r.close()
      r = await openTicketRuntime({ ...opts, allow: [...opts.allow, ip + ':8081'] })
      assert.equal((await r.runTest(request)).output, 'ok')
      assert.match(await checked('docker', ['logs', remote]), /second registry received/)
    } finally {
      await r.close()
    }
  },
)
