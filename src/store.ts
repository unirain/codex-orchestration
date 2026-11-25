import { DatabaseSync } from 'node:sqlite'
import type { Repositories } from './core/ports.ts'
import type { Trigger, Thread, Ticket, Decision, TriggerDisposition } from './core/model.ts'

type Table = 'domain_trigger' | 'domain_thread' | 'domain_ticket' | 'domain_decision' | 'domain_disposition'

/** Domain objects use stable identifiers. SQLite binds the Engine's entire synchronous command to one transaction. */
export class DomainStore implements Repositories {
  readonly db: DatabaseSync
  private depth = 0
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_thread (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_decision (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS domain_disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS domain_decision_thread ON domain_decision(json_extract(value,'$.threadKey'));
      CREATE TABLE IF NOT EXISTS domain_history (
        seq INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS domain_history_id ON domain_history(entity, entity_id, seq);
    `)
  }

  atomic<T>(work: () => T): T {
    const nested = this.depth > 0 || this.db.isTransaction
    const savepoint = 'domain_' + this.depth
    this.db.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE')
    this.depth++
    try {
      const value = work()
      this.db.exec(nested ? 'RELEASE ' + savepoint : 'COMMIT')
      return value
    } catch (error) {
      if (nested) this.db.exec('ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint)
      else this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  private get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM ' + table + ' WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  private rows<T>(table: Table, where = '1', params: string[] = [], order = 'rowid'): T[] {
    return this.db.prepare('SELECT value FROM ' + table + ' WHERE ' + where + ' ORDER BY ' + order)
      .all(...params).map(row => JSON.parse(String(row.value)))
  }
  private save(table: Table, id: string, value: unknown) {
    const json = JSON.stringify(value)
    this.db.prepare('INSERT INTO ' + table + ' (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(id,json)
  }

  readonly triggers = {
    get: (id: string) => this.get<Trigger>('domain_trigger', id),
    save: (v: Trigger) => { this.db.prepare('INSERT INTO domain_trigger VALUES (?,?)').run(v.id, JSON.stringify(v)) },
    disposition: (id: string) => this.get<TriggerDisposition>('domain_disposition', id),
    saveDisposition: (id: string, v: TriggerDisposition) => this.save('domain_disposition', id, v),
  }
  readonly threads = {
    get: (id: string) => this.get<Thread>('domain_thread', id),
    save: (v: Thread) => this.save('domain_thread', v.key, v),
    list: () => this.rows<Thread>('domain_thread'),
    active: () => this.rows<Thread>('domain_thread', "json_array_length(value,'$.pending')>0 OR json_type(value,'$.evaluating') IS NOT NULL"),
  }
  readonly tickets = {
    get: (id: string) => this.get<Ticket>('domain_ticket', id),
    save: (v: Ticket) => this.save('domain_ticket', v.id, v),
    list: () => this.rows<Ticket>('domain_ticket', '1', [], 'rowid DESC'),
    open: () => this.rows<Ticket>('domain_ticket', "json_type(value,'$.ended') IS NULL", [], 'rowid DESC'),
    active: () => this.rows<Ticket>('domain_ticket', "json_array_length(value,'$.undelivered')>0 OR json_extract(value,'$.assignments[#-1].state') IN ('pending','running')", [], 'rowid DESC'),
  }
  readonly decisions = {
    get: (id: string) => this.get<Decision>('domain_decision', id),
    save: (v: Decision) => this.save('domain_decision', v.id, v),
    byThread: (id: string) => this.rows<Decision>('domain_decision', "json_extract(value,'$.threadKey')=?", [id]),
  }

  record(entity: string, id: string, value: unknown) {
    this.db.prepare('INSERT INTO domain_history(entity,entity_id,value) VALUES (?,?,?)').run(entity,id,JSON.stringify(value))
  }
}
