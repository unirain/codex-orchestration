import type { Domain } from '../domain.ts'
import { latestAssignment, waitsForPerson } from '../core/model.ts'

export type WakeReason = 'start' | 'human' | 'event'
export type TestStatus = 'running' | 'passed' | 'failed' | 'interrupted' | 'unknown' | 'timeout'
export interface TestStart {
  id: string
  ticketId: string
  assignmentId: string
  command: string
  commit: string
  dirty: boolean
  image: string
}
export interface TestResult {
  status: Exclude<TestStatus, 'running'>
  exitCode?: number | null
  output?: string
  truncated?: boolean
}
export interface TestRun extends TestStart {
  startedAt: number
  endedAt: number | null
  status: TestStatus
  exitCode: number | null
  excerpt: string | null
  truncated: boolean
  cleared: boolean
  feedback: 'pending' | 'delivered' | 'historical'
}
interface UsageUpdate {
  threadId: string
  turnId: string
  role: 'main' | 'worker'
  ticketId?: string
  /** Codex reports a thread-cumulative total; the per-turn "last" value must not be passed here. */
  total: number
}
interface Options {
  now?: () => number
  excerptBytes?: number
  secrets?: () => readonly string[]
}

const WAIT_WINDOW_MS = 30 * 60 * 1000

function redact(text: string, secrets: readonly string[]): string {
  let value = text
  // Longer configured values first so an overlapping shorter credential cannot expose the remainder.
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    value = value.replaceAll(secret, '[REDACTED]')
  }
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi,'$1[REDACTED]')
    .replace(/(\b[\w.-]*(?:token|password|secret|api[_-]?key)\b\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,'$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
}

/** Keep the tail of redacted text, advancing past any UTF-8 continuation bytes at the cut. */
function tailBytes(text: string, limit: number) {
  const bytes = Buffer.from(text)
  let offset = Math.max(0,bytes.length-limit)
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++
  return { text: bytes.toString('utf8',offset), truncated: offset > 0 }
}

export class Supervision {
  private readonly d: Domain
  private readonly options: Options
  private readonly excerptBytes: number

  constructor(domain: Domain, options: Options = {}) {
    this.d = domain
    this.options = options
    this.excerptBytes = options.excerptBytes ?? 4096
    if (!Number.isSafeInteger(this.excerptBytes) || this.excerptBytes <= 0) throw new TypeError('Invalid test excerpt byte limit')
    domain.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_pause (ticketId TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_slot (
        ticketId TEXT PRIMARY KEY, assignmentId TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('reserved','active','waiting')), turnId TEXT, waitSince INTEGER
      );
      CREATE TABLE IF NOT EXISTS worker_queue (
        seq INTEGER PRIMARY KEY, ticketId TEXT UNIQUE NOT NULL, assignmentId TEXT NOT NULL, human INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_test (
        id TEXT PRIMARY KEY, ticketId TEXT NOT NULL, assignmentId TEXT NOT NULL,
        command TEXT NOT NULL, "commit" TEXT NOT NULL, dirty INTEGER NOT NULL, image TEXT NOT NULL,
        startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, exitCode INTEGER,
        excerpt TEXT, truncated INTEGER NOT NULL DEFAULT 0, cleared INTEGER NOT NULL DEFAULT 0,
        feedback TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS worker_test_ticket ON worker_test(ticketId, assignmentId, status);
      CREATE TABLE IF NOT EXISTS worker_usage (
        threadId TEXT PRIMARY KEY, role TEXT NOT NULL, ticketId TEXT, turnId TEXT NOT NULL, total INTEGER NOT NULL
      );
    `)
  }

  private get db() { return this.d.db }
  private now() { return this.options.now?.() ?? Date.now() }
  private redact(value: string) { return redact(value,this.options.secrets?.() ?? []) }
  private slot(ticketId: string) {
    return this.db.prepare('SELECT * FROM worker_slot WHERE ticketId=?').get(ticketId)
  }
  private current(ticketId: string, assignmentId: string) {
    const ticket = this.d.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    return ticket && !ticket.ended && assignment?.id === assignmentId && assignment.state !== 'ended' ? ticket : undefined
  }
  private runningTests(ticketId: string, assignmentId: string) {
    return !!this.db.prepare("SELECT 1 FROM worker_test WHERE ticketId=? AND assignmentId=? AND status='running' LIMIT 1")
      .get(ticketId,assignmentId)
  }

  /** After the host reconciles the old executor process and changes the domain assignment, discard obsolete scheduling state. */
  reconcile() {
    this.d.store.atomic(() => {
      for (const table of ['worker_slot','worker_queue']) {
        for (const row of this.db.prepare('SELECT ticketId,assignmentId FROM ' + table).all()) {
          if (!this.current(String(row.ticketId),String(row.assignmentId))) {
            this.db.prepare('DELETE FROM ' + table + ' WHERE ticketId=? AND assignmentId=?').run(row.ticketId,row.assignmentId)
          }
        }
      }
    })
  }

  occupied(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM worker_slot').get()!.n)
  }
  isPaused(ticketId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM worker_pause WHERE ticketId=?').get(ticketId)
  }

  /**
   * Reserve synchronously before launching. A pending Assignment cannot consume the human-only fourth slot.
   * Rechecking a queued request respects older requests in its class and queued human follow-ups.
   */
  reserve(ticketId: string, assignmentId: string, reason: WakeReason): boolean {
    return this.d.store.atomic(() => {
      this.reconcile()
      const ticket = this.current(ticketId,assignmentId)
      if (!ticket || this.isPaused(ticketId)) return false
      const owned = this.slot(ticketId)
      if (owned) {
        // A new turn is being reserved while jobs from the previous one finish. A simultaneous pause
        // must wait for the in-flight launch to be cancelled or acknowledged before releasing capacity.
        if (owned.phase === 'waiting') {
          this.db.prepare("UPDATE worker_slot SET phase='reserved',waitSince=NULL WHERE ticketId=?").run(ticketId)
        }
        return true
      }
      const human = reason === 'human' && latestAssignment(ticket)?.state === 'running' ? 1 : 0
      this.db.prepare(`INSERT INTO worker_queue(ticketId,assignmentId,human) VALUES (?,?,?)
        ON CONFLICT(ticketId) DO UPDATE SET human=MAX(worker_queue.human,excluded.human)`).run(ticketId,assignmentId,human)
      const count = this.occupied()
      const next = this.db.prepare(`SELECT ticketId,human FROM worker_queue
        WHERE human=1 OR ?<3 ORDER BY human DESC,seq LIMIT 1`).get(count)
      if (next?.ticketId !== ticketId || count >= (next.human ? 4 : 3)) return false
      this.db.prepare("INSERT INTO worker_slot(ticketId,assignmentId,phase) VALUES (?,?,'reserved')").run(ticketId,assignmentId)
      this.db.prepare('DELETE FROM worker_queue WHERE ticketId=?').run(ticketId)
      return true
    })
  }

  turnStarted(ticketId: string, assignmentId: string, turnId: string) {
    if (!turnId || !this.current(ticketId,assignmentId)) throw new Error('Invalid turn binding')
    const slot = this.slot(ticketId)
    if (!slot || slot.assignmentId !== assignmentId) throw new Error('Turn started without a matching slot')
    if (slot.phase === 'active' && slot.turnId !== turnId) throw new Error('Another turn still owns this slot')
    // A pause may have raced a remote start. Bind the actual turn so its eventual interruption can release the slot.
    this.db.prepare("UPDATE worker_slot SET phase='active',turnId=?,waitSince=NULL WHERE ticketId=?").run(turnId,ticketId)
  }

  turnEnded(ticketId: string, assignmentId: string, turnId: string) {
    this.d.store.atomic(() => {
      const slot = this.slot(ticketId)
      if (!slot || slot.assignmentId !== assignmentId || slot.phase !== 'active' || slot.turnId !== turnId) return
      const ticket = this.current(ticketId,assignmentId)
      if (ticket && !this.isPaused(ticketId) && !waitsForPerson(ticket) && this.runningTests(ticketId,assignmentId)) {
        this.db.prepare("UPDATE worker_slot SET phase='waiting',turnId=NULL,waitSince=? WHERE ticketId=?").run(this.now(),ticketId)
      } else {
        this.release(ticketId,assignmentId)
      }
    })
  }

  release(ticketId: string, assignmentId: string) {
    this.db.prepare('DELETE FROM worker_slot WHERE ticketId=? AND assignmentId=?').run(ticketId,assignmentId)
    this.db.prepare('DELETE FROM worker_queue WHERE ticketId=? AND assignmentId=?').run(ticketId,assignmentId)
  }

  /** The caller interrupts the returned turn and acknowledges its terminal event before freeing its slot. */
  pause(ticketId: string): string | undefined {
    return this.d.store.atomic(() => {
      const ticket = this.d.store.tickets.get(ticketId)
      if (!ticket || ticket.ended) throw new Error('Only an open ticket can pause')
      this.db.prepare('INSERT OR IGNORE INTO worker_pause VALUES (?,?)').run(ticketId,this.now())
      this.db.prepare('DELETE FROM worker_queue WHERE ticketId=?').run(ticketId)
      const slot = this.slot(ticketId)
      if (slot?.phase === 'waiting') this.release(ticketId,String(slot.assignmentId))
      return typeof slot?.turnId === 'string' ? slot.turnId : undefined
    })
  }

  resume(ticketId: string) {
    const ticket = this.d.store.tickets.get(ticketId)
    if (!ticket || ticket.ended) throw new Error('Only an open ticket can resume')
    this.db.prepare('DELETE FROM worker_pause WHERE ticketId=?').run(ticketId)
    this.flushFeedback()
  }

  startTest(run: TestStart): boolean {
    return this.d.store.atomic(() => {
      const { id, ticketId, assignmentId } = run
      if (![id,ticketId,assignmentId,run.command,run.commit,run.image].every(s => typeof s === 'string' && s.trim())) {
        throw new Error('Incomplete test identity or code version')
      }
      const command = this.redact(run.command)
      const old = this.db.prepare('SELECT * FROM worker_test WHERE id=?').get(id)
      if (old) {
        if (old.ticketId !== ticketId || old.assignmentId !== assignmentId || old.command !== command ||
          old.commit !== run.commit || !!old.dirty !== run.dirty || old.image !== run.image) throw new Error('Conflicting test ID')
        return false
      }
      const slot = this.slot(ticketId)
      if (!this.current(ticketId,assignmentId) || this.isPaused(ticketId) || slot?.assignmentId !== assignmentId || slot.phase !== 'active') {
        throw new Error('Test requires an active turn on its current assignment')
      }
      this.db.prepare(`INSERT INTO worker_test(id,ticketId,assignmentId,command,"commit",dirty,image,startedAt,status)
        VALUES (?,?,?,?,?,?,?,?,'running')`).run(id,ticketId,assignmentId,command,run.commit,Number(run.dirty),run.image,this.now())
      return true
    })
  }

  finishTest(id: string, result: TestResult): boolean {
    return this.d.store.atomic(() => {
      const run = this.db.prepare('SELECT * FROM worker_test WHERE id=?').get(id)
      if (!run) throw new Error('Unknown test run')
      if (run.status !== 'running') return false
      const exitCode = result.exitCode ?? null
      if (!['passed','failed','timeout','unknown','interrupted'].includes(result.status) ||
          (exitCode !== null && !Number.isSafeInteger(exitCode)) ||
          (result.status === 'passed' && exitCode !== 0) || (result.status === 'failed' && exitCode === 0)) throw new Error('Invalid test outcome')
      const failed = result.status === 'failed' || result.status === 'timeout'
      const excerpt = tailBytes(failed ? this.redact(result.output ?? '') : '',this.excerptBytes)
      this.db.prepare(`UPDATE worker_test SET status=?,exitCode=?,excerpt=?,truncated=?,endedAt=? WHERE id=?`)
        .run(result.status,exitCode,failed ? excerpt.text : null,Number(failed && (excerpt.truncated || result.truncated === true)),this.now(),id)
      const ticketId = String(run.ticketId)
      const assignmentId = String(run.assignmentId)
      if (this.slot(ticketId)?.phase === 'waiting' && !this.runningTests(ticketId,assignmentId)) this.release(ticketId,assignmentId)
      return true
    })
  }

  /** Return job IDs eligible to terminate now. Recheck after any asynchronous scheduling boundary. */
  overdueTests(): string[] {
    this.reconcile()
    return this.db.prepare(`SELECT t.id FROM worker_test t JOIN worker_slot s USING(ticketId,assignmentId)
      LEFT JOIN worker_pause p USING(ticketId)
      WHERE p.ticketId IS NULL AND s.phase='waiting' AND s.waitSince<=? AND t.status='running' ORDER BY t.rowid`)
      .all(this.now()-WAIT_WINDOW_MS).map(row=>String(row.id))
  }

  recoverInterruptedTests(liveRunIds: ReadonlySet<string>) {
    for (const row of this.db.prepare("SELECT id FROM worker_test WHERE status='running'").all()) {
      const id = String(row.id)
      if (!liveRunIds.has(id)) this.finishTest(id,{status:'unknown'})
    }
  }

  /**
   * Engine.note and the consumed receipt commit on the very same SQLite connection. The note points at an erasable excerpt
   * by run ID; copying its contents into business history would defeat manual cleanup.
   */
  flushFeedback(): number {
    return this.d.store.atomic(() => {
      let delivered = 0
      const runs = this.db.prepare("SELECT * FROM worker_test WHERE status<>'running' AND feedback='pending' ORDER BY rowid").all()
      for (const run of runs) {
        const ticketId = String(run.ticketId)
        const ticket = this.current(ticketId,String(run.assignmentId))
        if (!ticket) {
          this.db.prepare("UPDATE worker_test SET feedback='historical' WHERE id=?").run(run.id)
          continue
        }
        if (this.isPaused(ticketId) || waitsForPerson(ticket)) continue
        this.d.engine.note(ticketId,JSON.stringify({kind:'test-result',runId:run.id,assignmentId:run.assignmentId,
          command:run.command,commit:run.commit,dirty:!!run.dirty,status:run.status,exitCode:run.exitCode}))
        this.db.prepare("UPDATE worker_test SET feedback='delivered' WHERE id=?").run(run.id)
        delivered++
      }
      return delivered
    })
  }

  tests(ticketId: string): TestRun[] {
    return this.db.prepare('SELECT * FROM worker_test WHERE ticketId=? ORDER BY rowid').all(ticketId)
      .map(row=>({...row,dirty:!!row.dirty,truncated:!!row.truncated,cleared:!!row.cleared}) as unknown as TestRun)
  }

  clearExcerpts(ticketId: string): number {
    return Number(this.db.prepare('UPDATE worker_test SET excerpt=NULL,cleared=1 WHERE ticketId=? AND excerpt IS NOT NULL').run(ticketId).changes)
  }

  recordUsage(update: UsageUpdate) {
    const {role,ticketId,threadId,turnId,total} = update
    if (!Number.isSafeInteger(total) || total < 0 || !threadId || !turnId ||
        (role === 'worker' ? !ticketId || !this.d.store.tickets.get(ticketId) : role !== 'main' || !!ticketId)) throw new Error('Invalid usage snapshot')
    this.d.store.atomic(() => {
      const old = this.db.prepare('SELECT * FROM worker_usage WHERE threadId=?').get(threadId)
      if (old && (old.role !== role || old.ticketId !== (ticketId??null))) throw new Error('Thread usage identity conflict')
      this.db.prepare(`INSERT INTO worker_usage(threadId,role,ticketId,turnId,total) VALUES (?,?,?,?,?)
        ON CONFLICT(threadId) DO UPDATE SET turnId=excluded.turnId,total=excluded.total WHERE excluded.total>worker_usage.total`)
        .run(threadId,role,ticketId??null,turnId,total)
    })
  }

  usage(ticketId?: string): number {
    return Number(this.db.prepare('SELECT COALESCE(SUM(total),0) AS total FROM worker_usage WHERE ticketId IS ?').get(ticketId??null)!.total)
  }
}
