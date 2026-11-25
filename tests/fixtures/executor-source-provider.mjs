// Test-only HTTPS Responses provider. Capture complete JSON request bodies and omit
// request headers. All fixture files and the dedicated test CA are ephemeral.
import https from 'node:https'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
let tls
for (let i = 0; i < 200 && !tls; i++) {
  try {
    tls = { key: await readFile('/fixture/leaf-0.key'), cert: await readFile('/fixture/leaf-0.pem') }
  } catch {
    await delay(100)
  }
}
if (!tls) throw Error('test provider certificate missing')
let sequence = 0
const service = https.createServer(tls, async (req, res) => {
  try {
    if (req.url !== '/responses') {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    const n = ++sequence
    await writeFile('/fixture/input-' + n + '.json', JSON.stringify(body))
    const id = 'source-proof-' + n
    let cmd
    if (n === 1) cmd = 'node /workspace/native-read.mjs'
    if (n === 2) cmd = 'sh /workspace/search-source.sh'
    if (n === 4) {
      const provided = JSON.stringify(body.input).match(/sdkTag\(\): '(snippet_[0-9a-f]{32})'/)
      if (!provided) throw Error('explicit user snippet missing')
      cmd = 'printf %s ' + provided[1] + ' > /workspace/used-snippet'
    }
    const item = cmd
      ? {
          type: 'function_call',
          call_id: 'call-' + n,
          name: 'exec_command',
          arguments: JSON.stringify({ cmd, workdir: '/workspace' }),
        }
      : {
          type: 'message',
          role: 'assistant',
          id: 'message-' + n,
          content: [{ type: 'output_text', text: 'Fixture finished.' }],
        }
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      {
        type: 'response.completed',
        response: { id, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
      },
    ]
    res
      .writeHead(200, { 'Content-Type': 'text/event-stream' })
      .end(events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''))
  } catch (e) {
    console.error(e.message)
    res.writeHead(500).end()
  }
})
service.listen(8443, '0.0.0.0')
