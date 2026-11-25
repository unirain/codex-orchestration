import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, serve, lockInstance, invoke } from '../src/host/server.ts'
test('AC-030/042: one scheduler, authenticated reconnect, independent client lifetime', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-http-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const release = lockInstance(dir)
  assert.throws(() => lockInstance(dir), /already owns/)
  let seen = 0
  const stop = await serve(dir, 'org/repo', async () => ({ seen: ++seen }))
  try {
    const a = await connect(dir, 'org/repo'),
      b = await connect(dir, 'org/repo')
    assert.ok(a && b)
    assert.equal(a.url, b.url)
    assert.equal(await connect(dir, 'org/other'), undefined)
    for (const auth of ['', 'Bearer wrong']) {
      const r: Response = await fetch(a.url + '/resume', { method: 'POST', headers: { authorization: auth } })
      assert.equal(r.status, 403)
    }
    assert.equal(seen, 0)
    assert.deepEqual(await invoke(b, 'status', {}), { seen: 1 })
    assert.equal(statSync(join(dir, 'instance.json')).mode & 0o777, 0o600)
  } finally {
    await stop()
    release()
  }
  const releaseAgain = lockInstance(dir)
  releaseAgain()
})
