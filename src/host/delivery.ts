import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { Pull, Remote, Ref } from './github.ts'
import { RetryLater } from './github.ts'

const exec=promisify(execFile)
export async function localGit(ref:Ref,args:string[], indexFile?:string) {
  const directory=realpathSync(ref.directory), gitDir=realpathSync(ref.gitDir)
  if (gitDir===directory||gitDir.startsWith(directory+sep)||directory!==resolve(ref.directory)) throw Error('Untrusted workspace metadata')
  const {stdout}=await exec('git',['--git-dir='+gitDir,'--work-tree='+directory,'-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],
    {cwd:gitDir,env:{...(indexFile?{GIT_INDEX_FILE:indexFile}:{}),PATH:process.env.PATH,LANG:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},timeout:45000})
  return stdout.trim()
}
export type DeliveryRequest={title:string;body:string;draft:boolean;commit?:string;operation?:'push'|'create'|'update';pr?:number}
interface Journal {call:string;ticket:string;ref:string;request:string;commit_sha:string;previous:string|null;push_state:string;pr:number|null;done:number}
export interface DeliveryHooks {
  authorize:(ref:Ref)=>void
  bind:(ref:Ref,pr:Pull)=>void
  closed:(pr:Pull)=>void
  open:(ticket:string)=>boolean
}
export class Delivery {
  db:DatabaseSync; remote:Remote; repo:string; account:string; hooks:DeliveryHooks
  private active=new Set<string>()
  nextPoll=0
  constructor(db:DatabaseSync,remote:Remote,repo:string,account:string,hooks:DeliveryHooks) {
    this.db=db; this.remote=remote; this.repo=repo; this.account=account; this.hooks=hooks
    db.exec(`CREATE TABLE IF NOT EXISTS remote_ops(call TEXT PRIMARY KEY,ticket TEXT NOT NULL,ref TEXT NOT NULL,request TEXT NOT NULL,
      commit_sha TEXT NOT NULL,previous TEXT,push_state TEXT NOT NULL DEFAULT 'pending',pr INTEGER,done INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tracked_pr(ticket TEXT NOT NULL,number INTEGER NOT NULL,settled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ticket,number));`)
  }
  private journal(call:string) {return this.db.prepare('SELECT * FROM remote_ops WHERE call=?').get(call) as unknown as Journal|undefined}
  private assertPull(ref:Ref,pr:Pull) {
    if(pr.repo.toLowerCase()!==this.repo.toLowerCase()||pr.headRepo.toLowerCase()!==this.repo.toLowerCase()||pr.author!==this.account||pr.branch!==ref.branch||pr.base!==ref.base)throw Error('PR is not owned by this Ticket')
    for(const t of this.db.prepare('SELECT ticket FROM tracked_pr WHERE number=? AND ticket<>?').all(pr.number,ref.ticket))
      if(this.hooks.open(String(t.ticket))) throw Error('PR is bound to another open Ticket')
  }
  async deliver(call:string,ref:Ref,request:DeliveryRequest, live:()=>void=()=>{}) {
    if(this.active.has(ref.ticket))throw Error('Delivery already in progress for this Ticket')
    const checkWrite=async()=>{await this.remote.verify();live();this.hooks.authorize(ref)}
    if(!request.title?.trim()||typeof request.body!=='string'||typeof request.draft!=='boolean')throw Error('Incomplete PR request')
    this.active.add(ref.ticket)
    try{
      let op=this.journal(call)
      if(op && (op.ticket!==ref.ticket||op.request!==JSON.stringify(request)||op.ref!==JSON.stringify(ref)))throw Error('Conflicting delivery receipt')
      if(op?.done)return {pr:op.pr,commit:op.commit_sha}
      await this.remote.verify()
      if(!op){
        live();this.hooks.authorize(ref)
        if(await localGit(ref,['symbolic-ref','--short','HEAD'])!==ref.branch)throw Error('Ticket branch mismatch')
        let sha=await localGit(ref,['rev-parse','HEAD'])
        if(request.commit && request.commit!==sha)throw Error('Requested commit differs from Ticket HEAD')
        if(!request.commit){
          // The service stages only this ticket worktree. Hooks, user config and signing agents are disabled.
          await localGit(ref,['add','--all','--','.'])
          const staged=await localGit(ref,['diff','--cached','--name-only','--no-ext-diff'])
          if(staged) {
            live();this.hooks.authorize(ref)
            await localGit(ref,['-c','user.name='+this.account,'-c','user.email='+this.account+'@users.noreply.github.com','commit','-m',request.title])
            sha=await localGit(ref,['rev-parse','HEAD'])
          }
        }
        const before=await this.remote.head(ref.branch)
        this.db.prepare('INSERT INTO remote_ops(call,ticket,ref,request,commit_sha,previous) VALUES(?,?,?,?,?,?)').run(call,ref.ticket,JSON.stringify(ref),JSON.stringify(request),sha,before)
        op=this.journal(call)!
      }
      const head=await this.remote.head(ref.branch)
      if(head!==op.commit_sha){
        if(head!==op.previous||op.push_state==='confirmed')throw Error('Remote head diverged; operator reconciliation required')
        await checkWrite()
        await this.remote.push(ref,op.commit_sha)
        if(await this.remote.head(ref.branch)!==op.commit_sha)throw Error('Remote push not confirmed')
      }
      this.db.prepare("UPDATE remote_ops SET push_state='confirmed' WHERE call=?").run(call)
      if(request.operation==='push'){
        this.db.prepare('UPDATE remote_ops SET done=1 WHERE call=?').run(call)
        return {pr:null,commit:op.commit_sha}
      }
      let pr:Pull
      if(request.operation==='update' && !request.pr)throw Error('Updating a PR requires its number')
      if(op.pr||request.pr)pr=await this.remote.read((op.pr||request.pr)!)
      else {
        const candidates=await this.remote.lookup(ref)
        const open=candidates.filter(p=>!p.closedAt)
        const match=open.length?open:candidates.filter(p=>p.commit===op.commit_sha)
        if(match.length>1)throw Error('Multiple matching PRs; operator reconciliation required')
        if(match.length)pr=match[0]
        else {
          await checkWrite()
          pr=await this.remote.create(ref,request.title,request.body,request.draft)
        }
      }
      this.assertPull(ref,pr)
      if(pr.commit!==op.commit_sha)throw Error('PR head does not yet confirm the requested commit')
      this.db.prepare('UPDATE remote_ops SET pr=? WHERE call=?').run(pr.number,call)
      if(!pr.closedAt) {
        if(pr.title!==request.title||pr.body!==request.body){
          await checkWrite()
          await this.remote.edit(pr.number,request.title,request.body)
        }
        if(pr.draft && !request.draft) {
          await checkWrite()
          await this.remote.ready(pr.number)
        }
      }
      // Binding is replayable after a crash between remote confirmation and local receipt.
      this.hooks.bind(ref,pr)
      this.db.prepare('INSERT OR IGNORE INTO tracked_pr(ticket,number) VALUES(?,?)').run(ref.ticket,pr.number)
      this.db.prepare('UPDATE remote_ops SET done=1 WHERE call=?').run(call)
      return {pr:pr.number,commit:op.commit_sha}
    } finally{this.active.delete(ref.ticket)}
  }
  pending(){return this.db.prepare('SELECT call,ticket,ref,request FROM remote_ops WHERE done=0 ORDER BY rowid').all()}
  async poll(now=Date.now()) {
    if(now<this.nextPoll)return
    this.nextPoll=now+60000
    const ids=new Set(this.db.prepare('SELECT ticket,number FROM tracked_pr WHERE settled=0').all()
      .filter(r=>this.hooks.open(String(r.ticket))).map(r=>Number(r.number)))
    for(const n of ids){
      try{
        const p=await this.remote.read(n)
        if(p.repo.toLowerCase()!==this.repo.toLowerCase()||p.number!==n)throw Error('PR lookup mismatch')
        if(p.closedAt){this.hooks.closed(p);this.db.prepare('UPDATE tracked_pr SET settled=1 WHERE number=?').run(n)}
      } catch(e){if(e instanceof RetryLater)this.nextPoll=Math.max(this.nextPoll,now+e.delayMs); throw e}
    }
  }
}
