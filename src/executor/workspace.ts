import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { checked } from './process.ts'

export interface Workspace {
  ticketId: string
  directory: string
  branch?: string
  baseBranch?: string
  baseCommit?: string
  gitDir?: string
}
export type Preparation =
  | { kind: 'empty' }
  | { kind: 'command'; command: string }
  | { kind: 'git'; baseBranch?: string }
export interface PrepareOptions {
  repoDir: string
  stateDir: string
  ticketId: string
  shortName?: string
  prepare?: Preparation
  // Supply a host-controlled credential helper only when the fetch target requires it.
  gitEnv?: NodeJS.ProcessEnv
}
const inFlight = new Map<string, Promise<Workspace>>()
export function ticketKey(ticketId: string) {
  if (!ticketId?.trim()) throw new Error('missing Ticket ID')
  return createHash('sha256').update(ticketId).digest('hex')
}
async function statOrNull(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function prepareTicket(options: PrepareOptions): Promise<Workspace> {
  const key = join(resolve(options.stateDir), 'tickets', ticketKey(options.ticketId))
  const pending = inFlight.get(key)
  if (pending) return pending
  const promise = prepare(options, key).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

async function prepare(o: PrepareOptions, root: string): Promise<Workspace> {
  const repository = await realpath(o.repoDir)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const dir = join(root, 'workspace'),
    metadata = join(root, 'workspace.json')
  const stat = await statOrNull(dir)
  if (await statOrNull(metadata)) {
    const saved = JSON.parse(await readFile(metadata, 'utf8'))
    if (!stat && saved.repo === repository && saved.workspace.ticketId === o.ticketId) {
      const record = saved.workspace as Workspace
      let history = 'no Git checkpoint was recorded'
      if (record.gitDir && record.branch && record.gitDir.startsWith((await realpath(root)) + '/')) {
        try {
          const current = await checked(
            'git',
            [
              '-c',
              'core.hooksPath=/dev/null',
              '--git-dir',
              record.gitDir,
              'rev-parse',
              '--verify',
              'refs/heads/' + record.branch + '^{commit}',
            ],
            {
              cwd: root,
              env: {
                PATH: process.env.PATH,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_TERMINAL_PROMPT: '0',
              },
            },
          )
          history = 'verified branch ' + record.branch + ' at commit ' + current
        } catch {
          history =
            'could not verify saved branch ' +
            record.branch +
            ' (recorded baseline ' +
            record.baseCommit +
            ')'
        }
      }
      throw Error(
        'Ticket workspace missing; ' + history + '; previous uncommitted changes cannot be verified',
      )
    }
    if (
      !stat?.isDirectory() ||
      saved.repo !== repository ||
      saved.workspace.ticketId !== o.ticketId ||
      saved.workspace.directory !== dir ||
      stat.dev.toString() !== saved.dev ||
      stat.ino.toString() !== saved.ino
    ) {
      throw new Error(
        'Ticket workspace missing or ownership changed; check the recorded branch and local work',
      )
    }
    return saved.workspace
  }
  if (stat) throw new Error('unverified Ticket workspace exists; inspect retained files before retry')
  const workspace: Workspace = { ticketId: o.ticketId, directory: dir }
  // Trusted repository preparation never inherits the operator's personal Git environment.
  const gitEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    ...o.gitEnv,
  }
  const git = (args: string[], cwd = root) =>
    checked('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv, timeoutMs: 600000 })
  try {
    const profile = o.prepare ?? { kind: 'empty' }
    if (profile.kind === 'empty') await mkdir(dir, { mode: 0o700 })
    else if (profile.kind === 'command') {
      if (!profile.command.trim()) await mkdir(dir, { mode: 0o700 })
      else
        await checked('/bin/sh', ['-eu', '-c', profile.command], {
          cwd: root,
          timeoutMs: 600000,
          env: {
            PATH: process.env.PATH,
            TICKET_DIR: dir,
            TICKET_ID: o.ticketId,
            TICKET_SLUG: o.shortName ?? o.ticketId,
            REPO_DIR: repository,
          },
        })
    } else if (profile.kind === 'git') {
      let remote = await git(['remote', 'get-url', 'origin'], repository)
      if (!remote || remote.startsWith('-')) throw new Error('invalid origin')
      if (
        !/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(remote) &&
        !/^[^/]+@[^:]+:/.test(remote) &&
        !isAbsolute(remote)
      )
        remote = resolve(repository, remote)
      let base = profile.baseBranch
      if (!base) {
        const refs = await git(['ls-remote', '--symref', '--', remote, 'HEAD'])
        base = refs.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1].trim()
        if (!base) throw new Error('remote HEAD does not identify a default branch')
      }
      if (base.startsWith('-')) throw new Error('invalid base branch')
      await git(['check-ref-format', '--branch', base])
      const privateRepo = await mkdtemp(join(root, 'git-'))
      await git(['init', '--bare', '--quiet', privateRepo])
      await git(['--git-dir', privateRepo, 'fetch', '--no-tags', '--', remote, `refs/heads/${base}`])
      const commit = await git(['--git-dir', privateRepo, 'rev-parse', 'FETCH_HEAD^{commit}'])
      const branch = 'ticket/' + ticketKey(o.ticketId).slice(0, 24)
      await git(['--git-dir', privateRepo, 'worktree', 'add', '--quiet', '-b', branch, dir, commit])
      const gitDir = await git(['rev-parse', '--absolute-git-dir'], dir)
      Object.assign(workspace, { branch, baseBranch: base, baseCommit: commit, gitDir })
    } else throw new Error('unsupported Ticket preparation')
    if (profile.kind === 'command' && !(await statOrNull(dir))) await mkdir(dir, { mode: 0o700 })
    const created = await lstat(dir, { bigint: true })
    if (!created.isDirectory() || (await realpath(dir)) !== join(await realpath(dirname(dir)), 'workspace'))
      throw new Error('prepared path is not the Ticket directory')
    await chmod(dir, 0o700)
    const temporary = join(root, randomUUID() + '.tmp')
    await writeFile(
      temporary,
      JSON.stringify({ repo: repository, dev: String(created.dev), ino: String(created.ino), workspace }),
      { mode: 0o600, flag: 'wx' },
    )
    await rename(temporary, metadata)
    return workspace
  } catch (error) {
    // Only remove the empty directory produced by this attempt; a dirty workspace is evidence.
    await rmdir(dir).catch(() => {})
    throw error
  }
}
