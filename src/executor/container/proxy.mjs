// Trusted, read-only program mounted by the host in a separate network namespace.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { chmodSync, chownSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

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
export function makeProxy(allowed,onDenied) {
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
      const upstream=net.connect({host,port:Number(port)},()=>{
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if(head.length) upstream.write(head)
        bridge(socket,upstream)
      })
      upstream.once('error',()=>socket.destroy());socket.once('error',()=>upstream.destroy())
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
    await listenUnix(makeProxy(allow,denied=>console.log(JSON.stringify({denied}))),'/relay/repo.sock',0,0o666)
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
