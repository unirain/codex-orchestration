import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDomain, terminalTrigger } from '../domain.ts'
import type { Domain, Effect } from '../domain.ts'
import { key } from '../core/ids.ts'
import type { Ticket } from '../core/model.ts'
import type { Config } from './config.ts'
import { CodexSession, ConnectionLost, RpcError, errorCode } from '../codex/session.ts'
import type { ToolContext, SessionEvent } from '../codex/session.ts'
import { intervals, retryable } from '../codex/retry.ts'
import { openMainTransport, type MainTransport } from '../codex/main-transport.ts'
import { deepseekArgs } from '../codex/deepseek.ts'
import { prepareTicket, openTicketRuntime, reapTicketRuntime } from '../executor/index.ts'
import type { Workspace } from '../executor/workspace.ts'
import { observeDispatch } from './reattach.ts'
import { prepareStore, formatVersion } from './storage.ts'
import { RoleHandlers, MAIN_INSTRUCTIONS, WORKER_INSTRUCTIONS } from './tools.ts'
import { Supervision } from './supervision.ts'
import { GitHub } from './github.ts'
import type { Ref } from './github.ts'
import { Delivery, localGit } from './delivery.ts'
import type { DeliveryRequest } from './delivery.ts'

type Environment = Awaited<ReturnType<typeof openTicketRuntime>>
type Call = {
  id: string
  owner: string
  assignment: string
  ids: string
  text: string
  turn: string | null
  state: string
  attempt: number
  due: number
}
type SessionRow = {
  owner: string
  thread: string
  model: string | null
  source: string
  requestedModel: string | null
}
type Live = { session: CodexSession; environment?: Environment; workspace?: Workspace }
const MAIN = 'main'
const asError = (e: unknown) => (e instanceof Error ? e.message : String(e))
function pullRef(repository: string, n: number) {
  return { source: 'github', id: repository + '/pull/' + n }
}
function refFor(w: Workspace): Ref {
  if (!w.branch || !w.baseBranch || !w.gitDir)
    throw Error('Ticket needs its repository Git preparation profile')
  return {
    ticket: w.ticketId,
    branch: w.branch,
    base: w.baseBranch,
    gitDir: w.gitDir,
    directory: w.directory,
  }
}

export class Host {
  config: Config
  dir: string
  domain: Domain
  supervision: Supervision
  tools: RoleHandlers
  private live = new Map<string, Live>()
  private delivery?: Delivery
  private remote?: GitHub
  private stop = false
  private working?: Promise<void>
  private timer?: NodeJS.Timeout
  private tests = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private mainTransport?: MainTransport
  private preparing = new Map<string, Promise<Live>>()
  private reconciling = new Set<string>()
  private disconnected = new Map<string, Live>()
  private observing = new Map<string, number>()
  private sleeping = new Map<string, number>()
  constructor(config: Config, dir: string) {
    this.config = config
    this.dir = dir
    const storePath = join(dir, 'store.sqlite')
    prepareStore(storePath)
    this.domain = openDomain(storePath, { actorId: config.actor, repository: config.repository })
    const db = this.domain.db
    db.exec(`CREATE TABLE IF NOT EXISTS host_settings(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_sessions(owner TEXT PRIMARY KEY,thread TEXT NOT NULL UNIQUE,model TEXT,source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_model_choice(owner TEXT PRIMARY KEY,requestedModel TEXT);
      CREATE TABLE IF NOT EXISTS host_environment(seq INTEGER PRIMARY KEY, ticket TEXT, assignment TEXT, imageRef TEXT, imageId TEXT,
      codexVersion TEXT,directory TEXT,branch TEXT,baseBranch TEXT,baseCommit TEXT);
      CREATE TABLE IF NOT EXISTS host_turns(id TEXT PRIMARY KEY,owner TEXT NOT NULL,assignment TEXT NOT NULL,ids TEXT NOT NULL,text TEXT NOT NULL,
      turn TEXT,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS host_messages(id TEXT PRIMARY KEY,text TEXT NOT NULL,ticket TEXT,kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_faults(owner TEXT PRIMARY KEY,message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_test_tree(id TEXT PRIMARY KEY,ticket TEXT NOT NULL,tree TEXT);
      CREATE TABLE IF NOT EXISTS host_recovery(owner TEXT PRIMARY KEY);`)
    this.supervision = new Supervision(this.domain, {
      excerptBytes: config.excerptBytes,
      secrets: () => [process.env[config.modelKeyEnv] ?? ''].filter(Boolean),
    })
    if (config.github) {
      this.remote = new GitHub(config.github)
      this.delivery = new Delivery(db, this.remote, config.repository, config.github.account, {
        authorize: (r) => this.authorize(r.ticket),
        open: (id) => Boolean(this.domain.store.tickets.get(id) && !this.domain.store.tickets.get(id)!.ended),
        bind: (r, p) => {
          const thread = pullRef(config.repository, p.number)
          if (
            !this.domain.store.tickets
              .get(r.ticket)
              ?.follows?.some((f) => f.thread === 'github:' + thread.id && f.own)
          )
            this.domain.engine.bindThread(r.ticket, thread, true)
        },
        closed: (p) =>
          this.domain.engine.threadClosed(
            pullRef(config.repository, p.number),
            p.merged ? 'merged' : 'closed',
            p.closedAt!,
          ),
      })
    }
    this.tools = new RoleHandlers(this.domain, {
      valid: (c) => this.valid(c),
      runTest: (id, c, command) => this.launchTest(id, c, command),
      deliver: (id, c, args) => this.deliver(id, c, args as DeliveryRequest),
      mayReportReady: (c, p) => this.ready(c, p),
      pause: (ticket) => {
        this.supervision.pause(ticket)
        queueMicrotask(() => void this.interrupt(ticket).catch((e) => this.fault(ticket, e)))
      },
    })
    db.exec('PRAGMA user_version=' + formatVersion)
  }
  private get db() {
    return this.domain.db
  }
  private setting(id: string) {
    return this.db.prepare('SELECT value FROM host_settings WHERE id=?').get(id)?.value
  }
  private fault(owner: string, e: unknown) {
    let reason = asError(e).slice(0, 1536)
    const secret = process.env[this.config.modelKeyEnv]
    if (secret) reason = reason.replaceAll(secret, '[redacted]')
    reason = reason.replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{10,}/g, '[redacted]')
    this.db.prepare('INSERT OR REPLACE INTO host_faults VALUES(?,?)').run(owner, reason)
  }
  private clear(owner: string) {
    this.db.prepare('DELETE FROM host_faults WHERE owner=?').run(owner)
  }
  private authorize(id: string) {
    const t = this.domain.store.tickets.get(id)
    if (
      this.stop ||
      this.setting('allow-write') !== 'yes' ||
      !t ||
      t.ended ||
      t.mandate.actor.id !== this.config.actor ||
      t.mandate.basis.scope?.repository !== this.config.repository ||
      this.supervision.isPaused(id)
    )
      throw Error('Ticket is paused or remote authorization is unavailable')
  }
  private valid(c: ToolContext) {
    const owner = c.ticketId ?? MAIN
    if (
      this.stop ||
      this.reconciling.has(owner) ||
      !this.db
        .prepare(
          "SELECT 1 FROM host_turns ht JOIN host_sessions hs USING(owner) WHERE ht.owner=? AND ht.assignment=? AND ht.turn=? AND hs.thread=? AND ht.state='active'",
        )
        .get(owner, c.assignmentId, c.turnId, c.threadId)
    )
      return false
    if (owner === MAIN) return true
    const t = this.domain.store.tickets.get(owner)
    return !!t && !t.ended && t.assignments.at(-1)?.id === c.assignmentId && !this.supervision.isPaused(owner)
  }
  async initialize() {
    const interrupted = this.db
      .prepare("SELECT DISTINCT ticketId FROM worker_test WHERE status='running'")
      .all()
    for (const r of interrupted) {
      const id = String(r.ticketId)
      await reapTicketRuntime({ stateDir: this.dir, ticketId: id })
      for (const run of this.supervision.tests(id).filter((t) => t.status === 'running'))
        this.supervision.finishTest(run.id, { status: 'unknown' })
    }
    if (this.remote) {
      try {
        await this.remote.verify()
        this.clear('github')
      } catch (e) {
        this.fault('github', e)
      }
    }
    // A confirmed remote write may already exist even if its caller died before recording the PR number.
    await this.reconcileDeliveries()
    for (const t of this.domain.store.tickets.open().reverse())
      if (t.assignments.at(-1)?.state === 'running')
        this.db.prepare('INSERT OR IGNORE INTO host_recovery VALUES(?)').run(t.id)
    for (const row of this.db
      .prepare(
        "SELECT DISTINCT owner FROM host_turns WHERE state IN ('active','prepared') UNION SELECT owner FROM host_sessions WHERE owner='main'",
      )
      .all())
      this.db.prepare('INSERT OR IGNORE INTO host_recovery VALUES(?)').run(row.owner)
    this.supervision.reconcile()
    this.timer = setInterval(() => void this.tick(), 200)
  }
  async command(action: string, b: Record<string, unknown>) {
    if (this.stop) throw Error('Host is stopping')
    if (action === 'say') {
      if (typeof b.id !== 'string' || !b.id || typeof b.text !== 'string' || !b.text.trim())
        throw Error('Expected message and stable ID')
      this.domain.engine.receive(terminalTrigger(b.id, b.text, this.config.actor))
      return { trigger: b.id, thread: 'terminal:default' }
    }
    if (action === 'grant' || action === 'revoke') {
      if (action === 'grant') {
        if (!this.remote) throw Error('Configure a target GitHub repository first')
        await this.remote.verify()
      }
      this.db
        .prepare("INSERT OR REPLACE INTO host_settings VALUES('allow-write',?)")
        .run(action === 'grant' ? 'yes' : 'no')
      return { repository: this.config.repository, remoteWrites: action === 'grant' }
    }
    if (action === 'reassess') {
      const id = String(b.trigger ?? '')
      this.sleeping.delete(MAIN)
      return { trigger: id, queued: this.domain.engine.reevaluate(id) }
    }
    if (action === 'role-model') {
      if (!['main', 'worker'].includes(String(b.role)) || typeof b.model !== 'string' || b.model.length > 128)
        throw Error('Expected role and model name')
      this.db.prepare('INSERT OR REPLACE INTO host_settings VALUES(?,?)').run('model:' + b.role, b.model)
      return { role: b.role, newSessionModel: b.model || 'default' }
    }
    if (action === 'events') {
      const after = Number(b.after ?? 0)
      if (!Number.isSafeInteger(after) || after < 0) throw Error('Invalid event cursor')
      return this.db
        .prepare('SELECT rowid AS seq,* FROM host_messages WHERE rowid>? ORDER BY rowid LIMIT 100')
        .all(after)
    }
    if (action === 'status')
      return {
        repo: this.config.repository,
        thread: 'terminal:default',
        tickets: this.domain.store.tickets.list().map((t) => ({
          id: t.id,
          title: t.title,
          status:
            t.ended?.outcome ??
            (this.supervision.isPaused(t.id)
              ? 'paused'
              : (t.assignments.at(-1)?.report?.state ?? t.assignments.at(-1)?.state)),
          attention: t.attention?.question,
        })),
        messages: this.db.prepare('SELECT * FROM host_messages ORDER BY rowid DESC LIMIT 40').all(),
        faults: this.db.prepare('SELECT * FROM host_faults').all(),
        mainTokens: this.supervision.usage(),
        occupied: this.supervision.occupied(),
        remoteWrites: this.setting('allow-write') === 'yes',
      }
    if (action === 'trace') {
      const id = String(b.trigger ?? ''),
        store = this.domain.store,
        trigger = store.triggers.get(id)
      if (!trigger) throw Error('Unknown Trigger')
      const disposition = store.triggers.disposition(id)
      const decisions = store.decisions.byThread('terminal:default').filter((d) => d.triggerIds.includes(id))
      const tickets = store.tickets
        .list()
        .filter((t) => t.origin.triggerIds.includes(id) || disposition?.fanout.includes(t.id))
        .map((t) => ({
          id: t.id,
          mandate: t.mandate,
          assignments: t.assignments,
          ended: t.ended,
          history: this.db
            .prepare(
              "SELECT entity,value FROM domain_history WHERE entity_id=? AND entity IN ('report','attention') ORDER BY seq",
            )
            .all(t.id)
            .map((row) => ({ ...row, value: JSON.parse(String(row.value)) })),
          deliveries: this.delivery
            ? this.db
                .prepare('SELECT commit_sha,push_state,pr,done FROM remote_ops WHERE ticket=? ORDER BY rowid')
                .all(t.id)
            : [],
          tests: this.supervision.tests(t.id),
        }))
      return {
        trigger,
        disposition,
        decisions,
        tickets,
        channel: this.db
          .prepare(
            'SELECT rowid AS seq,* FROM host_messages WHERE ticket IN (SELECT value FROM json_each(?)) ORDER BY rowid',
          )
          .all(JSON.stringify(tickets.map((t) => t.id))),
      }
    }
    const id = String(b.ticket ?? ''),
      t = this.domain.store.tickets.get(id)
    if (!t) throw Error('Unknown Ticket')
    if (action === 'show')
      return {
        ticket: t,
        session: this.binding(id),
        environments: this.db.prepare('SELECT * FROM host_environment WHERE ticket=? ORDER BY seq').all(id),
        tests: this.supervision.tests(id),
        tokens: this.supervision.usage(id),
        pulls: this.delivery
          ? this.db.prepare('SELECT number,settled FROM tracked_pr WHERE ticket=?').all(id)
          : [],
        deliveries: this.delivery
          ? this.db.prepare('SELECT commit_sha,push_state,pr,done FROM remote_ops WHERE ticket=?').all(id)
          : [],
        deniedTargets: (await this.live.get(id)?.environment?.deniedTargets()) ?? [],
        runs: this.db.prepare('SELECT id,turn,state,attempt FROM host_turns WHERE owner=?').all(id),
      }
    if (action === 'track-pr') {
      const n = Number(b.pr)
      if (!this.remote || !Number.isSafeInteger(n) || n <= 0 || t.ended)
        throw Error('An open Ticket and a valid PR number are required')
      const pull = await this.remote.read(n)
      if (pull.repo !== this.config.repository || pull.number !== n) throw Error('Foreign pull request')
      this.domain.store.atomic(() => {
        const thread = pullRef(this.config.repository, n)
        if (!this.domain.store.tickets.get(id)?.follows?.some((f) => f.thread === 'github:' + thread.id))
          this.domain.engine.bindThread(id, thread, false)
        this.db.prepare('INSERT OR IGNORE INTO tracked_pr(ticket,number) VALUES(?,?)').run(id, n)
      })
      return { ticket: id, tracked: n }
    }
    if (action === 'clear-excerpts') {
      this.supervision.clearExcerpts(id)
      return { cleared: id }
    }
    if (t.ended) throw Error('Ticket ended')
    if (action === 'pause') {
      this.supervision.pause(id)
      await this.interrupt(id)
      return { paused: id }
    }
    if (action === 'resume') {
      this.supervision.resume(id)
      this.clear(id)
      this.sleeping.delete(id)
      if (!this.db.prepare('SELECT 1 FROM host_recovery WHERE owner=?').get(id)) {
        const report = t.assignments.at(-1)?.report
        if (report && ['blocked', 'failed'].includes(report.state)) this.domain.engine.retryTicket(id)
        else
          this.domain.engine.note(id, 'The operator explicitly resumed this work under its existing mandate.')
      }
      return { resumed: id }
    }
    throw Error('Unknown operation')
  }
  private binding(owner: string) {
    return this.db
      .prepare(
        'SELECT host_sessions.*,requestedModel FROM host_sessions LEFT JOIN host_model_choice USING(owner) WHERE owner=?',
      )
      .get(owner) as unknown as SessionRow | undefined
  }
  private async session(owner: string): Promise<Live> {
    const live = this.live.get(owner)
    if (live) return live
    const opening = this.preparing.get(owner)
    if (opening) return opening
    const p = this.open(owner).finally(() => this.preparing.delete(owner))
    this.preparing.set(owner, p)
    return p
  }
  private async open(owner: string): Promise<Live> {
    const main = owner === MAIN,
      cfg = this.config,
      existing = this.binding(owner),
      retained = this.disconnected.get(owner)
    const apiKey = process.env[cfg.modelKeyEnv]
    if (!apiKey) throw Error('Model service credential unavailable: ' + cfg.modelKeyEnv)
    let environment: Environment | undefined,
      workspace: Workspace | undefined,
      session: CodexSession | undefined
    const serviceHome = join(this.dir, 'main-service'),
      mainCwd = join(this.dir, 'main-cwd')
    mkdirSync(mainCwd, { recursive: true, mode: 0o700 })
    mkdirSync(serviceHome, { recursive: true, mode: 0o700 })
    const saved = this.setting('model:' + (main ? 'main' : 'worker'))
    const override =
      saved === undefined ? (main ? cfg.mainModel : cfg.workerModel) : String(saved) || undefined
    const model = existing
      ? (existing.model ?? existing.requestedModel ?? undefined)
      : (override ?? (cfg.provider === 'deepseek' ? 'deepseek-flash' : undefined))
    try {
      if (retained?.environment) {
        workspace = retained.workspace
        environment = retained.environment
      } else if (!main) {
        const gh = cfg.github
        const gitEnv = gh
          ? {
              GH_CONFIG_DIR: gh.configDir,
              GH_HOST: 'github.com',
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
              GIT_CONFIG_VALUE_0: '!' + "'" + gh.gh.replaceAll("'", "'\\''") + "'" + ' auth git-credential',
            }
          : {}
        workspace = await prepareTicket({
          ticketId: owner,
          repoDir: cfg.repoDir,
          stateDir: this.dir,
          prepare: cfg.prepare,
          gitEnv,
        })
        environment = await openTicketRuntime({
          workspace,
          stateDir: this.dir,
          image: cfg.image,
          apiKey,
          allow: cfg.allow,
          requireHistory: !!existing,
          providerBaseUrl:
            cfg.provider === 'deepseek' ? 'https://api.deepseek.com/' : 'https://api.openai.com/v1',
        })
      }
      const homeEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: serviceHome,
        CODEX_HOME: serviceHome,
        LANG: 'C.UTF-8',
        [cfg.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY']: apiKey,
      }
      if (main && !this.mainTransport) {
        this.mainTransport = await openMainTransport({
          bin: cfg.codex,
          cwd: mainCwd,
          env: homeEnv,
          args: cfg.provider === 'deepseek' ? deepseekArgs(model) : ['app-server', '--stdio'],
        })
      }
      const launcher = environment ? environment.appServer() : this.mainTransport!.descriptor
      session = await CodexSession.connect({
        ...launcher,
        role: main ? 'main' : 'worker',
        ticketId: main ? undefined : owner,
        onReplay: (c, a) => this.tools.replay(c, a),
        onTool: async (c, a) => {
          try {
            return await this.tools.call(c, a)
          } catch (e) {
            this.fault(owner, e)
            return {
              accepted: false,
              reason: this.db.prepare('SELECT message FROM host_faults WHERE owner=?').get(owner)?.message,
            }
          }
        },
        onEvent: (e) => this.event(owner, e),
      })
      const opts = {
        cwd: main ? mainCwd : '/workspace',
        model,
        instructions: main ? MAIN_INSTRUCTIONS : WORKER_INSTRUCTIONS,
      }
      let active: { turnId: string; assignmentId: string } | undefined
      if (existing && this.db.prepare('SELECT 1 FROM host_recovery WHERE owner=?').get(owner)) {
        const history = await session.readThread(existing.thread, true)
        const turns = Array.isArray(history.turns) ? history.turns : []
        for (const turn of turns.filter((t) => t.status === 'inProgress')) {
          const attempts = this.db
            .prepare("SELECT * FROM host_turns WHERE owner=? AND state IN ('active','prepared')")
            .all(owner) as unknown as Call[]
          const row = attempts.find(
            (r) =>
              r.turn === turn.id ||
              turn.items?.some(
                (i: { clientId?: string }) => i.clientId === key('turn-input', r.id, String(r.attempt)),
              ),
          )
          if (!row || active) throw Error('Unidentified active turn; recovery blocked')
          active = { turnId: turn.id, assignmentId: row.assignment }
        }
      }
      const opened = existing
        ? await session.resumeThread({ ...opts, threadId: existing.thread, active })
        : await session.startThread(opts)
      this.db
        .prepare('INSERT OR IGNORE INTO host_sessions VALUES(?,?,?,?)')
        .run(owner, opened.threadId, opened.model ?? null, override ? 'role override' : 'runtime default')
      if (!existing) this.db.prepare('INSERT INTO host_model_choice VALUES(?,?)').run(owner, model ?? null)
      if (environment && workspace)
        this.db
          .prepare(
            'INSERT INTO host_environment(ticket,assignment,imageRef,imageId,codexVersion,directory,branch,baseBranch,baseCommit) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            owner,
            this.domain.store.tickets.get(owner)?.assignments.at(-1)?.id ?? null,
            cfg.image,
            environment.imageId,
            environment.codexVersion,
            workspace.directory,
            workspace.branch ?? null,
            workspace.baseBranch ?? null,
            workspace.baseCommit ?? null,
          )
      const result = { session, environment, workspace }
      this.live.set(owner, result)
      if (!this.reconciling.has(owner)) this.disconnected.delete(owner)
      return result
    } catch (e) {
      await session?.close().catch(() => {})
      if (!retained) await environment?.close().catch(() => {})
      throw e
    }
  }
  private async interrupt(owner: string) {
    const session = this.live.get(owner)?.session
    if (!session) return
    const sent = await session.interrupt()
    if (sent) {
      let deadline: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          session.waitForCompletion(sent.turnId),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(Error('Turn interruption needs reconciliation')), 30000)
          }),
        ])
      } catch (e) {
        this.db.prepare('INSERT OR IGNORE INTO host_recovery VALUES(?)').run(owner)
        throw e
      } finally {
        clearTimeout(deadline)
      }
    }
  }
  private async tree(w: Workspace) {
    if (!w.gitDir) return { commit: 'unversioned', dirty: true, tree: null }
    const ref = refFor(w),
      dir = mkdtempSync(join(this.dir, 'index-')),
      index = join(dir, 'index')
    try {
      const commit = await localGit(ref, ['rev-parse', 'HEAD'])
      await localGit(ref, ['read-tree', commit], index)
      await localGit(ref, ['add', '--all', '--', '.'], index)
      const tree = await localGit(ref, ['write-tree'], index)
      return { commit, dirty: tree !== (await localGit(ref, ['rev-parse', commit + '^{tree}'])), tree }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  private async launchTest(id: string, c: ToolContext, command: string) {
    const ticket = c.ticketId!,
      w = this.live.get(ticket)
    if (!w?.environment || !w.workspace) throw Error('Missing Ticket environment')
    const previous = this.supervision.tests(ticket).find((r) => r.id === id)
    if (previous) return { run: id, status: previous.status }
    const version = await this.tree(w.workspace)
    if (!this.valid(c)) throw Error('Stale test request')
    if (
      !this.supervision.startTest({
        id,
        ticketId: ticket,
        assignmentId: c.assignmentId,
        command,
        commit: version.commit,
        dirty: version.dirty,
        image: w.environment.imageId,
      })
    )
      return { run: id }
    this.db.prepare('INSERT OR IGNORE INTO host_test_tree VALUES(?,?,?)').run(id, ticket, version.tree)
    const abort = new AbortController()
    const done = w.environment
      .runTest(command, abort.signal)
      .then(async (result) => {
        const changed = version.tree !== null && (await this.tree(w.workspace!)).tree !== version.tree
        const status = abort.signal.aborted
          ? abort.signal.reason === 'timeout'
            ? 'timeout'
            : 'interrupted'
          : changed
            ? 'unknown'
            : result.code === 0
              ? 'passed'
              : result.code === null
                ? 'unknown'
                : 'failed'
        this.supervision.finishTest(id, {
          status,
          exitCode: result.code,
          output: result.output,
          truncated: result.truncated,
        })
      })
      .catch((e) => {
        this.supervision.finishTest(id, {
          status: abort.signal.aborted
            ? abort.signal.reason === 'timeout'
              ? 'timeout'
              : 'interrupted'
            : 'unknown',
          output: asError(e),
        })
      })
      .finally(() => this.tests.delete(id))
    this.tests.set(id, { abort, done })
    return {
      run: id,
      status: 'running',
      next: 'End this turn; the host sends the test result when it finishes.',
    }
  }
  private async deliver(id: string, c: ToolContext, args: DeliveryRequest) {
    const t = this.domain.store.tickets.get(c.ticketId!)!,
      w = this.live.get(t.id)?.workspace
    if (!this.delivery || !w) throw Error('Remote delivery not configured')
    const request = {
      ...args,
      title: args.title || t.title,
      body: args.body ?? '',
      draft: args.draft ?? true,
    }
    try {
      return await this.delivery.deliver(id, refFor(w), request, () => {
        if (!this.valid(c)) throw Error('Stale remote request')
      })
    } catch (e) {
      if (
        this.valid(c) &&
        /authorization|identity mismatch|permission mismatch|HTTP 40[13]/i.test(asError(e))
      ) {
        this.fault(t.id, e)
        this.domain.engine.report(t.id, {
          state: 'blocked',
          summary: 'Remote delivery requires current authorization.',
          question: 'Please verify the bound account and repository authorization before resuming.',
        })
        this.supervision.pause(t.id)
        queueMicrotask(() => void this.interrupt(t.id).catch((reason) => this.fault(t.id, reason)))
      }
      throw e
    }
  }
  private async ready(c: ToolContext, n: number) {
    if (
      !this.remote ||
      !this.db.prepare('SELECT 1 FROM tracked_pr WHERE ticket=? AND number=?').get(c.ticketId!, n)
    )
      return false
    const workspace = this.live.get(c.ticketId!)?.workspace
    if (!workspace) return false
    const p = await this.remote.read(n),
      ref = refFor(workspace),
      current = await this.tree(workspace)
    if (
      p.author !== this.config.github?.account ||
      p.branch !== ref.branch ||
      p.base !== ref.base ||
      p.repo !== this.config.repository ||
      p.headRepo !== p.repo ||
      p.draft ||
      current.dirty ||
      p.commit !== current.commit
    )
      return false
    const all = this.supervision.tests(c.ticketId!)
    const checked = all.filter((r) =>
      this.db.prepare('SELECT 1 FROM host_test_tree WHERE id=? AND tree=?').get(r.id, current.tree),
    )
    const latest = new Map(checked.map((r) => [r.command, r]))
    return (
      !all.some((r) => r.status === 'running') &&
      latest.size > 0 &&
      [...latest.values()].every((r) => r.status === 'passed')
    )
  }
  private event(owner: string, e: SessionEvent) {
    if (!this.binding(owner)) return
    if (e.type === 'usage') {
      this.supervision.recordUsage({
        role: owner === MAIN ? 'main' : 'worker',
        ticketId: owner === MAIN ? undefined : owner,
        threadId: e.threadId,
        turnId: e.turnId,
        total: e.totalTokens,
      })
    } else if (e.type === 'started') {
      const r = this.db
        .prepare(
          "SELECT * FROM host_turns WHERE owner=? AND assignment=? AND state='prepared' ORDER BY rowid DESC LIMIT 1",
        )
        .get(owner, e.assignmentId) as unknown as Call
      if (!r) throw Error('Turn started without a persisted dispatch')
      this.domain.store.atomic(() => {
        this.db.prepare("UPDATE host_turns SET state='active',turn=? WHERE id=?").run(e.turnId, r.id)
        if (owner === MAIN) this.domain.engine.candidateDelivered(e.assignmentId)
        else {
          if (this.domain.store.tickets.get(owner)?.assignments.at(-1)?.state === 'pending')
            this.domain.engine.assignmentStarted(owner, e.assignmentId)
          this.supervision.turnStarted(owner, e.assignmentId, e.turnId)
          const ids = JSON.parse(r.ids)
          this.domain.engine.inputsDelivered(owner, e.assignmentId, ids)
          this.domain.engine.inputsRead(owner, ids)
        }
      })
    } else if (e.type === 'completed') {
      const r = this.db
        .prepare('SELECT * FROM host_turns WHERE owner=? AND turn=?')
        .get(owner, e.turnId) as unknown as Call | undefined
      if (!r) return
      this.domain.store.atomic(() => {
        this.db.prepare('UPDATE host_turns SET state=? WHERE id=?').run(e.status, r.id)
        if (owner !== MAIN) {
          this.supervision.turnEnded(owner, e.assignmentId, e.turnId)
          this.domain.engine.turnEnded(owner, e.assignmentId)
        }
        if (e.status === 'failed') this.failedAttempt(r, e.errorCode ?? 'Model turn failed')
      })
    } else if (e.type === 'disconnected' && !this.stop && this.live.has(owner)) {
      this.db.prepare('INSERT OR IGNORE INTO host_recovery VALUES(?)').run(owner)
      this.fault(owner, 'App Server disconnected; checking persisted session before any replay.')
      const old = this.live.get(owner)
      this.live.delete(owner)
      // Only the adapter connection was lost. Keep the original ticket environment and its background jobs.
      if (old) this.disconnected.set(owner, old)
    }
  }
  private failedAttempt(r: Call, reason: string) {
    this.fault(r.owner, 'Attempt ' + (r.attempt + 1) + ': ' + reason)
    if (
      r.owner !== MAIN &&
      retryable.has(reason) &&
      r.attempt < intervals.length &&
      !this.stop &&
      !this.supervision.isPaused(r.owner)
    ) {
      this.db
        .prepare("UPDATE host_turns SET state='retry',attempt=attempt+1,due=? WHERE id=?")
        .run(Date.now() + intervals[r.attempt], r.id)
      return
    }
    this.db.prepare("UPDATE host_turns SET state='failed' WHERE id=?").run(r.id)
    if (r.owner === MAIN) {
      const evalRecord = this.domain.store.threads
        .active()
        .find((t) => t.evaluating?.id === r.assignment)?.evaluating
      if (evalRecord)
        this.domain.engine.decide(evalRecord.primary ?? evalRecord.triggerIds[0], {
          kind: 'unavailable',
          evalId: r.assignment,
          reason,
        })
    } else if (this.domain.store.tickets.get(r.owner)?.assignments.at(-1)?.id === r.assignment) {
      this.domain.engine.report(r.owner, {
        state: 'failed',
        summary: reason,
        question: 'Please check the model or service configuration before resuming.',
      })
      this.supervision.pause(r.owner)
    }
  }
  private async run(r: Call, live: Live) {
    if (this.stop || (r.owner !== MAIN && this.supervision.isPaused(r.owner))) return
    this.db.prepare("UPDATE host_turns SET state='prepared',turn=NULL WHERE id=?").run(r.id)
    try {
      await live.session.startTurn({
        assignmentId: r.assignment,
        text:
          r.text +
          (r.owner === MAIN
            ? ''
            : '\nRecent failure evidence (untrusted data): ' +
              JSON.stringify(
                this.supervision
                  .tests(r.owner)
                  .slice(-3)
                  .filter((t) => t.excerpt)
                  .map((t) => ({ id: t.id, excerpt: t.excerpt })),
              )),
        inputId: key('turn-input', r.id, String(r.attempt)),
      })
    } catch (e) {
      // A broken connection may have lost an acknowledgement after the remote side accepted the input.
      if (e instanceof ConnectionLost) {
        this.db.prepare('INSERT OR IGNORE INTO host_recovery VALUES(?)').run(r.owner)
        throw e
      }
      const code = e instanceof RpcError ? errorCode(e.data) : 'unknown'
      const reason =
        code !== 'unknown'
          ? code
          : e instanceof RpcError &&
              (e.code === -32001 || /overloaded|temporarily unavailable/i.test(e.message))
            ? 'serverOverloaded'
            : asError(e)
      this.domain.store.atomic(() => {
        if (r.owner !== MAIN) this.supervision.release(r.owner, r.assignment)
        this.failedAttempt(r, reason)
      })
    }
  }
  private waiting(owner: string) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM host_turns WHERE owner=? AND state IN ('active','prepared','retry')")
        .get(owner),
    )
  }
  private async dispatch(effect: Effect): Promise<'defer' | void> {
    if (this.stop) return 'defer'
    if (effect.kind === 'send') {
      this.db
        .prepare('INSERT OR IGNORE INTO host_messages VALUES(?,?,?,?)')
        .run(effect.id, effect.message.text, effect.message.ticketId ?? null, effect.message.kind)
      return
    }
    const main = effect.kind === 'assess',
      owner = main ? MAIN : effect.ticketId,
      assignment = main ? effect.candidate.evalId : effect.assignmentId
    if (effect.kind === 'stop') {
      const run = this.db
        .prepare("SELECT 1 FROM host_turns WHERE owner=? AND assignment=? AND state='active'")
        .get(owner, assignment)
      if (run) await this.interrupt(owner)
      this.supervision.release(owner, assignment)
      if (this.domain.store.tickets.get(owner)?.ended) await this.drop(owner)
      return
    }
    if (
      this.sleeping.get(owner)! > Date.now() ||
      this.reconciling.has(owner) ||
      this.db.prepare('SELECT 1 FROM host_recovery WHERE owner=?').get(owner)
    )
      return 'defer'
    if (this.db.prepare("SELECT 1 FROM host_turns WHERE id=? AND state NOT IN ('prepared')").get(effect.id))
      return
    if (this.waiting(owner)) return 'defer'
    let t: Ticket | undefined
    let ids: string[] = []
    let text: string
    if (effect.kind === 'assess') {
      if (this.domain.store.threads.get(effect.candidate.thread.key)?.evaluating?.id !== assignment) return
      text =
        'Evaluate this pending Candidate. Use orchestrator_read then orchestrator_route. ' +
        JSON.stringify({
          eval: assignment,
          triggers: effect.candidate.triggers.map((i) => ({ id: i.id, text: i.text })),
          tickets: effect.candidate.tickets.map((i) => ({
            id: i.id,
            title: i.title,
            scope: i.mandate.scope,
          })),
        })
    } else {
      t = this.domain.store.tickets.get(owner)
      if (!t || t.ended || t.assignments.at(-1)?.id !== assignment) return
      ids = t.undelivered
      if (effect.kind === 'deliver' && !ids.length) return
      const items = t.inputs
        .filter((i) => ids.includes(i.id))
        .map((i) => ({
          ...i,
          ...('triggerId' in i ? { original: this.domain.store.triggers.get(i.triggerId)?.text } : {}),
        }))
      const reason =
        effect.kind === 'start'
          ? 'start'
          : items.some((i) => i.kind === 'trigger' && i.human && !i.context)
            ? 'human'
            : 'event'
      if (!this.supervision.reserve(owner, assignment, reason)) return 'defer'
      const runs = this.supervision.tests(owner)
      text = JSON.stringify({
        assignment,
        ticket: owner,
        mandate: t.mandate,
        origin: this.domain.store.triggers.get(t.origin.triggerId)?.text,
        delivery: this.delivery
          ? this.db
              .prepare(
                'SELECT commit_sha,pr,done,push_state FROM remote_ops WHERE ticket=? ORDER BY rowid DESC LIMIT 3',
              )
              .all(owner)
          : [],
        task:
          effect.kind === 'start'
            ? 'Begin or recover the authorized assignment.'
            : 'Decide each new input within the mandate.',
        inputs: items,
        recentTests: runs
          .slice(-5)
          .map((r) => ({ id: r.id, command: r.command, status: r.status, exitCode: r.exitCode })),
      })
    }
    try {
      const live = await this.session(owner)
      if (
        this.stop ||
        (!main &&
          (this.supervision.isPaused(owner) ||
            this.domain.store.tickets.get(owner)?.assignments.at(-1)?.id !== assignment))
      ) {
        if (!main) this.supervision.release(owner, assignment)
        return 'defer'
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO host_turns(id,owner,assignment,ids,text,state) VALUES(?,?,?,?,?,'prepared')",
        )
        .run(effect.id, owner, assignment, JSON.stringify(ids), text)
      this.clear(owner)
      await this.run(
        this.db.prepare('SELECT * FROM host_turns WHERE id=?').get(effect.id) as unknown as Call,
        live,
      )
    } catch (e) {
      this.fault(owner, e)
      if (!main && !this.waiting(owner)) this.supervision.release(owner, assignment)
      if (!this.waiting(owner) && !this.stop) {
        if (!main) {
          this.domain.engine.report(owner, {
            state: 'blocked',
            summary: 'Ticket environment could not start.',
            question: 'Correct the recorded executor or service error, then resume this Ticket.',
          })
          this.supervision.pause(owner)
        } else if (effect.kind === 'assess') {
          const id = effect.candidate.triggers[0]?.id
          if (id && this.domain.engine.candidate(id)?.evalId === assignment)
            this.domain.engine.decide(id, {
              kind: 'unavailable',
              evalId: assignment,
              reason: 'Main service unavailable. Inspect host status and reassess this Trigger.',
            })
        }
      }
      this.sleeping.set(owner, Date.now() + 60000)
      return 'defer'
    }
  }
  private async drop(owner: string) {
    const old = this.live.get(owner)
    if (!old) return
    this.live.delete(owner)
    await old.session.close()
    await old.environment?.close()
  }
  private async observe(owner: string, threadId: string, history: { id?: unknown; turns?: unknown[] }) {
    return observeDispatch(this.domain, owner, history, {
      started: (turnId, assignmentId) =>
        this.event(owner, { type: 'started', threadId, turnId, assignmentId }),
      ended: (e) => this.event(owner, e),
    })
  }
  private async recover(owner: string) {
    if (this.reconciling.has(owner) || this.sleeping.get(owner)! > Date.now()) return
    this.reconciling.add(owner)
    try {
      const { recoverOwner } = await import('./recovery.ts')
      const read = async (thread: string) => {
        const l = await this.session(owner),
          history = await l.session.readThread(thread, true)
        if (!Array.isArray(history.turns)) throw Error('Missing Codex turn history')
        return { ...history, turns: history.turns }
      }
      if (this.disconnected.has(owner)) {
        const thread = this.binding(owner)?.thread
        if (!thread) throw Error('Disconnected session has no verified thread')
        const history = await read(thread)
        const result = await this.observe(owner, thread, history)
        if (result === 'observing') this.observing.set(owner, Date.now() + 1000)
        this.disconnected.delete(owner)
        this.db.prepare('DELETE FROM host_recovery WHERE owner=?').run(owner)
        this.clear(owner)
        return
      }
      await recoverOwner(
        this.domain,
        owner,
        read,
        async (turn, assignment) => {
          const l = await this.session(owner)
          const stopped = await l.session.interrupt()
          if (!stopped || stopped.turnId !== turn) throw Error('Old turn is not attached: ' + assignment)
          await l.session.waitForCompletion(turn)
        },
        owner !== MAIN && this.supervision.isPaused(owner),
      )
      this.clear(owner)
    } catch (e) {
      this.fault(owner, e)
      this.sleeping.set(owner, Date.now() + 60000)
    } finally {
      this.reconciling.delete(owner)
    }
  }
  private async sweep() {
    // When the host owns a new lock, old managed tests must be terminated or confirmed
    // before recording a result. Runtime reconstruction reaps its prior containers.
    for (const r of this.db.prepare('SELECT owner FROM host_recovery ORDER BY rowid').all()) {
      if (this.stop) return
      await this.recover(String(r.owner))
    }
    if (this.stop) return
    for (const [owner, due] of this.observing) {
      const live = this.live.get(owner),
        thread = this.binding(owner)?.thread
      if (!live || !thread || !this.waiting(owner)) {
        this.observing.delete(owner)
        continue
      }
      if (Date.now() < due) continue
      this.observing.set(owner, Date.now() + 2000)
      try {
        const history = await live.session.readThread(thread, true)
        const result = await this.observe(owner, thread, { ...history, turns: history.turns as unknown[] })
        if (result !== 'observing') {
          this.observing.delete(owner)
          // Drop the completed transport binding. Any running tests still belong to the retained container.
          this.live.delete(owner)
          this.disconnected.set(owner, live)
          await live.session.close()
        }
      } catch (e) {
        this.fault(owner, e)
      }
    }
    this.supervision.flushFeedback()
    this.supervision.reconcile()
    for (const id of this.supervision.overdueTests()) this.tests.get(id)?.abort.abort('timeout')
    this.domain.engine.evaluateDue()
    for (const r of this.db
      .prepare("SELECT * FROM host_turns WHERE state='retry' AND due<=? ORDER BY due")
      .all(Date.now()) as unknown as Call[]) {
      if (this.stop || this.db.prepare('SELECT 1 FROM host_recovery WHERE owner=?').get(r.owner)) continue
      if (r.owner === MAIN) {
        if (!this.domain.store.threads.active().some((t) => t.evaluating?.id === r.assignment)) {
          this.db.prepare("UPDATE host_turns SET state='interrupted' WHERE id=?").run(r.id)
          continue
        }
        try {
          await this.run(r, await this.session(MAIN))
        } catch (e) {
          this.fault(MAIN, e)
        }
        continue
      }
      const t = this.domain.store.tickets.get(r.owner)
      if (!t || t.ended || t.assignments.at(-1)?.id !== r.assignment) {
        this.db.prepare("UPDATE host_turns SET state='interrupted' WHERE id=?").run(r.id)
        continue
      }
      if (this.supervision.isPaused(t.id)) continue
      if (this.supervision.reserve(r.owner, r.assignment, 'event')) {
        try {
          await this.run(r, await this.session(r.owner))
        } catch (e) {
          this.fault(r.owner, e)
        }
      }
    }
    await this.domain.drain((e) => this.dispatch(e)).catch((error) => this.fault('effects', error))
    if (this.delivery && !this.stop) {
      try {
        if (await this.delivery.poll()) this.clear('github-poll')
      } catch (e) {
        this.fault('github-poll', e)
      }
      if ((this.sleeping.get('deliveries') ?? 0) <= Date.now()) await this.reconcileDeliveries()
    }
  }
  private async reconcileDeliveries() {
    this.sleeping.set('deliveries', Date.now() + 60000)
    if (!this.delivery) return
    for (const op of this.delivery.pending()) {
      const ticket = String(op.ticket)
      if (this.reconciling.has(ticket)) continue
      try {
        await this.delivery.deliver(
          String(op.call),
          JSON.parse(String(op.ref)),
          JSON.parse(String(op.request)),
        )
      } catch (e) {
        this.fault(ticket, e)
      }
    }
  }
  tick() {
    if (this.stop) return Promise.resolve()
    if (!this.working)
      this.working = this.sweep()
        .catch((e) => this.fault('runtime', e))
        .finally(() => {
          this.working = undefined
        })
    return this.working
  }
  async close() {
    if (this.stop) return
    this.stop = true
    clearInterval(this.timer)
    for (const x of this.tests.values()) x.abort.abort('shutdown')
    await Promise.allSettled([...this.tests.values()].map((x) => x.done))
    await this.working
    await Promise.allSettled([...this.live.keys()].map((owner) => this.interrupt(owner)))
    await Promise.allSettled([...this.live.keys()].map((owner) => this.drop(owner)))
    await Promise.allSettled(
      [...this.disconnected.values()].map(async (l) => {
        await l.session.close()
        await l.environment?.close()
      }),
    )
    await this.mainTransport?.close()
    this.domain.close()
  }
}
