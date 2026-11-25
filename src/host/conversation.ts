import type { Domain } from '../domain.ts'
import { key } from '../core/ids.ts'

/** Conversation visible at intake. Later replies cannot retroactively give "yes" a referent. */
export function precedingConversation(domain: Domain, triggerId: string) {
  const current = domain.store.triggers.get(triggerId)
  const channel = current?.channel
  if (!current || !channel || channel.source !== 'terminal') return []
  const rows = domain.db
    .prepare(
      `
    SELECT t.id, json_extract(t.value, '$.text') AS text, json_extract(d.value, '$.evalId') AS evalId
    FROM domain_trigger t JOIN domain_disposition d ON t.id=d.id
    WHERE t.rowid < (SELECT rowid FROM domain_trigger WHERE id=?)
      AND json_extract(t.value,'$.channel.source')=? AND json_extract(t.value,'$.channel.thread')=?
      AND json_extract(t.value,'$.actor.id')=? AND json_extract(t.value,'$.human')=1
      AND json_type(d.value,'$.filtered') IS NULL AND json_type(t.value,'$.meta.attentionId') IS NULL
    ORDER BY t.rowid DESC LIMIT 8
  `,
    )
    .all(current.id, channel.source, channel.thread, current.actor.id)
    .reverse()
  const cursor = current.meta.replyCursor
  const replies =
    typeof cursor === 'number' && Number.isSafeInteger(cursor)
      ? domain.db.prepare(
          'SELECT ticket,text FROM host_messages WHERE rowid<=? AND id IN (?,?) ORDER BY rowid',
        )
      : undefined
  // Omit oversized text as a whole: cutting a qualifier off can change an authorization's meaning.
  const bounded = (s: unknown) => (typeof s === 'string' && s.length <= 2000 ? s : null)
  return rows.map((row) => {
    const id = String(row.id)
    const sent =
      replies?.all(
        Number(cursor),
        key('ack', id),
        row.evalId ? key('clarify', String(row.evalId), id) : null,
      ) ?? []
    return {
      triggerId: id,
      userText: bounded(row.text),
      replies: sent.map((m) => ({ ticketId: m.ticket, text: bounded(m.text) })),
    }
  })
}
