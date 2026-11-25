import { randomUUID } from 'node:crypto'
import { key } from '../core/ids.ts'
import { canRetry } from '../core/stage.ts'
import { terminalTrigger, type Domain } from '../domain.ts'
import type { Config } from './config.ts'
import type { Supervision } from './supervision.ts'

export type AnswerMode = 'continue' | 'save'
export interface Question {
  id: string
  text: string
  mode: AnswerMode
}
export interface ChatTicket {
  id: string
  title: string
  status: string
  pauseCause?: string
  attention?: string
  question?: Question
}
export interface ChatView {
  version: 1
  stream: string
  repo: string
  latest: number
  tickets: ChatTicket[]
  faults: { owner: string; message: string }[]
}
export interface ChatEvent {
  seq: number
  id: string
  kind: string
  text: string
  ticket?: string
}
type Body = Record<string, unknown>

export class ChatHost {
  private domain: Domain
  private supervision: Supervision
  private config: Config
  constructor(domain: Domain, supervision: Supervision, config: Config) {
    this.domain = domain
    this.supervision = supervision
    this.config = config
    domain.store.atomic(() => {
      const db = domain.db
      db.exec(`CREATE TABLE IF NOT EXISTS chat_feed(seq INTEGER PRIMARY KEY, source TEXT, ref TEXT, UNIQUE(source,ref));
        CREATE TABLE IF NOT EXISTS chat_answer(id TEXT PRIMARY KEY, ticket TEXT, question TEXT, mode TEXT, text TEXT, receipt TEXT,
          UNIQUE(ticket,question));`)
      if (!db.prepare("SELECT 1 FROM host_settings WHERE id='chat-stream'").get()) {
        // Existing terminals persisted the highest visible receipt when a Trigger arrived.
        // For older inputs without this metadata, keep input order and the original outbound receipt order.
        db.exec(`INSERT INTO chat_feed(source,ref)
          SELECT source, ref FROM (
            SELECT 'user' AS source,t.id AS ref,coalesce(json_extract(t.value,'$.meta.replyCursor'),0) AS boundary,1 AS lane,t.rowid AS ordinal
            FROM domain_trigger t JOIN domain_disposition d USING(id)
            WHERE json_extract(t.value,'$.source')='terminal' AND json_type(d.value,'$.filtered') IS NULL
            UNION ALL SELECT 'message',id,rowid,0,rowid FROM host_messages
          ) ORDER BY boundary,lane,ordinal`)
        db.prepare("INSERT INTO host_settings VALUES('chat-stream',?)").run(randomUUID())
      }
      db.exec(`CREATE TRIGGER IF NOT EXISTS chat_input AFTER INSERT ON domain_disposition
        WHEN json_type(NEW.value,'$.filtered') IS NULL AND EXISTS
          (SELECT 1 FROM domain_trigger t WHERE t.id=NEW.id AND json_extract(t.value,'$.source')='terminal')
        BEGIN INSERT OR IGNORE INTO chat_feed(source,ref) VALUES('user',NEW.id); END;
        CREATE TRIGGER IF NOT EXISTS chat_message AFTER INSERT ON host_messages
        BEGIN INSERT OR IGNORE INTO chat_feed(source,ref) VALUES('message',NEW.id); END;`)
    })
  }
  view(): ChatView {
    const { db, store } = this.domain
    const active = new Set(
      db
        .prepare("SELECT DISTINCT owner FROM host_turns WHERE state='active'")
        .all()
        .map((r) => r.owner),
    )
    return {
      version: 1,
      stream: String(db.prepare("SELECT value FROM host_settings WHERE id='chat-stream'").get()!.value),
      repo: this.config.repository,
      latest: Number(db.prepare('SELECT coalesce(max(seq),0) n FROM chat_feed').get()!.n),
      faults: db.prepare('SELECT owner,message FROM host_faults').all() as unknown as ChatView['faults'],
      tickets: store.tickets.list().map((t) => {
        const pause = this.supervision.pauseCause(t.id),
          q = t.ended ? undefined : t.attention
        const status =
          t.ended?.outcome ??
          (pause
            ? 'paused'
            : active.has(t.id)
              ? 'running'
              : t.undelivered.length
                ? 'queued'
                : (t.assignments.at(-1)?.report?.state ?? 'queued'))
        return {
          id: t.id,
          title: t.title,
          status,
          attention: q?.question,
          pauseCause: pause?.startsWith('question:') ? 'attention' : pause,
          question: q?.id
            ? { id: q.id, text: q.question, mode: pause === 'question:' + q.id ? 'continue' : 'save' }
            : undefined,
        }
      }),
    }
  }
  events(b: Body): ChatEvent[] {
    const after = Number(b.after ?? 0)
    if (!Number.isSafeInteger(after) || after < 0) throw Error('无效的消息位置')
    const { db, store } = this.domain
    return db
      .prepare(
        `SELECT f.seq,f.ref,f.source,m.text,m.ticket,m.kind,
        json_extract(t.value,'$.text') userText,json_extract(t.value,'$.meta.ticketId') answerTicket
      FROM chat_feed f LEFT JOIN host_messages m ON f.source='message' AND f.ref=m.id
      LEFT JOIN domain_trigger t ON f.source='user' AND f.ref=t.id
      WHERE f.seq>? ORDER BY f.seq LIMIT 100`,
      )
      .all(after)
      .map((r) => {
        const ticket = r.ticket ? store.tickets.get(String(r.ticket)) : undefined
        const accepted =
          ticket && r.kind === 'acknowledgement' && r.ref === key('ack', ticket.origin.triggerId)
        return {
          seq: Number(r.seq),
          id: String(r.ref),
          text: String(r.userText ?? r.text ?? ''),
          ticket: ticket?.id ?? (r.answerTicket ? String(r.answerTicket) : undefined),
          kind: r.source === 'user' ? 'user' : accepted ? 'accepted' : String(r.kind),
        }
      })
  }
  receipt(b: Body) {
    const id = String(b.id ?? '')
    const row = this.domain.db.prepare('SELECT receipt FROM chat_answer WHERE id=?').get(id)
    if (row) return JSON.parse(String(row.receipt))
    return this.domain.store.triggers.get(id) ? { trigger: id, thread: 'terminal:default' } : null
  }
  answer(b: Body) {
    const { id, ticket, question, text, mode, repo } = b
    if (
      repo !== this.config.repository ||
      typeof id !== 'string' ||
      !id ||
      typeof ticket !== 'string' ||
      !ticket ||
      typeof question !== 'string' ||
      !question ||
      typeof text !== 'string' ||
      !text.trim() ||
      (mode !== 'continue' && mode !== 'save')
    )
      throw Error('答复缺少有效的仓库、工单、问题、正文或提交动作')
    const { db, store, engine } = this.domain
    return store.atomic(() => {
      const previous = db.prepare('SELECT * FROM chat_answer WHERE id=?').get(id)
      if (previous) {
        if (
          previous.ticket !== ticket ||
          previous.question !== question ||
          previous.text !== text ||
          previous.mode !== mode
        )
          throw Error('同一发送标识不能更换答复内容或目标')
        return JSON.parse(String(previous.receipt))
      }
      const t = store.tickets.get(ticket)
      if (!t || t.ended || t.attention?.id !== question)
        throw Error('这条问题已处理或已被替换，答复草稿已保留')
      const cause = this.supervision.pauseCause(ticket)
      if (cause === 'question:' + question && mode === 'continue') {
        this.supervision.resume(ticket)
        if (canRetry(t) && !db.prepare('SELECT 1 FROM host_recovery WHERE owner=?').get(ticket))
          engine.retryTicket(ticket)
      }
      const trigger = terminalTrigger(id, text, this.config.actor)
      trigger.meta = {
        ticketId: ticket,
        attentionId: question,
        question: t.attention.question,
        replyCursor: db.prepare('SELECT coalesce(max(rowid),0) n FROM host_messages').get()!.n,
      }
      engine.answerAttention(ticket, question, trigger)
      const receipt = {
        id,
        ticket,
        question,
        status: this.supervision.isPaused(ticket) ? 'paused' : 'queued',
      }
      db.prepare('INSERT INTO chat_answer VALUES(?,?,?,?,?,?)').run(
        id,
        ticket,
        question,
        String(mode),
        text,
        JSON.stringify(receipt),
      )
      return receipt
    })
  }
}
