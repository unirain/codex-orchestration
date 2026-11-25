import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { authority, makeProxy } from '../src/executor/container/proxy.mjs'

test('repo proxy matches exact authority and rechecks redirects before contacting new target', async t=>{
  for(const s of ['*.example.org:443','a.example:65536','example','example.org:0','user@foo:443']) assert.throws(()=>authority(s))
  assert.equal(authority('UPPER.example:443'),'upper.example:443')
  let secondHits=0
  const second=http.createServer((_req,res)=>{secondHits++;res.end('private')})
  const first=http.createServer((req,res)=>{if(req.url==='/redirect') res.writeHead(302,{location:'http://127.0.0.1:'+port(second)+'/next'});res.end('ok')})
  function port(server:http.Server){return (server.address() as AddressInfo).port}
  async function listen(server:http.Server){await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>server.close())}
  await listen(second);await listen(first)
  const denied:string[]=[]
  const proxy=makeProxy(['127.0.0.1:'+port(first)],(d:string)=>denied.push(d))
  await listen(proxy)
  const get=(url:string)=>new Promise<{code:number;location?:string}>((resolve,reject)=>{
    http.get({hostname:'127.0.0.1',port:port(proxy),path:url},r=>{r.resume();resolve({code:r.statusCode!,location:r.headers.location})}).on('error',reject)
  })
  const start=await get('http://127.0.0.1:'+port(first)+'/redirect');assert.equal(start.code,302)
  assert.equal((await get(start.location!)).code,403);assert.equal(secondHits,0)
  const connect=await new Promise<string>(ok=>{const s=net.connect(port(proxy),'127.0.0.1',()=>s.write('CONNECT new.example:443 HTTP/1.1\r\nHost: new.example:443\r\n\r\n'));s.once('data',chunk=>{s.destroy();ok(String(chunk))})})
  assert.match(connect,/403/);assert.deepEqual(denied,['127.0.0.1:'+port(second),'new.example:443'])
})
