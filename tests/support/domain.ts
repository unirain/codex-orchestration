import { openDomain, terminalTrigger, type DomainOptions } from '../../src/domain.ts'
import { recordingPorts, temporaryDatabase } from './fixture.ts'

export function domainFixture(overrides: Partial<DomainOptions> = {}) {
  const temporary = temporaryDatabase()
  let clock = Date.parse('2026-11-25T01:00:00Z')
  const now = () => new Date(++clock).toISOString()
  const actorId = 'owner'
  const config = { repository: 'fixture/repo', actorId, now, ...overrides }
  const d = openDomain(temporary.path, config)
  const ports = recordingPorts()
  function receive(id: string, text: string) {
    return d.engine.receive(terminalTrigger(id,text,actorId,now()))
  }
  function accept(id: string, title: string) {
    const evalId = d.engine.candidate(id)!.evalId
    return d.engine.decide(id, { kind: 'accept', title, scope: title, reason: 'explicit user request', evalId })
  }
  return { d, ports, config, temporary, receive, accept, now, close: () => { d.close(); temporary.cleanup() } }
}
