import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareTicket,ticketKey } from '../src/executor/workspace.ts'
import { checked } from '../src/executor/process.ts'

test('empty/custom preparations are owned, isolated and reused; failed nonempty work survives',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'orch-ws-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const opts={repoDir:dir,stateDir:join(dir,'state'),ticketId:'A / punctuation'}
  const [a,b]=await Promise.all([prepareTicket(opts),prepareTicket(opts)])
  assert.deepEqual(a,b);assert.deepEqual(await readdir(a.directory),[])
  await writeFile(join(a.directory,'uncommitted'),'evidence')
  assert.deepEqual(await prepareTicket(opts),a);assert.equal(await readFile(join(a.directory,'uncommitted'),'utf8'),'evidence')
  const failed={...opts,ticketId:'B',prepare:{kind:'command' as const,command:'mkdir "$TICKET_DIR"; echo preserve > "$TICKET_DIR/failure"; exit 1'}}
  await assert.rejects(prepareTicket(failed),/exited 1/)
  await assert.rejects(prepareTicket(failed),/unverified/)
  const empty={...opts,ticketId:'C',prepare:{kind:'command' as const,command:'mkdir "$TICKET_DIR"; exit 1'}}
  await assert.rejects(prepareTicket(empty),/exited 1/)
  assert.deepEqual(await readdir(join(opts.stateDir,'tickets',ticketKey('C'))),[])
  await rm(a.directory,{recursive:true});await assert.rejects(prepareTicket(opts),/missing/)
  await symlink(dir,a.directory);await assert.rejects(prepareTicket(opts),/ownership changed/)
})
test('Git uses remote HEAD and private metadata; dirty operator checkout is preserved',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'orch-git-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const remote=join(dir,'origin'), repo=join(dir,'checkout')
  const git=(cwd:string,...args:string[])=>checked('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args],{cwd,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})
  await git(dir,'init','-q','--bare','-b','trunk',remote)
  await git(dir,'init','-q','-b','trunk',repo)
  await writeFile(join(repo,'code'),'base');await git(repo,'add','code');await git(repo,'commit','-qm','base')
  const base=await git(repo,'rev-parse','HEAD')
  await git(repo,'remote','add','origin',remote);await git(repo,'push','origin','trunk')
  await git(repo,'switch','-qc','feature/mail');await writeFile(join(repo,'code'),'dirty')
  const o={repoDir:repo,stateDir:join(dir,'state'),prepare:{kind:'git' as const}}
  const a=await prepareTicket({...o,ticketId:'A'}),b=await prepareTicket({...o,ticketId:'B'})
  assert.equal(a.baseBranch,'trunk');assert.equal(a.baseCommit,base);assert.notEqual(a.branch,b.branch)
  assert.notEqual(a.gitDir,b.gitDir);assert.ok(!a.gitDir!.startsWith(a.directory+'/'))
  assert.equal(await git(a.directory,'rev-parse','HEAD'),base);assert.equal(await readFile(join(repo,'code'),'utf8'),'dirty')
  await writeFile(join(a.directory,'new'),'stay');assert.equal((await prepareTicket({...o,ticketId:'A'})).directory,a.directory)
  assert.equal(await git(repo,'branch','--show-current'),'feature/mail')
  await git(a.directory,'add','new');await git(a.directory,'commit','-qm','Ticket checkpoint')
  const checkpoint=await git(a.directory,'rev-parse','HEAD')
  await rm(a.directory,{recursive:true})
  await assert.rejects(prepareTicket({...o,ticketId:'A'}),err=>String(err).includes(checkpoint) &&
    String(err).includes('verified branch '+a.branch) && String(err).includes('uncommitted changes cannot be verified'))
  assert.equal(await readFile(join(b.directory,'code'),'utf8'),'base')
})
