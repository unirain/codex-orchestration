// Disposable stdio connection. The app-server daemon and its turn survive
// each client. The repo UID cannot read the separate control capability.
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const capability = readFileSync('/service/app-cap', 'utf8')
const socket = new WebSocket('ws://127.0.0.1:4023', {
  headers: { Authorization: 'Bearer ' + capability },
})
const stop = () => socket.close()
socket.addEventListener('error', () => {
  process.stderr.write('Ticket control handshake or transport failed\n')
  process.exit(1)
})
socket.addEventListener('close', () => process.exit(0))
process.on('SIGTERM', stop)
process.stdout.on('error', stop)
socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') {
    socket.close()
    return
  }
  process.stdout.write(event.data + '\n')
})
socket.addEventListener('open', () => {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(line)
  })
  input.on('close', stop)
})
