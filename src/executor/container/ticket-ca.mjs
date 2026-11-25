import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'

// A throwaway CA exists only in the relay's private Linux tmpfs. Only its
// public certificate is shared with this Ticket's package clients.
export function makeCertificates(directory, names) {
  const openssl = args => execFileSync('openssl', args, {cwd:directory,stdio:['ignore','ignore','pipe']})
  openssl(['req','-sha256','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-pkeyopt','ec_param_enc:named_curve','-nodes',
    '-keyout','ca.key','-out','ca.pem','-days','3650','-subj','/CN=Ticket egress',
    '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign'])
  const contexts=new Map()
  for(const name of new Set(names)) {
    const stem='leaf-'+contexts.size
    const san=isIP(name)?'IP:'+name:'DNS:'+name
    writeFileSync(join(directory,stem+'.ext'),'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName='+san+'\n')
    openssl(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-pkeyopt','ec_param_enc:named_curve','-nodes',
      '-keyout',stem+'.key','-out',stem+'.csr','-subj','/CN=Ticket package endpoint'])
    openssl(['x509','-sha256','-req','-in',stem+'.csr','-CA','ca.pem','-CAkey','ca.key',
      '-set_serial','0x'+randomBytes(16).toString('hex'),'-days','3650','-extfile',stem+'.ext','-out',stem+'.pem'])
    contexts.set(name,{key:readFileSync(join(directory,stem+'.key')),cert:readFileSync(join(directory,stem+'.pem'))})
  }
  return {contexts,publicCa:readFileSync(join(directory,'ca.pem'))}
}
