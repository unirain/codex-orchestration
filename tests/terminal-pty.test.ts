import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Host } from '../src/host/runtime.ts'
import { serve, privateDir } from '../src/host/server.ts'
import { instanceDir, type Config } from '../src/host/config.ts'
import { terminalTrigger } from '../src/domain.ts'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const tmux = spawnSync('tmux', ['-V']).status === 0
test(
  'Pi main-screen PTY preserves Chinese multiline draft and cursor across 20 receipts, resize and targeted reply',
  {
    skip: !tmux,
    timeout: 45000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'orch-tui-')),
      socket = 'orch-tui-' + process.pid
    const cfg: Config = {
      repoDir: root,
      repository: 'fixture/terminal',
      codex: '/unused',
      actor: 'me',
      provider: 'openai',
      modelKeyEnv: 'UNUSED',
      image: 'unused:local',
    }
    const file = join(root, 'binding.json'),
      dir = join(root, basename(instanceDir(cfg)))
    writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 })
    privateDir(dir)
    const h = new Host(cfg, dir),
      db = h.domain.db
    const { engine, store } = h.domain
    engine.receive(terminalTrigger('first', '三天未回复', 'me'))
    engine.evaluateDue()
    const id = engine.decide('first', {
      kind: 'accept',
      title: '三天未回复',
      scope: '讨论计时',
      evalId: engine.candidate('first')!.evalId,
      reason: 'asked',
    }).ticketId!
    engine.assignmentStarted(id, store.tickets.get(id)!.assignments[0].id)
    const ticket = engine.report(id, { state: 'blocked', summary: '等待', question: '催促会重置吗？' })
    h.supervision.pause(id, 'question:' + ticket.attention!.id)
    db.prepare("INSERT INTO host_messages VALUES('old','之前的回执',NULL,'reply')").run()
    let legacy = false
    const stop = await serve(dir, cfg.repository, async (action, b) => {
      if (legacy && action === 'chat-view') throw Error('Unknown Ticket')
      return h.command(action, b)
    })
    // Interrupt just the response to one successful write. The real CLI must reconcile its original ID.
    const instanceFile = join(dir, 'instance.json')
    const instance = JSON.parse(readFileSync(instanceFile, 'utf8'))
    let lost = false
    const proxy = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks).toString()
        const response = await fetch(instance.url + req.url, {
          method: req.method,
          headers: {
            authorization: req.headers.authorization ?? '',
            'content-type': 'application/json',
          },
          ...(req.method === 'POST' ? { body } : {}),
        })
        const result = await response.text()
        if (!lost && req.url === '/say' && response.ok && JSON.parse(body).text === '丢失回执') {
          lost = true
          res.destroy()
          return
        }
        res.writeHead(response.status, { 'content-type': 'application/json' })
        res.end(result)
      } catch {
        res.destroy()
      }
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    writeFileSync(
      instanceFile,
      JSON.stringify({
        ...instance,
        url: 'http://127.0.0.1:' + String((proxy.address() as AddressInfo).port),
      }),
    )
    const env = {
      ...process.env,
      ORCH_CONFIG: file,
      ORCH_STATE_ROOT: root,
      ORCH_VIEW_ID: 'stable-test-view',
      LANG: 'en_US.UTF-8',
    }
    const tm = async (...args: string[]) => (await exec('tmux', ['-L', socket, ...args], { env })).stdout
    t.after(async () => {
      await tm('kill-server').catch(() => {})
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await stop()
      await h.close()
      rmSync(root, { recursive: true, force: true })
    })
    const start = () =>
      tm('new-session', '-d', '-s', 'chat', '-x', '94', '-y', '30', process.execPath, cli, 'chat')
    const screen = () => tm('capture-pane', '-p', '-S', '-1000', '-t', 'chat')
    const send = (...keys: string[]) => tm('send-keys', '-t', 'chat', ...keys)
    async function see(str: string) {
      let s = ''
      for (let i = 0; i < 75; i++) {
        s = await screen()
        if (s.includes(str) || s.replace(/\s/g, '').includes(str.replace(/\s/g, ''))) return s
        await delay(100)
      }
      assert.fail('Missing ' + str + ' in terminal:\n' + s.slice(-3500))
    }
    await start()
    await see('AI 待答 · 三天未回复')
    await see('● AI · Main')
    await see('❯ 你 · 输入消息')
    await see('催促会重置吗？')
    await send('-l', '第一行')
    await send('C-j')
    await send('-l', '乙丁')
    await send('Left')
    for (let n = 1; n <= 20; n++)
      db.prepare("INSERT INTO host_messages VALUES(?,?,NULL,'reply')").run('batch' + n, '回执第' + n + '条')
    let s = await see('回执第20条')
    for (let n = 1; n <= 20; n++) assert.equal(s.split('回执第' + n + '条').length - 1, 1)
    await tm('resize-window', '-t', 'chat', '-x', '68', '-y', '24')
    await send('C-r')
    await see('选择待答问题')
    await send('Enter')
    await see('回复并继续')
    await send('-l', '稍后决定')
    await send('Escape')
    await see('乙丁')
    await send('C-r')
    await send('Enter')
    await see('回复并继续')
    await send('-l', '从第一条消息计时')
    await send('Enter')
    await see('答复已保存，等待执行')
    await send('-l', '丙')
    await send('Enter')
    await see('│ 乙丙丁')
    await see('❯ 你 → 三天未回复')
    let inputs = db
      .prepare("SELECT json_extract(value,'$.text') txt FROM domain_trigger ORDER BY rowid")
      .all()
      .map((r) => r.txt)
    assert.deepEqual(inputs, ['三天未回复', '从第一条消息计时', '第一行\n乙丙丁'])
    await send('-l', '/status')
    await send('Enter')
    await see('1. 三天未回复')
    await send('-l', '/show 1')
    await send('Enter')
    await see('工作范围：讨论计时')
    await send('-l', '/不存在')
    await send('Enter')
    s = await see('未知命令')
    assert.doesNotMatch(s, /"(?:trigger|thread|repo|ticketId)"\s*:/)
    // Drop the successful /say response, keep its text, then recover from the durable receipt.
    await send('C-u')
    await send('-l', '丢失回执')
    await send('Enter')
    for (let n = 0; n < 50 && !lost; n++) await delay(100)
    assert.ok(lost)
    await see('已收到')
    await send('-l', '/trace')
    await send('Enter')
    await see('消息 · 丢失回执')
    assert.equal(
      db.prepare("SELECT count(*) n FROM domain_trigger WHERE json_extract(value,'$.text')='丢失回执'").get()!
        .n,
      1,
    )
    const machine = async (...args: string[]) =>
      JSON.parse((await exec(process.execPath, [cli, ...args], { env })).stdout)
    assert.equal((await machine('status')).tickets[0].id, id)
    const submitted = await machine('say', '脚本消息')
    assert.equal((await machine('trace', submitted.trigger)).trigger.text, '脚本消息')
    await tm(
      'new-session',
      '-d',
      '-s',
      'human',
      '-x',
      '85',
      '-y',
      '25',
      '/bin/sh',
      '-c',
      '"$1" "$2" status; "$1" "$2" trace "$3"; sleep 30',
      'check',
      process.execPath,
      cli,
      submitted.trigger,
    )
    let summary = ''
    for (let n = 0; n < 50; n++) {
      summary = await tm('capture-pane', '-p', '-t', 'human')
      if (summary.includes('消息 · 脚本消息')) break
      await delay(100)
    }
    assert.match(summary, /三天未回复/)
    assert.match(summary, /消息 · 脚本消息/)
    assert.doesNotMatch(summary, /"(?:repo|trigger|thread)"\s*:/)
    assert.equal(db.prepare('SELECT count(*) n FROM host_turns').get()!.n, 0)
    await tm('new-session', '-d', '-s', 'keeper')
    await tm('kill-session', '-t', 'chat')
    db.prepare("INSERT INTO host_messages VALUES('offline','离开时完成的工作',NULL,'reply')").run()
    for (let n = 0; n < 107; n++)
      db.prepare("INSERT INTO host_messages VALUES(?,?,NULL,'reply')").run(
        'gap' + n,
        '离线事件 #' + n + ' 完成',
      )
    await start()
    await see('离线事件 #106 完成')
    await see('离开时完成的工作')
    s = await see('离线期间的进展')
    assert.ok(!s.includes('回执第20条'))
    await tm('kill-session', '-t', 'chat')
    legacy = true
    await start()
    await see('兼容模式')
  },
)
