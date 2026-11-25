import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

export type Dispatch = (action: string, body: Record<string, unknown>) => Promise<unknown>
export interface Endpoint {
  url: string
  key: string
  repo: string
  pid: number
}
export function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw Error('Runtime directory must be private and owned by the current user')
}
export function lockInstance(dir: string) {
  privateDir(dir)
  const lock = new DatabaseSync(join(dir, 'instance.lock'))
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
  } catch {
    lock.close()
    throw Error('A host already owns this repository')
  }
  return () => lock.close()
}
export async function serve(dir: string, repo: string, dispatch: Dispatch) {
  const key = randomBytes(32).toString('hex')
  const service = createServer(async (req, res) => {
    const status = (code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    const incoming = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from('Bearer ' + key)
    if (
      req.headers.origin ||
      req.headers.host !== '127.0.0.1:' + String((service.address() as AddressInfo)?.port) ||
      incoming.length !== expected.length ||
      !timingSafeEqual(incoming, expected)
    ) {
      status(403, { error: 'Invalid local credentials' })
      return
    }
    try {
      if (req.method === 'GET' && req.url === '/health') {
        status(200, { repo })
        return
      }
      if (req.method !== 'POST' || !/^\/[a-z][a-z-]*$/.test(req.url ?? '')) {
        status(404, { error: 'Unknown command' })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 256 * 1024) {
          status(413, { error: 'Message exceeds 256 KiB' })
          return
        }
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Expected an object')
      status(200, await dispatch(req.url!.slice(1), body))
    } catch (e) {
      status(400, { error: e instanceof Error ? e.message : 'Request failed' })
    }
  })
  service.requestTimeout = 30000
  await new Promise<void>((resolve, reject) => {
    service.once('error', reject)
    service.listen(0, '127.0.0.1', resolve)
  })
  const info: Endpoint = {
    url: 'http://127.0.0.1:' + String((service.address() as AddressInfo).port),
    key,
    repo,
    pid: process.pid,
  }
  const file = join(dir, 'instance.json')
  const temp = file + '.' + process.pid
  try {
    writeFileSync(temp, JSON.stringify(info), { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
    chmodSync(file, 0o600)
  } catch (e) {
    service.close()
    throw e
  }
  return async () => {
    rmSync(file, { force: true })
    await new Promise<void>((resolve) => service.close(() => resolve()))
  }
}
export async function connect(dir: string, repo: string): Promise<Endpoint | undefined> {
  try {
    const f = join(dir, 'instance.json'),
      stat = lstatSync(f)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return
    const i: Endpoint = JSON.parse(readFileSync(f, 'utf8'))
    if (i.repo !== repo || !/^http:\/\/127\.0\.0\.1:\d+$/.test(i.url) || !/^[0-9a-f]{64}$/.test(i.key)) return
    const r = await fetch(i.url + '/health', {
      headers: { authorization: 'Bearer ' + i.key },
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    })
    if (r.ok && (await r.json()).repo === repo) return i
  } catch {
    /* The daemon may still be starting or may have released its lock. */
  }
}
export class HostRejection extends Error {}
export async function invoke(i: Endpoint, action: string, body: Record<string, unknown>) {
  const r = await fetch(i.url + '/' + action, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + i.key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  })
  const value = await r.json()
  if (!r.ok) throw new HostRejection(value.error ?? 'Local host request failed')
  return value
}
