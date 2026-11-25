import { existsSync, chmodSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export const formatVersion = 3
/** Called while holding the host instance lock, before opening any domain or execution tables. */
export function prepareStore(path: string): string | undefined {
  if (!existsSync(path)) return
  const db = new DatabaseSync(path)
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > formatVersion)
      throw Error('Unsupported newer database format; open with its compatible host version')
    if (
      version === formatVersion ||
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()
    )
      return
    const backup = path + '.v' + version + '-' + randomUUID() + '.backup'
    db.prepare('VACUUM INTO ?').run(backup)
    chmodSync(backup, 0o600)
    return backup
  } finally {
    db.close()
  }
}
