#!/usr/bin/env node
/** AC-046 opt-in helper. Copy this file to a private acceptance directory,
 * with fixture.json beside it. A separate armed.json names one ticket head.
 * Never configure this as a normal project's gh binary. */
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = 'unirain/test-orch-code'
function check(condition, message) { if (!condition) throw Error(message) }
function privateOwned(file, directory = false) {
  const stat = lstatSync(file)
  check((directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid() && !(stat.mode & 0o077),
    'Expected an owner-only acceptance fixture')
}
function json(file) { privateOwned(file); return JSON.parse(readFileSync(file,'utf8')) }
async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  privateOwned(here,true)
  const cfg = json(join(here,'fixture.json'))
  check(cfg.repo === repo && process.env.GH_HOST === 'github.com', 'Unexpected destination')
  privateOwned(cfg.configDir,true)
  check(realpathSync(cfg.configDir) === realpathSync(process.env.GH_CONFIG_DIR), 'Unexpected gh identity directory')
  const binary = realpathSync(cfg.gh)
  check(binary !== realpathSync(process.argv[1]), 'Recursive gh wrapper')
  const args = process.argv.slice(2)
  const api = args[0] === 'api' && args[1] === '--hostname' && args[2] === 'github.com'
  const endpoint = args[3]
  const local = endpoint === 'repos/'+repo || endpoint?.startsWith('repos/'+repo+'/')
  const ready = args.length === 5 && args[0] === 'pr' && args[1] === 'ready' && /^\d+$/.test(args[2]) && args[3] === '--repo' && args[4] === repo
  const helper = args.length === 3 && args[0] === 'auth' && args[1] === 'git-credential' && ['get','store','erase'].includes(args[2])
  const apiRead = endpoint === 'user' && args.length === 4 || endpoint === '-i' && args.length === 5 && args[4] === 'rate_limit'
  check((api && (local || apiRead)) || ready || helper,'Unexpected acceptance command')
  const isCreate = api && endpoint === 'repos/'+repo+'/pulls' && args.includes('--method') && args[args.indexOf('--method')+1] === 'POST'
  let target
  if (isCreate) {
    try { target = json(join(here,'armed.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const intercept = target && args.includes('head='+target.branch)
  let instance
  if (intercept) {
    instance = json(cfg.instanceFile)
    check(instance.pid === process.ppid && instance.pid > 1 && instance.repo === cfg.instanceRepo &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(instance.url),'Wrong host process')
    const health = await fetch(instance.url+'/health', {headers:{authorization:'Bearer '+instance.key},
      redirect:'error',signal:AbortSignal.timeout(2000)})
    check(health.ok && (await health.json()).repo === cfg.instanceRepo,'Could not verify fixture host identity')
  }
  if (!intercept) {
    const child = spawnSync(binary,args,{stdio:'inherit'})
    process.exitCode = child.status ?? 1
    return
  }
  const result = spawnSync(binary,args,{encoding:'utf8',stdio:['inherit','pipe','inherit'],maxBuffer:4*1024*1024})
  if (result.status !== 0) { process.exitCode = result.status ?? 1; return }
  const pr = JSON.parse(result.stdout)
  check(pr.base?.repo?.full_name === repo && pr.head?.repo?.full_name === repo && pr.head?.ref === target.branch && Number.isInteger(pr.number),'PR identity mismatch')
  try {
    writeFileSync(join(here,'injected.json'),JSON.stringify({repository:repo,pr:pr.number,head:target.branch,
      commit:pr.head.sha,daemon:instance.pid,at:new Date().toISOString()}),{flag:'wx',mode:0o600})
  } catch(error) {
    if (error.code !== 'EEXIST') throw error
    process.stdout.write(result.stdout)
    return
  }
  check(process.ppid === instance.pid, 'Acceptance host already terminated')
  process.kill(instance.pid,'SIGKILL')
  // Do not emit GitHub's successful response. On restart the normal delivery
  // journal must discover the already-created PR by repository, branch and SHA.
}
main().catch(error => { process.stderr.write('AC-046 helper stopped: '+error.message+'\n');process.exitCode=1 })
