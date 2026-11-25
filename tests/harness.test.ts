import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { Effects } from '../src/effects.ts'
import { DomainStore } from '../src/store.ts'
import { recordingPorts, temporaryDatabase } from './support/fixture.ts'

test('two independent SQLite files replay the same port input from empty state', async t => {
  for (let n = 0; n < 2; n++) {
    const temporary = temporaryDatabase()
    const db = new DatabaseSync(temporary.path)
    t.after(() => { db.close(); temporary.cleanup() })
    const effects = new Effects(db)
    const store = new DomainStore(db)
    assert.deepEqual(store.tickets.list(), [])
    const ports = recordingPorts()
    const input = { id: 'effect-1', kind: 'start', ticketId: 'ticket', assignmentId: 'assignment' } as const
    store.atomic(() => effects.add(input))
    await Promise.all([effects.drain(ports.dispatch), effects.drain(ports.dispatch)])
    assert.deepEqual(ports.calls, [input])
    assert.equal(effects.state(input.id), 'sent')
  }
})
