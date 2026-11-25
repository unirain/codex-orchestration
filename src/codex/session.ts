import { ConnectionLost, object, RpcError, StdioRpc, stringField } from './transport.ts'
import type { ObjectValue, ProcessOptions } from './transport.ts'
import { roleTools } from './tools.ts'
import type { Role, ToolSpec } from './tools.ts'

export { ConnectionLost, RpcError }
export type { ToolSpec }

export interface ToolContext {
  role: Role
  ticketId?: string
  assignmentId: string
  threadId: string
  turnId: string
  callId: string
  tool: string
}

export type ReplayContext = Omit<ToolContext,'assignmentId'>
export interface SavedReply { value: unknown }

export type TurnStatus = 'completed' | 'failed' | 'interrupted'
export interface Completion {
  type: 'completed'
  threadId: string
  turnId: string
  assignmentId: string
  status: TurnStatus
  errorCode?: string
}
export type SessionEvent = Completion
  | { type: 'started', threadId: string, turnId: string, assignmentId: string }
  | { type: 'usage', threadId: string, turnId: string, totalTokens: number }
  | { type: 'error', threadId: string, turnId: string, errorCode: string, willRetry: boolean }
  | { type: 'disconnected', threadId?: string }

export interface SessionOptions extends ProcessOptions {
  role: Role
  ticketId?: string
  /** Set by the trusted isolated ticket launcher after its filesystem, process
   * and network boundaries are in force; never sourced from tool arguments. */
  externallySandboxed?: true
  tools?: ToolSpec[]
  /** The host validates the current Assignment and commits a durable, idempotent
   * result, keyed by threadId + turnId + callId, before returning. */
  onTool(context: ToolContext, args: ObjectValue): Promise<unknown>
  /** Read-only lookup for known, completed calls from an earlier connection. */
  onReplay?(context: ReplayContext, args: ObjectValue): Promise<SavedReply | undefined> | SavedReply | undefined
  /** Synchronous binding/receipt persistence before subsequent callbacks. */
  onEvent?(event: SessionEvent): void
}
interface OpenThread {
  cwd: string
  model?: string
  instructions?: string
}
interface Binding {
  assignmentId: string
  turnId: string
  frozen: boolean
}
interface ToolReply {
  success: boolean
  contentItems: Array<{type: 'inputText', text: string}>
}
function reply(value: unknown, success: boolean): ToolReply {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return { success, contentItems: [{ type: 'inputText', text }] }
}

/** Classify by protocol identifier. Never copy provider messages containing
 * credentials, request bodies, or project data into persistent event records. */
export function errorCode(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown'
  const info = (value as ObjectValue).codexErrorInfo
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') {
    const [name] = Object.keys(info)
    const details = (info as ObjectValue)[name] as ObjectValue | null
    const http = details?.httpStatusCode
    if (http === 401 || http === 403) return 'unauthorized'
    if (http === 429) return 'rateLimitExceeded'
    return name ?? 'unknown'
  }
  return 'unknown'
}

export class CodexSession {
  private rpc: StdioRpc
  private options: SessionOptions
  private tools: ToolSpec[]
  private binding?: Binding
  private opening = false
  private resumingThread?: string
  private starting?: Promise<{threadId: string, turnId: string}>
  private earlyEvents: Array<{method: string, params: ObjectValue}> = []
  private disconnected = false
  private completions = new Map<string, Completion>()
  private waiting = new Map<string, ReturnType<typeof Promise.withResolvers<Completion>>>()
  private calls = new Map<string, { signature: string, result: Promise<ToolReply> }>()
  threadId?: string
  model?: string
  initialized?: ObjectValue

  private constructor(options: SessionOptions) {
    if (options.externallySandboxed && options.role !== 'worker') throw new Error('External sandbox requires an isolated Worker')
    if (options.role === 'worker' && !options.ticketId) throw new Error('Worker requires a Ticket binding')
    this.options = options
    const allowed = roleTools[options.role]
    this.tools = options.tools ?? allowed
    if (this.tools.some(t => !allowed.some(a => a.name === t.name))) throw new Error('Tool unavailable to this role')
    this.rpc = new StdioRpc(options, {
      onRequest: (method, params) => this.serverRequest(method, params),
      onNotification: (method, params) => this.notification(method, params),
      onDisconnect: error => {
        this.disconnected = true
        for (const waiter of this.waiting.values()) waiter.reject(error)
        this.waiting.clear()
        this.options.onEvent?.({ type: 'disconnected', threadId: this.threadId })
      },
    })
  }

  static async connect(options: SessionOptions): Promise<CodexSession> {
    const session = new CodexSession(options)
    try {
      session.initialized = object(await session.rpc.request('initialize', {
        clientInfo: { name: 'codex-orchestration', title: 'Local ticket orchestrator', version: '0.1' },
        capabilities: { experimentalApi: true },
      }))
      // The Main runs on the host. Verify the build whose actual provider tool
      // catalog passed our main-only capabilities test, before opening a thread.
      if (options.role === 'main') {
        const agent = session.initialized.userAgent
        const version = typeof agent === 'string' ? /^codex-orchestration\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(agent)?.[1] : undefined
        if (version !== '0.171.0') throw new Error('Main requires tested Codex App Server 0.171.0; found ' + (version ?? 'unidentified build'))
      }
      session.rpc.notify('initialized')
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }

  async startThread(params: OpenThread) { return this.openThread(params) }
  /** Pass the stored model (when known), rather than current role defaults. */
  async resumeThread(params: OpenThread & {threadId: string, active?: {turnId: string, assignmentId: string}}) {
    return this.openThread(params, params.threadId, params.active)
  }

  private async openThread(params: OpenThread, existing?: string, expectedActive?: {turnId: string, assignmentId: string}) {
    if (this.threadId || this.opening) throw new Error('One binding per connection')
    this.opening = true
    this.resumingThread = existing
    const main = this.options.role === 'main'
    try {
      const result = object(await this.rpc.request(existing ? 'thread/resume' : 'thread/start', {
        cwd: params.cwd, model: params.model, developerInstructions: params.instructions,
        approvalPolicy: 'never', sandbox: main ? 'read-only' : 'workspace-write',
        config: main ? {
          features: {shell_tool:false, unified_exec:false, view_image:false, goals:false,
            multi_agent:false, multi_agent_v2:false, image_generation:false, code_mode:false},
          web_search: 'disabled',
        } : {},
        ...(existing ? {threadId: existing} : { allowProviderModelFallback: false, ephemeral: false, historyMode: 'legacy',
          ...(main ? {environments: []} : {}),
          dynamicTools: this.tools.map(tool => ({ type: 'function', ...tool })) }),
      }))
      const thread = object(result.thread)
      const threadId = stringField(thread, 'id')
      if (existing && threadId !== existing) throw new Error('App Server resumed an unexpected thread')
      const turns: ObjectValue[] = Array.isArray(thread.turns) ? thread.turns.map(object) : []
      const active = turns.filter(turn => turn.status === 'inProgress')
      if (active.length || (thread.status && object(thread.status).type === 'active')) {
        if (!expectedActive || active.length !== 1 || active[0].id !== expectedActive.turnId)
          throw new Error('Existing turn is still active; reconcile before resume')
        this.binding = {...expectedActive, frozen: false}
      }
      this.threadId = threadId
      this.model = typeof result.model === 'string' ? result.model : undefined
      for (const event of this.earlyEvents.splice(0)) this.processEvent(event.method, event.params)
      return { threadId, model: this.model }
    } finally {
      this.opening = false
      this.resumingThread = undefined
      this.earlyEvents = []
    }
  }

  async readThread(threadId = this.threadId, includeTurns = true): Promise<ObjectValue> {
    if (!threadId || this.threadId && threadId !== this.threadId) throw new Error('Invalid thread binding')
    const result = object(await this.rpc.request('thread/read', {threadId, includeTurns}))
    if (stringField(result.thread, 'id') !== threadId) throw new Error('Unexpected thread history')
    return object(result.thread)
  }

  startTurn(input: {assignmentId: string, text: string, inputId?: string}): Promise<{threadId: string, turnId: string}> {
    if (!this.threadId || this.starting || this.binding || this.disconnected || !input.assignmentId)
      return Promise.reject(new Error('Session unavailable for a new turn'))
    const threadId = this.threadId
    const starting = this.rpc.request('turn/start', { threadId, clientUserMessageId: input.inputId,
      ...(this.options.externallySandboxed ? { sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } } : {}),
      input: [{ type: 'text', text: input.text, text_elements: [] }] })
      .then(value => {
        const turnId = stringField(object(value).turn, 'id')
        this.binding = { assignmentId: input.assignmentId, turnId, frozen: false }
        this.options.onEvent?.({type: 'started', threadId, turnId, assignmentId: input.assignmentId})
        for (const event of this.earlyEvents.splice(0)) this.processEvent(event.method, event.params)
        return { threadId, turnId }
      }).finally(() => {
        this.earlyEvents = []
        this.starting = undefined
      })
    this.starting = starting
    return starting
  }

  async interrupt() {
    if (this.starting) await this.starting
    if (!this.binding) return
    this.binding.frozen = true
    const turnId = this.binding.turnId
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId })
    return {threadId: this.threadId!, turnId}
  }

  waitForCompletion(turnId: string): Promise<Completion> {
    const completed = this.completions.get(turnId)
    if (completed) return Promise.resolve(completed)
    if (this.disconnected) return Promise.reject(new ConnectionLost('Reconcile the interrupted connection'))
    if (this.binding?.turnId !== turnId) return Promise.reject(new Error('Turn not bound to this session'))
    let waiting = this.waiting.get(turnId)
    if (!waiting) {
      waiting = Promise.withResolvers<Completion>()
      this.waiting.set(turnId, waiting)
    }
    return waiting.promise
  }

  private notification(method: string, params: ObjectValue) {
    if (params.threadId !== (this.threadId ?? this.resumingThread) || !['turn/completed', 'thread/tokenUsage/updated', 'error'].includes(method)) return
    if (this.opening || (this.starting && !this.binding)) {
      if (this.earlyEvents.length >= 1024) throw new Error('Excessive messages before turn acknowledgment')
      this.earlyEvents.push({method, params})
    } else this.processEvent(method, params)
  }

  private processEvent(method: string, params: ObjectValue) {
    const threadId = this.threadId!
    if (method === 'turn/completed') {
      const turn = object(params.turn)
      const turnId = stringField(turn, 'id')
      if (!this.binding || turnId !== this.binding.turnId) return
      const { assignmentId } = this.binding
      const status = turn.status
      if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') throw new Error('Unknown turn terminal state')
      const event: Completion = { type: 'completed', threadId, turnId, assignmentId, status,
        ...(turn.error ? {errorCode: errorCode(turn.error)} : {}) }
      this.binding = undefined
      this.completions.set(turnId, event)
      if (this.completions.size > 64) this.completions.delete(this.completions.keys().next().value!)
      this.options.onEvent?.(event)
      this.waiting.get(turnId)?.resolve(event)
      this.waiting.delete(turnId)
      return
    }
    const turnId = stringField(params, 'turnId')
    if (method === 'thread/tokenUsage/updated') {
      const totalTokens = object(object(params.tokenUsage).total).totalTokens
      if (typeof totalTokens === 'number' && Number.isSafeInteger(totalTokens) && totalTokens >= 0)
        this.options.onEvent?.({ type: 'usage', threadId, turnId, totalTokens })
    } else if (this.binding?.turnId === turnId) {
      this.options.onEvent?.({ type: 'error', threadId, turnId, errorCode: errorCode(params.error), willRetry: params.willRetry === true })
    }
  }

  private async serverRequest(method: string, params: ObjectValue): Promise<ToolReply> {
    if (method !== 'item/tool/call') throw new Error('Unsupported request')
    if (params.namespace != null || !this.threadId || params.threadId !== this.threadId)
      return reply('Invalid tool binding', false)
    const turnId = stringField(params, 'turnId')
    const callId = stringField(params, 'callId')
    const tool = stringField(params, 'tool')
    if (!this.tools.some(t => t.name === tool)) return reply('Unavailable role tool', false)
    if (this.starting) await this.starting
    const args = object(params.arguments)
    const key = JSON.stringify([turnId, callId])
    const signature = JSON.stringify([tool, args])
    const previous = this.calls.get(key)
    if (previous) return previous.signature === signature ? previous.result : reply('Conflicting repeated tool call', false)
    const identity: ReplayContext = { role: this.options.role, ticketId: this.options.ticketId,
      threadId: this.threadId, turnId, callId, tool }
    if (this.disconnected || !this.binding || this.binding.turnId !== turnId || this.binding.frozen) {
      const previous = await this.options.onReplay?.(identity,args)
      return previous ? reply(previous.value,true) : reply('Stale or paused assignment', false)
    }
    const ctx: ToolContext = { ...identity, assignmentId: this.binding.assignmentId }
    const result = Promise.resolve().then(() => this.options.onTool(ctx, args)).then(value => reply(value, true),
      () => reply('Host rejected the tool call; consult the ticket status.', false))
    this.calls.set(key, {signature, result})
    // Durable receipts live in the host store. Bound this short-term replay cache.
    if (this.calls.size > 1024) this.calls.delete(this.calls.keys().next().value!)
    return result
  }

  close() { return this.rpc.close() }
}
