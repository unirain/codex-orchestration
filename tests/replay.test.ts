import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { replay } from '../examples/routing.ts'
import { temporaryDatabase } from './support/fixture.ts'

test('GATE-001 replays from two empty databases and persisted evidence survives closing them', async t=>{
  const runs=[]
  for (let i=0;i<2;i++) {
    const tmp=temporaryDatabase();t.after(tmp.cleanup)
    const result=await replay(tmp.path)
    const db=new DatabaseSync(tmp.path,{readOnly:true})
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM domain_ticket').get()?.n,2)
      assert.equal(db.prepare('SELECT count(*) AS n FROM domain_decision').get()?.n,2)
      assert.deepEqual(result.steps[2].receivedBy.sort(),result.tickets.map(t=>t.ticketId).sort())
      assert.equal(db.prepare("SELECT json_extract(value,'$.handbacks[0].ticketId') AS id FROM domain_disposition WHERE id='follow-a'").get()?.id,result.tickets[1].ticketId)
    } finally { db.close() }
    runs.push(result)
  }
  assert.deepEqual(runs[0],runs[1])
})
