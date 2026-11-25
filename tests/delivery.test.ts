import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {Delivery,localGit} from '../src/host/delivery.ts'
import type {Pull,Remote} from '../src/host/github.ts'

function setup(t: any) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'orch-pr-')))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const directory=join(root,'files'),gitDir=join(root,'store.git')
  mkdirSync(directory)
  execFileSync('git',['init','-q','-b','ticket/a','--separate-git-dir',gitDir,directory])
  writeFileSync(join(directory,'README.md'),'fixture')
  execFileSync('git',['-C',directory,'add','.'])
  execFileSync('git',['-C',directory,'-c','user.name=Fixture','-c','user.email=test@example.com','commit','-qm','fixture'])
  const ref={directory,gitDir,branch:'ticket/a',base:'master',ticket:'A'}
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close())
  const state={authorized:true,pushes:0,creates:0,ends:0,binds:0,head:null as string|null,pr:undefined as Pull|undefined,lose:false}
  const remote:Remote={
    async verify(){},async head(){return state.head},async push(r,sha){state.pushes++;state.head=sha},
    async lookup(){return state.pr?[state.pr]:[]},async read(){return state.pr!},
    async create(r,title,body,draft){
      state.creates++
      state.pr={number:3,repo:'org/test',headRepo:'org/test',branch:r.branch,base:r.base,commit:state.head!,title,body,draft,closedAt:null,merged:false,author:'agent'}
      if(state.lose)throw Error('lost response')
      return state.pr
    },
    async edit(n,title,body){Object.assign(state.pr!,{title,body})},async ready(){state.pr!.draft=false},
  }
  const adapter=()=>new Delivery(db,remote,'org/test','agent',{
    authorize:()=>{if(!state.authorized)throw Error('revoked')},open:()=>true,
    bind:()=>state.binds++,closed:()=>state.ends++})
  return {state,db,ref,remote,adapter}
}
test('local commit confined to ticket, remote creation survives a lost receipt and closes once',async t=>{
  const {state,ref,adapter}=setup(t)
  writeFileSync(join(ref.directory,'change.txt'),'fix')
  const req={title:'Fix email',body:'unit check passed',draft:false}
  state.lose=true
  await assert.rejects(adapter().deliver('first',ref,req),/lost response/)
  assert.match(await localGit(ref,['show','HEAD:change.txt']),/fix/)
  const recovered=adapter()
  const result=await recovered.deliver('first',ref,req)
  assert.equal(result.pr,3)
  assert.equal(state.creates,1); assert.equal(state.pushes,1)
  state.pr!.closedAt=new Date().toISOString();state.pr!.merged=true
  await recovered.poll(10);await recovered.poll(90_000)
  assert.equal(state.ends,1)
})
test('revocation between push and create preserves push receipt without creating PR',async t=>{
  const {ref,state,adapter,remote,db}=setup(t)
  const push=remote.push
  remote.push=async(r,sha)=>{await push(r,sha);state.authorized=false}
  await assert.rejects(adapter().deliver('once',ref,{title:'Fix',body:'',draft:true}),/revoked/)
  assert.equal(state.creates,0);assert.equal(state.pushes,1)
  assert.equal(db.prepare('select push_state from remote_ops').get()!.push_state,'confirmed')
})
test('refuse a matching PR from another author and refuse binding replay with new args',async t=>{
  const {ref,state,adapter}=setup(t)
  const d=adapter(),req={title:'Fix',body:'',draft:true}
  await d.deliver('once',ref,req)
  await assert.rejects(d.deliver('once',ref,{...req,title:'other'}),/Conflicting/)
  state.pr!.author='someone-else'
  await assert.rejects(d.deliver('again',ref,req),/not owned/)
})
