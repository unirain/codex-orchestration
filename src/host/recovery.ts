import type { Domain } from '../domain.ts'
import { key } from '../core/ids.ts'
import { latestAssignment } from '../core/model.ts'

type ReadHistory = (threadId: string) => Promise<{ turns?: unknown[] }>
type Interrupt = (turnId: string, assignment: string) => Promise<void>
type State = 'prepared' | 'active' | 'retry' | 'completed' | 'failed' | 'interrupted'
type RemoteStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted'
interface Call {
  id: string
  assignment: string
  ids: string
  turn: string | null
  state: State
  attempt: number
}
interface RemoteTurn {
  id: string
  status: RemoteStatus
  markers: Set<string>
  complete: boolean
}
interface Verification {
  call: Call
  ids: string[]
  matched?: RemoteTurn
  verifiedAbsent: boolean
}
const inFlight = new WeakMap<Domain, Map<string, Promise<void>>>()

function fail(reason: string): never {
  throw new Error('Recovery blocked: ' + reason)
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function parseHistory(history: Awaited<ReturnType<ReadHistory>>): RemoteTurn[] {
  if (!Array.isArray(history.turns)) fail('thread/read did not return turn history')
  const ids = new Set<string>()
  const markers = new Set<string>()
  return history.turns.map(turn => {
    if (!object(turn) || typeof turn.id !== 'string' || !turn.id || ids.has(turn.id)) fail('turn history has an invalid or duplicate turn ID')
    ids.add(turn.id)
    const status = turn.status
    if (status !== 'completed' && status !== 'failed' && status !== 'interrupted' && status !== 'inProgress') fail('turn status is unknown: ' + turn.id)
    const items = Array.isArray(turn.items) ? turn.items : []
    const user = items.filter(item => object(item) && item.type === 'userMessage')
    const clientIds = new Set<string>()
    for (const item of user) {
      if (typeof item.clientId !== 'string' || !item.clientId) continue
      if (markers.has(item.clientId)) fail('duplicate client input ID in turn history')
      markers.add(item.clientId)
      clientIds.add(item.clientId)
    }
    // Positive evidence can survive a summarized view. Negative evidence requires all user-message IDs.
    const complete = (turn.itemsView === undefined || turn.itemsView === 'full') && user.length > 0 &&
      user.length === clientIds.size && items.every(item => object(item) && typeof item.type === 'string')
    return { id: turn.id, status, markers: clientIds, complete }
  })
}

export function checkCalls(calls: Call[], turns: RemoteTurn[]): Verification[] {
  const verified = calls.map(call => {
    const ids: unknown = JSON.parse(call.ids)
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string') || new Set(ids).size !== ids.length) fail('invalid persisted input list: ' + call.id)
    if (!Number.isSafeInteger(call.attempt) || call.attempt < 0) fail('invalid dispatch attempt: ' + call.id)
    // A scheduled retry carries the failed previous turn until the next attempt is prepared.
    const previousAttempt = call.state === 'retry' && !!call.turn
    const attempt = previousAttempt ? call.attempt - 1 : call.attempt
    const marker = key('turn-input',call.id,String(attempt))
    const byMarker = turns.find(turn => turn.markers.has(marker))
    const byTurn = call.turn ? turns.find(turn => turn.id === call.turn) : undefined
    if (call.turn && (!byTurn || (byMarker && byMarker.id !== call.turn))) fail('turn ID or client input ID disagrees with history: ' + call.id)
    const matched = byMarker ?? byTurn
    if (byTurn && byTurn.markers.size && !byMarker) fail('recorded turn belongs to a different client input: ' + call.id)
    const uncertain = call.state === 'prepared' || call.state === 'active'
    if (uncertain && !matched && (call.state === 'active' || !turns.every(t => t.complete))) {
      fail('cannot verify whether the turn received this input: ' + call.id)
    }
    if (matched && !byMarker && ids.length && uncertain) fail('missing accepted input marker: ' + call.id)
    if (matched?.status === 'inProgress' && !uncertain) fail('active remote turn conflicts with its local terminal or retry state')
    return {call,ids,matched,verifiedAbsent:uncertain && !matched}
  })
  const active = turns.filter(t=>t.status === 'inProgress')
  if (active.length > 1 || active.some(t=>verified.filter(v=>v.matched?.id === t.id).length !== 1)) fail('active turn has no unique verified local owner')
  return verified
}

/** Reconcile one owner marked by the single host instance. A failed check leaves the recovery marker and pending work intact. */
export function recoverOwner(domain: Domain, owner: string, readHistory: ReadHistory, interrupted: Interrupt, isPaused: boolean): Promise<void> {
  let pending = inFlight.get(domain)
  if (!pending) { pending = new Map(); inFlight.set(domain,pending) }
  const previous = pending.get(owner)
  if (previous) return previous
  const promise = recover(domain,owner,readHistory,interrupted,isPaused).finally(()=>pending.delete(owner))
  pending.set(owner,promise)
  return promise
}

async function recover(d: Domain, owner: string, readHistory: ReadHistory, interrupt: Interrupt, pausedAtEntry: boolean) {
  const {db,store,engine} = d
  const marked = () => !!db.prepare('SELECT 1 FROM host_recovery WHERE owner=?').get(owner)
  if (!marked()) return
  const calls = db.prepare('SELECT id,assignment,ids,turn,state,attempt FROM host_turns WHERE owner=? ORDER BY rowid').all(owner) as unknown as Call[]
  const binding = db.prepare('SELECT thread FROM host_sessions WHERE owner=?').get(owner)
  if (!binding && calls.length) fail('persisted turn has no verified Session binding for ' + owner)
  let checked: Verification[] = []
  if (binding) {
    const read = async () => {
      const history = await readHistory(String(binding.thread))
      if ('id' in history && history.id !== binding.thread) fail('history returned a different thread')
      return checkCalls(calls,parseHistory(history))
    }
    checked = await read()
    const active = checked.find(check=>check.matched?.status === 'inProgress')
    if (active?.matched) {
      await interrupt(active.matched.id,active.call.assignment)
      const reread = await read()
      const final = reread.find(v=>v.call.id === active.call.id)?.matched
      if (final?.id !== active.matched.id || final.status === 'inProgress' || reread.some(v=>v.matched?.status === 'inProgress')) {
        fail('interrupt has not reached a verified terminal state')
      }
      checked = reread
    }
  }
  store.atomic(()=>{
    if (!marked()) return
    if (db.prepare('SELECT thread FROM host_sessions WHERE owner=?').get(owner)?.thread !== binding?.thread) fail('Session binding changed during recovery')
    db.exec(`CREATE TABLE IF NOT EXISTS host_recovery_receipt (
      owner TEXT NOT NULL, dispatch TEXT NOT NULL, attempt INTEGER NOT NULL,
      assignment TEXT NOT NULL, turn TEXT, observation TEXT NOT NULL, inputs TEXT NOT NULL,
      PRIMARY KEY(owner,dispatch,attempt)
    )`)
    const current = owner === 'main' ? undefined : store.tickets.get(owner)
    const old = current && !current.ended ? latestAssignment(current) : undefined
    // The operator can pause while thread/read or an interrupt is in flight.
    const pauseTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_pause'").get()
    const paused = pausedAtEntry || !!(pauseTable && db.prepare('SELECT 1 FROM worker_pause WHERE ticketId=?').get(owner))
    for (const v of checked) {
      const {call,matched} = v
      if (call.state !== 'active' && call.state !== 'prepared') continue
      const observed = matched?.status ?? 'not-received'
      db.prepare('INSERT OR IGNORE INTO host_recovery_receipt VALUES (?,?,?,?,?,?,?)')
        .run(owner,call.id,call.attempt,call.assignment,matched?.id??null,observed,JSON.stringify(v.ids))
      const row = db.prepare('SELECT state,attempt,turn FROM host_turns WHERE id=?').get(call.id)
      // App Server may emit the actual terminal event while the interrupt callback waits.
      if (!row || row.attempt !== call.attempt || (row.turn && row.turn !== matched?.id)) fail('dispatch changed during reconciliation: ' + call.id)
      if (matched && owner !== 'main' && old?.id === call.assignment && current && !current.ended) {
        if (old.state === 'pending') engine.assignmentStarted(owner,old.id)
        const fresh = store.tickets.get(owner)!
        if (v.ids.some(id=>!fresh.inputs.some(i=>i.id===id))) fail('verified turn references an unknown Ticket input')
        const waiting = v.ids.filter(id=>fresh.undelivered.includes(id))
        if (waiting.length) engine.inputsDelivered(owner,old.id,waiting)
        const unread = fresh.inputs.filter(i=>i.kind==='trigger' && v.ids.includes(i.id) && !i.readAt).map(i=>i.id)
        if (unread.length) engine.inputsRead(owner,unread)
      }
      // An absent prepared attempt remains retryable only if its Assignment survives the recovery below.
      const state = matched?.status ?? 'retry'
      db.prepare('UPDATE host_turns SET state=?,turn=?,due=0 WHERE id=?').run(state,matched?.id??null,call.id)
    }
    if (owner === 'main') {
      for (const thread of store.threads.active()) {
        const evaluation = thread.evaluating
        if (!evaluation) continue
        const id = key('assess',evaluation.id)
        const row = db.prepare('SELECT state,attempt FROM host_turns WHERE id=? AND owner=?').get(id,owner)
        if (row && row.state !== 'retry') {
          // The Candidate is still current. Give its next turn a fresh input ID without creating another Eval.
          db.prepare("UPDATE host_turns SET state='retry',turn=NULL,attempt=attempt+1,due=0 WHERE id=?").run(id)
        } else if (!row) {
          db.prepare("UPDATE domain_effect SET state='pending' WHERE id=?").run(id)
        }
      }
    } else if (old) {
      const latest = latestAssignment(store.tickets.get(owner)!)!
      if (latest.id !== old.id) fail('current assignment changed while verifying inputs')
      if (!paused && latest.state === 'running') engine.assignmentInterrupted(owner,latest.id)
      const next = latestAssignment(store.tickets.get(owner)!)!
      if (next.id !== old.id) {
        db.prepare("UPDATE host_turns SET state='interrupted' WHERE owner=? AND assignment=? AND state='retry'").run(owner,old.id)
      }
      // Reconciled terminal attempts release a previous process's reservation. Never overwrite another assignment's slot.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_slot'").get()) {
        db.prepare('DELETE FROM worker_slot WHERE ticketId=? AND assignmentId=?').run(owner,old.id)
        db.prepare('DELETE FROM worker_queue WHERE ticketId=? AND assignmentId=?').run(owner,old.id)
      }
    }
    db.prepare('DELETE FROM host_recovery WHERE owner=?').run(owner)
  })
}
