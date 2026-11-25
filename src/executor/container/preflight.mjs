// Check the actual App Server binary from the bound image, using the same UID,
// HOME, executable and configuration as the production control connection.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const proc = spawn('node', ['/opt/orch/app.mjs'], { stdio: ['pipe', 'pipe', 'ignore'] })
const lines = createInterface({ input: proc.stdout })
const pending = new Map()
let id = 0
const deadline = setTimeout(() => {
  process.stderr.write('App Server environment checks timed out\n')
  process.exit(1)
}, 10000)
function send(message) {
  proc.stdin.write(JSON.stringify(message) + '\n')
}
function request(method, params) {
  const n = ++id
  return new Promise((resolve, reject) => {
    pending.set(n, { resolve, reject })
    send({ method, params, id: n })
  })
}
lines.on('line', (line) => {
  const response = JSON.parse(line)
  const waiter = pending.get(response.id)
  if (waiter) {
    pending.delete(response.id)
    waiter.resolve(response)
  }
})
proc.on('exit', () => {
  for (const waiter of pending.values()) waiter.reject(Error('App Server exited during preflight'))
})
try {
  const init = await request('initialize', {
    clientInfo: { name: 'ticket-runtime', version: '1' },
    capabilities: { experimentalApi: true },
  })
  if (!init.result) throw Error('App Server initialization failed')
  send({ method: 'initialized' })
  const remote = await request('environment/status', { environmentId: 'remote' })
  if (remote.result?.status !== 'ready') throw Error('Ticket project exec-server is unavailable')
  const fs = await request('fs/readFile', { path: '/etc/os-release' })
  const shell = await request('command/exec', { command: ['id', '-u'], cwd: '/tmp' })
  if (
    !fs.error?.message.includes('local filesystem is not configured') ||
    !shell.error?.message.includes('local environment is not configured')
  ) {
    throw Error('service identity can execute local tools; Ticket startup blocked')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  lines.close()
  proc.stdin.end()
}
