/** Disposable NDJSON transport to an authenticated local App Server. */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [address, tokenFile] = process.argv.slice(2)
if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(address)) throw Error('Expected a local App Server address')
const ws = new WebSocket(address, {headers:{Authorization:'Bearer '+readFileSync(tokenFile,'utf8').trim()}})
ws.addEventListener('error',()=>process.exit(1))
ws.addEventListener('close',()=>process.exit(0))
ws.addEventListener('message',({data})=>{
  if (typeof data !== 'string') return process.exit(1)
  process.stdout.write(data+'\n')
})
ws.addEventListener('open',()=>{
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity})
  lines.on('line',line=>ws.send(line))
  lines.on('close',()=>ws.close())
})
