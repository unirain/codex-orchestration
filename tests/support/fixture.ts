import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Effect } from '../../src/effects.ts'

export function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'codex-domain-'))
  return { path: join(directory, 'state.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

export function recordingPorts() {
  const calls: Effect[] = []
  return { calls, dispatch: (effect: Effect) => { calls.push(structuredClone(effect)) } }
}
