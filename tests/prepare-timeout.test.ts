import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { prepareTicket, ticketKey } from '../src/executor/workspace.ts'

test('AC-013: ten-minute prepare deadline terminates a real child and removes only its empty workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prepare-clock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = 'deadline'
  const ticketDir = join(root, 'tickets', ticketKey(id))
  const preparing = prepareTicket({
    repoDir: root, stateDir: root, ticketId: id,
    prepare: { kind: 'command', command: 'mkdir "$TICKET_DIR"; echo $$ > started; exec sleep 1200' },
  })
  const terminated = assert.rejects(preparing, /exceeded its time limit/)
  const deadline = Date.now() + 5000
  let pid = 0
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await readFile(join(ticketDir, 'started'), 'utf8')) } catch { await setImmediate() }
  }
  assert.ok(pid)
  t.mock.timers.tick(599999)
  process.kill(pid, 0)
  t.mock.timers.tick(1)
  await terminated
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(stat(join(ticketDir, 'workspace')), { code: 'ENOENT' })
})
