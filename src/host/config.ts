import { readFileSync, realpathSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { GithubConfig } from './github.ts'
import type { Preparation } from '../executor/workspace.ts'

export interface Config {
  repository: string
  repoDir: string
  actor: string
  image: string
  codex: string
  prepare?: Preparation
  modelKeyEnv: string
  provider: 'deepseek' | 'openai'
  mainModel?: string
  workerModel?: string
  allow?: string[]
  github?: GithubConfig
  excerptBytes?: number
}
export function loadConfig(file: string): Config {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw Error('Binding must be a trusted, current-user configuration file')
  const c = JSON.parse(readFileSync(file, 'utf8')) as Config
  for (const k of ['repository', 'repoDir', 'actor', 'image', 'codex', 'modelKeyEnv'] as const)
    if (typeof c[k] !== 'string' || !c[k].trim()) throw Error('Missing binding setting: ' + k)
  if (!isAbsolute(c.repoDir) || !isAbsolute(c.codex) || !/^\w+$/.test(c.modelKeyEnv))
    throw Error('Invalid checkout, executable or credential reference')
  if (!['deepseek', 'openai'].includes(c.provider)) throw Error('Unknown model provider')
  if (c.github && c.github.repo !== c.repository) throw Error('GitHub repository must match the binding')
  return { ...c, repoDir: realpathSync(c.repoDir) }
}
export function instanceDir(c: Config) {
  const root = process.env.ORCH_STATE_ROOT || join(homedir(), '.local', 'state', 'codex-orchestration')
  return join(root, createHash('sha256').update(c.repository).digest('hex').slice(0, 24))
}
