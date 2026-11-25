import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareStore, formatVersion } from '../src/host/storage.ts'

test('old format has a readable consistent snapshot; a newer format blocks opening', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'business.sqlite'),
    db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE receipt(n); INSERT INTO receipt VALUES(7)')
  db.close()
  const backup = prepareStore(file)!
  assert.equal(statSync(backup).mode & 0o777, 0o600)
  const restored = new DatabaseSync(backup, { readOnly: true })
  assert.equal(restored.prepare('SELECT n FROM receipt').get()!.n, 7)
  restored.close()
  const next = new DatabaseSync(file)
  next.exec('PRAGMA user_version=' + (formatVersion + 1))
  next.close()
  assert.throws(() => prepareStore(file), /newer/)
})
