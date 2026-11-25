import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { authority, makeProxy } from '../src/executor/container/proxy.mjs'

test('repo proxy matches exact authority and rechecks redirects before contacting new target', async (t) => {
  for (const s of ['*.example.org:443', 'a.example:65536', 'example', 'example.org:0', 'user@foo:443'])
    assert.throws(() => authority(s))
  assert.equal(authority('UPPER.example:443'), 'upper.example:443')
  let secondHits = 0
  const second = http.createServer((_req, res) => {
    secondHits++
    res.end('private')
  })
  const first = http.createServer((req, res) => {
    if (req.url === '/redirect')
      res.writeHead(302, { location: 'http://127.0.0.1:' + port(second) + '/next' })
    res.end('ok')
  })
  function port(server: http.Server) {
    return (server.address() as AddressInfo).port
  }
  async function listen(server: http.Server) {
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    t.after(() => server.close())
  }
  await listen(second)
  await listen(first)
  const denied: string[] = []
  const proxy = makeProxy(['127.0.0.1:' + port(first)], (d: string) => denied.push(d))
  await listen(proxy)
  const get = (url: string) =>
    new Promise<{ code: number; location?: string }>((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: port(proxy), path: url }, (r) => {
          r.resume()
          resolve({ code: r.statusCode!, location: r.headers.location })
        })
        .on('error', reject)
    })
  const start = await get('http://127.0.0.1:' + port(first) + '/redirect')
  assert.equal(start.code, 302)
  assert.equal((await get(start.location!)).code, 403)
  assert.equal(secondHits, 0)
  const connect = await new Promise<string>((ok) => {
    const s = net.connect(port(proxy), '127.0.0.1', () =>
      s.write('CONNECT new.example:443 HTTP/1.1\r\nHost: new.example:443\r\n\r\n'),
    )
    s.once('data', (chunk) => {
      s.destroy()
      ok(String(chunk))
    })
  })
  assert.match(connect, /403/)
  assert.deepEqual(denied, ['127.0.0.1:' + port(second), 'new.example:443'])
})

test('HTTPS proxy checks the request authority inside a reused TLS connection and before following redirection', async (t) => {
  const https = await import('node:https')
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { run } = await import('../src/executor/process.ts')
  const { makeCertificates } = await import('../src/executor/container/ticket-ca.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'ticket-egress-ca-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const tls = makeCertificates(dir, ['127.0.0.1'])
  const options = {
    cert: await readFile(join(dir, 'leaf-0.pem')),
    key: await readFile(join(dir, 'leaf-0.key')),
  }
  async function listen(server: http.Server) {
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    t.after(() => server.closeAllConnections())
    t.after(() => server.close())
    return (server.address() as AddressInfo).port
  }
  let redirected = 0,
    original = 0
  const second = await listen(
    https.createServer(options, (_r, s) => {
      redirected++
      s.end('other')
    }),
  )
  const first = await listen(
    https.createServer(options, (r, s) => {
      original++
      if (r.url === '/redirect') s.writeHead(302, { location: 'https://127.0.0.1:' + second + '/pkg' })
      s.end('fixture')
    }),
  )
  const denies: string[] = []
  const proxy = await listen(
    makeProxy(['127.0.0.1:' + first], (a: string) => denies.push(a), tls.contexts, { ca: tls.publicCa }),
  )
  const curl = (path: string, ...flags: string[]) =>
    run('curl', [
      '--noproxy',
      '',
      '-sS',
      '--max-time',
      '5',
      '--cacert',
      join(dir, 'ca.pem'),
      '--proxy',
      'http://127.0.0.1:' + proxy,
      '-w',
      ' %{http_code}',
      ...flags,
      'https://127.0.0.1:' + first + path,
    ])
  assert.equal((await curl('/pkg')).output, 'fixture 200')
  assert.match((await curl('/pkg', '-H', 'Host: other.example')).output, /403$/)
  assert.notEqual((await curl('/redirect', '-fL')).code, 0)
  assert.equal(original, 2)
  assert.equal(redirected, 0)
  assert.ok(denies.includes('other.example:443'))
  assert.ok(denies.includes('127.0.0.1:' + second))
})
