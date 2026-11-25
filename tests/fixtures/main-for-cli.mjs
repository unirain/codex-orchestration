// Scripted Main used by the offline terminal integration test. The host supplies the executable and token file.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'

const threadId = 'synthetic-local-main'
const turnId = 'synthetic-turn'

function route(q, send) {
  const { id, method } = q
  if (method === 'initialize') {
    send({ id, result: { userAgent: 'codex-orchestration/0.171.0 LOCAL-AUDIT-FIXTURE' } })
  } else if (method === 'thread/start') {
    send({ id, result: { thread: { id: threadId, status: { type: 'idle' } }, model: 'audit-model' } })
  } else if (method === 'turn/start') {
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } })
    send({
      id: 987, method: 'item/tool/call', params: {
        threadId, turnId, callId: 'accept', namespace: null, tool: 'orchestrator_route',
        arguments: { kind: 'accept', title: 'Follow up', scope: 'Follow up', reason: 'explicit local fixture request' },
      },
    })
  } else if (!method && id === 987) {
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
  } else if (method === 'thread/read') {
    send({ id, result: { thread: { id: threadId, turns: [] } } })
  }
}

function argument(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

// This bounded fixture accepts only the complete, masked JSON text frames sent by the loopback bridge.
function websocket(socket, initial) {
  let pending = Buffer.alloc(0)
  function send(value) {
    const body = Buffer.from(JSON.stringify(value))
    const header = Buffer.alloc(body.length < 126 ? 2 : 4)
    header[0] = 0x81
    if (header.length === 2) header[1] = body.length
    else {
      header[1] = 126
      header.writeUInt16BE(body.length, 2)
    }
    socket.write(Buffer.concat([header, body]))
  }
  function consume(data) {
    pending = Buffer.concat([pending, data])
    while (pending.length >= 2) {
      const type = pending[0]
      if (type === 0x88) {
        socket.end(Buffer.from([0x88, 0]))
        return
      }
      if (type !== 0x81 || !(pending[1] & 0x80)) return socket.destroy()
      let size = pending[1] & 0x7f
      let prefix = 2
      if (size === 127) return socket.destroy()
      if (size === 126) {
        if (pending.length < 4) return
        size = pending.readUInt16BE(2)
        prefix = 4
      }
      if (pending.length < prefix + 4 + size) return
      const mask = pending.subarray(prefix, prefix + 4)
      const body = Buffer.from(pending.subarray(prefix + 4, prefix + 4 + size))
      pending = pending.subarray(prefix + 4 + size)
      for (let i = 0; i < size; i++) body[i] ^= mask[i % 4]
      try { route(JSON.parse(body.toString('utf8')), send) } catch { return socket.destroy() }
    }
  }
  socket.on('data', consume)
  socket.on('error', () => socket.destroy())
  consume(initial)
}

const address = argument('--listen')
if (address?.startsWith('ws://')) {
  if (address !== 'ws://127.0.0.1:0' || argument('--ws-auth') !== 'capability-token') throw Error('Expected protected local transport')
  const auth = 'Bearer ' + readFileSync(argument('--ws-token-file'), 'utf8').trim()
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key']
    if (request.headers.authorization !== auth || typeof key !== 'string') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    websocket(socket, head)
  })
  server.listen(0, '127.0.0.1', () => {
    process.stderr.write('listening on: ws://127.0.0.1:' + server.address().port + '\n')
  })
} else if (process.argv.includes('--stdio')) {
  createInterface({ input: process.stdin }).on('line', line => route(JSON.parse(line), value => console.log(JSON.stringify(value))))
} else {
  throw Error('Expected an App Server transport')
}
