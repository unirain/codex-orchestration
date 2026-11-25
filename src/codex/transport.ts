import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type ObjectValue = Record<string, unknown>

export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid App Server object')
  return value as ObjectValue
}

export function stringField(value: unknown, name: string): string {
  const field = object(value)[name]
  if (typeof field !== 'string' || !field) throw new Error('Missing App Server field: ' + name)
  return field
}

/** The server explicitly rejected an individual request. Transport loss/timeouts
 * are distinguished because a mutating request may already have taken effect. */
export class RpcError extends Error {
  code: number
  data: unknown
  constructor(method: string, error: ObjectValue) {
    super(method + ' rejected: ' + (typeof error.message === 'string' ? error.message : 'unknown error'))
    this.code = typeof error.code === 'number' ? error.code : -32603
    this.data = error.data
  }
}
export class ConnectionLost extends Error {}

export interface ProcessOptions {
  command: string
  args: string[]
  /** Explicit environment for the transport. Never inherit ambient credentials. */
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
}
interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class StdioRpc {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private serial = 0
  private dead?: Error
  private timeoutMs: number
  readonly closed: Promise<void>
  readonly onRequest: (method: string, params: ObjectValue) => Promise<unknown>
  readonly onNotification: (method: string, params: ObjectValue) => void
  readonly onDisconnect: (error: Error) => void

  constructor(options: ProcessOptions, handlers: Pick<StdioRpc, 'onRequest' | 'onNotification' | 'onDisconnect'>) {
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.onRequest = handlers.onRequest
    this.onNotification = handlers.onNotification
    this.onDisconnect = handlers.onDisconnect
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: 'pipe', shell: false })
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()))
    const fail = () => this.disconnect(new ConnectionLost('App Server connection lost; reconcile in-flight requests'))
    this.child.on('error', fail)
    this.child.on('close', fail)
    this.child.stdin.on('error', fail)
    this.child.stdout.on('error', fail)
    // Server stderr may contain environment or source data. Never persist it.
    this.child.stderr.resume()
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', line => {
      try {
        this.receive(object(JSON.parse(line)))
      } catch {
        this.disconnect(new ConnectionLost('Malformed App Server message'))
      }
    })
  }

  private disconnect(error: Error) {
    if (this.dead) return
    this.dead = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.child.kill()
    this.onDisconnect(error)
  }

  private send(message: ObjectValue) {
    if (this.dead) throw this.dead
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  private receive(message: ObjectValue) {
    if (this.dead) return
    if (typeof message.method === 'string') {
      const params = object(message.params ?? {})
      if (message.id === undefined) {
        this.onNotification(message.method, params)
      } else {
        const id = message.id
        void this.onRequest(message.method, params).then(
          result => { if (!this.dead) this.send({ id, result }) },
          () => { if (!this.dead) this.send({ id, error: { code: -32601, message: 'Request not supported' } }) },
        ).catch(() => this.disconnect(new ConnectionLost('App Server callback response failed')))
      }
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    const error = message.error ? new RpcError(request.method, object(message.error)) : null
    if (!error && !('result' in message)) throw new Error('Missing result')
    this.pending.delete(message.id)
    clearTimeout(request.timer)
    if (error) request.reject(error)
    else request.resolve(message.result)
  }

  request(method: string, params: ObjectValue): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead)
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(new ConnectionLost(method + ' timed out; reconcile before retry')), this.timeoutMs)
      this.pending.set(id, { resolve, reject, method, timer })
      try { this.send({ id, method, params }) }
      catch { this.disconnect(new ConnectionLost('Unable to send ' + method)) }
    })
  }

  notify(method: string) { this.send({ method }) }

  async close() {
    this.disconnect(new ConnectionLost('App Server closed'))
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000)
    try { await this.closed }
    finally { clearTimeout(timer) }
  }
}
