// Trusted, read-only program mounted by the host in a separate network namespace.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { chmodSync, chownSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createServer as tlsServer } from 'node:tls'
import { makeCertificates } from './ticket-ca.mjs'

export function authority(raw) {
  if (typeof raw !== 'string' || !/^(?:[a-z\d-]+\.)*[a-z\d-]+:[1-9]\d{0,4}$/i.test(raw)) throw new Error('expected exact hostname:port')
  const [name,port] = raw.toLowerCase().split(':')
  if (Number(port)>65535 || name.split('.').some(label => label.length>63 || label.startsWith('-') || label.endsWith('-'))) throw new Error('invalid network authority')
  return name+':'+Number(port)
}
function targetOf(url) {
  return authority(url.hostname+':'+(url.port || (url.protocol==='https:'?'443':'80')))
}
function bridge(left,right) {
  left.once('error',()=>right.destroy());right.once('error',()=>left.destroy())
  left.once('close',()=>right.destroy());right.once('close',()=>left.destroy())
  left.pipe(right).pipe(left)
}
function rejectRequest(res,code) {
  res.writeHead(code,{'content-type':'text/plain'}).end('Ticket network policy: '+code)
}
function forward(req,res,url,options={}) {
  const transport = url.protocol==='https:' ? https : http
  const headers={...req.headers,host:url.host}
  for (const header of ['proxy-authorization','proxy-connection','connection','upgrade']) delete headers[header]
  const remote=transport.request(url,{method:req.method,headers,...options},reply=>{
    res.writeHead(reply.statusCode ?? 502,reply.headers)
    reply.on('error',()=>res.destroy())
    reply.pipe(res)
  })
  remote.on('error',()=>res.headersSent?res.destroy():rejectRequest(res,502))
  res.once('close',()=>remote.destroy())
  req.pipe(remote)
}
export function makeProxy(allowed,onDenied,contexts=new Map(),upstreamOptions={}) {
  const allow=new Set(allowed.map(authority))
  function permits(key) {
    if (allow.has(key)) return true
    onDenied(key)
    return false
  }
  const s=http.createServer((req,res)=>{
    try {
      const u=new URL(req.url)
      if (u.protocol!=='http:' || u.username || u.password) return rejectRequest(res,400)
      if (!permits(targetOf(u))) return rejectRequest(res,403)
      forward(req,res,u)
    } catch { rejectRequest(res,400) }
  })
  s.on('connect',(req,socket,head)=>{
    try {
      const key=authority(req.url)
      if(!permits(key)) {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return}
      const [host,port]=key.split(':')
      const context=contexts.get(host)
      if(!context){socket.end('HTTP/1.1 502 Unavailable\r\n\r\n');return}
      // CONNECT grants an exact HTTPS authority. Terminate TLS here so a
      // redirected request, an origin switch or a reused connection cannot
      // silently contact an unchecked destination behind the same tunnel.
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if(head.length)socket.unshift(head)
      const requestServer=scheme=>http.createServer((inner,reply)=>{
        const origin=new URL(scheme+'://'+host+':'+port)
        try {
          if(!inner.headers.host || !inner.url.startsWith('/') || inner.url.startsWith('//'))return rejectRequest(reply,400)
          const declared=new URL(scheme+'://'+inner.headers.host)
          const dest=new URL(inner.url,origin)
          if(declared.username || declared.password || targetOf(declared)!==key || targetOf(dest)!==key){
            onDenied(targetOf(declared));return rejectRequest(reply,403)
          }
          forward(inner,reply,dest,upstreamOptions)
        }catch{rejectRequest(reply,400)}
      })
      const transport=tlsServer({...context,ALPNProtocols:['http/1.1']},secure=>{
        secure.on('error',()=>secure.destroy())
        if(secure.servername && secure.servername.toLowerCase()!==host){onDenied(secure.servername+':'+port);secure.destroy();return}
        requestServer('https').emit('connection',secure)
      })
      transport.on('tlsClientError',(_err,connection)=>connection.destroy())
      // npm can also send plain HTTP/1.1 through CONNECT for an http package URL.
      // Parse that request at this same authority boundary instead of opening a raw tunnel.
      socket.once('data',chunk=>{
        socket.pause();socket.unshift(chunk)
        if(chunk[0]===22) transport.emit('connection',socket)
        else {requestServer('http').emit('connection',socket);socket.resume()}
      })
    } catch { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') }
  })
  return s
}
function listenUnix(server,path,uid,mode) {
  return new Promise((ok,fail)=>{
    server.once('error',fail);server.listen(path,()=>{chmodSync(path,mode);chownSync(path,uid,uid);ok()})
  })
}
async function start() {
  if(process.argv[2]==='outbound'){
    const {allow,providerBaseUrl,serviceUid}=JSON.parse(process.argv[3])
    const upstream=new URL(providerBaseUrl)
    const model=http.createServer((req,res)=>{
      if(!/^\/(responses|models)(?:\?|\/|$)/.test(req.url)) return rejectRequest(res,404)
      const dest=new URL(upstream)
      dest.pathname=upstream.pathname.replace(/\/$/,'')+req.url.split('?')[0]
      dest.search=req.url.split('?')[1] ?? ''
      forward(req,res,dest)
    })
    await listenUnix(model,'/relay/model.sock',serviceUid,0o600)
    const certificates=makeCertificates('/ca',allow.map(k=>authority(k).split(':')[0]))
    writeFileSync('/relay/ca.pem',certificates.publicCa,{mode:0o444})
    await listenUnix(makeProxy(allow,denied=>console.log(JSON.stringify({denied})),certificates.contexts),'/relay/repo.sock',0,0o666)
  } else if(process.argv[2]==='local'){
    const secret=await readFile('/private/proxy-token','utf8')
    const token=Buffer.from('Bearer '+secret)
    // The model listener requires a service-only throwaway token. The real credential
    // stays out of App Server/exec-server environments, including inherited shell variables.
    const apiKey=await readFile('/private/provider-key','utf8')
    http.createServer((req,res)=>{
      const actual=Buffer.from(req.headers.authorization ?? '')
      if(actual.length!==token.length || !timingSafeEqual(actual,token))return rejectRequest(res,403)
      if(!/^\/(responses|models)(?:\?|\/|$)/.test(req.url))return rejectRequest(res,404)
      req.headers.authorization='Bearer '+apiKey
      forward(req,res,new URL('http://relay'+req.url),{socketPath:'/relay/model.sock'})
    }).listen(4021,'127.0.0.1')
    net.createServer(socket=>bridge(socket,net.connect('/relay/repo.sock'))).listen(4020,'127.0.0.1')
  } else throw new Error('unknown proxy role')
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) start().catch(err=>{console.error(err.message);process.exit(1)})
