import type { Domain } from '../domain.ts'
import { key } from '../core/ids.ts'
import { errorCode } from '../codex/session.ts'
import type { Completion } from '../codex/session.ts'
import { checkCalls, parseHistory } from './recovery.ts'

type Dispatch = Parameters<typeof checkCalls>[0][number]
type History = {id?: unknown, turns?: unknown[], historyMode?: unknown}
interface ObserveCallbacks {
  /** Use Host's ordinary start/completion handlers. They persist receipts
   * synchronously inside this transaction, exactly as on the live connection. */
  started(turnId: string, assignment: string): void
  ended(event: Completion): void
}

export async function observeDispatch(d: Domain, owner: string, history: History, callbacks: ObserveCallbacks): Promise<'idle'|'observing'|'retry'> {
  const {db,store} = d
  return store.atomic(()=>{
    const binding = db.prepare('SELECT thread FROM host_sessions WHERE owner=?').get(owner)
    if (!binding || history.id !== undefined && binding.thread !== history.id) throw new Error('Session history does not match this owner')
    const threadId = String(binding.thread)
    const calls = db.prepare("SELECT id,assignment,ids,turn,state,attempt FROM host_turns WHERE owner=? AND state IN ('prepared','active')").all(owner) as unknown as Dispatch[]
    if (calls.length > 1) throw new Error('Multiple in-flight dispatches on one Session')
    const turns = parseHistory(history)
    const verified = checkCalls(calls,turns)
    if (!verified.length) return 'idle'
    const {call,matched,ids,verifiedAbsent} = verified[0]
    if (owner !== 'main') {
      const ticket = store.tickets.get(owner)
      if (!ticket || ticket.ended || ticket.assignments.at(-1)?.id !== call.assignment || ids.some(id=>!ticket.inputs.some(i=>i.id===id))) {
        throw new Error('Dispatch owner, assignment or stored input is no longer valid')
      }
    }
    if (!matched) {
      if (!verifiedAbsent || call.state !== 'prepared' || call.turn || history.historyMode === 'paginated')
        throw new Error('Cannot prove input absent from the thread')
      // Keep the input ID and attempt. A single durable retry becomes ready;
      // subsequent scans will not schedule another copy.
      db.prepare("UPDATE host_turns SET state='retry',due=0 WHERE id=? AND state='prepared' AND turn IS NULL").run(call.id)
      return 'retry'
    }
    if (!matched.markers.has(key('turn-input',call.id,String(call.attempt)))) throw new Error('Turn history lacks the dispatch input receipt')
    if (call.state === 'prepared') callbacks.started(matched.id,call.assignment)
    if (matched.status === 'inProgress') return 'observing'
    const raw = history.turns!.find(v=>v && typeof v==='object' && 'id' in v && v.id===matched.id) as {error?:unknown}
    callbacks.ended({type:'completed',threadId,turnId:matched.id,assignmentId:call.assignment,status:matched.status,
      ...(raw.error ? {errorCode:errorCode(raw.error)} : {})})
    return 'idle'
  })
}
