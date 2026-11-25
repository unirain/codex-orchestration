import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Engine } from './core/engine.ts'
import { key } from './core/ids.ts'
import { type Trigger } from './core/model.ts'
import type { Policy } from './core/ports.ts'
import { DomainStore } from './store.ts'
import { Effects, type Dispatch } from './effects.ts'

export type { Effect, Dispatch } from './effects.ts'
export interface DomainOptions {
  actorId: string
  repository: string
  now?: () => string
  policy?: () => { version: string; allowWork: boolean }
}

/** The authenticated terminal adapter supplies the actor and event ID; message text cannot override either. */
export function terminalTrigger(id: string, text: string, actorId: string, at = new Date().toISOString()): Trigger {
  if (!id || !text.trim() || !actorId) throw new TypeError('A terminal message needs an ID, text and actor')
  return { id, text, at, human: true, addressed: 'direct', actor: { source: 'terminal', id: actorId },
    source: 'terminal', threads: [{ source: 'terminal', id: 'default' }],
    channel: { source: 'terminal', thread: 'default', address: {} }, meta: {} }
}

function admittedSource(t: Trigger, actorId: string) {
  return t.source === 'terminal' && t.actor?.source === 'terminal' && t.actor.id === actorId &&
    t.human === true && t.addressed === 'direct' && t.text.trim().length > 0
}

export function openDomain(path: string, options: DomainOptions) {
  if (!options.repository || !options.actorId) throw new Error('A domain requires a repository and an owner')
  if (path !== ':memory:') mkdirSync(dirname(path), { mode: 0o700, recursive: true })
  const db = new DatabaseSync(path)
  try {
    if (path !== ':memory:') chmodSync(path, 0o600)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000')
    const store = new DomainStore(db)
    const effects = new Effects(db)
    store.atomic(() => {
      db.exec('CREATE TABLE IF NOT EXISTS domain_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1),repository TEXT NOT NULL, actor TEXT NOT NULL)')
      db.prepare('INSERT OR IGNORE INTO domain_binding VALUES (1,?,?)').run(options.repository, options.actorId)
      const binding = db.prepare('SELECT repository,actor FROM domain_binding WHERE singleton=1').get()!
      if (binding.repository !== options.repository || binding.actor !== options.actorId) throw new Error('Database is bound to another repository or owner')
    })
    function policy(): Policy {
      const setting = options.policy?.() ?? { version: 'terminal-1', allowWork: true }
      return {
        version: setting.version, paused: false, evalTimeoutMs: 5 * 60_000,
        admitsInferred: () => false,
        gate: trigger => admittedSource(trigger, options.actorId) && setting.allowWork
          ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', sender: options.actorId,
              source: 'terminal', scope: { repository: options.repository } } }
          : { admissible: false, reason: 'notAuthorized' },
        revalidate: mandate => setting.allowWork && mandate.strength === 'explicit' && mandate.actor.source === 'terminal' &&
          mandate.actor.id === options.actorId && mandate.basis.scope?.repository === options.repository,
      }
    }
    const engine = new Engine({
      repo: store, policy, now: options.now,
      scope: { scope: value => admittedSource(value as Trigger, options.actorId)
        ? { listened: true, observed: false } : { listened: false, reason: 'outsideTerminalScope' } },
      emit: event => {
        store.record('event', 'ticketId' in event.data ? event.data.ticketId : 'threadKey' in event.data ? event.data.threadKey : '', event)
        if(event.type==='ticket.ended'){
          const ticket=store.tickets.get(event.data.ticketId)
          if(ticket?.ended && ticket.channels[0]){
            const id=key('ticket-result',ticket.id,ticket.assignments.at(-1)!.id,ticket.ended.outcome)
            effects.add({id,kind:'send',message:{id,channel:ticket.channels[0],kind:'notice',ticketId:ticket.id,
              text:ticket.title+' · ended/'+ticket.ended.outcome}})
          }
        }
      },
      assessor: {
        request: candidate => effects.add({ kind: 'assess', id: key('assess',candidate.evalId), candidate }),
        release: evalId => effects.withdraw(key('assess',evalId)),
      },
      executor: {
        start: (t,a) => effects.add({ kind: 'start', id: key('start',t.id,a.id), ticketId: t.id, assignmentId: a.id }),
        deliver: (t,a) => effects.add({ kind: 'deliver', id: key('deliver',t.id,a.id,...t.undelivered), ticketId: t.id, assignmentId: a.id }),
        stop: (t,a,reason) => effects.add({ kind: 'stop', id: key('stop',t.id,a.id), ticketId: t.id, assignmentId: a.id, reason }),
      },
      outbox: {
        send: message => effects.add({ id: message.id, kind: 'send', message }),
        status: id => effects.state(id),
        withdraw: id => effects.withdraw(id),
      },
    })

    function clarify(triggerId: string, evalId: string, question: string) {
      if (!question.trim()) throw new Error('A clarification needs a specific question')
      return store.atomic(() => {
        const trigger = store.triggers.get(triggerId)
        if (!trigger?.channel) throw new Error('Missing source channel')
        const decision = engine.decide(triggerId, { kind: 'ignore', evalId, reason: 'awaiting clarification' })
        if (decision.kind === 'ignore') {
          const id = key('clarify',evalId,triggerId)
          effects.add({ kind: 'send', id, message: { id, channel: trigger.channel, kind: 'reply', text: question } })
        }
        return decision
      })
    }
    return { db, store, engine, effects, clarify, drain: (dispatch: Dispatch) => effects.drain(dispatch), close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}
export type Domain = ReturnType<typeof openDomain>
