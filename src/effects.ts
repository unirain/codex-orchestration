import { DatabaseSync } from 'node:sqlite'
import type { Candidate, OutboundMessage } from './core/ports.ts'

export type Effect =
  | { id: string; kind: 'assess'; candidate: Candidate }
  | { id: string; kind: 'start' | 'deliver' | 'stop'; ticketId: string; assignmentId: string; reason?: string }
  | { id: string; kind: 'send'; message: OutboundMessage }
export type Dispatch = (effect: Effect) => Promise<'defer' | void> | 'defer' | void

/** The host holds the repository instance lock. A port must reconcile the effect ID before repeating external work. */
export class Effects {
  private db: DatabaseSync
  private flushing?: Promise<number>
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_effect(
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped'))
      );
      CREATE INDEX IF NOT EXISTS domain_effect_pending ON domain_effect(seq) WHERE state='pending';
    `)
  }
  add(effect: Effect) {
    this.db.prepare('INSERT INTO domain_effect(id,payload) VALUES (?,?) ON CONFLICT(id) DO NOTHING')
      .run(effect.id,JSON.stringify(effect))
  }
  state(id: string): 'pending' | 'sent' | 'dropped' | undefined {
    return this.db.prepare('SELECT state FROM domain_effect WHERE id=?').get(id)?.state as ReturnType<Effects['state']>
  }
  withdraw(id: string) {
    this.db.prepare("UPDATE domain_effect SET state='dropped' WHERE id=? AND state='pending'").run(id)
  }
  drain(dispatch: Dispatch): Promise<number> {
    if (!this.flushing) this.flushing = Promise.resolve().then(() => this.flush(dispatch)).finally(() => { this.flushing = undefined })
    return this.flushing
  }
  private async flush(dispatch: Dispatch): Promise<number> {
    if (this.db.isTransaction) throw new Error('Dispatch requires committed state')
    const pending = this.db.prepare("SELECT id,payload FROM domain_effect WHERE state='pending' ORDER BY seq").all()
    let sent = 0
    const errors: unknown[] = []
    for (const row of pending) {
      const id = String(row.id)
      // A prior handler may have withdrawn an assessment while this snapshot was in flight.
      if (this.state(id) !== 'pending') continue
      try {
        if (await dispatch(JSON.parse(String(row.payload))) === 'defer') continue
        this.db.prepare("UPDATE domain_effect SET state='sent' WHERE id=? AND state='pending'").run(id)
        sent++
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'One or more effects failed delivery')
    return sent
  }
}
