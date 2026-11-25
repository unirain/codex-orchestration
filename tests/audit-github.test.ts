import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHub } from '../src/host/github.ts'

test('AC-039/040 execute only the bound gh program, enforce login/repo/push permission, and ignore inherited personal OAuth variables', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'orch-gh-audit-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const name=join(dir,'gh'),identity=join(dir,'identity.json')
  // The executable reads its isolated config and fails the test if personal credential variables are inherited.
  writeFileSync(name,`#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path')
if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN||process.env.SSH_AUTH_SOCK)process.exit(44)
const s=JSON.parse(fs.readFileSync(path.join(process.env.GH_CONFIG_DIR,'identity.json')))
if(!s.login){process.stderr.write('HTTP 401');process.exit(1)}
const args=process.argv.slice(2)
if(args[3]==='user') console.log(JSON.stringify({login:s.login}))
else if(args[3]==='repos/org/repo')console.log(JSON.stringify({full_name:s.repo,permissions:{push:s.push}}))
else process.exit(45)
`,{mode:0o700})
  const adapter=new GitHub({repo:'org/repo',account:'dedicated-bot',configDir:dir,gh:name})
  assert.equal(adapter.env.GH_CONFIG_DIR,realpathSync(dir))
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK','GIT_CONFIG_COUNT'])assert.equal(adapter.env[key],undefined)
  const put=(login:string,push:boolean,repo='org/repo')=>writeFileSync(identity,JSON.stringify({login,push,repo}))
  put('dedicated-bot',true);await adapter.verify()
  put('personal',true);await assert.rejects(adapter.verify(),/identity mismatch/)
  put('dedicated-bot',false);await assert.rejects(adapter.verify(),/permission mismatch/)
  put('dedicated-bot',true,'org/other');await assert.rejects(adapter.verify(),/identity or push permission mismatch/)
  put('',true);await assert.rejects(adapter.verify(),/HTTP 401/)
})

test('AC-038 GitHub CLI headers carry a secondary rate limit delay into PR polling',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'orch-gh-header-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const executable=join(dir,'gh')
  writeFileSync(executable,`#!/usr/bin/env node
if(process.argv.includes('user')){console.log(JSON.stringify({login:'agent'}));process.exit(0)}
if(!process.argv.includes('--include'))process.exit(2)
process.stdout.write('HTTP/2.0 403 Forbidden\\r\\nretry-after: 120\\r\\n\\r\\n{}')
process.stderr.write('gh: forbidden (HTTP 403)')
process.exitCode=1
`,{mode:0o700})
  const adapter=new GitHub({repo:'org/repo',account:'agent',configDir:dir,gh:executable})
  await assert.rejects(adapter.read(3),(error:unknown)=>!!error && typeof error==='object' && 'delayMs' in error && error.delayMs===120000)
})
