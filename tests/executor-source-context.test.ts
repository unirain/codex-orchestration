import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readFile,
  writeFile,
  readdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  mkdir,
  copyFile,
} from 'node:fs/promises'
import { prepareTicket, openTicketRuntime } from '../src/executor/index.ts'
import { ticketKey } from '../src/executor/workspace.ts'
import { checked } from '../src/executor/process.ts'
import { makeCertificates } from '../src/executor/container/ticket-ca.mjs'

const image = process.env.ORCH_TEST_IMAGE
test(
  'AC-027 exact outbound model inputs show only authorized code; explicit SDK snippet is usable on the next turn',
  { skip: !image, timeout: 120000 },
  async (t) => {
    const { CodexSession } = await import('../src/codex/session.ts')
    // Only the temporary provider receives a writable /fixture mount. It has no
    // project workspace, real model identity, or access to the local Docker API.
    const dir = await realpath(await mkdtemp(join(homedir(), '.orch-source-context-')))
    const mockDir = join(dir, 'fixture'),
      buildDir = join(dir, 'build')
    await mkdir(mockDir)
    await mkdir(buildDir)
    const suffix = randomUUID().slice(0, 12),
      providerName = 'orch-context-' + suffix,
      testImage = 'orch-eval/context:' + suffix
    const marker = () => randomUUID().replaceAll('-', '')
    const own = 'local_' + marker(),
      foreign = 'sibling_' + marker(),
      sdk = 'external_' + marker(),
      snippet = 'snippet_' + marker()
    const stateDir = join(dir, 'state'),
      options = { repoDir: dir, stateDir }
    const a = await prepareTicket({ ...options, ticketId: 'a' })
    const b = await prepareTicket({ ...options, ticketId: 'b' })
    const name = 'orch-ticket-' + ticketKey((await realpath(stateDir)) + '\0a').slice(0, 28)
    let container = false,
      built = false,
      environment: Awaited<ReturnType<typeof openTicketRuntime>> | undefined
    t.after(async () => {
      try {
        if (environment) await environment.close()
      } finally {
        if (environment) await checked('docker', ['volume', 'rm', name + '-history']).catch(() => {})
        if (container) await checked('docker', ['rm', '-f', providerName])
        if (built) await checked('docker', ['image', 'rm', testImage])
        await rm(dir, { recursive: true, force: true })
      }
    })
    const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
    await checked('docker', [
      'run',
      '-d',
      '--name',
      providerName,
      '--pull=never',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      'type=bind,src=' + mockDir + ',dst=/fixture',
      '--mount',
      'type=bind,src=' + join(fixtures, 'executor-source-provider.mjs') + ',dst=/mock.mjs,readonly',
      '--entrypoint',
      'node',
      image!,
      '/mock.mjs',
    ])
    container = true
    const ip = await checked('docker', [
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      providerName,
    ])
    const certs = makeCertificates(mockDir, [ip])
    await writeFile(join(buildDir, 'test-ca.crt'), certs.publicCa)
    await writeFile(
      join(buildDir, 'Dockerfile'),
      'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY test-ca.crt /opt/test-ca.crt\nENV NODE_EXTRA_CA_CERTS=/opt/test-ca.crt\n',
    )
    await checked('docker', [
      'build',
      '--pull=false',
      '--network=none',
      '--build-arg',
      'BASE_IMAGE=' + image,
      '-t',
      testImage,
      buildDir,
    ])
    built = true
    const sdkPath = join(dir, 'private-sdk.ts'),
      siblingPath = join(b.directory, 'b.ts')
    const signature = "export declare function sdkTag(): '" + snippet + "'"
    await writeFile(sdkPath, 'SOURCE_VALUE=' + sdk + '\n' + signature + '\n')
    await writeFile(siblingPath, 'SOURCE_VALUE=' + foreign)
    await writeFile(join(a.directory, 'a.ts'), 'SOURCE_VALUE=' + own)
    await symlink(sdkPath, join(a.directory, 'sdk-link.ts'))
    await symlink(siblingPath, join(a.directory, 'sibling-link.ts'))
    await writeFile(
      join(a.directory, 'probe-paths.json'),
      JSON.stringify({
        own: '/workspace/a.ts',
        sdk: sdkPath,
        sibling: siblingPath,
        sdklink: '/workspace/sdk-link.ts',
        siblinglink: '/workspace/sibling-link.ts',
      }),
    )
    await copyFile(join(fixtures, 'executor-native-read.mjs'), join(a.directory, 'native-read.mjs'))
    await writeFile(
      join(a.directory, 'search-source.sh'),
      [
        'set -eu',
        'printf "shell-own="; cat /workspace/a.ts; echo',
        ...Object.entries({
          sdk: sdkPath,
          sibling: siblingPath,
          sdklink: '/workspace/sdk-link.ts',
          siblinglink: '/workspace/sibling-link.ts',
        }).map(
          ([label, p]) =>
            'if cat ' +
            JSON.stringify(p) +
            ' 2>/dev/null; then echo shell-' +
            label +
            '=read; else echo shell-' +
            label +
            '=unavailable; fi',
        ),
        ...Object.entries({
          sdk: sdkPath,
          sibling: siblingPath,
          sdklink: '/workspace/sdk-link.ts',
          siblinglink: '/workspace/sibling-link.ts',
        }).map(
          ([label, p]) =>
            'if rg --follow --no-filename SOURCE_VALUE= ' +
            JSON.stringify(p) +
            ' 2>/dev/null; then echo search-' +
            label +
            '=read; else echo search-' +
            label +
            '=unavailable; fi',
        ),
        'echo search-start; rg --follow --no-ignore --no-filename "SOURCE_VALUE=" -g "*.ts" /workspace 2>/dev/null || true; echo search-end',
      ].join('\n'),
    )
    environment = await openTicketRuntime({
      workspace: a,
      stateDir,
      image: testImage,
      apiKey: 'synthetic-provider-key',
      providerBaseUrl: 'https://' + ip + ':8443',
    })
    const session = await CodexSession.connect({
      ...environment.appServer(),
      role: 'worker',
      ticketId: 'a',
      tools: [],
      onTool: async () => {
        throw Error('unexpected dynamic tool')
      },
    })
    try {
      const { threadId } = await session.startThread({ cwd: '/workspace', model: 'gpt-5.4' })
      for (const [index, text] of [
        'Check source availability within this Ticket.',
        'Here is the SDK interface declaration I can share: ' + signature,
      ].entries()) {
        const { turnId } = await session.startTurn({
          assignmentId: 'assignment-a',
          inputId: 'source-' + index,
          text,
        })
        assert.equal((await session.waitForCompletion(turnId)).status, 'completed')
        assert.equal(session.threadId, threadId)
      }
      const files = (await readdir(mockDir)).filter((f) => /^input-\d+\.json$/.test(f)).sort()
      assert.equal(files.length, 5)
      const inputs = await Promise.all(files.map((f) => readFile(join(mockDir, f), 'utf8')))
      const group = inputs.join('\n')
      for (const confidential of [foreign, sdk])
        assert.ok(!group.includes(confidential), 'unexpected external marker in model input')
      for (const label of ['sdk', 'sibling', 'sdklink', 'siblinglink']) {
        assert.ok(inputs[1].includes('native-' + label + '=unavailable'), label + ' file RPC')
        assert.ok(inputs[2].includes('shell-' + label + '=unavailable'), label + ' shell')
        assert.ok(inputs[2].includes('search-' + label + '=unavailable'), label + ' search')
      }
      assert.ok(inputs[1].includes('native-own=SOURCE_VALUE=' + own), 'native file read must reach the model')
      assert.ok(inputs[2].includes('shell-own=SOURCE_VALUE=' + own), 'own shell read must reach model')
      assert.match(inputs[2], new RegExp('search-start.{0,80}SOURCE_VALUE=' + own + '.{0,80}search-end'))
      assert.ok(
        inputs.slice(0, 3).every((body) => !body.includes(snippet)),
        'snippet present before operator supplied it',
      )
      assert.ok(inputs[3].includes(signature))
      assert.equal(await readFile(join(a.directory, 'used-snippet'), 'utf8'), snippet)
      t.diagnostic(
        '5 exact request bodies; 3 access paths; 2 denied source markers; 1 explicitly supplied snippet used',
      )
    } finally {
      await session.close()
    }
  },
)
