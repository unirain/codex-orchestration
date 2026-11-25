import { spawn } from 'node:child_process'

export interface Result { code: number | null; output: string; truncated: boolean }

export function run(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; outputLimit?: number
} = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: 'pipe' })
    const limit = options.outputLimit ?? 65536
    let tail = Buffer.alloc(0), truncated = false, expired = false
    const append = (chunk: Buffer) => {
      const combined = Buffer.concat([tail, chunk])
      truncated ||= combined.length > limit
      tail = combined.subarray(Math.max(0, combined.length - limit))
    }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)
    proc.stdin.on('error', () => {}) // EPIPE if a short-lived command exits first.
    proc.stdin.end(options.input)
    const timer = setTimeout(() => {
      expired = true
      if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL') } catch { /* Already exited. */ }
      }
    }, options.timeoutMs ?? 60000)
    proc.once('error', error => { clearTimeout(timer); reject(error) })
    proc.once('close', code => {
      clearTimeout(timer)
      if (expired) reject(new Error(`${command} exceeded its time limit`))
      else resolve({ code, output: tail.toString('utf8').trimEnd(), truncated })
    })
  })
}

export function redact(value: string): string {
  return value.replace(/((?:token|api[_-]?key|password|authorization)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
}

export async function checked(command: string, args: string[], options?: Parameters<typeof run>[2]) {
  const result = await run(command, args, options)
  if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${redact(result.output)}`)
  return result.output
}
