// Invoke the same native file endpoint that the remote Codex executor uses.
// Print only the file result or a generic failure per test path.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const paths = JSON.parse(await readFile('/workspace/probe-paths.json', 'utf8'))
const ws = new WebSocket('ws://127.0.0.1:4022')
const waiters = new Map()
let id = 0
function call(method, params) {
  const n = ++id
  return new Promise((ok) => {
    waiters.set(n, ok)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
}
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  waiters.get(msg.id)?.(msg)
})
await new Promise((ok, fail) => {
  ws.addEventListener('open', ok)
  ws.addEventListener('error', fail)
})
try {
  const init = await call('initialize', { clientName: 'source-boundary-eval' })
  if (!init.result) throw Error('file RPC initialization failed')
  ws.send(JSON.stringify({ method: 'initialized', params: {} }))
  for (const [label, path] of Object.entries(paths)) {
    const reply = await call('fs/readFile', {
      path: pathToFileURL(path).href,
      followSymlinks: true,
      sandbox: null,
    })
    console.log(
      'native-' +
        label +
        '=' +
        (reply.result
          ? Buffer.from(reply.result.dataBase64, 'base64').toString('utf8').trim()
          : 'unavailable'),
    )
  }
} finally {
  ws.close()
}
