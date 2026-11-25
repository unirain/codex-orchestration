import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDomain, terminalTrigger, type Effect } from '../src/domain.ts'

/**
 * Deterministic Assessor and Worker replies exercise the same SQLite domain and post-commit ports
 * as the host. A fixture responds only when its port actually receives the corresponding effect.
 */
export async function replay(path: string) {
  if (existsSync(path)) throw new Error('演示需要新的 SQLite 路径，以免与已有数据混用')
  let time = Date.parse('2026-11-25T00:00:00Z')
  const now = () => new Date(++time).toISOString()
  const domain = openDomain(path,{repository:'demo/follow-up-mail',actorId:'owner',now})
  const {engine,store,db}=domain
  const calls: Effect[]=[]
  const inputs=[
    ['request-a','调整 follow up'],
    ['request-b','发送邮件有 bug'],
    ['follow-a','刚才的 follow up，先改触发条件'],
  ] as const
  function handle(effect: Effect) {
    calls.push(effect)
    if (effect.kind==='assess') {
      const c=effect.candidate
      assert.equal(c.triggers.length,1)
      const origin=c.triggers[0]
      assert.ok(origin.id==='request-a' || origin.id==='request-b', '追问产生了多余的 Eval')
      engine.candidateDelivered(c.evalId)
      engine.decide(origin.id,{kind:'accept',title:origin.text,scope:origin.text,reason:'用户明确交代了一个独立目标',evalId:c.evalId})
    } else if (effect.kind==='start') {
      engine.assignmentStarted(effect.ticketId,effect.assignmentId)
    } else if (effect.kind==='deliver') {
      const ticket=store.tickets.get(effect.ticketId)!
      const ids=ticket.undelivered
      engine.inputsDelivered(ticket.id,effect.assignmentId,ids)
      engine.inputsRead(ticket.id,ids)
      for (const input of ticket.inputs.filter(item=>ids.includes(item.id))) {
        assert.equal(input.kind,'trigger')
        if (input.kind!=='trigger') throw new Error('unexpected fixture input')
        if (input.triggerId==='follow-a' && ticket.origin.triggerId==='request-a') {
          engine.reply({purpose:'acknowledgement',ticketId:ticket.id,triggerId:input.triggerId,text:'已接手 follow up 的触发条件调整'})
        } else {
          engine.handback(ticket.id,input.triggerId,'此请求超出当前 Mandate')
        }
      }
    }
  }
  try {
    const steps=[]
    for (const [id,text] of inputs) {
      const previous=calls.length
      engine.receive(terminalTrigger(id,text,'owner',now()))
      for (let pass=0;;pass++) {
        if (pass>=16) throw new Error('事件队列未收敛')
        engine.evaluateDue()
        if (!await domain.drain(handle)) break
      }
      const disposition=store.triggers.disposition(id)!
      const delta=calls.slice(previous)
      steps.push({triggerId:id,text:store.triggers.get(id)!.text,receivedBy:disposition.fanout,
        handbacks:disposition.handbacks??[],acknowledgedBy:disposition.acked??[],
        evals:delta.filter(e=>e.kind==='assess').length,starts:delta.filter(e=>e.kind==='start').length})
    }
    const tickets=store.tickets.list().reverse().map(t=>({ticketId:t.id,title:t.title,mandate:t.mandate,assignmentId:t.assignments[0].id}))
    assert.equal(tickets.length,2)
    assert.notEqual(tickets[0].mandate.scope,tickets[1].mandate.scope)
    assert.deepEqual(steps.map(s=>[s.evals,s.starts]),[[1,1],[1,1],[0,0]])
    assert.deepEqual(steps[2].acknowledgedBy,[tickets[0].ticketId])
    assert.deepEqual(steps[2].handbacks.map(h=>h.ticketId),[tickets[1].ticketId])
    const storedEvals=db.prepare("SELECT COUNT(*) AS count FROM domain_history WHERE json_extract(value,'$.type')='eval.started'").get()!.count
    assert.equal(storedEvals,2)
    return {sqlite:db.prepare('SELECT sqlite_version() AS version').get()!.version,tickets,steps,storedEvals}
  } finally { domain.close() }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const path=process.argv[2]
  if (process.argv.length>3 || path?.startsWith('-')) throw new Error('用法：npm run demo:routing -- 可选的新数据库路径')
  const directory=path?undefined:mkdtempSync(join(tmpdir(),'routing-demo-'))
  try {
    const result=await replay(path??join(directory!,'demo.sqlite'))
    process.stdout.write(JSON.stringify(result,null,2)+'\n')
  } finally { if (directory) rmSync(directory,{recursive:true,force:true}) }
}
