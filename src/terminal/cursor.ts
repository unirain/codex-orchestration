import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, fstatSync } from 'node:fs'
import { join } from 'node:path'

export function viewCursor(dir: string, stream: string) {
  const terminal =
    process.env.ORCH_VIEW_ID ||
    JSON.stringify([
      process.env.TMUX_PANE,
      process.env.TERM_SESSION_ID,
      process.env.WT_SESSION,
      fstatSync(0).rdev,
    ])
  const root = join(dir, 'views')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const file = join(
    root,
    createHash('sha256')
      .update(stream + '\0' + terminal)
      .digest('hex'),
  )
  return {
    read(): number | undefined {
      try {
        const n = Number(readFileSync(file, 'utf8'))
        return Number.isSafeInteger(n) && n >= 0 ? n : undefined
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    },
    save(n: number) {
      const temp = file + '.' + randomUUID()
      writeFileSync(temp, String(n), { flag: 'wx', mode: 0o600 })
      renameSync(temp, file)
    },
  }
}
