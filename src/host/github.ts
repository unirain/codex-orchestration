// Host-only adapter. The caller resolves the ticket, workspace and authorized target.
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export interface GithubConfig { repo: string; account: string; gh: string; configDir: string; localLoginTestRepo?: string }
export interface Ref { ticket: string; branch: string; base: string; directory: string; gitDir: string }
export interface Pull {
  number: number; repo: string; headRepo: string; author: string; branch: string; base: string
  commit: string; title: string; body: string; draft: boolean; closedAt: string | null; merged: boolean
}
export interface Remote {
  verify(): Promise<void>
  head(branch: string): Promise<string | null>
  push(ref: Ref, commit: string): Promise<void>
  lookup(ref: Ref): Promise<Pull[]>
  read(number: number): Promise<Pull>
  create(ref: Ref, title: string, body: string, draft: boolean): Promise<Pull>
  edit(number: number, title: string, body: string): Promise<void>
  ready(number: number): Promise<void>
}
export interface CommandFailure { code?: number|string; stderr?: string }
export class RetryLater extends Error {
  delayMs: number
  constructor(delayMs: number) { super('GitHub requested a later poll'); this.delayMs=delayMs }
}
export class GitHub implements Remote {
  config: GithubConfig
  env: NodeJS.ProcessEnv
  constructor(config: GithubConfig) {
    if (!/^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(config.repo) || !config.account.trim()) throw Error('Invalid repository binding')
    if (![config.gh,config.configDir].every(isAbsolute)) throw Error('Dedicated gh executable and config directory must be absolute')
    if (realpathSync(config.configDir) === homedir()+'/.config/gh' && config.localLoginTestRepo !== config.repo) throw Error('Use a dedicated gh config directory')
    this.config={...config, configDir:realpathSync(config.configDir), gh:realpathSync(config.gh)}
    this.env={PATH:process.env.PATH, LANG:'C', GH_CONFIG_DIR:this.config.configDir, GH_HOST:'github.com',
      GH_PROMPT_DISABLED:'1', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0'}
  }
  private async api(path: string, args: string[] = []) {
    try {
      const {stdout}=await exec(this.config.gh,['api','--hostname','github.com',path,...args],{env:this.env,timeout:30000,maxBuffer:4*1024*1024})
      return JSON.parse(stdout)
    } catch(err) {
      const status=(err as CommandFailure).stderr?.match(/HTTP (\d{3})/)?.[1]
      if (status==='429'||(status==='403' && /rate limit/i.test((err as CommandFailure).stderr??''))) {
        // Fetch response headers without repeating the rejected mutation.
        let delay=60000
        try {
          const {stdout}=await exec(this.config.gh,['api','--hostname','github.com','-i','rate_limit'],{env:this.env,timeout:5000})
          const reset=Number(stdout.match(/^x-ratelimit-reset:\s*(\d+)/im)?.[1])
          if (reset) delay=Math.max(delay,reset*1000-Date.now())
        } catch { /* next poll retains the conservative minimum */ }
        throw new RetryLater(delay)
      }
      throw Object.assign(Error('GitHub API request failed'+(status?' (HTTP '+status+')':'')),{status})
    }
  }
  async verify() {
    const user=await this.api('user')
    if (user.login!==this.config.account) throw Error('Dedicated GitHub identity mismatch')
    const repo=await this.api('repos/'+this.config.repo)
    if (repo.full_name.toLowerCase()!==this.config.repo.toLowerCase() || repo.permissions?.push!==true) throw Error('Repository identity or push permission mismatch')
  }
  async head(branch: string) {
    try {return String((await this.api('repos/'+this.config.repo+'/git/ref/heads/'+branch.split('/').map(encodeURIComponent).join('/'))).object.sha)}
    catch(e) {if((e as {status?:string}).status==='404')return null;throw e}
  }
  async push(ref: Ref, commit: string) {
    // Disable hooks and use only the bound HTTPS server and specific gh helper.
    const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'"
    const args=['--git-dir='+ref.gitDir,'--work-tree='+ref.directory,'-c','core.hooksPath=/dev/null','-c','credential.helper=','-c',
      'credential.helper=!'+quote(this.config.gh)+' auth git-credential','-c','protocol.allow=never','-c','protocol.https.allow=always',
      'push','--no-verify','https://github.com/'+this.config.repo+'.git',commit+':refs/heads/'+ref.branch]
    try {await exec('git',args,{env:this.env,timeout:90000})}
    catch {throw Error('Ticket push failed; reconcile remote head before retry')}
  }
  private parse(p:any):Pull {
    return {number:p.number,repo:p.base.repo.full_name,headRepo:p.head.repo?.full_name??'',author:p.user.login,branch:p.head.ref,
      base:p.base.ref,commit:p.head.sha,title:p.title,body:p.body??'',draft:p.draft,closedAt:p.closed_at,merged:Boolean(p.merged_at)}
  }
  async lookup(ref:Ref) {
    const q=new URLSearchParams({state:'all',head:this.config.repo.split('/')[0]+':'+ref.branch,base:ref.base,per_page:'100'})
    return (await this.api('repos/'+this.config.repo+'/pulls?'+q)).map((p:unknown)=>this.parse(p)) as Pull[]
  }
  async read(n:number){return this.parse(await this.api('repos/'+this.config.repo+'/pulls/'+n))}
  async create(ref:Ref,title:string,body:string,draft:boolean){
    return this.parse(await this.api('repos/'+this.config.repo+'/pulls',['--method','POST','-f','head='+ref.branch,'-f','base='+ref.base,'-f','title='+title,'-f','body='+body,'-F','draft='+String(draft)]))
  }
  async edit(n:number,title:string,body:string){await this.api('repos/'+this.config.repo+'/pulls/'+n,['--method','PATCH','-f','title='+title,'-f','body='+body])}
  async ready(n:number){
    try { await exec(this.config.gh,['pr','ready',String(n),'--repo',this.config.repo],{env:this.env,timeout:30000}) }
    catch {throw Error('Cannot confirm PR marked ready')}
  }
}
